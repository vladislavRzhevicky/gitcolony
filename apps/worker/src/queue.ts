import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');

export const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
export const publisher = new IORedis(redisUrl, { maxRetriesPerRequest: null });

export const QUEUE_GENERATION = 'generation';

export interface GenerationJobData {
  cityId: string;
  mode: 'initial' | 'resync' | 'regenerate';
}

export function jobChannel(jobId: string) {
  return `job:${jobId}:progress`;
}
