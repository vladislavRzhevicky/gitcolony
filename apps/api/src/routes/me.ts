import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { decryptSecret } from '@gitcolony/crypto';
import { listAccessibleRepos } from '@gitcolony/github';
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

meRoute.get('/repos', async (c) => {
  const user = c.get('user');
  const token = await resolveOauthToken(user.id);
  if (!token) {
    return c.json(
      { error: 'no OAuth token on file — please re-login via GitHub' },
      401,
    );
  }

  let repos;
  try {
    repos = await listAccessibleRepos(token, {
      affiliations: ['OWNER'],
      // Two pages is enough to cover ~99% of accounts; keeps the dialog
      // snappy and bounds the GraphQL bill.
      limit: 200,
    });
  } catch (err) {
    log.error('listAccessibleRepos failed', err, { userId: user.id });
    return c.json({ error: 'github request failed' }, 502);
  }

  // Join existing cities so the UI shows Open vs. Generate without a
  // second roundtrip. One query, indexed by repoFullName per user.
  const existing = await db
    .select({
      repoFullName: schema.cities.repoFullName,
      slug: schema.cities.slug,
    })
    .from(schema.cities)
    .where(eq(schema.cities.userId, user.id));
  const slugByRepo = new Map(existing.map((r) => [r.repoFullName, r.slug]));

  const owned: OwnedRepo[] = repos.map((r) => ({
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

  // Browser-side cache for a minute — repo lists barely move and the dialog
  // is opened repeatedly. Private so a shared proxy can't bleed lists.
  c.header('cache-control', 'private, max-age=60');
  return c.json({
    repos: owned,
    viewerLogin: user.githubLogin,
    fetchedAt: new Date().toISOString(),
  });
});
