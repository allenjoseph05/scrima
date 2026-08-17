/**
 * VLM Provider interface and related types.
 * Based on Section 5.2 of the Technical Specification.
 *
 * The VlmProvider interface is the key abstraction that prevents vendor lock-in.
 * Start with Gemini, swap to self-hosted later without changing any other code.
 */

import type { CoachingReport, PatternSummary } from './game-plugin.js';

// ============================================================
// VLM INPUT TYPES
// ============================================================

export type VideoInputType = 'file_path' | 'buffer' | 'uri';

export interface VideoInput {
  type: VideoInputType;
  data: string | Uint8Array; // Path, URI, or raw buffer
  mimeType: string;
  durationMs: number;
}

export interface GameContext {
  game: string;
  gameMode?: string; // competitive, deathmatch, spike_rush, etc.
  map: string;
  agent: string; // Agent/character name
  rank: string;
  matchEvents: MatchEventSummary[];
  deathDetails: DeathDetail[];
  economyTimeline: EconomyEntry[];
  abilityUsage: AbilityUsageSummary;
  playerPatterns?: PatternSummary;
}

export interface MatchEventSummary {
  type: string;
  round?: number;
  timestampMs: number;
  won?: boolean;
  data?: Record<string, unknown>;
}

export interface DeathDetail {
  index: number;
  round: number;
  timestampMs: number;
  timestampFormatted: string; // "04:23"
  killer: string;
  weapon: string;
  headshot: boolean;
  hpBefore: number;
  teamAlive: number;
  enemyAlive: number;
  abilitiesAvailable: string[];
  money: number;
  teamMoneyAvg: number;
}

export interface EconomyEntry {
  round: number;
  money: number;
  buyType: 'full_buy' | 'half_buy' | 'eco' | 'force_buy' | 'save';
}

export interface AbilityUsageSummary {
  totalUsed: number;
  totalAvailable: number;
  usageRate: number; // 0.0 - 1.0
  byAbility: Record<string, { used: number; available: number }>;
}

// ============================================================
// VLM RESULT TYPES
// ============================================================

export interface VlmCoachingResult {
  success: boolean;
  coachingReport: CoachingReport;
  tokensUsed: { input: number; output: number; thinking?: number };
  costUsd: number;
  latencyMs: number;
  modelId: string;
}

export interface TokenEstimationInput {
  videoInputs?: VideoInput[];
  promptText: string;
  contextJson?: string;
}

export interface TokenEstimate {
  inputTokens: number;
  estimatedCostUsd: number;
}

// ============================================================
// VLM PROVIDER INTERFACE
// ============================================================

/**
 * Abstract interface for VLM providers.
 * Implementations: GeminiProvider, MockVlmProvider, etc.
 * This is the key abstraction that prevents vendor lock-in.
 */
export interface VlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly maxInputTokens: number;

  /** Analyze a full game video and return coaching report. */
  analyzeFullGame(
    videoPath: string,
    prompt: string,
    context: GameContext,
  ): Promise<VlmCoachingResult>;

  estimateTokens(input: TokenEstimationInput): Promise<TokenEstimate>;
}

// ============================================================
// SERVICE INTERFACES
// ============================================================

export interface DeepCoachingResult {
  matchId: string;
  report: CoachingReport;
  processingTimeMs: number;
  costUsd: number;
}

export interface WeeklyReportResult {
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  matchesAnalyzed: number;
  report: CoachingReport;
  processingTimeMs: number;
  totalCostUsd: number;
}

export interface DeepCoachingService {
  /** Run deep coaching analysis on a full game (Tier 3 pipeline). */
  analyzeGame(
    matchId: string,
    userId: string,
    videoUri: string,
    context: GameContext,
  ): Promise<DeepCoachingResult>;

  /** Generate weekly coaching report aggregating recent patterns. */
  generateWeeklyReport(
    userId: string,
    matchIds: string[],
    historicalPatterns: PatternSummary,
  ): Promise<WeeklyReportResult>;
}

// ============================================================
// USAGE TRACKING
// ============================================================

export type UsageOperation = 'game_analysis' | 'weekly_report';

export interface UsageCheck {
  allowed: boolean;
  remaining?: number;
  resetAt?: Date;
  reason?: string;
}

export interface UsageSummary {
  userId: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  analysesUsed: number;
  analysesLimit: number;
  totalCostUsd: number;
}

export interface UsageService {
  canPerform(userId: string, operation: UsageOperation): Promise<UsageCheck>;
  recordUsage(userId: string, operation: UsageOperation, costUsd: number): Promise<void>;
  getCurrentUsage(userId: string): Promise<UsageSummary>;
}

// ============================================================
// GEMINI MODEL CONFIGS
// ============================================================

export interface GeminiModelConfig {
  id: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  maxInputTokens: number;
}

export const GEMINI_MODELS = {
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    maxInputTokens: 1_000_000,
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.4,
    maxInputTokens: 1_000_000,
  },
} as const satisfies Record<string, GeminiModelConfig>;

export type GeminiModelId = keyof typeof GEMINI_MODELS;
