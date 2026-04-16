import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { requireUser } from '../middleware/auth.js';
import { jobChannel } from '../queue.js';
import type { JobProgressEvent } from '@gitcolony/schema';

export const jobsRoute = new Hono();
jobsRoute.use('*', requireUser);

// ----------------------------------------------------------------------------
// Snapshot — used as initial state before SSE stream takes over.
// ----------------------------------------------------------------------------

jobsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(schema.generationJobs)
    .where(eq(schema.generationJobs.id, id))
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  // TODO: ownership check via city -> user
  return c.json({ job: row });
});

// ----------------------------------------------------------------------------
// SSE stream — worker publishes JobProgressEvent frames to redis channel
// `job:<id>:progress`, we fan them out to the client.
//
// Each connection opens its own subscriber client since ioredis in subscribe
// mode cannot issue other commands.
// ----------------------------------------------------------------------------

jobsRoute.get('/:id/stream', (c) => {
  const id = c.req.param('id');
  const redisUrl = process.env.REDIS_URL!;
  return streamSSE(c, async (stream) => {
    // Long retry — suppress EventSource auto-reconnect after an intentional
    // close (done/failed). Otherwise the browser keeps spamming
    // ERR_INCOMPLETE_CHUNKED_ENCODING and cycling through tiny snapshots.
    const RETRY_MS = 24 * 60 * 60 * 1000;

    const sub = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    let closed = false;
    let hb: ReturnType<typeof setInterval> | null = null;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      if (hb) {
        clearInterval(hb);
        hb = null;
      }
      try {
        await sub.unsubscribe();
      } catch {}
      sub.disconnect();
    };
    stream.onAbort(cleanup);

    // Emit a snapshot frame first so the client has state if it joined late.
    const [row] = await db
      .select()
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, id))
      .limit(1);
    if (row) {
      const snapshot: JobProgressEvent = {
        jobId: id,
        phase: (row.phase as JobProgressEvent['phase']) ?? 'queued',
        progress: row.progress,
        message: row.message ?? undefined,
        error: row.error ?? undefined,
      };
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify(snapshot),
        retry: RETRY_MS,
      });
      if (row.status === 'done' || row.status === 'failed') {
        await cleanup();
        return;
      }
    }

    await sub.subscribe(jobChannel(id));
    sub.on('message', async (_ch, payload) => {
      if (closed) return;
      await stream.writeSSE({ event: 'progress', data: payload });
      try {
        const evt = JSON.parse(payload) as JobProgressEvent;
        if (evt.phase === 'done' || evt.phase === 'failed') {
          await cleanup();
          await stream.close();
        }
      } catch {}
    });

    // Keep the stream open; heartbeat prevents proxies from timing out.
    hb = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
    }, 15_000);

    // Block on close.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (closed) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  });
});
