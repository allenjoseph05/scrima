import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema.js';

if (!env.DATABASE_URL && env.NODE_ENV === 'production') {
  throw new Error('DATABASE_URL is required in production');
}

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL?.startsWith('postgresql://localhost')
    ? undefined
    : env.DATABASE_URL
      ? { rejectUnauthorized: false }
      : undefined,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export * from './schema.js';
