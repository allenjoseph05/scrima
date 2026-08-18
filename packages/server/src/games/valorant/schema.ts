import type { GameKnowledgeService } from '../../services/knowledge/game-knowledge.service.js';
import { VALID_AGENTS, VALID_MAPS, VALID_WEAPONS } from './knowledge.js';

// Weapon classes accepted as fallback when a specific weapon name can't be
// read. Keeps the enum small but avoids forcing the model to invent a name
// it can't confirm. Matches the stage-1 observation vocabulary.
//
// Declared at module top so the module-load `VALORANT_REPORT_SCHEMA =
// buildSchema(...)` below doesn't hit a temporal-dead-zone reference.
const WEAPON_CLASSES: string[] = ['sidearm', 'rifle', 'sniper', 'smg', 'shotgun', 'heavy', 'melee'];

/**
 * Valorant coaching report JSON schema.
 *
 * IMPORTANT: Keep ALL description strings SHORT. Gemini rejects schemas with
 * too much text — especially inside arrays (text multiplies with maxItems).
 * Detailed instructions belong in the system prompt, not here.
 *
 * When a knowledge service is provided, agent/map enums are generated
 * dynamically from the knowledge store. Otherwise falls back to static lists.
 */
export function buildValorantReportSchema(
  knowledgeService?: GameKnowledgeService | null,
): Record<string, unknown> {
  const agents = knowledgeService?.isCacheWarmed()
    ? knowledgeService.getActiveDisplayNamesSync('valorant', 'agent')
    : VALID_AGENTS;
  const maps = knowledgeService?.isCacheWarmed()
    ? knowledgeService.getActiveDisplayNamesSync('valorant', 'map')
    : VALID_MAPS;

  return buildSchema(agents, maps);
}

/** @deprecated Use buildValorantReportSchema() instead. Kept for backwards compat. */
export const VALORANT_REPORT_SCHEMA = buildSchema(VALID_AGENTS, VALID_MAPS);

/**
 * Death detection schema — Pass 1 of two-pass analysis.
 *
 * Pass 1 only needs to:
 *   1. Validate this is Valorant
 *   2. Identify agent and map
 *   3. Detect all death timestamps with brief observations
 *   4. Provide match overview and strengths
 *
 * No detailed coaching — that's Pass 2's job after clip extraction.
 */
export function buildDeathDetectionSchema(
  knowledgeService?: GameKnowledgeService | null,
): Record<string, unknown> {
  const agents = knowledgeService?.isCacheWarmed()
    ? knowledgeService.getActiveDisplayNamesSync('valorant', 'agent')
    : VALID_AGENTS;
  const maps = knowledgeService?.isCacheWarmed()
    ? knowledgeService.getActiveDisplayNamesSync('valorant', 'map')
    : VALID_MAPS;

  return {
    type: 'object',
    properties: {
      video_validation: {
        type: 'object',
        description: 'Verify this is Valorant gameplay before scanning.',
        properties: {
          is_valorant: { type: 'boolean', description: 'true if Valorant HUD visible.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          rejection_reason: { type: 'string', description: 'Why not Valorant, or empty string.' },
          detected_agent: {
            type: 'string',
            enum: [...agents, 'unknown'],
            description:
              'Player agent from FIRST buy phase — check agent portrait (bottom-left) and ability icons (bottom-center). LOCK this value once set. Spectated teammates after death show DIFFERENT agents — ignore those. Use "unknown" if unclear.',
          },
          detected_map: {
            type: 'string',
            enum: [...maps, 'unknown'],
            description:
              'Map from loading screen text. Do NOT guess from architecture — use "unknown" if you cannot READ the map name. A match has ONE map only.',
          },
        },
        required: [
          'is_valorant',
          'confidence',
          'rejection_reason',
          'detected_agent',
          'detected_map',
        ],
      },

      detected_deaths: {
        type: 'array',
        maxItems: 15,
        description: 'All player deaths detected in the video.',
        items: {
          type: 'object',
          properties: {
            death_number: { type: 'integer', description: 'Sequential (1,2,3...)' },
            approximate_time: { type: 'string', description: 'MM:SS from timestamp overlay.' },
            killed_by_observation: {
              type: 'string',
              description: 'Enemy agent name or "unknown" from death screen.',
            },
            weapon_observation: {
              type: 'string',
              description: 'Weapon name or class from death screen.',
            },
            context_before_death: {
              type: 'string',
              description: 'One sentence: what was the player doing?',
            },
            coaching_priority: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description:
                'How coachable is this death? 5 = clear mistake with actionable fix (bad peek, no utility, wrong position). 4 = likely mistake. 3 = average. 2 = hard to coach (unlucky timing, trades). 1 = uncoachable (eco round loss, team collapse, post-plant retake).',
            },
            round_utility_summary: {
              type: 'string',
              description:
                'Abilities player used EARLIER in this round before dying. Format: "ability@MM:SS: description; ability@MM:SS: description" or empty if none seen.',
            },
          },
          required: [
            'death_number',
            'approximate_time',
            'killed_by_observation',
            'weapon_observation',
            'context_before_death',
            'coaching_priority',
          ],
        },
      },

      match_overview: {
        type: 'object',
        description: 'High-level match summary.',
        properties: {
          total_deaths_observed: { type: 'integer', description: 'Total deaths found in video.' },
          overall_playstyle: { type: 'string', description: '1-2 sentences on playstyle.' },
          observed_strengths: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 3,
            description: 'Good habits observed.',
          },
        },
        required: ['total_deaths_observed', 'overall_playstyle', 'observed_strengths'],
      },
    },
    required: ['video_validation', 'detected_deaths', 'match_overview'],
  };
}

function buildSchema(
  validAgents: string[],
  validMaps: string[],
  validWeapons: string[] = VALID_WEAPONS,
): Record<string, unknown> {
  const weaponEnum = [...validWeapons, ...WEAPON_CLASSES, 'unknown'];
  const killerEnum = [...validAgents, 'an enemy'];
  return {
    type: 'object',
    properties: {
      video_validation: {
        type: 'object',
        description: 'Verify this is Valorant gameplay before coaching.',
        properties: {
          is_valorant: { type: 'boolean', description: 'true if Valorant HUD visible.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          rejection_reason: { type: 'string', description: 'Why not Valorant, or empty string.' },
          detected_agent: {
            type: 'string',
            enum: [...validAgents, 'unknown'],
            description:
              'Player agent from FIRST buy phase — agent portrait (bottom-left) and ability icons (bottom-center). LOCK once set. Spectated teammates after death are DIFFERENT agents — ignore them. Use "unknown" if unclear.',
          },
          detected_map: {
            type: 'string',
            enum: [...validMaps, 'unknown'],
            description:
              'Map from loading screen text. Do NOT guess from architecture. A match has ONE map. Use "unknown" if not readable.',
          },
        },
        required: [
          'is_valorant',
          'confidence',
          'rejection_reason',
          'detected_agent',
          'detected_map',
        ],
      },

      death_coaching: {
        type: 'array',
        maxItems: 8,
        description: 'Up to 8 most coaching-relevant deaths showing different mistakes.',
        items: {
          type: 'object',
          properties: {
            death_number: { type: 'integer', description: 'Sequential (1,2,3...)' },
            approximate_time: { type: 'string', description: 'MM:SS from timestamp overlay.' },
            situation: { type: 'string', description: 'What the player was doing and where.' },
            mistake: { type: 'string', description: 'Root cause, not symptom.' },
            correction: { type: 'string', description: 'What to do instead, with mechanic.' },
            category: {
              type: 'string',
              enum: [
                'crosshair',
                'positioning',
                'utility',
                'economy',
                'movement',
                'game_sense',
                'peeking',
                'trading',
                'unclear',
              ],
            },
            avoidable: { type: 'boolean', description: 'true=clear error, false=fair duel.' },
            weapon_used: {
              type: 'string',
              enum: weaponEnum,
              description: 'Weapon name from allowlist, a weapon class, or "unknown".',
            },
            weapon_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
            killed_by: {
              type: 'string',
              enum: killerEnum,
              description: 'Killer agent from allowlist, or "an enemy" if unreadable.',
            },
            killed_by_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
            visual_evidence: { type: 'string', description: 'What you see on screen.' },
          },
          required: [
            'death_number',
            'approximate_time',
            'situation',
            'mistake',
            'correction',
            'category',
            'avoidable',
            'weapon_used',
            'weapon_confidence',
            'killed_by',
            'killed_by_confidence',
            'visual_evidence',
          ],
        },
      },

      priority_pattern: {
        type: 'object',
        description: 'Single most important pattern from 2+ deaths.',
        properties: {
          category: {
            type: 'string',
            enum: [
              'crosshair',
              'positioning',
              'utility',
              'economy',
              'movement',
              'game_sense',
              'peeking',
              'trading',
            ],
          },
          death_count: { type: 'integer', description: 'Deaths showing this pattern.' },
          title: { type: 'string', description: '5-8 word specific title.' },
          what_happened: { type: 'string', description: 'Recurring behavior observed.' },
          why_it_hurts: { type: 'string', description: 'Why this costs rounds.' },
          fix: { type: 'string', description: 'When [trigger], do [action].' },
        },
        required: ['category', 'death_count', 'title', 'what_happened', 'why_it_hurts', 'fix'],
      },

      secondary_patterns: {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [
                'crosshair',
                'positioning',
                'utility',
                'economy',
                'movement',
                'game_sense',
                'peeking',
                'trading',
              ],
            },
            death_count: { type: 'integer' },
            title: { type: 'string' },
            what_happened: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['category', 'death_count', 'title', 'what_happened', 'fix'],
        },
      },

      strengths: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', description: 'Specific correct habit observed.' },
      },

      session_focus: {
        type: 'object',
        properties: {
          drill_name: { type: 'string', description: 'Short drill name.' },
          drill_steps: { type: 'string', description: 'Step-by-step practice routine.' },
          drill_duration_minutes: { type: 'integer' },
          in_game_cue: { type: 'string', description: 'One concrete action trigger per round.' },
        },
        required: ['drill_name', 'drill_steps', 'drill_duration_minutes', 'in_game_cue'],
      },

      match_verdict: {
        type: 'string',
        description: '2-3 sentence summary with #1 takeaway.',
      },

      coaching_continuity: {
        type: 'object',
        description: 'Comment on coaching journey and active challenge.',
        properties: {
          progress_note: {
            type: 'string',
            description: '1-2 sentences on progress.',
          },
        },
        required: ['progress_note'],
      },
    },
    required: [
      'video_validation',
      'death_coaching',
      'priority_pattern',
      'secondary_patterns',
      'strengths',
      'session_focus',
      'match_verdict',
      'coaching_continuity',
    ],
  };
}
