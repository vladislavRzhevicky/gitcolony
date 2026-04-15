import IORedis from 'ioredis';
import type { StorageAdapter } from '@openauthjs/openauth/storage/storage';

/**
 * Redis-backed storage for OpenAuth's short-lived OAuth state (codes, pkce
 * challenges, in-flight authorization requests). Values are small and
 * typically TTL'd in seconds to minutes, so Redis is a natural fit.
 *
 * We keep a dedicated ioredis client here — mixing this with the BullMQ
 * connection would be fine, but keeping it separate matches the rest of the
 * repo's "one purpose per connection" discipline.
 */
export function redisStorage(): StorageAdapter {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  const redis = new IORedis(url);

  const keyOf = (key: string[]) => `openauth:${key.join(':')}`;

  return {
    async get(key) {
      const raw = await redis.get(keyOf(key));
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    },
    async set(key, value, expiry) {
      const k = keyOf(key);
      const v = JSON.stringify(value);
      const ttl = expiry
        ? Math.max(1, Math.ceil((expiry.getTime() - Date.now()) / 1000))
        : 0;
      if (ttl > 0) await redis.setex(k, ttl, v);
      else await redis.set(k, v);
    },
    async remove(key) {
      await redis.del(keyOf(key));
    },
    async *scan(prefix) {
      const pattern = `${keyOf(prefix)}*`;
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const batch of stream) {
        for (const full of batch as string[]) {
          const raw = await redis.get(full);
          if (!raw) continue;
          const stripped = full.replace(/^openauth:/, '').split(':');
          yield [stripped, JSON.parse(raw) as Record<string, unknown>];
        }
      }
    },
  };
}
