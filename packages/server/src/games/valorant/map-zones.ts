/**
 * Valorant Map-Zone Dictionary
 *
 * The HUD location text Valorant displays is highly stable but free-form
 * (e.g. "A Hookah", "A Bath", "Hookah" — all the same place). To group
 * patterns by zone in the brain we need a canonical zone_id for each
 * callout, plus aliases so HUD reads normalize cleanly.
 *
 * Data shape:
 *   - mapKey: lowercase canonical map name ("bind", "haven", ...)
 *   - zones: array of { id, displayName, side, aliases[] }
 *     - id: stable kebab-case identifier ("a_hookah")
 *     - side: 'attack_main' | 'defense_main' | 'site_a' | 'site_b' | 'site_c' | 'mid' | 'spawn'
 *     - aliases: lowercase normalized strings the HUD might emit
 *
 * Normalization steps applied to incoming HUD text:
 *   1. lowercase
 *   2. strip non-alphanumeric except spaces
 *   3. collapse multiple spaces
 *   4. trim
 * Then exact-match against alias list.
 *
 * Coverage is NOT exhaustive — we cover the ~12-18 most common callouts
 * per map. Unknown callouts fall through and the original HUD text is
 * preserved as a free-form `displayName` so coaching still works, just
 * not zone-grouped.
 */

export type ZoneSide =
  | 'site_a'
  | 'site_b'
  | 'site_c'
  | 'a_main'
  | 'b_main'
  | 'c_main'
  | 'mid'
  | 'spawn_attack'
  | 'spawn_defense'
  | 'other';

export interface MapZone {
  id: string; // 'a_hookah'
  displayName: string; // 'A Hookah'
  side: ZoneSide;
  aliases: string[]; // lowercased, alphanumeric+spaces
}

export interface MapDefinition {
  mapKey: string; // 'bind'
  displayName: string; // 'Bind'
  zones: MapZone[];
}

// Helper to keep zone defs short.
const z = (id: string, displayName: string, side: ZoneSide, ...aliases: string[]): MapZone => ({
  id,
  displayName,
  side,
  aliases: [displayName.toLowerCase(), ...aliases.map((a) => a.toLowerCase())],
});

export const MAP_ZONES: Record<string, MapDefinition> = {
  bind: {
    mapKey: 'bind',
    displayName: 'Bind',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a short', 'short'),
      z('a_bath', 'A Bath', 'site_a', 'bath', 'bathroom'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_hookah', 'A Hookah', 'site_a', 'hookah', 'a long'),
      z('a_lamps', 'A Lamps', 'site_a', 'lamps', 'a heaven'),
      z('b_main', 'B Main', 'b_main', 'b long', 'long b'),
      z('b_hall', 'B Hall', 'site_b', 'hall', 'b chute'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_garden', 'B Garden', 'site_b', 'garden', 'b heaven'),
      z('b_window', 'B Window', 'site_b', 'window'),
      z('mid_showers', 'Showers', 'mid', 'showers', 'mid showers'),
      z('teleporter', 'Teleporter', 'other', 'teleporter', 'tp', 'teleport'),
    ],
  },
  haven: {
    mapKey: 'haven',
    displayName: 'Haven',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a long', 'a lobby'),
      z('a_short', 'A Short', 'a_main', 'short'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_heaven', 'A Heaven', 'site_a', 'heaven', 'a heaven'),
      z('b_main', 'B Main', 'b_main', 'b mid'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b', 'mid b'),
      z('b_garage', 'B Garage', 'site_b', 'garage'),
      z('c_main', 'C Main', 'c_main', 'c long'),
      z('c_site', 'C Site', 'site_c', 'c', 'site c'),
      z('c_link', 'C Link', 'site_c', 'link', 'mid link'),
      z('mid_courtyard', 'Mid Courtyard', 'mid', 'courtyard', 'mid'),
    ],
  },
  ascent: {
    mapKey: 'ascent',
    displayName: 'Ascent',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a lobby'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_heaven', 'A Heaven', 'site_a', 'heaven'),
      z('a_hell', 'A Hell', 'site_a', 'hell'),
      z('b_main', 'B Main', 'b_main', 'b lobby'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_stairs', 'B Stairs', 'site_b', 'stairs'),
      z('b_market', 'B Market', 'b_main', 'market'),
      z('mid_top', 'Mid Top', 'mid', 'top mid', 'catwalk'),
      z('mid_bottom', 'Mid Bottom', 'mid', 'bottom mid', 'mid courtyard'),
      z('mid_courtyard', 'Mid', 'mid', 'mid', 'middle'),
      z('mid_link', 'Mid Link', 'mid', 'link'),
    ],
  },
  fracture: {
    mapKey: 'fracture',
    displayName: 'Fracture',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a hall', 'a halls'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_drop', 'A Drop', 'site_a', 'drop'),
      z('a_dish', 'A Dish', 'site_a', 'dish', 'a satellite'),
      z('b_main', 'B Main', 'b_main', 'b tower'),
      z('b_tree', 'B Tree', 'site_b', 'tree'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_arcade', 'B Arcade', 'site_b', 'arcade'),
      z('mid_link', 'Mid Link', 'mid', 'link'),
      z('mid_door', 'Mid Door', 'mid', 'door', 'mid'),
      z('generator', 'Generator', 'other', 'gen', 'mid generator'),
      z('attacker_spawn', 'Attacker Spawn', 'spawn_attack', 'attacker side', 'attack spawn'),
      z('defender_spawn', 'Defender Spawn', 'spawn_defense', 'defender side', 'defender spawn'),
    ],
  },
  pearl: {
    mapKey: 'pearl',
    displayName: 'Pearl',
    zones: [
      z('a_main', 'A Main', 'a_main'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_long', 'A Long', 'a_main', 'long'),
      z('a_restaurant', 'A Restaurant', 'a_main', 'restaurant', 'a cubby'),
      z('a_link', 'A Link', 'mid', 'a link', 'top mid'),
      z('b_main', 'B Main', 'b_main'),
      z('b_hall', 'B Hall', 'b_main', 'hall'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_plate', 'B Plate', 'site_b', 'plate'),
      z('mid', 'Mid', 'mid', 'middle'),
      z('connector', 'Connector', 'mid', 'mid connector'),
      z('art', 'Art', 'mid', 'art room'),
    ],
  },
  lotus: {
    mapKey: 'lotus',
    displayName: 'Lotus',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a lobby'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_tree', 'A Tree', 'site_a', 'tree', 'a pillar'),
      z('a_drop', 'A Drop', 'site_a', 'a heaven', 'drop'),
      z('b_main', 'B Main', 'b_main'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_stairs', 'B Stairs', 'site_b', 'stairs'),
      z('c_main', 'C Main', 'c_main', 'c hall'),
      z('c_site', 'C Site', 'site_c', 'c', 'site c'),
      z('c_tree', 'C Tree', 'site_c', 'c pillar'),
      z('mid_tree', 'Mid Tree', 'mid', 'mid'),
      z('mid_top', 'Mid Top', 'mid', 'top mid'),
    ],
  },
  sunset: {
    mapKey: 'sunset',
    displayName: 'Sunset',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a lobby'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_elbow', 'A Elbow', 'site_a', 'elbow'),
      z('b_main', 'B Main', 'b_main', 'b lobby'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_market', 'B Market', 'b_main', 'market'),
      z('mid_top', 'Mid Top', 'mid', 'top mid'),
      z('mid_bottom', 'Mid Bottom', 'mid', 'bottom mid'),
      z('tile', 'Tile', 'mid', 'mid tile'),
    ],
  },
  split: {
    mapKey: 'split',
    displayName: 'Split',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a lobby', 'a ramps'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_heaven', 'A Heaven', 'site_a', 'heaven'),
      z('a_tower', 'A Tower', 'site_a', 'tower'),
      z('b_main', 'B Main', 'b_main', 'b alley'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_tower', 'B Tower', 'site_b', 'b heaven'),
      z('mid_top', 'Mid Top', 'mid', 'top mid'),
      z('mid_vents', 'Mid Vents', 'mid', 'vents'),
      z('sewers', 'Sewers', 'mid', 'sewer'),
    ],
  },
  icebox: {
    mapKey: 'icebox',
    displayName: 'Icebox',
    zones: [
      z('a_main', 'A Main', 'a_main', 'a long'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_pipes', 'A Pipes', 'site_a', 'pipes'),
      z('a_belt', 'A Belt', 'site_a', 'belt', 'a heaven'),
      z('b_main', 'B Main', 'b_main', 'b orange', 'orange'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_yellow', 'B Yellow', 'site_b', 'yellow'),
      z('b_tube', 'B Tube', 'site_b', 'tube'),
      z('mid_top', 'Mid Top', 'mid', 'top mid'),
      z('mid_bottom', 'Mid Bottom', 'mid', 'bottom mid'),
    ],
  },
  breeze: {
    mapKey: 'breeze',
    displayName: 'Breeze',
    zones: [
      z('a_main', 'A Main', 'a_main'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('a_hall', 'A Hall', 'site_a', 'a halls'),
      z('a_cave', 'A Cave', 'site_a', 'cave'),
      z('b_main', 'B Main', 'b_main'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('b_tunnel', 'B Tunnel', 'site_b', 'tunnel'),
      z('mid_wood', 'Mid Wood', 'mid', 'mid'),
      z('mid_top', 'Mid Top', 'mid', 'top mid'),
      z('mid_bottom', 'Mid Bottom', 'mid', 'bottom mid'),
    ],
  },
  abyss: {
    mapKey: 'abyss',
    displayName: 'Abyss',
    zones: [
      z('a_main', 'A Main', 'a_main'),
      z('a_site', 'A Site', 'site_a', 'a', 'site a'),
      z('b_main', 'B Main', 'b_main'),
      z('b_site', 'B Site', 'site_b', 'b', 'site b'),
      z('mid', 'Mid', 'mid', 'middle'),
    ],
  },
};

/** Normalize a free-form HUD location string to canonical form for matching. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NormalizedZone {
  zoneId: string; // 'a_hookah' (or 'unknown' if no match)
  displayName: string; // 'A Hookah' (or original HUD text if unknown)
  side: ZoneSide; // 'site_a' (or 'other' if unknown)
  matched: boolean; // true if dictionary match
}

/**
 * Normalize a HUD location text against the map's zone dictionary.
 * Returns matched zone or a passthrough with `matched=false` so callers
 * can choose whether to surface the unknown text or drop it.
 */
export function normalizeLocation(
  mapDisplayName: string | null | undefined,
  hudText: string | null | undefined,
): NormalizedZone | null {
  if (!hudText) return null;
  const text = normalize(hudText);
  if (!text) return null;

  const mapKey = (mapDisplayName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const def = MAP_ZONES[mapKey];

  // No map dictionary — return free-form passthrough.
  if (!def) {
    return {
      zoneId: 'unknown',
      displayName: hudText.trim(),
      side: 'other',
      matched: false,
    };
  }

  for (const zone of def.zones) {
    if (zone.aliases.some((a) => a === text)) {
      return { zoneId: zone.id, displayName: zone.displayName, side: zone.side, matched: true };
    }
  }

  // Partial match fallback: if HUD says "a hookah dirty" and we have
  // "a hookah", accept partial substring match in either direction.
  for (const zone of def.zones) {
    if (zone.aliases.some((a) => text.includes(a) || a.includes(text))) {
      return { zoneId: zone.id, displayName: zone.displayName, side: zone.side, matched: true };
    }
  }

  return {
    zoneId: 'unknown',
    displayName: hudText.trim(),
    side: 'other',
    matched: false,
  };
}

/** Returns true if the map name is one we have zone data for. */
export function hasMapDictionary(mapDisplayName: string | null | undefined): boolean {
  if (!mapDisplayName) return false;
  const key = mapDisplayName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return key in MAP_ZONES;
}
