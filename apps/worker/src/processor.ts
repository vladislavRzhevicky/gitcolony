import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { decryptSecret } from '@gitcolony/crypto';
import {
  enrichCommitFiles,
  fetchCommits,
} from '@gitcolony/github';
import { extendWorld, generateWorld, rankAll } from '@gitcolony/core';
import type { LLMConfig } from '@gitcolony/llm';
import type { JobPhase, JobProgressEvent, World } from '@gitcolony/schema';
import { log } from '@gitcolony/log';
import { jobChannel, publisher, type GenerationJobData } from './queue.js';
import { runNamingPhase } from './pipeline/naming.js';
import { runTickerPhase } from './pipeline/ticker.js';

// ----------------------------------------------------------------------------
// Progress reporter — writes to DB for late-join snapshots, publishes to
// Redis for live SSE subscribers. Same JobProgressEvent shape both places.
// ----------------------------------------------------------------------------

function makeReporter(jobId: string) {
  return async (partial: Omit<JobProgressEvent, 'jobId'>) => {
    const evt: JobProgressEvent = { jobId, ...partial };
    const status =
      partial.phase === 'done'
        ? 'done'
        : partial.phase === 'failed'
          ? 'failed'
          : partial.phase === 'queued'
            ? 'queued'
            : 'running';
    await db
      .update(schema.generationJobs)
      .set({
        status,
        phase: partial.phase,
        progress: Math.round(partial.progress),
        message: partial.message ?? null,
        error: partial.error ?? null,
        ...(partial.phase === 'done' || partial.phase === 'failed'
          ? { finishedAt: new Date() }
          : {}),
      })
      .where(eq(schema.generationJobs.id, jobId));
    await publisher.publish(jobChannel(jobId), JSON.stringify(evt));
  };
}

// ----------------------------------------------------------------------------
// Flavor text — shown during the "first generation" page. Rotated per phase
// so users see motion even when a phase takes a few seconds.
// ----------------------------------------------------------------------------

const FLAVOR: Record<JobPhase, readonly string[]> = {
  queued: ['queued', 'waiting for a surveyor'],
  fetching: [
    'reading commit history',
    'counting footprints',
    'mapping subsystems',
  ],
  ranking: [
    'classifying roles',
    'sorting characters from decor',
    'measuring the weight of each change',
  ],
  layout: ['drawing district lines', 'surveying the land'],
  roads: ['paving routes between districts', 'laying cobblestones'],
  placing: ['placing foundations', 'raising walls', 'sending settlers out'],
  naming: ['naming the new buildings', 'introducing the inhabitants'],
  ticker: ['gathering city gossip', 'composing the evening news'],
  saving: ['saving your world'],
  done: ['welcome to your colony'],
  failed: ['generation failed'],
};

function flavor(phase: JobPhase): string {
  const list = FLAVOR[phase] ?? [];
  if (list.length === 0) return '';
  const idx = Math.floor(Math.random() * list.length);
  return list[idx] ?? '';
}

// ----------------------------------------------------------------------------
// Token resolution — same logic as the API, duplicated here because jobs may
// outlive HTTP sessions and need to re-decrypt from DB.
// ----------------------------------------------------------------------------

async function resolveToken(cityId: string): Promise<string> {
  const [city] = await db
    .select()
    .from(schema.cities)
    .where(eq(schema.cities.id, cityId))
    .limit(1);
  if (!city) throw new Error(`city ${cityId} not found`);

  if (city.sourceTokenId) {
    const [tok] = await db
      .select()
      .from(schema.userTokens)
      .where(eq(schema.userTokens.id, city.sourceTokenId))
      .limit(1);
    if (!tok) throw new Error('token was revoked');
    return decryptSecret(tok.encryptedPat);
  }

  // Public-flow: fall back to the user's stored OAuth access token.
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, city.userId))
    .limit(1);
  if (!user?.encryptedOauthToken) {
    throw new Error(
      'no OAuth token on file for user — re-login required to sync this city',
    );
  }
  return decryptSecret(user.encryptedOauthToken);
}

// ----------------------------------------------------------------------------
// LLM config resolver — pulls the user's active LLM key from the DB and
// decrypts it. Returns null if the user hasn't picked one, which causes
// the naming/ticker phases to skip (fail-soft contract).
// ----------------------------------------------------------------------------

async function resolveLlmConfig(userId: string): Promise<LLMConfig | null> {
  const [user] = await db
    .select({ activeLlmKeyId: schema.users.activeLlmKeyId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user?.activeLlmKeyId) return null;

  const [key] = await db
    .select({
      id: schema.userLlmKeys.id,
      encryptedApiKey: schema.userLlmKeys.encryptedApiKey,
      model: schema.userLlmKeys.model,
    })
    .from(schema.userLlmKeys)
    .where(eq(schema.userLlmKeys.id, user.activeLlmKeyId))
    .limit(1);
  if (!key) return null;

  // Best-effort usage bookkeeping; never blocks the job on failure.
  try {
    await db
      .update(schema.userLlmKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.userLlmKeys.id, key.id));
  } catch {
    // ignored
  }

  return {
    apiKey: decryptSecret(key.encryptedApiKey),
    model: key.model,
  };
}

// ----------------------------------------------------------------------------
// Main processor
// ----------------------------------------------------------------------------

export async function processGeneration(job: Job<GenerationJobData>) {
  const jobId = job.id!;
  const { cityId, mode } = job.data;
  const report = makeReporter(jobId);

  try {
    await db
      .update(schema.generationJobs)
      .set({ startedAt: new Date() })
      .where(eq(schema.generationJobs.id, jobId));
    await report({ phase: 'fetching', progress: 5, message: flavor('fetching') });

    const [city] = await db
      .select()
      .from(schema.cities)
      .where(eq(schema.cities.id, cityId))
      .limit(1);
    if (!city) throw new Error('city disappeared');

    // Resolve the LLM config from the owning user's active key. Null means
    // no key is saved/selected — naming/ticker phases then skip cleanly.
    const llmConfig = await resolveLlmConfig(city.userId);
    if (!llmConfig) {
      log.info('no active LLM key for user — LLM phases will skip', {
        userId: city.userId,
        cityId,
      });
    }

    const token = await resolveToken(cityId);
    const [ownerPart, namePart] = city.repoFullName.split('/');
    if (!ownerPart || !namePart) throw new Error('invalid repoFullName');

    const isIncremental = mode === 'resync' && city.lastSyncedSha;

    // --- Phase: fetching --------------------------------------------------
    const { repo, commits } = await fetchCommits(token, {
      owner: ownerPart,
      name: namePart,
      maxCommits: isIncremental ? 500 : Number(process.env.INITIAL_COMMIT_LIMIT ?? 1000),
      untilSha: isIncremental ? city.lastSyncedSha ?? undefined : undefined,
      onProgress: (n, max) => {
        const p = 5 + Math.min(45, (n / (max ?? n)) * 45);
        report({ phase: 'fetching', progress: p, message: flavor('fetching') });
      },
    });

    if (commits.length === 0) {
      // Nothing new upstream — but a sync attempt still completed, so bump
      // `lastSyncedAt` so the UI's "Synced Nm ago" chip resets. We leave
      // `lastSyncedSha` alone since no new commits were observed.
      await db
        .update(schema.cities)
        .set({
          lastSyncedAt: new Date(),
          ...(repo.totalCommits !== undefined
            ? { lastTotalCommits: repo.totalCommits }
            : {}),
        })
        .where(eq(schema.cities.id, cityId));
      await report({ phase: 'done', progress: 100, message: 'already up to date' });
      return;
    }

    // --- File enrichment --------------------------------------------------
    // GraphQL history doesn't return per-commit file paths, so without
    // REST enrichment the ranker's primaryPath is null for every commit
    // and district subdivision collapses to the handful of conventional-
    // commit scopes. We enrich the heaviest commits (by churn) up to a
    // budget, then fall back for the rest. Budget defaults to 800 REST
    // calls per sync (~16 % of a 5k-rph PAT quota).
    const enrichCap = Math.min(
      commits.length,
      Number(process.env.ENRICH_FILES_CAP ?? 800),
    );
    const enrichTargets = [...commits]
      .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, enrichCap)
      .map((c) => c.sha);

    const files = await enrichCommitFiles(token, {
      owner: ownerPart,
      name: namePart,
      shas: enrichTargets,
      onProgress: (done, total) => {
        // Share the fetching phase progress window: fetch reports 5-50,
        // enrichment occupies 50-55 visually (brief, usually sub-second
        // per call but runs in parallel with chunked pagination).
        const p = 50 + (done / total) * 5;
        report({
          phase: 'fetching',
          progress: p,
          message: `enriching files ${done}/${total}`,
        });
      },
    });

    const enrichedCommits = commits.map((c) => {
      const f = files.get(c.sha);
      return f && f.length > 0 ? { ...c, changedFiles: f } : c;
    });

    // --- Phase: ranking ---------------------------------------------------
    await report({ phase: 'ranking', progress: 55, message: flavor('ranking') });
    const ranked = rankAll(enrichedCommits);

    // --- Phases: layout → roads → placing ---------------------------------
    // generateWorld runs layout/roads/placing internally in one pass (fast:
    // ms-scale), but we emit each phase as a distinct progress frame so the
    // UI can reflect the pipeline. Labels track the roadmap contract.
    //
    // We also capture the pre-existing object/agent ids when running an
    // incremental sync, so the naming phase below can name only the truly
    // new entities and leave already-named ones untouched (invariant #2).
    let world: World;
    let preExistingObjectIds: ReadonlySet<string> = new Set();
    let preExistingAgentIds: ReadonlySet<string> = new Set();
    if (isIncremental) {
      const [existing] = await db
        .select()
        .from(schema.cityWorlds)
        .where(eq(schema.cityWorlds.cityId, cityId))
        .limit(1);
      if (!existing) {
        await report({ phase: 'layout', progress: 55, message: flavor('layout') });
        await report({ phase: 'roads', progress: 60, message: flavor('roads') });
        await report({ phase: 'placing', progress: 65, message: flavor('placing') });
        world = generateWorld(repo, ranked);
      } else {
        // Sync: layout + roads are immutable (invariant #2), only placing runs.
        const prev = existing.world as World;
        preExistingObjectIds = new Set(prev.objects.map((o) => o.id));
        preExistingAgentIds = new Set(prev.agents.map((a) => a.id));
        await report({ phase: 'placing', progress: 65, message: flavor('placing') });
        world = extendWorld(prev, ranked, repo.totalCommits);
      }
    } else {
      await report({ phase: 'layout', progress: 55, message: flavor('layout') });
      await report({ phase: 'roads', progress: 60, message: flavor('roads') });
      await report({ phase: 'placing', progress: 65, message: flavor('placing') });
      world = generateWorld(repo, ranked);
    }

    // --- Phase: naming (LLM, fail-soft) -----------------------------------
    await report({ phase: 'naming', progress: 75, message: flavor('naming') });
    world = await runNamingPhase({
      world,
      preExistingObjectIds,
      preExistingAgentIds,
      config: llmConfig,
    });

    // --- Phase: ticker (LLM, fail-soft) -----------------------------------
    await report({ phase: 'ticker', progress: 87, message: flavor('ticker') });
    world = await runTickerPhase({ world, ranked, config: llmConfig });

    // --- Phase: saving ----------------------------------------------------
    await report({ phase: 'saving', progress: 94, message: flavor('saving') });
    await db
      .insert(schema.cityWorlds)
      .values({ cityId, world, schemaVersion: world.version })
      .onConflictDoUpdate({
        target: schema.cityWorlds.cityId,
        set: { world, updatedAt: new Date() },
      });
    await db
      .update(schema.cities)
      .set({
        lastSyncedSha: world.lastCommitSha,
        lastSyncedAt: new Date(),
        // Record the repo's real commit count so the next re-render can
        // detect growth and resize the city on a full regenerate. Null-safe:
        // CLI-sourced worlds won't carry this, and that's fine.
        ...(repo.totalCommits !== undefined
          ? { lastTotalCommits: repo.totalCommits }
          : {}),
      })
      .where(eq(schema.cities.id, cityId));

    await report({ phase: 'done', progress: 100, message: flavor('done') });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('generation job failed', err, { jobId, cityId });
    await report({ phase: 'failed', progress: 0, error: message, message: flavor('failed') });
    throw err; // let BullMQ decide about retries
  }
}
