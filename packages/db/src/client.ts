import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const queryClient = postgres(url, {
  max: 10,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
});

export const db = drizzle(queryClient, { schema, logger: false });
export type DB = typeof db;
export { schema };
