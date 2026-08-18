/**
 * Two-level coaching response cache
 *
 * Hot tier:  Redis    — 24 h TTL, sub-ms reads
 * Cold tier: Postgres — 30 d TTL, survives Redis restarts
 *
 * Cache keys are built from stable game context signals so
 * similar deaths across different users share the same cached analysis.
 */

import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { coachingCache } from '../../db/schema.js';
import { getRedis } from '../../lib/redis.js';

const REDIS_TTL_S = 60 * 60 * 24; // 24 hours
const PG_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class CoachingCacheService {
  constructor(private db: Db) {}

  /**
   * Build a deterministic cache key from the signals that matter for analysis.
   * We don't include userId — caches are shared across users for the same scenario.
   */
  buildCacheKey(params: {
    game: string;
    rankBracket: string; // e.g. "iron-bronze", "gold-plat", "diamond+"
    agent: string;
    map: string;
    weapon: string;
    headshot: boolean;
  }): string {
    const parts = [
      params.game,
      params.rankBracket,
      params.agent,
      params.map,
      params.weapon,
      params.headshot ? 'hs' : 'body',
    ].map((s) => s.toLowerCase().replace(/\s+/g, '_'));
    return `t2:${parts.join(':')}`;
  }

  async get(key: string): Promise<unknown | null> {
    // 1. Try Redis hot cache
    try {
      const redis = getRedis();
      const raw = redis ? await redis.get(key) : null;
      if (raw) return JSON.parse(raw);
    } catch {
      // Redis miss or error — fall through to Postgres
    }

    // 2. Try Postgres cold cache
    try {
      const row = await this.db.query.coachingCache.findFirst({
        where: and(eq(coachingCache.cacheKey, key), gt(coachingCache.expiresAt, new Date())),
      });
      if (!row) return null;

      // Backfill Redis so next hit is hot
      try {
        const redis = getRedis();
        if (redis) await redis.setex(key, REDIS_TTL_S, JSON.stringify(row.response));
      } catch {
        /* best-effort */
      }

      // Bump hit count async — don't await
      this.db
        .update(coachingCache)
        .set({ hitCount: row.hitCount + 1 })
        .where(eq(coachingCache.id, row.id))
        .catch(() => {});

      return row.response;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);

    // Write Redis
    try {
      const redis = getRedis();
      if (redis) await redis.setex(key, REDIS_TTL_S, json);
    } catch {
      /* best-effort */
    }

    // Write Postgres (upsert)
    const expiresAt = new Date(Date.now() + PG_TTL_MS);
    try {
      await this.db
        .insert(coachingCache)
        .values({ cacheKey: key, response: value as any, expiresAt })
        .onConflictDoUpdate({
          target: coachingCache.cacheKey,
          set: { response: value as any, expiresAt, hitCount: 0 },
        });
    } catch {
      /* best-effort */
    }
  }
}
