import type { CoachingReport, GameContext } from '@scrima/shared';
import type { CoachingHistory } from '../../services/coaching/deep-analysis.service.js';
import type { GameKnowledgeService } from '../../services/knowledge/game-knowledge.service.js';
import type {
  DeathDetectionContext,
  PreScreenConfig,
  PromptParts,
  ServerGameConfig,
} from '../types.js';
import {
  COACHABLE_MODES,
  UNSUPPORTED_MODE_MESSAGES,
  VALID_AGENTS,
  VALID_MAPS,
} from './knowledge.js';
import { parseValorantReport } from './parser.js';
import {
  buildCompetitivePrompt,
  buildDeathDetectionPrompt,
  buildDeathmatchPrompt,
  buildSpikeRushPrompt,
} from './prompts.js';
import { buildDeathDetectionSchema, buildValorantReportSchema } from './schema.js';

export function createValorantConfig(): ServerGameConfig {
  let knowledgeService: GameKnowledgeService | null = null;

  return {
    gameId: 'valorant',
    displayName: 'Valorant',

    setKnowledgeService(service: GameKnowledgeService): void {
      knowledgeService = service;
    },

    isCoachableMode(mode: string): boolean {
      return COACHABLE_MODES.has(mode);
    },

    getRejectionMessage(mode: string): string {
      return (
        UNSUPPORTED_MODE_MESSAGES[mode] ?? `Game mode "${mode}" is not supported for coaching.`
      );
    },

    getPreScreenConfig(): PreScreenConfig {
      // Dynamic agent/map lists from knowledge store or static fallback
      const agents = knowledgeService?.isCacheWarmed()
        ? knowledgeService.getActiveDisplayNamesSync('valorant', 'agent')
        : VALID_AGENTS;
      const maps = knowledgeService?.isCacheWarmed()
        ? knowledgeService.getActiveDisplayNamesSync('valorant', 'map')
        : VALID_MAPS;

      return {
        prompt: `Analyze this video recording. Answer THREE things:

1. IS THIS VALORANT? Look for the HUD: ability bar (bottom-center), minimap (top-left), round score (top-center), weapon (bottom-right). If missing → is_valorant=false.

2. WHAT MAP? Look at the EARLIEST frames for a LOADING SCREEN — it displays the map name in large text. Read it exactly. If no loading screen, try distinctive architecture. Valid maps: ${maps.join(', ')}.

3. WHAT AGENT IS THE PLAYER? Look at the FIRST BUY PHASE (earliest gameplay frames).
   - Player's agent portrait: BOTTOM-LEFT of screen
   - Player's 4 ability icons: BOTTOM-CENTER
   - Valid agents: ${agents.join(', ')}
   CRITICAL: After the player dies, the camera SPECTATES A TEAMMATE with a DIFFERENT agent. Only identify from the FIRST buy phase — never from spectating.

Output JSON matching the schema.`,
        schema: {
          type: 'object',
          properties: {
            is_valorant: {
              type: 'boolean',
              description: 'true if Valorant gameplay with HUD visible.',
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            rejection_reason: {
              type: 'string',
              description: 'If is_valorant=false, what you see. If true, empty string.',
            },
            detected_agent: {
              type: 'string',
              enum: [...agents, 'unknown'],
              description: 'Player agent from FIRST buy phase only. "unknown" if unidentifiable.',
            },
            detected_map: {
              type: 'string',
              enum: [...maps, 'unknown'],
              description:
                'Map from loading screen text or landmarks. "unknown" if unidentifiable.',
            },
            agent_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            map_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: [
            'is_valorant',
            'confidence',
            'rejection_reason',
            'detected_agent',
            'detected_map',
            'agent_confidence',
            'map_confidence',
          ],
        },
      };
    },

    buildPrompt(
      context: GameContext,
      trigger: 'manual' | 'weekly_report',
      _sparseInterval: number,
      coachingHistory?: CoachingHistory,
      deathInfo?: DeathDetectionContext,
    ): PromptParts {
      const mode = context.gameMode ?? 'competitive';

      switch (mode) {
        case 'deathmatch':
        case 'team_deathmatch':
          return buildDeathmatchPrompt(context, coachingHistory, knowledgeService);
        case 'spike_rush':
          return buildSpikeRushPrompt(
            context,
            trigger,
            coachingHistory,
            knowledgeService,
            deathInfo,
          );
        default:
          return buildCompetitivePrompt(
            context,
            trigger,
            coachingHistory,
            knowledgeService,
            deathInfo,
          );
      }
    },

    getDeathDetectionSchema(): Record<string, unknown> {
      return buildDeathDetectionSchema(knowledgeService);
    },

    buildDeathDetectionPrompt(
      context: GameContext,
      coachingHistory?: CoachingHistory,
    ): PromptParts {
      return buildDeathDetectionPrompt(context, coachingHistory, knowledgeService);
    },

    getReportSchema(): Record<string, unknown> {
      return buildValorantReportSchema(knowledgeService);
    },

    parseReport(json: Record<string, unknown>): CoachingReport & Record<string, unknown> {
      return parseValorantReport(json);
    },
  };
}
