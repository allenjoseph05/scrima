/**
 * Core game-agnostic types for the Scrima plugin system.
 * Based on Addendum A — Game Plugin Architecture.
 *
 * The engine treats all game-specific data as opaque.
 * Each game plugin defines its own vocabulary.
 */

// ============================================================
// IDENTIFIERS
// ============================================================

/** Unique identifier for a game (e.g., "valorant", "league_of_legends") */
export interface GameId {
  value: string;
}

export function gameId(value: string): GameId {
  return { value };
}

// ============================================================
// GAME GENRE
// ============================================================

export type GameGenre =
  | 'tactical_fps'
  | 'battle_royale'
  | 'moba'
  | 'fighting'
  | 'sports'
  | 'rts'
  | 'card_game'
  | 'racing'
  | 'mmo'
  | 'platformer'
  | { custom: string };

// ============================================================
// EVENT TYPES (game-agnostic)
// ============================================================

/** How much video context a coaching moment needs */
export interface ClipWindow {
  beforeSeconds: number;
  afterSeconds: number;
}

/**
 * A game-defined event type. The engine treats these as opaque.
 * Each game plugin defines its own event vocabulary.
 */
export interface GameEventType {
  /** Machine-readable ID (e.g., "kill", "death", "cs_missed", "goal_conceded") */
  id: string;
  /** Human-readable label */
  label: string;
  /**
   * Whether this event is a "coachable moment" — something the VLM should analyze.
   * A round_start is an event but not coachable. A death is both.
   */
  isCoachable: boolean;
  /**
   * Coaching priority 0.0 - 1.0.
   * Used to prioritize which moments get sent to the VLM.
   */
  coachingPriority: number;
  /** How much video context this event type needs for coaching */
  clipWindow: ClipWindow;
  /** Optional arbitrary metadata schema the plugin can attach */
  metadataSchema?: Record<string, unknown>;
}

/** A detected in-game event. The engine passes these without understanding their contents. */
export interface GameEvent {
  id: string; // UUID
  timestampMs: number;
  eventTypeId: string; // References GameEventType.id
  confidence: number; // 0.0 - 1.0
  detectionSources: string[]; // ["kill_feed_ocr", "hp_bar", "audio"]
  data: Record<string, unknown>; // Game-specific payload (opaque to engine)
}

// ============================================================
// COACHING CATEGORIES (game-agnostic)
// ============================================================

/** A game-defined coaching category. */
export interface CoachingCategory {
  /** Machine-readable ID (e.g., "crosshair_placement", "cs_management") */
  id: string;
  /** Human-readable label */
  label: string;
  /** Longer description for the player */
  description: string;
  /** Icon identifier for the UI (Lucide icon name) */
  icon: string;
  /** Color for the UI (hex) */
  color: string;
}

// ============================================================
// PERFORMANCE METRICS (game-agnostic)
// ============================================================

export type MetricUnit = 'count' | 'percentage' | 'per_minute' | 'seconds' | { custom: string };

export type MetricFormat = 'integer' | 'percentage' | 'duration' | { decimal: { places: number } };

export interface PerformanceMetric {
  id: string;
  label: string;
  unit: MetricUnit;
  higherIsBetter: boolean;
  format: MetricFormat;
}

export interface MetricValue {
  metricId: string;
  value: number;
}

// ============================================================
// GAME PHASES (game-agnostic)
// ============================================================

export interface GamePhaseDefinition {
  id: string; // "buy_phase", "laning_phase", "overtime"
  label: string;
  isActiveGameplay: boolean; // false for menus, loading screens, replays
  isCoachable: boolean; // true for phases where coaching applies
}

// ============================================================
// HUD ELEMENTS (game-agnostic)
// ============================================================

/** Screen region using normalized coordinates (0.0 - 1.0) so they work at any resolution */
export interface ScreenRegion {
  x: number; // 0.0 = left, 1.0 = right
  y: number; // 0.0 = top, 1.0 = bottom
  width: number;
  height: number;
}

export type BarDirection = 'left_to_right' | 'right_to_left' | 'bottom_to_top' | 'top_to_bottom';

export interface Color {
  hex: string; // e.g., "#4ade80"
}

export type HudReadingType =
  | {
      type: 'text';
      language: string;
      charWhitelist?: string;
    }
  | {
      type: 'number';
      min?: number;
      max?: number;
    }
  | {
      type: 'bar';
      emptyColor: Color;
      fullColor: Color;
      direction: BarDirection;
    }
  | {
      type: 'template_match';
      templateId: string;
      threshold: number;
    }
  | {
      type: 'classify';
      categories: string[];
      modelId: string;
    };

/** A HUD element that should be tracked. */
export interface HudElement {
  id: string; // "kill_feed", "gold_counter", "boost_meter"
  label: string;
  region: ScreenRegion; // Normalized 0-1 coords
  readingType: HudReadingType;
  pollIntervalMs: number;
  activeDuringPhases: string[]; // Only read during these game phases
}

export type ReadingValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'percentage'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'category'; value: string };

export interface HudReading {
  elementId: string;
  value: ReadingValue;
}

// ============================================================
// AUDIO SIGNATURES
// ============================================================

export interface AudioSignature {
  id: string; // "kill_sound", "round_end", "spike_beep"
  label: string;
  modelId: string; // References the audio classifier model
  minConfidence: number;
  emitsEventTypeId: string; // Which GameEventType this triggers
}

// ============================================================
// MATCH CONTEXT & COACHING
// ============================================================

/** Engine-provided context about a match (game-agnostic parts) */
export interface MatchContext {
  matchId: string; // UUID
  durationMs: number;
  events: GameEvent[];
  metrics: MetricValue[];
  playerRank?: string;
  playerAgentOrCharacter?: string;
  mapOrArena?: string;
}

/** A moment worth coaching on, selected by the engine based on is_coachable flag */
export interface CoachableMoment {
  event: GameEvent;
  surroundingEvents: GameEvent[]; // Events within ±30s
  clipWindow: ClipWindow;
  gameStateAtMoment: Record<string, unknown>; // PluginState.data
}

/** Result of classifying a coachable moment */
export interface MomentClassification {
  momentIndex: number;
  categoryId: string; // References CoachingCategory.id
  confidence: number;
  briefReason: string;
}

/** A post-game match summary */
export interface MatchSummary {
  gameId: string;
  durationMs: number;
  events: GameEvent[];
  metrics: MetricValue[];
  coachableMoments: CoachableMoment[];
  gameSpecificSummary: Record<string, unknown>; // Plugin-specific data
}

/** Pattern summary from historical data */
export interface PatternSummary {
  gamesAnalyzed: number;
  totalCoachableMoments: number;
  categoryBreakdown: Record<string, number>; // categoryId -> percentage
  topIssues: Array<{
    categoryId: string;
    percentage: number;
    description: string;
  }>;
}

// ============================================================
// COACHING REPORT TYPES
// ============================================================

export type CoachingMomentSeverity = 'critical' | 'moderate' | 'minor';

export interface CoachingMoment {
  timestamp: string; // "4:23"
  round?: number;
  category: string; // coaching category id
  whatHappened: string;
  whatWasWrong: string;
  whatToDo: string;
  severity: CoachingMomentSeverity;
}

export interface CoachingIssue {
  category: string;
  frequency: string;
  description: string;
  drill: string;
}

export interface CoachingReport {
  gameMode?: string;
  overallAssessment: string;
  moments: CoachingMoment[];
  topIssues: CoachingIssue[];
  positiveHighlights: Array<{
    timestamp: string;
    description: string;
  }>;
  /** Returned when the game mode is unsupported — no analysis was performed */
  rejected?: boolean;
  rejectionReason?: string;
}

// ============================================================
// UI CONFIGURATION
// ============================================================

/** Configuration the React UI reads to render game-appropriate dashboard */
export interface GameUIConfig {
  gameId: string;
  displayName: string;
  genre: GameGenre;
  coachingCategories: CoachingCategory[];
  performanceMetrics: PerformanceMetric[];
  gamePhases: GamePhaseDefinition[];
  eventTypes: GameEventType[];
}
