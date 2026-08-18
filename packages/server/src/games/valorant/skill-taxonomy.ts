/**
 * Valorant Skill Taxonomy — Core skills for BKT mastery tracking.
 *
 * Each skill has:
 *   - domain: mechanical, game_sense, utility, mental
 *   - detectionCategories: which death categories signal this skill
 *   - signal: 'negative' (death in this category = skill weakness) or
 *             'positive' (strength mention = skill demonstrated)
 *   - prerequisites: skills that should be learned first
 *   - rankRelevance: how important this skill is at each rank tier (1-5)
 *   - roleWeight: multiplier per agent role (higher = more relevant)
 */

export interface SkillDefinition {
  id: string;
  name: string;
  domain: 'mechanical' | 'game_sense' | 'utility' | 'mental';
  detectionCategories: string[];
  signal: 'negative' | 'positive';
  prerequisites: string[];
  rankRelevance: { low: number; mid: number; high: number }; // Iron-Silver, Gold-Plat, Diamond+
  roleWeight: { duelist: number; initiator: number; controller: number; sentinel: number };
}

// ── Detection category → skill mappings ──────────────────────────────────────
// When a death has category X, these skills are implicated (negative signal).
// When a strength mentions keyword Y, these skills are credited (positive signal).

export const SKILL_TAXONOMY: SkillDefinition[] = [
  // ═══ MECHANICAL ═══════════════════════════════════════════════════════════
  {
    id: 'crosshair_placement',
    name: 'Crosshair Placement',
    domain: 'mechanical',
    detectionCategories: ['crosshair'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 5, mid: 4, high: 3 },
    roleWeight: { duelist: 1.2, initiator: 1.0, controller: 0.8, sentinel: 0.8 },
  },
  {
    id: 'spray_control',
    name: 'Spray Control',
    domain: 'mechanical',
    detectionCategories: ['crosshair'],
    signal: 'negative',
    prerequisites: ['crosshair_placement'],
    rankRelevance: { low: 4, mid: 4, high: 3 },
    roleWeight: { duelist: 1.2, initiator: 1.0, controller: 1.0, sentinel: 1.0 },
  },
  {
    id: 'counter_strafing',
    name: 'Counter-Strafing',
    domain: 'mechanical',
    detectionCategories: ['movement'],
    signal: 'negative',
    prerequisites: ['crosshair_placement'],
    rankRelevance: { low: 3, mid: 5, high: 4 },
    roleWeight: { duelist: 1.3, initiator: 1.0, controller: 0.8, sentinel: 0.8 },
  },
  {
    id: 'peeking_technique',
    name: 'Peeking Technique',
    domain: 'mechanical',
    detectionCategories: ['peeking'],
    signal: 'negative',
    prerequisites: ['crosshair_placement', 'counter_strafing'],
    rankRelevance: { low: 4, mid: 5, high: 5 },
    roleWeight: { duelist: 1.3, initiator: 1.1, controller: 0.8, sentinel: 0.7 },
  },
  {
    id: 'movement_discipline',
    name: 'Movement Discipline',
    domain: 'mechanical',
    detectionCategories: ['movement'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 3, mid: 4, high: 4 },
    roleWeight: { duelist: 1.2, initiator: 1.0, controller: 1.0, sentinel: 1.0 },
  },

  // ═══ GAME SENSE ═══════════════════════════════════════════════════════════
  {
    id: 'positioning',
    name: 'Positioning',
    domain: 'game_sense',
    detectionCategories: ['positioning'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 5, mid: 5, high: 5 },
    roleWeight: { duelist: 0.8, initiator: 1.0, controller: 1.2, sentinel: 1.3 },
  },
  {
    id: 'angle_discipline',
    name: 'Angle Discipline',
    domain: 'game_sense',
    detectionCategories: ['positioning', 'peeking'],
    signal: 'negative',
    prerequisites: ['positioning'],
    rankRelevance: { low: 3, mid: 5, high: 5 },
    roleWeight: { duelist: 0.9, initiator: 1.0, controller: 1.1, sentinel: 1.2 },
  },
  {
    id: 'map_awareness',
    name: 'Map Awareness',
    domain: 'game_sense',
    detectionCategories: ['game_sense', 'positioning'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 3, mid: 4, high: 5 },
    roleWeight: { duelist: 0.8, initiator: 1.2, controller: 1.3, sentinel: 1.0 },
  },
  {
    id: 'trading',
    name: 'Trade Awareness',
    domain: 'game_sense',
    detectionCategories: ['trading'],
    signal: 'negative',
    prerequisites: ['map_awareness'],
    rankRelevance: { low: 2, mid: 4, high: 5 },
    roleWeight: { duelist: 1.3, initiator: 1.2, controller: 0.8, sentinel: 0.7 },
  },
  {
    id: 'economy_management',
    name: 'Economy Management',
    domain: 'game_sense',
    detectionCategories: ['economy'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 3, mid: 4, high: 5 },
    roleWeight: { duelist: 1.0, initiator: 1.0, controller: 1.0, sentinel: 1.0 },
  },
  {
    id: 'rotation_timing',
    name: 'Rotation Timing',
    domain: 'game_sense',
    detectionCategories: ['game_sense'],
    signal: 'negative',
    prerequisites: ['map_awareness'],
    rankRelevance: { low: 2, mid: 3, high: 5 },
    roleWeight: { duelist: 0.8, initiator: 1.0, controller: 1.2, sentinel: 1.0 },
  },
  {
    id: 'information_gathering',
    name: 'Information Gathering',
    domain: 'game_sense',
    detectionCategories: ['game_sense', 'peeking'],
    signal: 'negative',
    prerequisites: ['map_awareness'],
    rankRelevance: { low: 2, mid: 4, high: 5 },
    roleWeight: { duelist: 0.7, initiator: 1.4, controller: 1.0, sentinel: 1.2 },
  },
  {
    id: 'post_plant_play',
    name: 'Post-Plant Positioning',
    domain: 'game_sense',
    detectionCategories: ['positioning', 'game_sense'],
    signal: 'negative',
    prerequisites: ['positioning'],
    rankRelevance: { low: 2, mid: 3, high: 4 },
    roleWeight: { duelist: 0.9, initiator: 1.0, controller: 1.2, sentinel: 1.1 },
  },

  // ═══ UTILITY ═══════════════════════════════════════════════════════════════
  {
    id: 'utility_timing',
    name: 'Utility Timing',
    domain: 'utility',
    detectionCategories: ['utility'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 3, mid: 5, high: 5 },
    roleWeight: { duelist: 0.8, initiator: 1.3, controller: 1.3, sentinel: 1.2 },
  },
  {
    id: 'ability_economy',
    name: 'Ability Economy',
    domain: 'utility',
    detectionCategories: ['utility'],
    signal: 'negative',
    prerequisites: ['utility_timing'],
    rankRelevance: { low: 2, mid: 3, high: 5 },
    roleWeight: { duelist: 0.7, initiator: 1.2, controller: 1.3, sentinel: 1.1 },
  },
  {
    id: 'flash_coordination',
    name: 'Flash Coordination',
    domain: 'utility',
    detectionCategories: ['utility'],
    signal: 'negative',
    prerequisites: ['utility_timing'],
    rankRelevance: { low: 2, mid: 4, high: 5 },
    roleWeight: { duelist: 1.0, initiator: 1.5, controller: 0.5, sentinel: 0.3 },
  },
  {
    id: 'smoke_usage',
    name: 'Smoke Placement',
    domain: 'utility',
    detectionCategories: ['utility'],
    signal: 'negative',
    prerequisites: ['utility_timing', 'map_awareness'],
    rankRelevance: { low: 2, mid: 4, high: 5 },
    roleWeight: { duelist: 0.3, initiator: 0.5, controller: 1.5, sentinel: 0.3 },
  },
  {
    id: 'setup_utility',
    name: 'Setup Utility',
    domain: 'utility',
    detectionCategories: ['utility'],
    signal: 'negative',
    prerequisites: ['utility_timing'],
    rankRelevance: { low: 3, mid: 4, high: 5 },
    roleWeight: { duelist: 0.2, initiator: 0.5, controller: 0.8, sentinel: 1.5 },
  },

  // ═══ MENTAL ═══════════════════════════════════════════════════════════════
  {
    id: 'patience',
    name: 'Patience & Discipline',
    domain: 'mental',
    detectionCategories: ['peeking', 'positioning', 'game_sense'],
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 4, mid: 5, high: 5 },
    roleWeight: { duelist: 0.8, initiator: 1.0, controller: 1.2, sentinel: 1.3 },
  },
  {
    id: 'tilt_resistance',
    name: 'Tilt Resistance',
    domain: 'mental',
    detectionCategories: [], // detected via death clustering pattern, not single deaths
    signal: 'negative',
    prerequisites: [],
    rankRelevance: { low: 3, mid: 4, high: 5 },
    roleWeight: { duelist: 1.0, initiator: 1.0, controller: 1.0, sentinel: 1.0 },
  },
  {
    id: 'adaptability',
    name: 'Mid-Match Adaptation',
    domain: 'mental',
    detectionCategories: ['game_sense'],
    signal: 'negative',
    prerequisites: ['map_awareness'],
    rankRelevance: { low: 1, mid: 3, high: 5 },
    roleWeight: { duelist: 1.0, initiator: 1.1, controller: 1.1, sentinel: 1.0 },
  },
  {
    id: 'aggression_control',
    name: 'Aggression Control',
    domain: 'mental',
    detectionCategories: ['peeking', 'positioning'],
    signal: 'negative',
    prerequisites: ['patience'],
    rankRelevance: { low: 4, mid: 5, high: 4 },
    roleWeight: { duelist: 1.3, initiator: 1.0, controller: 0.8, sentinel: 0.7 },
  },
];

// ── Lookup helpers ───────────────────────────────────────────────────────────

const _byId = new Map(SKILL_TAXONOMY.map((s) => [s.id, s]));
const _byCategory = new Map<string, SkillDefinition[]>();

for (const skill of SKILL_TAXONOMY) {
  for (const cat of skill.detectionCategories) {
    const existing = _byCategory.get(cat) ?? [];
    existing.push(skill);
    _byCategory.set(cat, existing);
  }
}

/** Get skill definition by ID. */
export function getSkill(id: string): SkillDefinition | undefined {
  return _byId.get(id);
}

/** Get all skills implicated by a death category (e.g., 'peeking' → peeking_technique, angle_discipline, patience, aggression_control). */
export function getSkillsForCategory(category: string): SkillDefinition[] {
  return _byCategory.get(category) ?? [];
}

/** Get all skill IDs. */
export function getAllSkillIds(): string[] {
  return SKILL_TAXONOMY.map((s) => s.id);
}

/** Determine rank tier from rank string. */
export function getRankTier(rank?: string): 'low' | 'mid' | 'high' {
  if (!rank) return 'mid';
  const lower = rank.toLowerCase();
  if (lower.includes('iron') || lower.includes('bronze') || lower.includes('silver')) return 'low';
  if (
    lower.includes('diamond') ||
    lower.includes('ascendant') ||
    lower.includes('immortal') ||
    lower.includes('radiant')
  )
    return 'high';
  return 'mid'; // gold, platinum
}

/** Map agent name to role. */
export function getAgentRole(agent?: string): 'duelist' | 'initiator' | 'controller' | 'sentinel' {
  if (!agent) return 'duelist';
  const lower = agent.toLowerCase();
  const duelists = ['jett', 'reyna', 'phoenix', 'raze', 'yoru', 'neon', 'iso', 'waylay'];
  const initiators = ['sova', 'breach', 'skye', 'kayo', 'kay/o', 'fade', 'gekko', 'tejo'];
  const controllers = ['brimstone', 'viper', 'omen', 'astra', 'harbor', 'clove', 'miks'];
  const sentinels = ['cypher', 'killjoy', 'sage', 'chamber', 'deadlock', 'vyse', 'veto'];
  if (duelists.includes(lower)) return 'duelist';
  if (initiators.includes(lower)) return 'initiator';
  if (controllers.includes(lower)) return 'controller';
  if (sentinels.includes(lower)) return 'sentinel';
  return 'duelist';
}
