import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@gitcolony/db';
import { decryptSecret } from '@gitcolony/crypto';
import {
  listAccessibleRepos,
  listReposViaRest,
  type RepoAffiliation,
} from '@gitcolony/github';
import { type OwnedRepo } from '@gitcolony/schema';
import { log } from '@gitcolony/log';
import { requireUser } from '../middleware/auth.js';

// ============================================================================
// /me — endpoints scoped to the authenticated user.
//
// `GET /me/repos` powers the "Generate a colony" picker. We use the stored
// OAuth token (read:user scope) to pull the viewer's owned repos via GraphQL,
// then left-join existing colonies so the dialog can render Open vs.
// Generate without a second roundtrip. Forks/archived repos come through
// flagged so the UI can hide them by default.
//
// Ownership invariant: we ask GitHub for `affiliations: [OWNER]` only, so
// every returned repo already satisfies the same check that POST /cities
// re-enforces. The UI can trust the list end-to-end.
// ============================================================================

export const meRoute = new Hono();
meRoute.use('*', requireUser);

async function resolveOauthToken(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ encryptedOauthToken: schema.users.encryptedOauthToken })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row?.encryptedOauthToken) return null;
  return decryptSecret(row.encryptedOauthToken);
}

async function buildRepoList(
  userId: string,
  token: string,
  affiliations: RepoAffiliation[],
  source: 'oauth' | 'pat' = 'oauth',
): Promise<OwnedRepo[]> {
  // PAT flows go through REST: GitHub's GraphQL `viewer.repositories`
  // silently omits org-owned repos for fine-grained PATs even with org
  // approval. REST `/user/repos` returns them correctly.
  // OAuth flows stay on GraphQL — the OAuth token isn't subject to the
  // fine-grained limitation and GraphQL is cheaper.
  const repos =
    source === 'pat'
      ? await listReposViaRest(token, { limit: 200 })
      : await listAccessibleRepos(token, { affiliations, limit: 200 });

  // Join existing cities so the UI shows Open vs. Generate without a
  // second roundtrip. Scoped by userId so a PAT-loaded list still shows
  // this user's colonies (even when the PAT points at org repos).
  const existing = await db
    .select({
      repoFullName: schema.cities.repoFullName,
      slug: schema.cities.slug,
    })
    .from(schema.cities)
    .where(eq(schema.cities.userId, userId));
  const slugByRepo = new Map(existing.map((r) => [r.repoFullName, r.slug]));

  return repos.map((r) => ({
    fullName: r.fullName,
    name: r.name,
    owner: r.owner,
    isPrivate: r.isPrivate,
    isFork: r.isFork,
    isArchived: r.isArchived,
    defaultBranch: r.defaultBranch,
    description: r.description,
    pushedAt: r.pushedAt,
    stargazerCount: r.stargazerCount,
    primaryLanguage: r.primaryLanguage,
    existingSlug: slugByRepo.get(r.fullName) ?? null,
  }));
}

meRoute.get('/repos', async (c) => {
  const user = c.get('user');
  const token = await resolveOauthToken(user.id);
  if (!token) {
    return c.json(
      { error: 'no OAuth token on file — please re-login via GitHub' },
      401,
    );
  }

  let owned: OwnedRepo[];
  try {
    owned = await buildRepoList(user.id, token, ['OWNER']);
  } catch (err) {
    log.error('listAccessibleRepos failed', err, { userId: user.id });
    return c.json({ error: 'github request failed' }, 502);
  }

  // Browser-side cache for a minute — repo lists barely move and the dialog
  // is opened repeatedly. Private so a shared proxy can't bleed lists.
  c.header('cache-control', 'private, max-age=60');
  return c.json({
    repos: owned,
    viewerLogin: user.githubLogin,
    fetchedAt: new Date().toISOString(),
  });
});

// POST /me/repos — list repos accessible via a caller-supplied PAT. Used by
// the Advanced section of the "Generate a colony" dialog so users can pick
// from the repos their fine-grained token can see (incl. org repos that the
// OAuth app isn't authorised for). Token is ephemeral: never persisted, not
// echoed in logs, not cached. Affiliations broaden to OWNER +
// ORGANIZATION_MEMBER + COLLABORATOR so a PAT scoped to an org repo
// surfaces it here even though the session OAuth wouldn't.
// Accepts either `{ pat }` (ephemeral inline token) or `{ tokenId }` (one of
// the user's saved `user_tokens`). Exactly one must be present — the api
// resolves tokenId to a decrypted PAT server-side so the browser never
// touches stored secrets.
const listBySecretSchema = z.union([
  z.object({ pat: z.string().min(20) }),
  z.object({ tokenId: z.string().uuid() }),
]);

meRoute.post('/repos', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  const parsed = listBySecretSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body: expected { pat } or { tokenId }' }, 400);
  }

  let pat: string;
  let usedTokenId: string | null = null;
  if ('pat' in parsed.data) {
    pat = parsed.data.pat;
  } else {
    const [row] = await db
      .select({ encryptedPat: schema.userTokens.encryptedPat })
      .from(schema.userTokens)
      .where(
        and(
          eq(schema.userTokens.id, parsed.data.tokenId),
          eq(schema.userTokens.userId, user.id),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'token not found' }, 404);
    pat = decryptSecret(row.encryptedPat);
    usedTokenId = parsed.data.tokenId;
  }

  let owned: OwnedRepo[];
  try {
    owned = await buildRepoList(
      user.id,
      pat,
      ['OWNER', 'ORGANIZATION_MEMBER', 'COLLABORATOR'],
      'pat',
    );
    log.info('listAccessibleRepos via PAT', {
      userId: user.id,
      tokenId: usedTokenId,
      count: owned.length,
      sampleOwners: Array.from(new Set(owned.map((r) => r.owner))).slice(0, 10),
    });
  } catch (err) {
    log.warn('listAccessibleRepos via PAT failed', {
      userId: user.id,
      tokenId: usedTokenId,
      message: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'token rejected by GitHub — check permissions',
      },
      502,
    );
  }

  if (usedTokenId) {
    await db
      .update(schema.userTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.userTokens.id, usedTokenId));
  }

  return c.json({
    repos: owned,
    viewerLogin: user.githubLogin,
    fetchedAt: new Date().toISOString(),
  });
});
