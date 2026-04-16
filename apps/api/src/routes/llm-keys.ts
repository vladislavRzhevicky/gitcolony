import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { encryptSecret } from '@gitcolony/crypto';
import { listGeminiModels } from '@gitcolony/llm';
import { requireUser } from '../middleware/auth.js';

// ============================================================================
// /llm-keys — CRUD for the user's saved Gemini (and later, other provider)
// credentials. The "active" key lives on users.activeLlmKeyId so the worker
// can resolve it per job without scanning the whole table.
//
// Keys never leave the server as plaintext: the settings UI posts {apiKey,
// model, label}, we validate the key by hitting the provider, encrypt at
// rest, and only ever return metadata on GET.
// ============================================================================

export const llmKeysRoute = new Hono();
llmKeysRoute.use('*', requireUser);

const SaveBody = z.object({
  label: z.string().min(1).max(80),
  apiKey: z.string().min(10),
  model: z.string().min(1).max(120),
  // Reserved for future providers; Gemini-only for now.
  provider: z.literal('gemini').optional(),
});

const ModelsBody = z.object({
  apiKey: z.string().min(10),
});

llmKeysRoute.get('/', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select({
      id: schema.userLlmKeys.id,
      label: schema.userLlmKeys.label,
      provider: schema.userLlmKeys.provider,
      model: schema.userLlmKeys.model,
      createdAt: schema.userLlmKeys.createdAt,
      lastUsedAt: schema.userLlmKeys.lastUsedAt,
    })
    .from(schema.userLlmKeys)
    .where(eq(schema.userLlmKeys.userId, user.id));

  const [row] = await db
    .select({ activeLlmKeyId: schema.users.activeLlmKeyId })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);

  return c.json({ keys: rows, activeKeyId: row?.activeLlmKeyId ?? null });
});

// POST /llm-keys/models — returns the list of available models for the
// provided API key. Key is ephemeral: never persisted, never logged.
llmKeysRoute.post('/models', async (c) => {
  const parsed = ModelsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  try {
    const models = await listGeminiModels(parsed.data.apiKey);
    return c.json({ models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

llmKeysRoute.post('/', async (c) => {
  const user = c.get('user');
  const parsed = SaveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { label, apiKey, model } = parsed.data;

  // Validate the key by resolving the model list. Cheap, scoped to the
  // provider, and gives a precise error if the key is bogus or rate-limited.
  try {
    const models = await listGeminiModels(apiKey);
    if (!models.some((m) => m.id === model)) {
      return c.json(
        { error: `model "${model}" is not available for this key` },
        400,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `key rejected: ${msg}` }, 400);
  }

  const [row] = await db
    .insert(schema.userLlmKeys)
    .values({
      userId: user.id,
      label,
      provider: 'gemini',
      model,
      encryptedApiKey: encryptSecret(apiKey),
    })
    .returning({
      id: schema.userLlmKeys.id,
      label: schema.userLlmKeys.label,
      provider: schema.userLlmKeys.provider,
      model: schema.userLlmKeys.model,
      createdAt: schema.userLlmKeys.createdAt,
    });

  // Auto-activate the first saved key so naming/ticker phases start working
  // without the user having to hit a second "make active" button.
  const [u] = await db
    .select({ activeLlmKeyId: schema.users.activeLlmKeyId })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (!u?.activeLlmKeyId && row) {
    await db
      .update(schema.users)
      .set({ activeLlmKeyId: row.id })
      .where(eq(schema.users.id, user.id));
  }

  return c.json({ key: row }, 201);
});

llmKeysRoute.post('/:id/activate', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db
    .select({ id: schema.userLlmKeys.id })
    .from(schema.userLlmKeys)
    .where(
      and(
        eq(schema.userLlmKeys.id, id),
        eq(schema.userLlmKeys.userId, user.id),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);

  await db
    .update(schema.users)
    .set({ activeLlmKeyId: id })
    .where(eq(schema.users.id, user.id));
  return c.json({ activeKeyId: id });
});

llmKeysRoute.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const result = await db
    .delete(schema.userLlmKeys)
    .where(
      and(
        eq(schema.userLlmKeys.id, id),
        eq(schema.userLlmKeys.userId, user.id),
      ),
    )
    .returning({ id: schema.userLlmKeys.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);

  // If the deleted row was the active one, clear the pointer — there's no
  // implicit fallback; the user picks the next active key themselves.
  const [u] = await db
    .select({ activeLlmKeyId: schema.users.activeLlmKeyId })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (u?.activeLlmKeyId === id) {
    await db
      .update(schema.users)
      .set({ activeLlmKeyId: null })
      .where(eq(schema.users.id, user.id));
  }

  return c.body(null, 204);
});
