/**
 * Knowledge Store Seed
 *
 * Idempotent — populates game_knowledge from static knowledge.ts on first run.
 * Subsequent calls skip if rows already exist.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { gameKnowledge } from '../../db/schema.js';
import {
  AGENTS,
  COACHABLE_MODES,
  DM_MECHANICS,
  MAP_CALLOUTS,
  UNSUPPORTED_MODE_MESSAGES,
  VALID_MAPS,
  VALID_WEAPONS,
  VALORANT_ECONOMY,
  VALORANT_MECHANICS,
  VALORANT_ROUND,
} from '../../games/valorant/knowledge.js';
import { logger } from '../../shared/logger.js';

function agentDisplayName(key: string): string {
  if (key === 'kay/o') return 'KAY/O';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export async function seedKnowledgeFromStatic(db: Db): Promise<void> {
  // Check if already seeded
  const existing = await db.select({ count: sql<number>`count(*)::int` }).from(gameKnowledge);

  if (Number(existing[0].count) > 0) {
    logger.debug('Knowledge store already seeded, skipping');
    return;
  }

  logger.info('Seeding knowledge store from static knowledge.ts...');

  const rows: Array<{
    gameId: string;
    category: string;
    entryKey: string;
    displayName: string;
    apiData: Record<string, unknown> | null;
    coachingData: Record<string, unknown>;
    mergedData: Record<string, unknown>;
    source: string;
  }> = [];

  // ── Agents ─────────────────────────────────────────────────────────────────
  for (const [key, info] of Object.entries(AGENTS)) {
    const coachingData = {
      role: info.role,
      expectation: info.expectation,
      abilities: info.abilities,
      flags: info.flags,
    };
    rows.push({
      gameId: 'valorant',
      category: 'agent',
      entryKey: key,
      displayName: agentDisplayName(key),
      apiData: null,
      coachingData,
      mergedData: coachingData, // No API data yet — merged = coaching
      source: 'static',
    });
  }

  // ── Maps ───────────────────────────────────────────────────────────────────
  for (const mapName of VALID_MAPS) {
    const key = mapName.toLowerCase();
    const callouts = MAP_CALLOUTS[key] ?? '';
    const coachingData = { callouts };
    rows.push({
      gameId: 'valorant',
      category: 'map',
      entryKey: key,
      displayName: mapName,
      apiData: null,
      coachingData,
      mergedData: coachingData,
      source: 'static',
    });
  }

  // ── Weapons ────────────────────────────────────────────────────────────────
  for (const w of VALID_WEAPONS) {
    rows.push({
      gameId: 'valorant',
      category: 'weapon',
      entryKey: w.toLowerCase(),
      displayName: w,
      apiData: null,
      coachingData: {},
      mergedData: {},
      source: 'static',
    });
  }

  // ── Mechanics ──────────────────────────────────────────────────────────────
  const mechanics = [
    { key: 'economy_rules', text: VALORANT_ECONOMY },
    { key: 'round_structure', text: VALORANT_ROUND },
    { key: 'core_mechanics', text: VALORANT_MECHANICS },
    { key: 'dm_mechanics', text: DM_MECHANICS },
  ];
  for (const m of mechanics) {
    const coachingData = { text: m.text };
    rows.push({
      gameId: 'valorant',
      category: 'mechanic',
      entryKey: m.key,
      displayName: m.key,
      apiData: null,
      coachingData,
      mergedData: coachingData,
      source: 'static',
    });
  }

  // ── Mode config ────────────────────────────────────────────────────────────
  rows.push({
    gameId: 'valorant',
    category: 'mode_config',
    entryKey: 'coachable_modes',
    displayName: 'Coachable Modes',
    apiData: null,
    coachingData: { modes: [...COACHABLE_MODES] },
    mergedData: { modes: [...COACHABLE_MODES] },
    source: 'static',
  });

  rows.push({
    gameId: 'valorant',
    category: 'mode_config',
    entryKey: 'unsupported_messages',
    displayName: 'Unsupported Mode Messages',
    apiData: null,
    coachingData: UNSUPPORTED_MODE_MESSAGES,
    mergedData: UNSUPPORTED_MODE_MESSAGES,
    source: 'static',
  });

  // Batch insert
  await db.insert(gameKnowledge).values(rows);

  logger.info({ count: rows.length }, 'Knowledge store seeded from static knowledge.ts');
}
