import { createSubjects } from '@openauthjs/openauth/subject';
import { z } from 'zod';

/**
 * Single source of truth for the JWT payload shape.
 *
 * Consumed by:
 *   - apps/auth  — issues tokens with this subject on successful GitHub login
 *   - apps/api   — verifies incoming tokens against this schema
 *
 * Keep lean. Anything that can be re-fetched from DB on demand (avatar, email,
 * OAuth access token) stays out of the JWT — smaller tokens, and we avoid
 * re-issuing just because a user changed their avatar.
 */
export const subjects = createSubjects({
  user: z.object({
    userId: z.string().uuid(),
    githubLogin: z.string(),
  }),
});

export type UserSubject = z.infer<(typeof subjects)['user']>;
