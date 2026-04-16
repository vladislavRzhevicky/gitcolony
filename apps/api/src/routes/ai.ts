import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { decryptSecret } from '@gitcolony/crypto';
import {
  generateMeetingLines,
  generateCodeReview,
  pickAgentIntent,
  type LLMConfig,
} from '@gitcolony/llm';
import {
  fetchCommitPatches,
  type CommitFilePatch,
} from '@gitcolony/github';
import {
  detectLanguage,
  isReviewableFile,
  parseAddedRuns,
  pickReviewableRun,
  type AddedRun,
} from '@gitcolony/core/code-hunks';
import { log } from '@gitcolony/log';
import { requireUser } from '../middleware/auth.js';

// ============================================================================
// /ai — server-mediated LLM calls driven by the client sim.
//
// The user's Gemini key lives encrypted in user_llm_keys; the browser never
// sees plaintext. Clients POST a meeting payload, we resolve the active
// key, decrypt, call Gemini via @gitcolony/llm, and return the two lines.
//
// Rate limiting is defence-in-depth: the sim enforces per-pair cooldowns
// and a session budget before it even hits us. Here we guard against a
// compromised or buggy client by capping per-user RPS in a small in-memory
// window.
// ============================================================================

export const aiRoute = new Hono();
aiRoute.use('*', requireUser);

const GreetBody = z.object({
  meetingId: z.string().min(1).max(128),
  first: z.object({
    label: z.string().min(1).max(40),
    personality: z.string().max(200).nullable(),
    districtName: z.string().max(80).nullable(),
    commitSubject: z.string().max(200).nullable(),
  }),
  second: z.object({
    label: z.string().min(1).max(40),
    personality: z.string().max(200).nullable(),
    districtName: z.string().max(80).nullable(),
    commitSubject: z.string().max(200).nullable(),
  }),
  context: z.object({
    districtName: z.string().max(80).nullable(),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'night']).optional(),
  }),
});

// Per-user rolling window: max N calls per 10s. Protects the user's Gemini
// quota from runaway client bugs without needing an external rate limiter.
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 30;
const windows = new Map<string, number[]>();

function checkRate(userId: string): boolean {
  const now = Date.now();
  const hits = (windows.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) {
    windows.set(userId, hits);
    return false;
  }
  hits.push(now);
  windows.set(userId, hits);
  return true;
}

const IntentBody = z.object({
  subject: z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(40),
    personality: z.string().max(200).nullable(),
    homeDistrictName: z.string().max(80).nullable(),
    currentDistrictName: z.string().max(80).nullable(),
    commitSubject: z.string().max(200).nullable(),
  }),
  districts: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().min(1).max(80),
        population: z.number().int().min(0).max(10_000),
        isHome: z.boolean(),
        isCurrent: z.boolean(),
      }),
    )
    .max(32),
  peers: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        label: z.string().min(1).max(40),
        districtName: z.string().max(80).nullable(),
      }),
    )
    .max(16),
  timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'night']).optional(),
});

aiRoute.post('/greet', async (c) => {
  const user = c.get('user');
  if (!checkRate(user.id)) return c.json({ error: 'rate limited' }, 429);

  const parsed = GreetBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  }

  const config = await resolveActiveKey(user.id);
  if (!config) return c.json({ error: 'no active llm key' }, 412);

  const lines = await generateMeetingLines(
    parsed.data.first,
    parsed.data.second,
    parsed.data.context,
    config,
  );
  if (!lines) {
    return c.json({ error: 'llm call failed' }, 502);
  }

  // Best-effort last-used stamp — don't fail the request on write errors.
  db.update(schema.userLlmKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.userLlmKeys.id, config.keyId))
    .catch((err) => log.warn('llm-key lastUsedAt update failed', { err: String(err) }));

  return c.json({ opener: lines.opener, reply: lines.reply });
});

// ============================================================================
// /ai/review — picks a random commit from the caller's city, extracts one
// reviewable snippet from its diff, and asks the LLM for a roast/praise
// exchange between two AI coworkers.
//
// Patch fetching dominates the cost (1 GitHub REST call per commit), so we
// cache `owner/name@sha → CommitFilePatch[]` in-process. Commits are
// immutable, so the only risk is memory bloat — the LRU cap is plenty for
// a single web client's session.
// ============================================================================

const ReviewBody = z.object({
  citySlug: z.string().min(1).max(64),
  commitSha: z.string().min(7).max(64),
  commitSubject: z.string().max(200).nullable(),
  reviewer: z.object({
    label: z.string().min(1).max(40),
    personality: z.string().max(200).nullable(),
  }),
  developer: z.object({
    label: z.string().min(1).max(40),
    personality: z.string().max(200).nullable(),
  }),
  tone: z.enum(['praise', 'roast']).optional(),
});

const PATCH_CACHE_LIMIT = 500;
const patchCache = new Map<string, CommitFilePatch[]>();

function getCachedPatches(key: string): CommitFilePatch[] | undefined {
  const hit = patchCache.get(key);
  if (hit) {
    // Touch for LRU: delete + reinsert puts it at the tail.
    patchCache.delete(key);
    patchCache.set(key, hit);
  }
  return hit;
}

function cachePatches(key: string, patches: CommitFilePatch[]): void {
  if (patchCache.size >= PATCH_CACHE_LIMIT) {
    const oldest = patchCache.keys().next().value;
    if (oldest) patchCache.delete(oldest);
  }
  patchCache.set(key, patches);
}

aiRoute.post('/review', async (c) => {
  const user = c.get('user');
  if (!checkRate(user.id)) return c.json({ error: 'rate limited' }, 429);

  const parsed = ReviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  const resolved = await resolveCityAndRepoToken(user.id, body.citySlug);
  if (!resolved) return c.json({ error: 'city not found' }, 404);
  if (!resolved.token) {
    return c.json({ error: 'no repo token on file for this city' }, 412);
  }
  const { owner, name, token } = resolved;

  const cacheKey = `${owner}/${name}@${body.commitSha}`;
  let patches = getCachedPatches(cacheKey);
  if (!patches) {
    const fetched = await fetchCommitPatches(token, owner, name, body.commitSha);
    if (!fetched) return c.json({ error: 'commit not reachable' }, 404);
    patches = fetched;
    cachePatches(cacheKey, patches);
  }

  const runs: AddedRun[] = [];
  for (const f of patches) {
    if (!f.patch) continue;
    if (!isReviewableFile(f.filename)) continue;
    for (const r of parseAddedRuns(f.filename, f.patch)) runs.push(r);
  }
  const snippetRun = pickReviewableRun(runs);
  // 204 has no body per HTTP spec; emit one with no payload so the proxy can
  // pass the status through cleanly.
  if (!snippetRun) return c.body(null, 204);

  const config = await resolveActiveKey(user.id);
  if (!config) return c.json({ error: 'no active llm key' }, 412);

  const tone: 'praise' | 'roast' =
    body.tone ?? (Math.random() < 0.35 ? 'praise' : 'roast');

  const lines = await generateCodeReview(
    {
      snippet: {
        filename: snippetRun.filename,
        language: detectLanguage(snippetRun.filename),
        lines: snippetRun.lines,
        startLine: snippetRun.startLine,
      },
      reviewer: body.reviewer,
      developer: body.developer,
      tone,
      commitSubject: body.commitSubject,
    },
    config,
  );
  if (!lines) return c.json({ error: 'llm call failed' }, 502);

  db.update(schema.userLlmKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.userLlmKeys.id, config.keyId))
    .catch((err) => log.warn('llm-key lastUsedAt update failed', { err: String(err) }));

  return c.json({
    opener: lines.opener,
    reply: lines.reply,
    tone,
    quote: {
      filename: snippetRun.filename,
      language: detectLanguage(snippetRun.filename),
      lines: snippetRun.lines,
      startLine: snippetRun.startLine,
    },
  });
});

aiRoute.post('/intent', async (c) => {
  const user = c.get('user');
  if (!checkRate(user.id)) return c.json({ error: 'rate limited' }, 429);

  const parsed = IntentBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  }

  const config = await resolveActiveKey(user.id);
  if (!config) return c.json({ error: 'no active llm key' }, 412);

  const intent = await pickAgentIntent(parsed.data, config);
  if (!intent) return c.json({ error: 'llm call failed' }, 502);

  db.update(schema.userLlmKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.userLlmKeys.id, config.keyId))
    .catch((err) => log.warn('llm-key lastUsedAt update failed', { err: String(err) }));

  return c.json({ intent });
});

// Resolves the repo and a GitHub token that can read it for the given city.
// Prefers the explicit token stored alongside the city (for private PAT
// flows); falls back to the user's OAuth token. Mirrors the token-priority
// logic in cities.ts. Returns null when the city isn't owned by this user.
async function resolveCityAndRepoToken(
  userId: string,
  slug: string,
): Promise<
  | {
      cityId: string;
      owner: string;
      name: string;
      token: string | null;
    }
  | null
> {
  const [city] = await db
    .select({
      id: schema.cities.id,
      repoFullName: schema.cities.repoFullName,
      sourceTokenId: schema.cities.sourceTokenId,
    })
    .from(schema.cities)
    .where(and(eq(schema.cities.slug, slug), eq(schema.cities.userId, userId)))
    .limit(1);
  if (!city) return null;

  const slash = city.repoFullName.indexOf('/');
  if (slash <= 0) return null;
  const owner = city.repoFullName.slice(0, slash);
  const name = city.repoFullName.slice(slash + 1);

  let token: string | null = null;
  if (city.sourceTokenId) {
    const [row] = await db
      .select({ encryptedPat: schema.userTokens.encryptedPat })
      .from(schema.userTokens)
      .where(
        and(
          eq(schema.userTokens.id, city.sourceTokenId),
          eq(schema.userTokens.userId, userId),
        ),
      )
      .limit(1);
    if (row) {
      try {
        token = decryptSecret(row.encryptedPat);
      } catch {
        token = null;
      }
    }
  }
  if (!token) {
    const [row] = await db
      .select({ encryptedOauthToken: schema.users.encryptedOauthToken })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (row?.encryptedOauthToken) {
      try {
        token = decryptSecret(row.encryptedOauthToken);
      } catch {
        token = null;
      }
    }
  }
  return { cityId: city.id, owner, name, token };
}

interface ResolvedKey extends LLMConfig {
  keyId: string;
}

async function resolveActiveKey(userId: string): Promise<ResolvedKey | null> {
  const [u] = await db
    .select({ activeLlmKeyId: schema.users.activeLlmKeyId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!u?.activeLlmKeyId) return null;

  const [row] = await db
    .select({
      id: schema.userLlmKeys.id,
      model: schema.userLlmKeys.model,
      encryptedApiKey: schema.userLlmKeys.encryptedApiKey,
    })
    .from(schema.userLlmKeys)
    .where(eq(schema.userLlmKeys.id, u.activeLlmKeyId))
    .limit(1);
  if (!row) return null;

  let apiKey: string;
  try {
    apiKey = decryptSecret(row.encryptedApiKey);
  } catch (err) {
    log.error('llm key decrypt failed', err instanceof Error ? err : new Error(String(err)), {
      userId,
      keyId: row.id,
    });
    return null;
  }
  return { keyId: row.id, apiKey, model: row.model };
}
