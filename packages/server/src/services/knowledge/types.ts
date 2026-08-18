/**
 * Knowledge pipeline types.
 */

// ── Core entry type ──────────────────────────────────────────────────────────

export interface MergedKnowledgeEntry {
  gameId: string;
  category: string;
  entryKey: string;
  displayName: string;
  mergedData: Record<string, unknown>;
  source: string;
  apiVersion: string | null;
  isActive: boolean;
  updatedAt: Date;
}

// ── Valorant-specific merged data shapes ─────────────────────────────────────

export interface ValorantAgentMergedData {
  role: string;
  expectation: string;
  abilities: string;
  flags: string;
  abilitiesRaw?: Array<{ slot: string; displayName: string; description: string }>;
}

export interface ValorantMapMergedData {
  callouts: string;
  calloutsRaw?: Array<{ regionName: string; superRegionName: string }>;
}

export interface ValorantWeaponMergedData {
  category?: string;
  cost?: number;
  fireRate?: number;
  magazineSize?: number;
}

export interface ValorantMechanicMergedData {
  text: string;
}

// ── Sync adapter types ───────────────────────────────────────────────────────

export interface TransformedEntry {
  entryKey: string;
  displayName: string;
  apiData: Record<string, unknown>;
}

export interface SyncResult {
  status: 'success' | 'partial' | 'failed' | 'no_changes';
  apiVersion: string | null;
  added: number;
  updated: number;
  removed: number;
  error?: string;
  durationMs: number;
}

// ── Merge helpers ────────────────────────────────────────────────────────────

const SLOT_MAP: Record<string, string> = {
  Grenade: 'C',
  Ability1: 'Q',
  Ability2: 'E',
  Ultimate: 'X',
  Passive: 'Passive',
};

/**
 * Auto-generate ability text from raw API data.
 * Used as fallback when no hand-written coaching overlay exists.
 */
export function formatAbilitiesFromApi(
  abilitiesRaw: Array<{ slot: string; displayName: string; description: string }>,
): string {
  return abilitiesRaw
    .map((a) => `${SLOT_MAP[a.slot] ?? a.slot} ${a.displayName}: ${a.description}`)
    .join('\n');
}

/**
 * Merge API data with coaching overlays for an agent entry.
 * Coaching data always takes precedence for coaching-specific fields.
 */
export function mergeAgentData(
  apiData: Record<string, unknown> | null,
  coachingData: Record<string, unknown>,
): ValorantAgentMergedData {
  const api = apiData as Record<string, any> | null;
  const coach = coachingData as Record<string, any>;

  const abilitiesRaw = api?.abilitiesRaw as
    | Array<{ slot: string; displayName: string; description: string }>
    | undefined;

  return {
    role: api?.role ?? coach?.role ?? 'Unknown',
    expectation: coach?.expectation ?? `Apply standard ${api?.role ?? 'Unknown'} principles.`,
    abilities: coach?.abilities ?? (abilitiesRaw ? formatAbilitiesFromApi(abilitiesRaw) : ''),
    flags: coach?.flags ?? '',
    abilitiesRaw: abilitiesRaw ?? [],
  };
}

/**
 * Merge API data with coaching overlays for a map entry.
 */
export function mergeMapData(
  apiData: Record<string, unknown> | null,
  coachingData: Record<string, unknown>,
): ValorantMapMergedData {
  const coach = coachingData as Record<string, any>;
  const api = apiData as Record<string, any> | null;

  return {
    callouts: coach?.callouts ?? '',
    calloutsRaw: api?.callouts ?? [],
  };
}

/**
 * Merge API data with coaching overlays for a weapon entry.
 */
export function mergeWeaponData(
  apiData: Record<string, unknown> | null,
  _coachingData: Record<string, unknown>,
): ValorantWeaponMergedData {
  const api = apiData as Record<string, any> | null;
  return {
    category: api?.category,
    cost: api?.cost,
    fireRate: api?.fireRate,
    magazineSize: api?.magazineSize,
  };
}

/**
 * Merge for mechanic entries (no API source — coaching data only).
 */
export function mergeMechanicData(
  _apiData: Record<string, unknown> | null,
  coachingData: Record<string, unknown>,
): ValorantMechanicMergedData {
  return { text: (coachingData as any)?.text ?? '' };
}

/**
 * Route to the correct merge function based on category.
 */
export function mergeEntryData(
  category: string,
  apiData: Record<string, unknown> | null,
  coachingData: Record<string, unknown>,
): Record<string, unknown> {
  switch (category) {
    case 'agent':
      return mergeAgentData(apiData, coachingData) as unknown as Record<string, unknown>;
    case 'map':
      return mergeMapData(apiData, coachingData) as unknown as Record<string, unknown>;
    case 'weapon':
      return mergeWeaponData(apiData, coachingData) as unknown as Record<string, unknown>;
    case 'mechanic':
      return mergeMechanicData(apiData, coachingData) as unknown as Record<string, unknown>;
    default:
      return { ...apiData, ...coachingData };
  }
}
