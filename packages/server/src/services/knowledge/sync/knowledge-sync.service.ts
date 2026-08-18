/**
 * Knowledge Sync Service
 *
 * Game-agnostic orchestrator. Each game registers a sync adapter.
 * On sync: version check → fetch → diff → upsert → deactivate stale → log.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../../db/index.js';
import { knowledgeSyncLog } from '../../../db/schema.js';
import { logger } from '../../../shared/logger.js';
import type { GameKnowledgeService } from '../game-knowledge.service.js';
import type { SyncResult } from '../types.js';
import type { KnowledgeSyncAdapter } from './sync-adapter.interface.js';

type SyncType = 'scheduled' | 'startup' | 'manual' | 'live_fetch';

export class KnowledgeSyncService {
  private adapters = new Map<string, KnowledgeSyncAdapter>();

  constructor(
    private knowledgeService: GameKnowledgeService,
    private db: Db,
  ) {}

  registerAdapter(adapter: KnowledgeSyncAdapter): void {
    this.adapters.set(adapter.gameId, adapter);
  }

  getAdapter(gameId: string): KnowledgeSyncAdapter | undefined {
    return this.adapters.get(gameId);
  }

  /** Sync all registered games. */
  async syncAll(syncType: SyncType): Promise<Map<string, SyncResult>> {
    const results = new Map<string, SyncResult>();
    for (const [gameId, _adapter] of this.adapters) {
      try {
        const result = await this.syncGame(gameId, syncType);
        results.set(gameId, result);
      } catch (err) {
        logger.error(
          { gameId, err: err instanceof Error ? err.message : err },
          'Sync failed for game',
        );
        results.set(gameId, {
          status: 'failed',
          apiVersion: null,
          added: 0,
          updated: 0,
          removed: 0,
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        });
      }
    }
    return results;
  }

  /** Sync a single game. */
  async syncGame(gameId: string, syncType: SyncType): Promise<SyncResult> {
    const start = Date.now();
    const adapter = this.adapters.get(gameId);
    if (!adapter) {
      throw new Error(`No sync adapter registered for game: ${gameId}`);
    }

    // ── 1. Version check ─────────────────────────────────────────────────────
    const currentVersion = await adapter.fetchVersion();

    if (currentVersion) {
      const lastSync = await this.db
        .select({ apiVersion: knowledgeSyncLog.apiVersion })
        .from(knowledgeSyncLog)
        .where(and(eq(knowledgeSyncLog.gameId, gameId), eq(knowledgeSyncLog.status, 'success')))
        .orderBy(desc(knowledgeSyncLog.createdAt))
        .limit(1);

      if (lastSync.length > 0 && lastSync[0].apiVersion === currentVersion) {
        const result: SyncResult = {
          status: 'no_changes',
          apiVersion: currentVersion,
          added: 0,
          updated: 0,
          removed: 0,
          durationMs: Date.now() - start,
        };

        await this.logSync(gameId, syncType, result);
        logger.info(
          { gameId, version: currentVersion },
          'Knowledge sync: no changes (same version)',
        );
        return result;
      }
    }

    // ── 2. Fetch all categories ──────────────────────────────────────────────
    let totalAdded = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    const errors: string[] = [];

    // Agents
    try {
      const agents = await adapter.fetchAgents();
      const agentKeys: string[] = [];
      for (const entry of agents) {
        agentKeys.push(entry.entryKey);
        const result = await this.knowledgeService.upsertFromApi(
          gameId,
          'agent',
          entry.entryKey,
          entry.apiData,
          entry.displayName,
          currentVersion ?? '',
        );
        if (result === 'created') totalAdded++;
        else if (result === 'updated') totalUpdated++;
      }
      totalRemoved += await this.knowledgeService.deactivateStale(gameId, 'agent', agentKeys);
    } catch (err) {
      errors.push(`agents: ${err instanceof Error ? err.message : err}`);
      logger.warn(
        { gameId, err: err instanceof Error ? err.message : err },
        'Failed to sync agents',
      );
    }

    // Maps
    try {
      const maps = await adapter.fetchMaps();
      const mapKeys: string[] = [];
      for (const entry of maps) {
        mapKeys.push(entry.entryKey);
        const result = await this.knowledgeService.upsertFromApi(
          gameId,
          'map',
          entry.entryKey,
          entry.apiData,
          entry.displayName,
          currentVersion ?? '',
        );
        if (result === 'created') totalAdded++;
        else if (result === 'updated') totalUpdated++;
      }
      totalRemoved += await this.knowledgeService.deactivateStale(gameId, 'map', mapKeys);
    } catch (err) {
      errors.push(`maps: ${err instanceof Error ? err.message : err}`);
      logger.warn({ gameId, err: err instanceof Error ? err.message : err }, 'Failed to sync maps');
    }

    // Weapons
    try {
      const weapons = await adapter.fetchWeapons();
      const weaponKeys: string[] = [];
      for (const entry of weapons) {
        weaponKeys.push(entry.entryKey);
        const result = await this.knowledgeService.upsertFromApi(
          gameId,
          'weapon',
          entry.entryKey,
          entry.apiData,
          entry.displayName,
          currentVersion ?? '',
        );
        if (result === 'created') totalAdded++;
        else if (result === 'updated') totalUpdated++;
      }
      totalRemoved += await this.knowledgeService.deactivateStale(gameId, 'weapon', weaponKeys);
    } catch (err) {
      errors.push(`weapons: ${err instanceof Error ? err.message : err}`);
      logger.warn(
        { gameId, err: err instanceof Error ? err.message : err },
        'Failed to sync weapons',
      );
    }

    // ── 3. Refresh cache ─────────────────────────────────────────────────────
    this.knowledgeService.invalidateCache(gameId);
    await this.knowledgeService.warmCache(gameId);

    // ── 4. Log result ────────────────────────────────────────────────────────
    const status =
      errors.length > 0 ? (totalAdded + totalUpdated > 0 ? 'partial' : 'failed') : 'success';

    const result: SyncResult = {
      status,
      apiVersion: currentVersion,
      added: totalAdded,
      updated: totalUpdated,
      removed: totalRemoved,
      error: errors.length > 0 ? errors.join('; ') : undefined,
      durationMs: Date.now() - start,
    };

    await this.logSync(gameId, syncType, result);

    logger.info(
      {
        gameId,
        status,
        version: currentVersion,
        added: totalAdded,
        updated: totalUpdated,
        removed: totalRemoved,
        durationMs: result.durationMs,
      },
      'Knowledge sync completed',
    );

    return result;
  }

  private async logSync(gameId: string, syncType: SyncType, result: SyncResult): Promise<void> {
    try {
      await this.db.insert(knowledgeSyncLog).values({
        gameId,
        syncType,
        status: result.status,
        apiVersion: result.apiVersion,
        entriesAdded: result.added,
        entriesUpdated: result.updated,
        entriesRemoved: result.removed,
        errorMsg: result.error ?? null,
        durationMs: result.durationMs,
      });
    } catch (err) {
      logger.error(
        { gameId, err: err instanceof Error ? err.message : err },
        'Failed to log sync result',
      );
    }
  }
}
