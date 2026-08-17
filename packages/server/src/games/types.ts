import type { CoachingReport, GameContext } from '@scrima/shared';
import type { CoachingHistory } from '../services/coaching/deep-analysis.service.js';
import type { GameKnowledgeService } from '../services/knowledge/game-knowledge.service.js';

export interface PromptParts {
  systemInstruction: string;
  userPrompt: string;
}

/**
 * Death detection results passed into the prompt builder so the VLM
 * receives pre-identified death timestamps instead of scanning the full video.
 * When present, the VLM analyzes pre-cut clips rather than the full recording.
 */
export interface DeathDetectionContext {
  deaths: { timestampSec: number; confidence: number; durationFrames: number }[];
  clipMap: {
    label: string;
    concatStartSec: number;
    concatEndSec: number;
    originalDeathSec: number;
  }[];
  /** Total duration of the original (unclipped) video in seconds */
  originalDurationSec: number;
}

/**
 * Each supported game implements this interface.
 * The server routes to the correct game module based on `context.game`.
 */
export interface PreScreenConfig {
  prompt: string;
  schema: Record<string, unknown>;
}

export interface ServerGameConfig {
  readonly gameId: string;
  readonly displayName: string;

  /** Inject the knowledge service (called once at startup or after sync). */
  setKnowledgeService(service: GameKnowledgeService): void;

  // Mode management
  isCoachableMode(mode: string): boolean;
  getRejectionMessage(mode: string): string;

  // Pre-screen: cheap validation + agent/map detection
  getPreScreenConfig(): PreScreenConfig;

  // Prompt building
  buildPrompt(
    context: GameContext,
    trigger: 'manual' | 'weekly_report',
    sparseInterval: number,
    coachingHistory?: CoachingHistory,
    deathInfo?: DeathDetectionContext,
  ): PromptParts;

  // Death detection schema (Pass 1 of two-pass analysis)
  getDeathDetectionSchema(): Record<string, unknown>;

  // Death detection prompt (Pass 1)
  buildDeathDetectionPrompt(context: GameContext, coachingHistory?: CoachingHistory): PromptParts;

  // Structured output schema (Gemini responseJsonSchema)
  getReportSchema(): Record<string, unknown>;

  // Response parsing (VLM JSON → canonical CoachingReport)
  parseReport(json: Record<string, unknown>): CoachingReport & Record<string, unknown>;
}
