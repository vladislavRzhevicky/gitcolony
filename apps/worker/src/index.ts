import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import { log } from '@gitcolony/log';
import { connection, QUEUE_GENERATION, type GenerationJobData } from './queue.js';
import { processGeneration } from './processor.js';

// LLM config is resolved per-job from the owning user's active key in the
// DB (see processor.resolveLlmConfig). The worker itself holds no
// LLM-related state, so credentials can be rotated through the UI without
// restarting the process.

const worker = new Worker<GenerationJobData>(
  QUEUE_GENERATION,
  async (job) => {
    // Ensure a matching row exists in generation_jobs for SSE subscribers.
    // BullMQ job.id is its own; we mirror it into our table.
    const jobId = job.id!;
    await db
      .insert(schema.generationJobs)
      .values({ id: jobId, cityId: job.data.cityId, status: 'running' })
      .onConflictDoNothing();
    await db
      .update(schema.generationJobs)
      .set({ status: 'running' })
      .where(eq(schema.generationJobs.id, jobId));

    await processGeneration(job);
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  },
);

worker.on('ready', () => log.info('worker ready'));
worker.on('failed', (job, err) => {
  log.error('worker job failed', err, { jobId: job?.id });
});

process.on('SIGTERM', async () => {
  log.info('worker shutting down');
  await worker.close();
  process.exit(0);
});
