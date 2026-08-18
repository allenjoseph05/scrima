/**
 * Level 3 fallback — reads from the static knowledge.ts file.
 * Used when both the database cache and live API are unavailable.
 */

import {
  AGENTS,
  DM_MECHANICS,
  MAP_CALLOUTS,
  VALID_MAPS,
  VALID_WEAPONS,
  VALORANT_ECONOMY,
  VALORANT_MECHANICS,
  VALORANT_ROUND,
} from '../../games/valorant/knowledge.js';
import type { MergedKnowledgeEntry } from './types.js';

function agentDisplayName(key: string): string {
  if (key === 'kay/o') return 'KAY/O';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function getStaticFallback(
  gameId: string,
  category: string,
  entryKey: string,
): MergedKnowledgeEntry | null {
  if (gameId !== 'valorant') return null;

  if (category === 'agent') {
    const info = AGENTS[entryKey];
    if (!info) return null;
    return {
      gameId: 'valorant',
      category: 'agent',
      entryKey,
      displayName: agentDisplayName(entryKey),
      mergedData: {
        role: info.role,
        expectation: info.expectation,
        abilities: info.abilities,
        flags: info.flags,
      },
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    };
  }

  if (category === 'map') {
    const callouts = MAP_CALLOUTS[entryKey];
    if (!callouts) return null;
    return {
      gameId: 'valorant',
      category: 'map',
      entryKey,
      displayName: entryKey.charAt(0).toUpperCase() + entryKey.slice(1),
      mergedData: { callouts },
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    };
  }

  if (category === 'weapon') {
    const found = VALID_WEAPONS.find((w) => w.toLowerCase() === entryKey);
    if (!found) return null;
    return {
      gameId: 'valorant',
      category: 'weapon',
      entryKey,
      displayName: found,
      mergedData: {},
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    };
  }

  if (category === 'mechanic') {
    const mechanics: Record<string, string> = {
      economy_rules: VALORANT_ECONOMY,
      round_structure: VALORANT_ROUND,
      core_mechanics: VALORANT_MECHANICS,
      dm_mechanics: DM_MECHANICS,
    };
    const text = mechanics[entryKey];
    if (!text) return null;
    return {
      gameId: 'valorant',
      category: 'mechanic',
      entryKey,
      displayName: entryKey,
      mergedData: { text },
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    };
  }

  return null;
}

/** Get all static entries for a category (used when DB cache is empty). */
export function getStaticActiveEntries(gameId: string, category: string): MergedKnowledgeEntry[] {
  if (gameId !== 'valorant') return [];

  if (category === 'agent') {
    return Object.keys(AGENTS).map((key) => ({
      gameId: 'valorant',
      category: 'agent',
      entryKey: key,
      displayName: agentDisplayName(key),
      mergedData: {
        role: AGENTS[key].role,
        expectation: AGENTS[key].expectation,
        abilities: AGENTS[key].abilities,
        flags: AGENTS[key].flags,
      },
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    }));
  }

  if (category === 'map') {
    return VALID_MAPS.map((m) => ({
      gameId: 'valorant',
      category: 'map',
      entryKey: m.toLowerCase(),
      displayName: m,
      mergedData: { callouts: MAP_CALLOUTS[m.toLowerCase()] ?? '' },
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    }));
  }

  if (category === 'weapon') {
    return VALID_WEAPONS.map((w) => ({
      gameId: 'valorant',
      category: 'weapon',
      entryKey: w.toLowerCase(),
      displayName: w,
      mergedData: {},
      source: 'static',
      apiVersion: null,
      isActive: true,
      updatedAt: new Date(0),
    }));
  }

  return [];
}
