import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import IORedis from 'ioredis';
import { and, desc, eq } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db, schema } from '@gitcolony/db';
import { requireUser } from '../middleware/auth.js';
import { enqueueGeneration, jobChannel } from '../queue.js';
import { checkOwnership } from '@gitcolony/github';
import { decryptSecret } from '@gitcolony/crypto';
import { deriveSeed } from '@gitcolony/core';
import { CityCreateRequestSchema, type JobProgressEvent } from '@gitcolony/schema';

async function resolveOauthToken(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ encryptedOauthToken: schema.users.encryptedOauthToken })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row?.encryptedOauthToken) return null;
  return decryptSecret(row.encryptedOauthToken);
}

const slugId = customAlphabet('abcdefghijkmnopqrstuvwxyz23456789', 10);

export const citiesRoute = new Hono();
citiesRoute.use('*', requireUser);

// ============================================================================
// Body schemas
// ============================================================================

// Web surface uses CityCreateRequest from @gitcolony/schema (repoFullName + optional pat).
// An inline PAT maps onto the same private-flow as storing a userToken, without
// persisting the token: we decrypt on the fly from the body. For MVP we only
// accept public-flow here (no tokenId / no PAT) — private tab lands later.

function normalizeRepo(raw: string): { owner: string; name: string } | null {
  const urlMatch = raw.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (urlMatch) return { owner: urlMatch[1]!, name: urlMatch[2]!.replace(/\.git$/, '') };
  const slashMatch = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slashMatch) return { owner: slashMatch[1]!, name: slashMatch[2]! };
  return null;
}

// ============================================================================
// List & detail
// ============================================================================

citiesRoute.get('/', async (c) => {
  const user = c.get('user');
  // Pull cities + the (cheap) stats block from city_worlds in one round-trip.
  // We intentionally don't select `world` itself — it's a heavy jsonb blob;
  // the dashboard only needs counts to render the card chips.
  const rows = await db
    .select({
      id: schema.cities.id,
      slug: schema.cities.slug,
      repoFullName: schema.cities.repoFullName,
      visibility: schema.cities.visibility,
      seed: schema.cities.seed,
      lastSyncedAt: schema.cities.lastSyncedAt,
      lastSyncedSha: schema.cities.lastSyncedSha,
      createdAt: schema.cities.createdAt,
      world: schema.cityWorlds.world,
    })
    .from(schema.cities)
    .leftJoin(schema.cityWorlds, eq(schema.cityWorlds.cityId, schema.cities.id))
    .where(eq(schema.cities.userId, user.id))
    .orderBy(desc(schema.cities.createdAt));

  // Latest job status per city — one extra query, a hash lookup at render.
  // Simpler than a correlated subquery and fine for MVP scale.
  const jobRows = await db
    .select({
      cityId: schema.generationJobs.cityId,
      status: schema.generationJobs.status,
      phase: schema.generationJobs.phase,
      progress: schema.generationJobs.progress,
      createdAt: schema.generationJobs.createdAt,
    })
    .from(schema.generationJobs)
    .orderBy(desc(schema.generationJobs.createdAt));
  const latestByCity = new Map<string, (typeof jobRows)[number]>();
  for (const j of jobRows) {
    if (!latestByCity.has(j.cityId)) latestByCity.set(j.cityId, j);
  }

  const cities = rows.map(({ world, ...city }) => ({
    ...city,
    stats: world?.stats ?? null,
    latestJob: latestByCity.get(city.id) ?? null,
  }));
  return c.json({ cities });
});

// Find a city by slug and verify it belongs to the caller. Returns null when
// the slug doesn't exist or is owned by somebody else — same 404 either way
// so we don't leak slug existence across users.
async function findOwnCityBySlug(userId: string, slug: string) {
  const [row] = await db
    .select()
    .from(schema.cities)
    .where(and(eq(schema.cities.slug, slug), eq(schema.cities.userId, userId)))
    .limit(1);
  return row ?? null;
}

citiesRoute.get('/:slug', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const row = await findOwnCityBySlug(user.id, slug);
  if (!row) return c.json({ error: 'not found' }, 404);

  const [worldRow] = await db
    .select()
    .from(schema.cityWorlds)
    .where(eq(schema.cityWorlds.cityId, row.id))
    .limit(1);

  const [latestJob] = await db
    .select()
    .from(schema.generationJobs)
    .where(eq(schema.generationJobs.cityId, row.id))
    .orderBy(desc(schema.generationJobs.createdAt))
    .limit(1);

  return c.json({
    city: row,
    world: worldRow?.world ?? null,
    job: latestJob ?? null,
  });
});

// ============================================================================
// Create (with ownership validation and job enqueue)
// ============================================================================

citiesRoute.post('/', async (c) => {
  const user = c.get('user');
  const parsed = CityCreateRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const repo = normalizeRepo(body.repoFullName);
  if (!repo) return c.json({ error: 'could not parse repo identifier' }, 400);

  // Resolve the token we'll authenticate to GitHub with. For MVP either:
  //   - inline PAT in the body (not persisted — ephemeral, used only for this
  //     request's ownership check and then discarded; worker falls back to
  //     the stored OAuth token for subsequent ingestion)
  //   - stored OAuth token from login (public-flow)
  // Persistent PAT tokens (`user_tokens`) remain for the private tab landing later.
  const oauth = await resolveOauthToken(user.id);
  const token = body.pat ?? oauth;
  if (!token) {
    return c.json(
      { error: 'no OAuth token on file — please re-login via GitHub' },
      401,
    );
  }
  const tokenId: string | null = null;

  // Ownership check: repo.owner must match the token-holder's login.
  const check = await checkOwnership(token, repo.owner, repo.name);
  if (!check.owned) {
    const message =
      check.reason === 'not_found'
        ? 'repository not found'
        : check.reason === 'private_inaccessible'
          ? 'repository is private and not accessible with this token'
          : `repository is owned by "${check.repoOwner}", not by you (${check.viewerLogin})`;
    return c.json({ error: message, reason: check.reason }, 403);
  }

  const fullName = `${repo.owner}/${repo.name}`;
  const seed = deriveSeed(fullName);

  // Upsert city (one per user per repo).
  const [existing] = await db
    .select()
    .from(schema.cities)
    .where(
      and(eq(schema.cities.userId, user.id), eq(schema.cities.repoFullName, fullName)),
    )
    .limit(1);

  if (existing) {
    return c.json({ error: 'city already exists for this repo', cityId: existing.id }, 409);
  }

  const slug = slugId();
  const [city] = await db
    .insert(schema.cities)
    .values({
      userId: user.id,
      sourceTokenId: tokenId,
      repoFullName: fullName,
      slug,
      seed,
      visibility: body.visibility,
    })
    .returning();

  const job = await enqueueGeneration(city!.id, 'initial');

  return c.json({ city, slug: city!.slug, jobId: job.id }, 201);
});

// ============================================================================
// SSE — live progress for the most recent job on this city.
//
// We subscribe to the BullMQ job's redis channel. If no job is active we emit
// the last DB snapshot once and close. Heartbeats keep proxies from dropping.
// ============================================================================

citiesRoute.get('/:slug/events', (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const redisUrl = process.env.REDIS_URL!;

  return streamSSE(c, async (stream) => {
    const city = await findOwnCityBySlug(user.id, slug);
    if (!city) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'not found' }),
      });
      await stream.close();
      return;
    }

    const [latest] = await db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.cityId, city.id))
      .orderBy(desc(schema.generationJobs.createdAt))
      .limit(1);

    // Always push a snapshot first so late joiners get immediate state.
    if (latest) {
      const snapshot: JobProgressEvent = {
        jobId: latest.id,
        phase: (latest.phase as JobProgressEvent['phase']) ?? 'queued',
        progress: latest.progress,
        message: latest.message ?? undefined,
        error: latest.error ?? undefined,
      };
      await stream.writeSSE({ event: 'progress', data: JSON.stringify(snapshot) });
      if (latest.status === 'done' || latest.status === 'failed') {
        await stream.close();
        return;
      }
    }

    if (!latest) {
      await stream.close();
      return;
    }

    const sub = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      try { await sub.unsubscribe(); } catch {}
      sub.disconnect();
    };
    stream.onAbort(cleanup);

    await sub.subscribe(jobChannel(latest.id));
    sub.on('message', async (_ch, payload) => {
      await stream.writeSSE({ event: 'progress', data: payload });
      try {
        const evt = JSON.parse(payload) as JobProgressEvent;
        if (evt.phase === 'done' || evt.phase === 'failed') {
          await cleanup();
          await stream.close();
        }
      } catch {}
    });

    const hb = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
    }, 15_000);
    stream.onAbort(() => clearInterval(hb));

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (closed) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  });
});

// ============================================================================
// Sync (incremental — fetches only commits newer than last_synced_sha)
// ============================================================================

citiesRoute.post('/:slug/sync', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const city = await findOwnCityBySlug(user.id, slug);
  if (!city) return c.json({ error: 'not found' }, 404);

  const job = await enqueueGeneration(city.id, 'resync');
  return c.json({ jobId: job.id });
});

// ============================================================================
// Regenerate from scratch (drops world and runs initial again)
// ============================================================================

citiesRoute.post('/:slug/regenerate', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const city = await findOwnCityBySlug(user.id, slug);
  if (!city) return c.json({ error: 'not found' }, 404);

  await db.delete(schema.cityWorlds).where(eq(schema.cityWorlds.cityId, city.id));
  await db
    .update(schema.cities)
    .set({ lastSyncedSha: null, lastSyncedAt: null })
    .where(eq(schema.cities.id, city.id));

  const job = await enqueueGeneration(city.id, 'regenerate');
  return c.json({ jobId: job.id });
});

citiesRoute.delete('/:slug', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const city = await findOwnCityBySlug(user.id, slug);
  if (!city) return c.json({ error: 'not found' }, 404);
  await db.delete(schema.cities).where(eq(schema.cities.id, city.id));
  return c.body(null, 204);
});
