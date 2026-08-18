/**
 * Unknown Agent/Map Handler
 *
 * When pre-screen detects an agent or map not in the knowledge store,
 * this handler attempts a live API fetch to discover it.
 * Falls back to static knowledge.ts if the API is also unavailable.
 */

import { logger } from '../../shared/logger.js';
import type { GameKnowledgeService } from './game-knowledge.service.js';
import { getStaticFallback } from './static-fallback.js';
import type { KnowledgeSyncAdapter } from './sync/sync-adapter.interface.js';
import type { MergedKnowledgeEntry, TransformedEntry } from './types.js';

/**
 * Try to resolve an unknown entity through the fallback chain:
 * 1. Live API fetch → store in DB → return
 * 2. Static fallback → return
 * 3. null → generic coaching
 */
export async function handleUnknownEntity(
  gameId: string,
  category: string,
  entryKey: string,
  knowledgeService: GameKnowledgeService,
  adapter: KnowledgeSyncAdapter,
): Promise<MergedKnowledgeEntry | null> {
  // Level 2: Live API fetch
  try {
    let entries: TransformedEntry[];
    if (category === 'agent') {
      entries = await adapter.fetchAgents();
    } else if (category === 'map') {
      entries = await adapter.fetchMaps();
    } else if (category === 'weapon') {
      entries = await adapter.fetchWeapons();
    } else {
      return getStaticFallback(gameId, category, entryKey);
    }

    const match = entries.find(
      (e) => e.entryKey === entryKey || e.displayName.toLowerCase() === entryKey.toLowerCase(),
    );

    if (match) {
      await knowledgeService.upsertFromApi(
        gameId,
        category,
        match.entryKey,
        match.apiData,
        match.displayName,
        'live_fetch',
      );
      // Invalidate + warm so the new entry is in the cache
      knowledgeService.invalidateCache(gameId);
      await knowledgeService.warmCache(gameId);

      logger.info(
        { gameId, category, entryKey: match.entryKey },
        'Discovered new %s via live API fetch',
        category,
      );

      return knowledgeService.getEntrySync(gameId, category, match.entryKey);
    }

    logger.info({ gameId, category, entryKey }, 'Entity not found in live API either');
  } catch (err) {
    logger.warn(
      { gameId, category, entryKey, err: err instanceof Error ? err.message : err },
      'Live API fetch failed for unknown %s',
      category,
    );
  }

  // Level 3: Static fallback
  return getStaticFallback(gameId, category, entryKey);
}
