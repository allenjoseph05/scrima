/**
 * Sync Adapter Interface
 *
 * Each game implements this to fetch knowledge from its external API.
 */

import type { TransformedEntry } from '../types.js';

export interface KnowledgeSyncAdapter {
  readonly gameId: string;

  /** Fetch the current game version from the external API. */
  fetchVersion(): Promise<string | null>;

  /** Fetch and transform all agents/characters. */
  fetchAgents(): Promise<TransformedEntry[]>;

  /** Fetch and transform all maps. */
  fetchMaps(): Promise<TransformedEntry[]>;

  /** Fetch and transform all weapons. */
  fetchWeapons(): Promise<TransformedEntry[]>;
}
