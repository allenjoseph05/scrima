/**
 * Valorant-specific types and constants.
 * These are the game-specific definitions for the Valorant plugin.
 * The core engine does not import these — only the Valorant plugin uses them.
 */

import type {
  CoachingCategory,
  GameEventType,
  GamePhaseDefinition,
  HudElement,
} from './game-plugin.js';

// ============================================================
// VALORANT GAME MODES
// ============================================================

/** All known Valorant queue types */
export type ValorantGameMode =
  | 'competitive'
  | 'unrated'
  | 'swiftplay'
  | 'premier'
  | 'custom'
  | 'deathmatch'
  | 'team_deathmatch'
  | 'spike_rush'
  | 'escalation'
  | 'practice'
  | 'not_valorant';

/** Modes that Scrima can coach */
export const COACHABLE_MODES = new Set<ValorantGameMode>([
  'competitive',
  'unrated',
  'swiftplay',
  'premier',
  'custom',
  'deathmatch',
  'team_deathmatch',
  'spike_rush',
]);

/** Modes we reject immediately (no Gemini call) */
export const UNSUPPORTED_MODE_MESSAGES: Record<string, string> = {
  escalation:
    "Escalation mode is not coachable — weapons rotate automatically and don't reflect your real gameplay.",
  practice: 'Practice/custom tool sessions are not analyzed. Try a real match!',
  not_valorant:
    "This doesn't appear to be a Valorant match. Scrima currently supports Valorant only.",
};

// ============================================================
// VALORANT EVENT TYPES
// ============================================================

export const VALORANT_EVENT_TYPES: GameEventType[] = [
  {
    id: 'kill',
    label: 'Kill',
    isCoachable: false,
    coachingPriority: 0.3,
    clipWindow: { beforeSeconds: 3.0, afterSeconds: 1.0 },
  },
  {
    id: 'death',
    label: 'Death',
    isCoachable: true,
    coachingPriority: 1.0,
    clipWindow: { beforeSeconds: 8.0, afterSeconds: 2.0 },
  },
  {
    id: 'assist',
    label: 'Assist',
    isCoachable: false,
    coachingPriority: 0.1,
    clipWindow: { beforeSeconds: 2.0, afterSeconds: 1.0 },
  },
  {
    id: 'round_start',
    label: 'Round Start',
    isCoachable: false,
    coachingPriority: 0.0,
    clipWindow: { beforeSeconds: 0.0, afterSeconds: 0.0 },
  },
  {
    id: 'round_end',
    label: 'Round End',
    isCoachable: false,
    coachingPriority: 0.0,
    clipWindow: { beforeSeconds: 0.0, afterSeconds: 0.0 },
  },
  {
    id: 'buy_phase_start',
    label: 'Buy Phase',
    isCoachable: true,
    coachingPriority: 0.4,
    clipWindow: { beforeSeconds: 0.0, afterSeconds: 15.0 },
  },
  {
    id: 'ability_used',
    label: 'Ability Used',
    isCoachable: false,
    coachingPriority: 0.2,
    clipWindow: { beforeSeconds: 1.0, afterSeconds: 2.0 },
  },
  {
    id: 'spike_planted',
    label: 'Spike Planted',
    isCoachable: false,
    coachingPriority: 0.3,
    clipWindow: { beforeSeconds: 3.0, afterSeconds: 2.0 },
  },
  {
    id: 'spike_defused',
    label: 'Spike Defused',
    isCoachable: false,
    coachingPriority: 0.2,
    clipWindow: { beforeSeconds: 5.0, afterSeconds: 1.0 },
  },
  {
    id: 'match_start',
    label: 'Match Start',
    isCoachable: false,
    coachingPriority: 0.0,
    clipWindow: { beforeSeconds: 0.0, afterSeconds: 0.0 },
  },
  {
    id: 'match_end',
    label: 'Match End',
    isCoachable: false,
    coachingPriority: 0.0,
    clipWindow: { beforeSeconds: 0.0, afterSeconds: 0.0 },
  },
  {
    id: 'firefight',
    label: 'Firefight',
    isCoachable: true,
    coachingPriority: 0.6,
    clipWindow: { beforeSeconds: 3.0, afterSeconds: 3.0 },
  },
  {
    id: 'clutch_situation',
    label: 'Clutch Situation',
    isCoachable: true,
    coachingPriority: 0.9,
    clipWindow: { beforeSeconds: 5.0, afterSeconds: 5.0 },
  },
];

// ============================================================
// VALORANT COACHING CATEGORIES
// ============================================================

export const VALORANT_COACHING_CATEGORIES: CoachingCategory[] = [
  {
    id: 'crosshair',
    label: 'Crosshair Placement',
    description: 'Crosshair not at head level or not pre-aimed at common angles',
    icon: 'crosshair',
    color: '#E24B4A',
  },
  {
    id: 'positioning',
    label: 'Positioning',
    description: 'Bad position — too exposed, no cover, holding angle wrong',
    icon: 'map-pin',
    color: '#BA7517',
  },
  {
    id: 'utility',
    label: 'Utility Usage',
    description: 'Abilities available but not used, or used poorly',
    icon: 'zap',
    color: '#378ADD',
  },
  {
    id: 'decision',
    label: 'Decision Making',
    description: 'Bad strategic choice — wrong rotation, unnecessary peek, bad economy',
    icon: 'brain',
    color: '#7F77DD',
  },
  {
    id: 'outplayed',
    label: 'Outplayed',
    description: 'Did everything right, opponent just made a better play',
    icon: 'shield',
    color: '#888780',
  },
];

// ============================================================
// DEATHMATCH-SPECIFIC COACHING CATEGORIES
// ============================================================

export const VALORANT_DM_COACHING_CATEGORIES: CoachingCategory[] = [
  {
    id: 'crosshair',
    label: 'Crosshair Placement',
    description: 'Crosshair not at head level or not pre-aimed at common angles',
    icon: 'crosshair',
    color: '#E24B4A',
  },
  {
    id: 'peeking',
    label: 'Peeking',
    description: 'Wide-swinging when should jiggle-peek, or holding too tight',
    icon: 'eye',
    color: '#F59E0B',
  },
  {
    id: 'movement',
    label: 'Movement',
    description: 'Counter-strafing, jiggle-peeking, and general movement quality',
    icon: 'move',
    color: '#10B981',
  },
  {
    id: 'spray_control',
    label: 'Spray Control',
    description: 'Recoil management and burst discipline',
    icon: 'target',
    color: '#8B5CF6',
  },
];

// ============================================================
// VALORANT GAME PHASES
// ============================================================

export const VALORANT_GAME_PHASES: GamePhaseDefinition[] = [
  {
    id: 'pre_match',
    label: 'Pre-Match',
    isActiveGameplay: false,
    isCoachable: false,
  },
  {
    id: 'buy_phase',
    label: 'Buy Phase',
    isActiveGameplay: true,
    isCoachable: true,
  },
  {
    id: 'combat',
    label: 'Combat',
    isActiveGameplay: true,
    isCoachable: true,
  },
  {
    id: 'post_round',
    label: 'Post-Round',
    isActiveGameplay: false,
    isCoachable: false,
  },
  {
    id: 'post_match',
    label: 'Post-Match',
    isActiveGameplay: false,
    isCoachable: false,
  },
];

// ============================================================
// VALORANT HUD ELEMENTS (normalized 0-1 coordinates for 1920x1080)
// ============================================================

export const VALORANT_HUD_ELEMENTS: HudElement[] = [
  {
    id: 'kill_feed',
    label: 'Kill Feed',
    region: { x: 0.82, y: 0.03, width: 0.17, height: 0.35 },
    readingType: { type: 'text', language: 'en', charWhitelist: undefined },
    pollIntervalMs: 300,
    activeDuringPhases: ['combat'],
  },
  {
    id: 'hp_bar',
    label: 'HP Bar',
    region: { x: 0.44, y: 0.935, width: 0.11, height: 0.018 },
    readingType: {
      type: 'bar',
      emptyColor: { hex: '#1a1a2e' },
      fullColor: { hex: '#4ade80' },
      direction: 'left_to_right',
    },
    pollIntervalMs: 100,
    activeDuringPhases: ['combat'],
  },
  {
    id: 'shield_bar',
    label: 'Shield Bar',
    region: { x: 0.44, y: 0.917, width: 0.11, height: 0.014 },
    readingType: {
      type: 'bar',
      emptyColor: { hex: '#1a1a2e' },
      fullColor: { hex: '#60a5fa' },
      direction: 'left_to_right',
    },
    pollIntervalMs: 100,
    activeDuringPhases: ['combat'],
  },
  {
    id: 'round_timer',
    label: 'Round Timer',
    region: { x: 0.46, y: 0.0, width: 0.08, height: 0.028 },
    readingType: {
      type: 'text',
      language: 'en',
      charWhitelist: '0123456789:',
    },
    pollIntervalMs: 1000,
    activeDuringPhases: ['buy_phase', 'combat'],
  },
  {
    id: 'money',
    label: 'Money',
    region: { x: 0.44, y: 0.895, width: 0.08, height: 0.025 },
    readingType: {
      type: 'number',
      min: 0,
      max: 9999,
    },
    pollIntervalMs: 500,
    activeDuringPhases: ['buy_phase'],
  },
  {
    id: 'crosshair_region',
    label: 'Crosshair Region',
    region: { x: 0.44, y: 0.4, width: 0.11, height: 0.18 },
    readingType: {
      type: 'template_match',
      templateId: 'valorant_hit_marker',
      threshold: 0.7,
    },
    pollIntervalMs: 100,
    activeDuringPhases: ['combat'],
  },
  {
    id: 'ability_bar',
    label: 'Ability Bar',
    region: { x: 0.38, y: 0.94, width: 0.24, height: 0.055 },
    readingType: {
      type: 'classify',
      categories: ['all_available', 'some_used', 'all_used'],
      modelId: 'valorant_ability_classifier',
    },
    pollIntervalMs: 500,
    activeDuringPhases: ['combat'],
  },
];

// ============================================================
// VALORANT PERFORMANCE METRICS
// ============================================================

export const VALORANT_PERFORMANCE_METRICS = [
  {
    id: 'kills',
    label: 'Kills',
    unit: 'count' as const,
    higherIsBetter: true,
    format: 'integer' as const,
  },
  {
    id: 'deaths',
    label: 'Deaths',
    unit: 'count' as const,
    higherIsBetter: false,
    format: 'integer' as const,
  },
  {
    id: 'assists',
    label: 'Assists',
    unit: 'count' as const,
    higherIsBetter: true,
    format: 'integer' as const,
  },
  {
    id: 'kda',
    label: 'K/D/A',
    unit: 'count' as const,
    higherIsBetter: true,
    format: { decimal: { places: 2 } } as const,
  },
  {
    id: 'headshot_pct',
    label: 'HS%',
    unit: 'percentage' as const,
    higherIsBetter: true,
    format: 'percentage' as const,
  },
  {
    id: 'ability_usage_rate',
    label: 'Ability Usage',
    unit: 'percentage' as const,
    higherIsBetter: true,
    format: 'percentage' as const,
  },
  {
    id: 'rounds_won',
    label: 'Rounds Won',
    unit: 'count' as const,
    higherIsBetter: true,
    format: 'integer' as const,
  },
  {
    id: 'rounds_lost',
    label: 'Rounds Lost',
    unit: 'count' as const,
    higherIsBetter: false,
    format: 'integer' as const,
  },
];

// ============================================================
// VALORANT PROCESS NAMES (for auto-detection)
// ============================================================

export const VALORANT_PROCESS_NAMES = ['VALORANT-Win64-Shipping.exe'];
