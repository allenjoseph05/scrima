/**
 * Valorant Sync Adapter
 *
 * Fetches game knowledge from valorant-api.com (free, no-auth, community-maintained).
 * Transforms API responses into our internal format.
 */

import { logger } from '../../../shared/logger.js';
import type { TransformedEntry } from '../types.js';
import type { KnowledgeSyncAdapter } from './sync-adapter.interface.js';

const BASE_URL = 'https://valorant-api.com';
const FETCH_TIMEOUT_MS = 15_000;

interface ValorantApiResponse<T> {
  status: number;
  data: T;
}

interface ApiAgent {
  uuid: string;
  displayName: string;
  description: string;
  isPlayableCharacter: boolean;
  role: {
    uuid: string;
    displayName: string;
    description: string;
  } | null;
  abilities: Array<{
    slot: string; // 'Ability1' | 'Ability2' | 'Grenade' | 'Ultimate' | 'Passive'
    displayName: string;
    description: string;
  }>;
}

interface ApiMap {
  uuid: string;
  displayName: string;
  coordinates: string | null;
  narrativeDescription: string | null;
  tacticalDescription: string | null;
  callouts: Array<{
    regionName: string;
    superRegionName: string;
    location: { x: number; y: number };
  }> | null;
}

interface ApiWeapon {
  uuid: string;
  displayName: string;
  category: string;
  shopData: {
    cost: number;
    category: string;
  } | null;
  weaponStats: {
    fireRate: number;
    magazineSize: number;
    damageRanges: Array<{
      rangeStartMeters: number;
      rangeEndMeters: number;
      headDamage: number;
      bodyDamage: number;
      legDamage: number;
    }>;
  } | null;
}

interface ApiVersion {
  manifestId: string;
  branch: string;
  version: string;
  buildVersion: string;
  riotClientVersion: string;
  buildDate: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`valorant-api.com ${path} returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAgentKey(displayName: string): string {
  // KAY/O -> kay/o, everything else -> lowercase
  return displayName.toLowerCase();
}

// Maps whose callouts are null or that aren't real competitive maps
// Maps that aren't real competitive/unrated maps — filter from sync
const EXCLUDED_MAPS = new Set([
  'the range',
  'basic training',
  'kasbah',
  'piazza',
  'district',
  'drift',
  'glitch',
  'skirmish a',
  'skirmish b',
  'skirmish c',
]);

export class ValorantSyncAdapter implements KnowledgeSyncAdapter {
  readonly gameId = 'valorant';

  async fetchVersion(): Promise<string | null> {
    try {
      const res = await fetchJson<ValorantApiResponse<ApiVersion>>('/v1/version');
      return res.data?.version ?? null;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'Failed to fetch Valorant version',
      );
      return null;
    }
  }

  async fetchAgents(): Promise<TransformedEntry[]> {
    const res = await fetchJson<ValorantApiResponse<ApiAgent[]>>(
      '/v1/agents?isPlayableCharacter=true',
    );
    return res.data.filter((a) => a.isPlayableCharacter).map((a) => this.transformAgent(a));
  }

  async fetchMaps(): Promise<TransformedEntry[]> {
    const res = await fetchJson<ValorantApiResponse<ApiMap[]>>('/v1/maps');
    return res.data
      .filter((m) => !EXCLUDED_MAPS.has(m.displayName.toLowerCase()))
      .map((m) => this.transformMap(m));
  }

  async fetchWeapons(): Promise<TransformedEntry[]> {
    const res = await fetchJson<ValorantApiResponse<ApiWeapon[]>>('/v1/weapons');
    return res.data.map((w) => this.transformWeapon(w));
  }

  private transformAgent(raw: ApiAgent): TransformedEntry {
    return {
      entryKey: normalizeAgentKey(raw.displayName),
      displayName: raw.displayName,
      apiData: {
        role: raw.role?.displayName ?? 'Unknown',
        roleDescription: raw.role?.description ?? '',
        description: raw.description,
        abilitiesRaw: raw.abilities.map((a) => ({
          slot: a.slot,
          displayName: a.displayName,
          description: a.description,
        })),
      },
    };
  }

  private transformMap(raw: ApiMap): TransformedEntry {
    return {
      entryKey: raw.displayName.toLowerCase(),
      displayName: raw.displayName,
      apiData: {
        coordinates: raw.coordinates,
        narrativeDescription: raw.narrativeDescription,
        callouts:
          raw.callouts?.map((c) => ({
            regionName: c.regionName,
            superRegionName: c.superRegionName,
          })) ?? [],
      },
    };
  }

  private transformWeapon(raw: ApiWeapon): TransformedEntry {
    return {
      entryKey: raw.displayName.toLowerCase(),
      displayName: raw.displayName,
      apiData: {
        category: raw.category,
        cost: raw.shopData?.cost,
        fireRate: raw.weaponStats?.fireRate,
        magazineSize: raw.weaponStats?.magazineSize,
        damageRanges: raw.weaponStats?.damageRanges?.map((d) => ({
          rangeStart: d.rangeStartMeters,
          rangeEnd: d.rangeEndMeters,
          headDamage: d.headDamage,
          bodyDamage: d.bodyDamage,
          legDamage: d.legDamage,
        })),
      },
    };
  }
}
