import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { log } from '@gitcolony/log';
import { citiesRoute } from './routes/cities.js';
import { jobsRoute } from './routes/jobs.js';
import { tokensRoute } from './routes/tokens.js';
import { meRoute } from './routes/me.js';

const app = new Hono();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: [process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173'],
    credentials: true,
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

app.route('/cities', citiesRoute);
app.route('/jobs', jobsRoute);
app.route('/tokens', tokensRoute);
app.route('/me', meRoute);

app.onError((err, c) => {
  log.error('api request failed', err, {
    path: c.req.path,
    method: c.req.method,
  });
  return c.json({ error: err.message }, 500);
});

const port = Number(process.env.PORT ?? 3000);
// Bun's default `idleTimeout` is 10s, which kills our SSE progress streams
// mid-generation — the naming / ticker phases can each sit quiet for longer
// than that between state changes. We emit a 15s heartbeat (see
// routes/cities.ts and routes/jobs.ts) to keep the socket warm, so 30s
// idleTimeout gives a comfortable margin. Bun caps this at 255s.
export default {
  port,
  fetch: app.fetch,
  idleTimeout: 30,
};

log.info('api listening', { port });
