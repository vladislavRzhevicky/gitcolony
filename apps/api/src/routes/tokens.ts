import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { requireUser } from '../middleware/auth.js';
import { resolveViewer } from '@gitcolony/github';
import { encryptSecret } from '@gitcolony/crypto';

export const tokensRoute = new Hono();
tokensRoute.use('*', requireUser);

const AddTokenBody = z.object({
  label: z.string().min(1).max(80),
  pat: z.string().min(20),
});

tokensRoute.get('/', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select({
      id: schema.userTokens.id,
      label: schema.userTokens.label,
      ownerLogin: schema.userTokens.ownerLogin,
      scopes: schema.userTokens.scopes,
      createdAt: schema.userTokens.createdAt,
      lastUsedAt: schema.userTokens.lastUsedAt,
    })
    .from(schema.userTokens)
    .where(eq(schema.userTokens.userId, user.id));
  return c.json({ tokens: rows });
});

tokensRoute.post('/', async (c) => {
  const user = c.get('user');
  const parsed = AddTokenBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { label, pat } = parsed.data;

  // Validate: talk to GitHub to confirm the token works and resolve owner login.
  let viewer;
  try {
    viewer = await resolveViewer(pat);
  } catch {
    return c.json({ error: 'token rejected by GitHub' }, 400);
  }

  const [row] = await db
    .insert(schema.userTokens)
    .values({
      userId: user.id,
      label,
      encryptedPat: encryptSecret(pat),
      ownerLogin: viewer.login,
      // Scope discovery requires a REST call; defer to post-MVP.
      scopes: [],
    })
    .returning({
      id: schema.userTokens.id,
      label: schema.userTokens.label,
      ownerLogin: schema.userTokens.ownerLogin,
    });

  return c.json({ token: row }, 201);
});

tokensRoute.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const result = await db
    .delete(schema.userTokens)
    .where(and(eq(schema.userTokens.id, id), eq(schema.userTokens.userId, user.id)))
    .returning({ id: schema.userTokens.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.body(null, 204);
});
