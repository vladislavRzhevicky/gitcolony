import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { decryptSecret } from '@gitcolony/crypto';
import {
  generateMeetingLines,
  pickAgentIntent,
  type LLMConfig,
} from '@gitcolony/llm';
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
