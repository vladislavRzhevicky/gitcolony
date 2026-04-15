import { issuer } from '@openauthjs/openauth';
import { GithubProvider } from '@openauthjs/openauth/provider/github';
import { subjects } from '@gitcolony/auth/subjects';
import { log } from '@gitcolony/log';
import { redisStorage } from './storage.js';
import { onGithubSuccess } from './success.js';

const clientID = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;
if (!clientID || !clientSecret) {
  throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set');
}

const app = issuer({
  subjects,
  storage: redisStorage(),
  // Only GitHub. No email/password, no magic link, no other providers.
  // If someone wants to sign in, it's through GitHub or not at all.
  providers: {
    github: GithubProvider({
      clientID,
      clientSecret,
      // read:user → viewer.login/id/avatar.
      // repo       → list & ingest private repos via OAuth (no PAT needed).
      //
      // The `repo` scope is broad — GitHub doesn't offer a "private read-only"
      // OAuth scope, only the full repo scope or a fine-grained PAT. We accept
      // that tradeoff so the picker can show every repo the user owns. The
      // app itself never writes (no push, no issue creation, no PR), and the
      // login screen states this honestly.
      //
      // Bumping this invalidates existing sessions: GitHub re-prompts for
      // consent the next time a user logs in, and the new token carries the
      // wider scope. Previously-stored tokens (read:user only) keep working
      // for already-logged-in users until they next sign in, but they won't
      // see private repos in /me/repos until they re-login.
      scopes: ['read:user', 'repo'],
    }),
  },
  // Invoked after a provider hands us a verified identity. Must return a
  // subject that OpenAuth will sign into a JWT.
  success: async (ctx, value) => {
    if (value.provider !== 'github') {
      throw new Error(`unsupported provider: ${value.provider}`);
    }
    const { userId, githubLogin } = await onGithubSuccess(value.tokenset.access);
    return ctx.subject('user', { userId, githubLogin });
  },
});

const port = Number(process.env.AUTH_PORT ?? 3001);
const server: { port: number; fetch: (req: Request) => Response | Promise<Response> } = {
  port,
  fetch: app.fetch,
};
export default server;

log.info('auth issuer listening', { port });
