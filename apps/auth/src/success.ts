import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { encryptSecret } from '@gitcolony/crypto';
import { resolveViewer } from '@gitcolony/github';

/**
 * Invoked after GitHub hands us a successful OAuth exchange.
 *
 * Responsibilities:
 *   1. Fetch the viewer identity (login / id / avatar) using the access token.
 *   2. Upsert the row in `users`.
 *   3. Encrypt and store the OAuth access token so workers can act on behalf
 *      of the user long after the HTTP session ends (public-tab flow).
 *   4. Return the userId so the OpenAuth `success` callback can mint a JWT.
 */
export async function onGithubSuccess(accessToken: string): Promise<{
  userId: string;
  githubLogin: string;
}> {
  const viewer = await resolveViewer(accessToken);
  const encryptedOauthToken = encryptSecret(accessToken);
  const now = new Date();

  // Try to find existing user by githubId.
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.githubId, viewer.id))
    .limit(1);

  if (existing) {
    await db
      .update(schema.users)
      .set({
        githubLogin: viewer.login,
        avatarUrl: viewer.avatarUrl,
        encryptedOauthToken,
        oauthTokenUpdatedAt: now,
      })
      .where(eq(schema.users.id, existing.id));
    return { userId: existing.id, githubLogin: viewer.login };
  }

  const [inserted] = await db
    .insert(schema.users)
    .values({
      githubId: viewer.id,
      githubLogin: viewer.login,
      avatarUrl: viewer.avatarUrl,
      encryptedOauthToken,
      oauthTokenUpdatedAt: now,
    })
    .returning({ id: schema.users.id });

  if (!inserted) throw new Error('failed to create user');
  return { userId: inserted.id, githubLogin: viewer.login };
}
