/**
 * Prompt Builder — thin orchestrator that delegates to game modules.
 *
 * All game-specific knowledge (agents, economy, maps, prompts, schemas)
 * lives in packages/server/src/games/<game>/.
 * This file routes to the correct game module based on context.game.
 */

import type { GameContext } from '@scrima/shared';
import { gameRegistry } from '../../games/registry.js';
import type { DeathDetectionContext } from '../../games/types.js';
import type { CoachingHistory } from '../coaching/deep-analysis.service.js';

// Re-export PromptParts from the canonical location
export type { PromptParts } from '../../games/types.js';

export class PromptBuilder {
  /** Build the full prompt (system instruction + user prompt) for a game analysis. */
  static buildGameAnalysisPrompt(
    context: GameContext,
    trigger: 'manual' | 'weekly_report' = 'manual',
    sparseInterval = 1,
    coachingHistory?: CoachingHistory,
    deathInfo?: DeathDetectionContext,
  ): { systemInstruction: string; userPrompt: string } {
    const gameId = context.game ?? 'valorant';
    const game = gameRegistry.getOrThrow(gameId);
    return game.buildPrompt(context, trigger, sparseInterval, coachingHistory, deathInfo);
  }

  /** Check if a game mode is coachable. */
  static isCoachableMode(gameId: string, mode: string): boolean {
    const game = gameRegistry.get(gameId);
    return game?.isCoachableMode(mode) ?? false;
  }

  /** Get rejection message for unsupported modes. */
  static getRejectionMessage(gameId: string, mode: string): string {
    const game = gameRegistry.get(gameId);
    return game?.getRejectionMessage(mode) ?? `Game mode "${mode}" is not supported for coaching.`;
  }

  /** Build the death detection prompt (Pass 1 of two-pass analysis). */
  static buildDeathDetectionPrompt(
    context: GameContext,
    coachingHistory?: CoachingHistory,
  ): { systemInstruction: string; userPrompt: string } {
    const gameId = context.game ?? 'valorant';
    const game = gameRegistry.getOrThrow(gameId);
    return game.buildDeathDetectionPrompt(context, coachingHistory);
  }

  /** Get the death detection schema (Pass 1 of two-pass analysis). */
  static getDeathDetectionSchema(gameId: string): Record<string, unknown> {
    return gameRegistry.getOrThrow(gameId).getDeathDetectionSchema();
  }

  /** Get the structured output JSON schema for a game. */
  static getReportSchema(gameId: string): Record<string, unknown> {
    return gameRegistry.getOrThrow(gameId).getReportSchema();
  }
}
