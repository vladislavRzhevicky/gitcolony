import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { db, schema } from '@gitcolony/db';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');

// BullMQ requires maxRetriesPerRequest: null on its connections.
export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

// Shared pub/sub connection used for SSE fan-out. Separate from the BullMQ one
// because ioredis clients in subscribe mode cannot issue other commands.
export const pubsub = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const QUEUE_GENERATION = 'generation';

export interface GenerationJobData {
  cityId: string;
  mode: 'initial' | 'resync' | 'regenerate';
}

export const generationQueue = new Queue<GenerationJobData>(QUEUE_GENERATION, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 4000 },
    removeOnComplete: { age: 60 * 60 * 24 }, // keep 1 day for SSE replay
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

// Redis channel where the worker publishes JobProgressEvent frames.
export function jobChannel(jobId: string) {
  return `job:${jobId}:progress`;
}

// ============================================================================
// Job enqueue helper.
//
// BullMQ defaults to sequential numeric job ids ("1", "2", …). Our
// `generation_jobs.id` column in Postgres is a uuid, so we force BullMQ to
// use a uuid here — the worker then mirrors that same id into the DB row
// and the SSE channel name. Centralized so every enqueue site gets it.
// ============================================================================

export type GenerationMode = GenerationJobData['mode'];

export async function enqueueGeneration(cityId: string, mode: GenerationMode) {
  const jobId = crypto.randomUUID();
  // Insert the DB row up-front so an SSE subscriber that connects between the
  // enqueue and the worker's pickup doesn't see the previous job and close
  // the stream. The worker's insert is onConflictDoNothing, so this is safe.
  await db
    .insert(schema.generationJobs)
    .values({ id: jobId, cityId, status: 'queued', phase: 'queued', progress: 0 });
  return generationQueue.add(mode, { cityId, mode }, { jobId });
}
