import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { verifyAccessToken } from '@gitcolony/auth/verify';

export interface AuthUser {
  id: string;
  githubLogin: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

/**
 * Bearer-token auth via OpenAuth.
 *
 * Dev-mode escape hatch: when NODE_ENV !== 'production' and the request
 * carries `x-dev-user-id`, we skip JWT verification and look up the user
 * directly. Handy for curl-driving the pipeline before the web app exists.
 * Never exposed in production — the NODE_ENV check is the gate.
 */
export const requireUser: MiddlewareHandler = async (c, next) => {
  if (process.env.NODE_ENV !== 'production') {
    const devUserId = c.req.header('x-dev-user-id');
    if (devUserId) {
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, devUserId))
        .limit(1);
      if (!row) return c.json({ error: 'dev user not found' }, 401);
      c.set('user', { id: row.id, githubLogin: row.githubLogin });
      return next();
    }
  }

  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const token = header.slice(7);

  const subject = await verifyAccessToken(token);
  if (!subject) return c.json({ error: 'invalid or expired token' }, 401);

  c.set('user', {
    id: subject.userId,
    githubLogin: subject.githubLogin,
  });
  return next();
};
