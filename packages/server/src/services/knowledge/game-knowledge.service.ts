/**
 * Game Knowledge Service
 *
 * Manages game knowledge (agents, maps, weapons, mechanics) with a three-layer
 * fallback: in-memory cache → PostgreSQL → static knowledge.ts.
 *
 * The in-memory cache is warmed at startup and invalidated after each sync.
 * All read methods used during analysis are synchronous Map lookups (sub-ms).
 */

import { and, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { gameKnowledge } from '../../db/schema.js';
import { logger } from '../../shared/logger.js';
import { getStaticActiveEntries, getStaticFallback } from './static-fallback.js';
import { type MergedKnowledgeEntry, mergeEntryData } from './types.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class GameKnowledgeService {
  // Map<`${gameId}:${category}`, Map<entryKey, MergedKnowledgeEntry>>
  private cache = new Map<string, Map<string, MergedKnowledgeEntry>>();
  private cacheLoadedAt = 0;

  constructor(private db: Db) {}

  // ── Sync read methods (hot path — used during analysis) ────────────────────

  /** Get a single entry from the in-memory cache. */
  getEntrySync(gameId: string, category: string, entryKey: string): MergedKnowledgeEntry | null {
    this.checkCacheFreshness(gameId);
    const key = `${gameId}:${category}`;
    return this.cache.get(key)?.get(entryKey) ?? null;
  }

  /** Get all active display names for a category (for enum/allowlist generation). */
  getActiveDisplayNamesSync(gameId: string, category: string): string[] {
    this.checkCacheFreshness(gameId);
    const key = `${gameId}:${category}`;
    const entries = this.cache.get(key);
    if (!entries || entries.size === 0) {
      // Fallback to static if cache is empty
      return getStaticActiveEntries(gameId, category).map((e) => e.displayName);
    }
    const names: string[] = [];
    for (const entry of entries.values()) {
      if (entry.isActive) names.push(entry.displayName);
    }
    return names;
  }

  /** Get all active entry keys for a category. */
  getActiveKeysSync(gameId: string, category: string): string[] {
    this.checkCacheFreshness(gameId);
    const key = `${gameId}:${category}`;
    const entries = this.cache.get(key);
    if (!entries || entries.size === 0) {
      return getStaticActiveEntries(gameId, category).map((e) => e.entryKey);
    }
    const keys: string[] = [];
    for (const entry of entries.values()) {
      if (entry.isActive) keys.push(entry.entryKey);
    }
    return keys;
  }

  /** Get entry with full fallback chain: cache → static. */
  getEntryWithFallback(
    gameId: string,
    category: string,
    entryKey: string,
  ): MergedKnowledgeEntry | null {
    const cached = this.getEntrySync(gameId, category, entryKey);
    if (cached) return cached;
    return getStaticFallback(gameId, category, entryKey);
  }

  // ── Async write methods (called during sync) ──────────────────────────────

  /**
   * Upsert an entry from API sync.
   * Updates apiData + recomputes mergedData. Never touches coachingData.
   */
  async upsertFromApi(
    gameId: string,
    category: string,
    entryKey: string,
    apiData: Record<string, unknown>,
    displayName: string,
    apiVersion: string,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const existing = await this.db
      .select()
      .from(gameKnowledge)
      .where(
        and(
          eq(gameKnowledge.gameId, gameId),
          eq(gameKnowledge.category, category),
          eq(gameKnowledge.entryKey, entryKey),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      // New entry — no coaching overlay yet, use empty object
      const coachingData = {};
      const mergedData = mergeEntryData(category, apiData, coachingData);
      await this.db.insert(gameKnowledge).values({
        gameId,
        category,
        entryKey,
        displayName,
        apiData,
        coachingData,
        mergedData,
        source: 'api_sync',
        apiVersion,
        isActive: true,
      });
      return 'created';
    }

    const row = existing[0];
    const existingApiJson = JSON.stringify(row.apiData);
    const newApiJson = JSON.stringify(apiData);

    if (existingApiJson === newApiJson && row.isActive) {
      return 'unchanged';
    }

    // Recompute mergedData using existing coachingData + new apiData
    const coachingData = (row.coachingData ?? {}) as Record<string, unknown>;
    const mergedData = mergeEntryData(category, apiData, coachingData);

    await this.db
      .update(gameKnowledge)
      .set({
        apiData,
        mergedData,
        displayName,
        source: 'api_sync',
        apiVersion,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(gameKnowledge.id, row.id));

    return 'updated';
  }

  /**
   * Upsert a coaching overlay.
   * Updates coachingData + recomputes mergedData. Never touches apiData.
   */
  async upsertCoachingOverlay(
    gameId: string,
    category: string,
    entryKey: string,
    coachingData: Record<string, unknown>,
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(gameKnowledge)
      .where(
        and(
          eq(gameKnowledge.gameId, gameId),
          eq(gameKnowledge.category, category),
          eq(gameKnowledge.entryKey, entryKey),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      const mergedData = mergeEntryData(category, null, coachingData);
      await this.db.insert(gameKnowledge).values({
        gameId,
        category,
        entryKey,
        displayName: entryKey,
        apiData: null,
        coachingData,
        mergedData,
        source: 'manual',
        isActive: true,
      });
      return;
    }

    const row = existing[0];
    const apiData = (row.apiData ?? null) as Record<string, unknown> | null;
    const mergedData = mergeEntryData(category, apiData, coachingData);

    await this.db
      .update(gameKnowledge)
      .set({
        coachingData,
        mergedData,
        source: 'manual',
        updatedAt: new Date(),
      })
      .where(eq(gameKnowledge.id, row.id));
  }

  /**
   * Soft-delete entries no longer present in the API response.
   * Returns the number of entries deactivated.
   */
  async deactivateStale(gameId: string, category: string, activeKeys: string[]): Promise<number> {
    if (activeKeys.length === 0) return 0;

    const result = await this.db
      .update(gameKnowledge)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(gameKnowledge.gameId, gameId),
          eq(gameKnowledge.category, category),
          eq(gameKnowledge.isActive, true),
          notInArray(gameKnowledge.entryKey, activeKeys),
        ),
      );

    return (result as any).rowCount ?? 0;
  }

  // ── Cache management ──────────────────────────────────────────────────────

  /** Load all entries for a game into memory. */
  async warmCache(gameId: string): Promise<void> {
    const rows = await this.db.select().from(gameKnowledge).where(eq(gameKnowledge.gameId, gameId));

    // Clear all categories for this game
    for (const [key] of this.cache) {
      if (key.startsWith(`${gameId}:`)) {
        this.cache.delete(key);
      }
    }

    for (const row of rows) {
      const cacheKey = `${row.gameId}:${row.category}`;
      if (!this.cache.has(cacheKey)) {
        this.cache.set(cacheKey, new Map());
      }
      this.cache.get(cacheKey)!.set(row.entryKey, {
        gameId: row.gameId,
        category: row.category,
        entryKey: row.entryKey,
        displayName: row.displayName,
        mergedData: (row.mergedData ?? {}) as Record<string, unknown>,
        source: row.source,
        apiVersion: row.apiVersion,
        isActive: row.isActive,
        updatedAt: row.updatedAt,
      });
    }

    this.cacheLoadedAt = Date.now();
    logger.info({ gameId, entries: rows.length }, 'Knowledge cache warmed');
  }

  /** Invalidate cache for a game (forces reload on next warmCache). */
  invalidateCache(gameId: string): void {
    for (const [key] of this.cache) {
      if (key.startsWith(`${gameId}:`)) {
        this.cache.delete(key);
      }
    }
    this.cacheLoadedAt = 0;
  }

  /** Check if cache is populated. If not, reads are empty (fallback to static). */
  isCacheWarmed(): boolean {
    return this.cacheLoadedAt > 0;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private checkCacheFreshness(_gameId: string): void {
    if (this.cacheLoadedAt > 0 && Date.now() - this.cacheLoadedAt > CACHE_TTL_MS) {
      // Cache is stale — mark as invalidated so next warmCache refreshes
      // We don't block here; stale data is better than no data
      logger.debug('Knowledge cache TTL expired, will refresh on next warm');
    }
  }
}
