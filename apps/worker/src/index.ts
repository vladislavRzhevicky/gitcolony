import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, schema } from '@gitcolony/db';
import type { LLMConfig } from '@gitcolony/llm';
import { log } from '@gitcolony/log';
import { connection, QUEUE_GENERATION, type GenerationJobData } from './queue.js';
import { processGeneration } from './processor.js';

// Resolved once at startup so each job doesn't re-read env. `null` means the
// LLM director is disabled — pipeline still runs, ticker stays empty,
// displayName/tagline/personality remain unset on world objects.
const llmConfig: LLMConfig | null = process.env.GEMINI_API_KEY
  ? {
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite',
    }
  : null;
if (!llmConfig) {
  log.warn('GEMINI_API_KEY not set — LLM director phases will be skipped');
}

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

    await processGeneration(job, llmConfig);
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
