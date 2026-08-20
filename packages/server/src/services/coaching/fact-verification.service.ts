/**
 * Coaching Enrichment Service
 *
 * Two modes:
 *
 * 1. FULL COACHING (primary mode):
 *    After the main VLM detects deaths (timestamps only) from low-res video,
 *    the client extracts high-res frames at those timestamps. This service
 *    receives those frames and produces the COMPLETE coaching report —
 *    situation analysis, mistake identification, corrections, patterns, drills.
 *    Cost: ~$0.03-0.05 per analysis.
 *
 * 2. FACT VERIFICATION (legacy mode):
 *    Rewrites coaching text with verified facts from high-res frames.
 *    Used as a fallback if full coaching fails.
 *    Cost: ~$0.005-0.008 per analysis.
 *
 * Entirely graceful — if anything fails, the original data is preserved.
 */

import sharp from 'sharp';
import { env } from '../../config/env.js';
import {
  AGENTS,
  VALID_AGENTS,
  VALID_MAPS,
  VALID_WEAPONS,
  VALORANT_ECONOMY,
  VALORANT_MECHANICS,
  VALORANT_ROUND,
} from '../../games/valorant/knowledge.js';
import { formatCoachingHistoryBlock, mapCalloutsBlock } from '../../games/valorant/prompts.js';
import type { GeminiProvider } from '../vlm/gemini.provider.js';
import type { ExtractedImage } from './clip-builder.js';
import type { CoachingHistory } from './deep-analysis.service.js';
import {
  type ExtractedFrame,
  buildFrameRequests,
  extractFrames,
  parseTimestamp,
} from './frame-extractor.js';

// ── Agent ID frame cropping (server-side) ────────────────────────────────────
// Full 720p frames have tiny agent portrait / ability icons. We crop them
// server-side so Gemini gets zoomed-in views for reliable identification.
// Crop regions match the Valorant HUD layout at 1280×720.

/** Crop the agent portrait (bottom-left ~18% of screen) */
async function cropAgentPortrait(base64: string): Promise<string> {
  const buf = Buffer.from(base64, 'base64');
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 1280;
  const h = meta.height ?? 720;
  // Agent portrait + name text: bottom-left corner. Wide enough to capture
  // the agent name text displayed beside/above the portrait icon.
  const cropW = Math.round(w * 0.18);
  const cropH = Math.round(h * 0.22);
  const left = 0;
  const top = h - cropH;
  const cropped = await sharp(buf)
    .extract({ left, top, width: cropW, height: cropH })
    .jpeg({ quality: 95 })
    .toBuffer();
  return cropped.toString('base64');
}

/** Crop the ability bar (bottom-center ~30% wide, 10% tall) */
async function cropAbilityBar(base64: string): Promise<string> {
  const buf = Buffer.from(base64, 'base64');
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 1280;
  const h = meta.height ?? 720;
  // Ability bar: bottom-center of screen
  const cropW = Math.round(w * 0.3);
  const cropH = Math.round(h * 0.1);
  const left = Math.round(w * 0.35);
  const top = Math.round(h * 0.88);
  const cropped = await sharp(buf)
    .extract({ left, top, width: cropW, height: cropH })
    .jpeg({ quality: 95 })
    .toBuffer();
  return cropped.toString('base64');
}

/** Crop the minimap (top-left corner) for map identification */
async function cropMinimap(base64: string): Promise<string> {
  const buf = Buffer.from(base64, 'base64');
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 1280;
  const h = meta.height ?? 720;
  // Minimap: top-left corner ~20%×30% of screen
  const cropW = Math.round(w * 0.18);
  const cropH = Math.round(h * 0.32);
  const cropped = await sharp(buf)
    .extract({ left: 0, top: 0, width: cropW, height: cropH })
    .jpeg({ quality: 95 })
    .toBuffer();
  return cropped.toString('base64');
}

// ── Ability bar brightness analysis ──────────────────────────────────────────
// Splits the ability bar crop into 4 quadrants (one per ability slot: C, Q, E, X)
// and measures average brightness. Bright = available, dark = used/cooldown.
// Combined with the known agent name, we can tell the VLM exactly which abilities
// were available at death instead of asking it to read tiny icons.

interface AbilitySlotState {
  slot: number; // 0-3 (C, Q, E, X)
  brightness: number; // 0-255 average
  available: boolean; // true if brightness exceeds threshold
}

interface AbilityBarAnalysis {
  slots: AbilitySlotState[];
  availableCount: number;
  summary: string; // e.g., "2/4 abilities available (slots 1,3 lit, slots 2,4 dark)"
}

/**
 * Analyze the ability bar from a full game frame.
 * Crops the ability bar region, splits into 4 slots, measures brightness.
 * Returns per-slot availability state.
 */
async function analyzeAbilityBar(frameBase64: string): Promise<AbilityBarAnalysis | null> {
  try {
    const buf = Buffer.from(frameBase64, 'base64');
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 1280;
    const h = meta.height ?? 720;

    // Ability bar region (same as cropAbilityBar but we need raw pixels)
    const barW = Math.round(w * 0.3);
    const barH = Math.round(h * 0.1);
    const barLeft = Math.round(w * 0.35);
    const barTop = Math.round(h * 0.88);

    // Extract and convert to grayscale raw pixels
    const { data: rawPixels, info } = await sharp(buf)
      .extract({ left: barLeft, top: barTop, width: barW, height: barH })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const slotWidth = Math.floor(info.width / 4);
    const slots: AbilitySlotState[] = [];

    for (let slot = 0; slot < 4; slot++) {
      let totalBrightness = 0;
      let pixelCount = 0;

      for (let y = 0; y < info.height; y++) {
        for (let x = slot * slotWidth; x < (slot + 1) * slotWidth && x < info.width; x++) {
          totalBrightness += rawPixels[y * info.width + x];
          pixelCount++;
        }
      }

      const brightness = pixelCount > 0 ? totalBrightness / pixelCount : 0;
      slots.push({ slot, brightness, available: false }); // threshold set below
    }

    // Determine threshold: use relative comparison
    // The brightest slot is likely available; significantly darker ones are used/cooldown
    const maxBright = Math.max(...slots.map((s) => s.brightness));
    const minBright = Math.min(...slots.map((s) => s.brightness));
    const range = maxBright - minBright;

    // If all slots are similar brightness (range < 15), they're likely all in the same state
    if (range < 15) {
      // All similar — check if bright (all available) or dark (all used)
      const allAvailable = maxBright > 80;
      for (const s of slots) s.available = allAvailable;
    } else {
      // Use adaptive threshold: midpoint between min and max
      const threshold = minBright + range * 0.4;
      for (const s of slots) s.available = s.brightness > threshold;
    }

    const availableCount = slots.filter((s) => s.available).length;
    const litSlots = slots
      .filter((s) => s.available)
      .map((s) => s.slot + 1)
      .join(',');
    const darkSlots = slots
      .filter((s) => !s.available)
      .map((s) => s.slot + 1)
      .join(',');
    const summary = `${availableCount}/4 abilities available${litSlots ? ` (slots ${litSlots} lit` : ''}${darkSlots ? `, slots ${darkSlots} dark)` : ')'}`;

    return { slots, availableCount, summary };
  } catch {
    return null;
  }
}

/**
 * Compare ability bar state between an early frame and a late (predeath) frame.
 * Returns a description of what changed: abilities used during the fight.
 */
function compareAbilityStates(
  early: AbilityBarAnalysis | null,
  late: AbilityBarAnalysis | null,
  agentName: string,
): string {
  if (!late) return 'Ability bar state: unknown (could not analyze).';
  if (!early) return `At death: ${late.summary}.`;

  // Find abilities that changed from available to unavailable
  const used: number[] = [];
  const stillAvailable: number[] = [];
  const alreadyUsed: number[] = [];

  for (let i = 0; i < 4; i++) {
    const e = early.slots[i];
    const l = late.slots[i];
    if (e?.available && !l?.available) {
      used.push(i + 1);
    } else if (l?.available) {
      stillAvailable.push(i + 1);
    } else {
      alreadyUsed.push(i + 1);
    }
  }

  // Look up ability names from the agent's kit
  // AGENTS is Record<string, AgentInfo> where abilities is a multiline string like:
  // "C Cloudburst (200cr): ...\nQ Updraft (150cr): ...\nE Tailwind (free): ...\nX Blade Storm: ..."
  const agentKey = agentName.toLowerCase();
  const agentData = AGENTS[agentKey];
  const slotKeys = ['C', 'Q', 'E', 'X'];
  const slotLabels = ['C', 'Q', 'E', 'X (Ultimate)'];

  // Parse ability names from the abilities string
  const abilityNames: Record<string, string> = {};
  if (agentData?.abilities) {
    for (const line of agentData.abilities.split('\n')) {
      const m = line.match(/^([CQEX])\s+(\w[\w\s'-]*?)(?:\s*\(|:)/);
      if (m) abilityNames[m[1]] = m[2].trim();
    }
  }

  const nameSlot = (slot: number) => {
    const key = slotKeys[slot - 1];
    const name = abilityNames[key];
    return name ? `${slotLabels[slot - 1]}: ${name}` : slotLabels[slot - 1];
  };

  const parts: string[] = [];
  if (used.length > 0) {
    parts.push(`USED during fight: ${used.map(nameSlot).join(', ')}`);
  }
  if (stillAvailable.length > 0) {
    parts.push(`AVAILABLE at death (not used): ${stillAvailable.map(nameSlot).join(', ')}`);
  }
  if (alreadyUsed.length > 0) {
    parts.push(`Already on cooldown: ${alreadyUsed.map(nameSlot).join(', ')}`);
  }

  return `Ability tracking: ${parts.join(' | ')}`;
}

/** Generate zoomed crops from agent_id frames for better identification */
async function generateAgentIdCrops(
  agentIdFrames: { label: string; base64: string; timestampSec: number; mimeType: string }[],
) {
  const crops: { label: string; base64: string; timestampSec: number; mimeType: string }[] = [];
  for (const frame of agentIdFrames) {
    try {
      const [portrait, abilityBar, minimap] = await Promise.all([
        cropAgentPortrait(frame.base64),
        cropAbilityBar(frame.base64),
        cropMinimap(frame.base64),
      ]);
      crops.push(
        {
          label: `${frame.label}_crop_portrait`,
          base64: portrait,
          timestampSec: frame.timestampSec,
          mimeType: 'image/jpeg',
        },
        {
          label: `${frame.label}_crop_ability_bar`,
          base64: abilityBar,
          timestampSec: frame.timestampSec,
          mimeType: 'image/jpeg',
        },
        {
          label: `${frame.label}_crop_minimap`,
          base64: minimap,
          timestampSec: frame.timestampSec,
          mimeType: 'image/jpeg',
        },
      );
    } catch (err) {
      console.warn('[FullCoaching] failed to crop agent_id frame %s:', frame.label, err);
    }
  }
  return crops;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface VerifiedDeath {
  death_number: number;
  weapon_used: string | null;
  weapon_confidence: 'certain' | 'uncertain';
  killed_by: string | null;
  killed_by_confidence: 'certain' | 'uncertain';
  map_location: string | null;
  abilities_available: string[];
  /** Enriched coaching text — rewritten with facts from high-res frames */
  situation?: string;
  mistake?: string;
  correction?: string;
}

export interface VerifiedBuyPhase {
  frame_label: string;
  credits_visible: number;
  weapon_purchased: string;
}

export interface VerifiedPlayerAgent {
  name: string;
  confidence: 'certain' | 'uncertain';
  evidence: string;
}

export interface VerificationResult {
  deaths: VerifiedDeath[];
  buyPhases: VerifiedBuyPhase[];
  playerAgent: VerifiedPlayerAgent | null;
  costUsd: number;
  tokensUsed: { input: number; output: number };
}

export interface FullCoachingResult {
  deathCoaching: any[];
  priorityPattern: any;
  secondaryPatterns: any[];
  strengths: string[];
  sessionFocus: any;
  matchVerdict: string;
  coachingContinuity: any;
  playerAgent: VerifiedPlayerAgent | null;
  verifiedMap: string;
  costUsd: number;
  tokensUsed: { input: number; output: number };
}

// ── Full Coaching Schema (enrichment does ALL coaching from high-res frames) ─

// Pass 2 verifies agent/map from high-res frames and produces the full coaching
// report. Agent/map/killed_by are enum-constrained to VALID_AGENTS/VALID_MAPS
// to prevent hallucinated names.

function buildFullCoachingSchemaLegacy(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      verified_agent: {
        type: 'object',
        description: 'Player agent identified from agent_id frames.',
        properties: {
          agent_name: {
            type: 'string',
            enum: [...VALID_AGENTS, 'unknown'],
            description: 'Agent name from portrait or ability bar icons.',
          },
          confidence: { type: 'string', enum: ['certain', 'uncertain'] },
        },
        required: ['agent_name', 'confidence'],
      },
      verified_map: {
        type: 'object',
        description: 'Map identified from minimap crops.',
        properties: {
          map_name: {
            type: 'string',
            enum: [...VALID_MAPS, 'unknown'],
            description: 'Map name from minimap or "unknown".',
          },
          confidence: { type: 'string', enum: ['certain', 'uncertain'] },
        },
        required: ['map_name', 'confidence'],
      },
      death_coaching: {
        type: 'array',
        maxItems: 8,
        description: 'Coaching for up to 8 deaths. Each must cover a different mistake.',
        items: {
          type: 'object',
          properties: {
            death_number: { type: 'integer' },
            approximate_time: { type: 'string', description: 'MM:SS from video.' },
            situation: {
              type: 'string',
              description:
                'What the player was doing — position, weapon, intent. No frame timestamps. 2-3 sentences.',
            },
            mistake: {
              type: 'string',
              description: 'Root cause decision error and why it was wrong. 1-2 sentences.',
            },
            correction: {
              type: 'string',
              description: 'Concrete rule: when [trigger], do [action]. 1-2 sentences.',
            },
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
            avoidable: {
              type: 'boolean',
              description: 'true if clear mistake, false if fair duel.',
            },
            weapon_used: { type: 'string', description: 'Weapon read from death screen or HUD.' },
            weapon_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
            killed_by: {
              type: 'string',
              enum: [...VALID_AGENTS, 'an enemy', 'unknown'],
              description: 'Enemy agent from death banner.',
            },
            killed_by_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
            visual_evidence: {
              type: 'string',
              description: 'Internal: what frames show (with timestamps). Not shown to player.',
            },
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
        description: 'The #1 recurring bad habit seen in 2+ deaths.',
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
          death_count: { type: 'integer', description: 'How many deaths showed this pattern.' },
          title: { type: 'string', description: 'Specific 5-8 word habit title.' },
          what_happened: {
            type: 'string',
            description: 'What the player kept doing wrong across deaths.',
          },
          why_it_hurts: { type: 'string', description: 'Why this habit costs rounds.' },
          fix: { type: 'string', description: 'Rule: when [trigger], do [action].' },
        },
        required: ['category', 'death_count', 'title', 'what_happened', 'why_it_hurts', 'fix'],
      },
      secondary_patterns: {
        type: 'array',
        maxItems: 2,
        description: 'Up to 2 other patterns.',
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
            title: { type: 'string', description: 'Specific habit title.' },
            what_happened: { type: 'string', description: 'What the player kept doing wrong.' },
            fix: { type: 'string', description: 'Rule: when [trigger], do [action].' },
          },
          required: ['category', 'death_count', 'title', 'what_happened', 'fix'],
        },
      },
      strengths: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', description: 'Specific good habit observed in the gameplay.' },
      },
      session_focus: {
        type: 'object',
        description: 'Practice drill targeting the priority pattern.',
        properties: {
          drill_name: { type: 'string', description: 'Drill name.' },
          drill_steps: {
            type: 'string',
            description: 'Step-by-step practice routine with sets and goals.',
          },
          drill_duration_minutes: { type: 'integer' },
          in_game_cue: {
            type: 'string',
            description: 'Short phrase to say before each round (max 8 words).',
          },
        },
        required: ['drill_name', 'drill_steps', 'drill_duration_minutes', 'in_game_cue'],
      },
      match_verdict: { type: 'string', description: '2-3 sentence coaching summary of the match.' },
      coaching_continuity: {
        type: 'object',
        description: 'Progress note on coaching journey.',
        properties: {
          progress_note: { type: 'string', description: '1-2 sentences on progress.' },
        },
        required: ['progress_note'],
      },
    },
    required: [
      'verified_agent',
      'verified_map',
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

// ── Multi-Phase Schemas ─────────────────────────────────────────────────────

/** Phase A: Agent + Map identification from agent_id frames only */
function buildIdentitySchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      agent_name: {
        type: 'string',
        enum: [...VALID_AGENTS, 'unknown'],
        description: 'Player agent name read from portrait text or ability bar icons.',
      },
      agent_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
      agent_evidence: {
        type: 'string',
        description:
          'What visual evidence you used to identify the agent (portrait text, ability icons, etc.).',
      },
      map_name: {
        type: 'string',
        enum: [...VALID_MAPS, 'unknown'],
        description: 'Map name identified from minimap layout.',
      },
      map_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
    },
    required: ['agent_name', 'agent_confidence', 'agent_evidence', 'map_name', 'map_confidence'],
  };
}

/** Phase B: Single death coaching analysis */
function buildPerDeathSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      death_number: { type: 'integer' },
      approximate_time: { type: 'string', description: 'MM:SS from video.' },
      // ── Ability observation FIRST — model must report ability state before categorizing ──
      ability_observation: {
        type: 'object',
        description:
          'REQUIRED FIRST STEP: Report what the ability bar shows BEFORE analyzing the death.',
        properties: {
          abilities_on_cooldown: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Ability NAMES that are dark/used/on cooldown in the frames. These were ALREADY USED by the player.',
          },
          abilities_available: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Ability NAMES still lit/available at the death moment. Player had them but did NOT use them.',
          },
          ability_bar_readable: {
            type: 'boolean',
            description: 'Could you read the ability bar clearly?',
          },
          observation_note: {
            type: 'string',
            description: 'Brief note on what you observed about ability usage in the frames.',
          },
        },
        required: [
          'abilities_on_cooldown',
          'abilities_available',
          'ability_bar_readable',
          'observation_note',
        ],
      },
      situation: {
        type: 'string',
        description:
          'What the player was doing — position, weapon, intent. No frame timestamps. 2-3 sentences.',
      },
      mistake: {
        type: 'string',
        description:
          'Root cause decision error and why it was wrong. MUST be consistent with ability_observation above. 1-2 sentences.',
      },
      correction: {
        type: 'string',
        description: 'Concrete rule: when [trigger], do [action]. 1-2 sentences.',
      },
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
        description:
          'MUST be consistent with ability_observation. If abilities were on cooldown (used), this death CANNOT be "utility" for those abilities.',
      },
      avoidable: { type: 'boolean', description: 'true if clear mistake, false if fair duel.' },
      weapon_used: { type: 'string', description: 'Weapon read from death screen or HUD.' },
      weapon_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
      killed_by: {
        type: 'string',
        enum: [...VALID_AGENTS, 'an enemy', 'unknown'],
        description: 'Enemy agent from death banner.',
      },
      killed_by_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
      abilities_confidence: { type: 'string', enum: ['certain', 'uncertain'] },
      map_location: { type: 'string', description: 'Map callout where the player died.' },
      visual_evidence: {
        type: 'string',
        description: 'Internal: what frames show (with timestamps). Not shown to player.',
      },
    },
    required: [
      'death_number',
      'approximate_time',
      'ability_observation',
      'situation',
      'mistake',
      'correction',
      'category',
      'avoidable',
      'weapon_used',
      'weapon_confidence',
      'killed_by',
      'killed_by_confidence',
      'abilities_confidence',
      'visual_evidence',
    ],
  };
}

/** Phase C: Pattern synthesis from death coaching text (no images) */
function buildSynthesisSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      priority_pattern: {
        type: 'object',
        description: 'The #1 recurring bad habit seen in 2+ deaths.',
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
          death_count: { type: 'integer', description: 'How many deaths showed this pattern.' },
          title: { type: 'string', description: 'Specific 5-8 word habit title.' },
          what_happened: {
            type: 'string',
            description: 'What the player kept doing wrong across deaths.',
          },
          why_it_hurts: { type: 'string', description: 'Why this habit costs rounds.' },
          fix: { type: 'string', description: 'Rule: when [trigger], do [action].' },
        },
        required: ['category', 'death_count', 'title', 'what_happened', 'why_it_hurts', 'fix'],
      },
      secondary_patterns: {
        type: 'array',
        maxItems: 2,
        description: 'Up to 2 other patterns.',
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
            title: { type: 'string', description: 'Specific habit title.' },
            what_happened: { type: 'string', description: 'What the player kept doing wrong.' },
            fix: { type: 'string', description: 'Rule: when [trigger], do [action].' },
          },
          required: ['category', 'death_count', 'title', 'what_happened', 'fix'],
        },
      },
      strengths: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: { type: 'string', description: 'Specific good habit observed in the gameplay.' },
      },
      session_focus: {
        type: 'object',
        description: 'Practice drill targeting the priority pattern.',
        properties: {
          drill_name: { type: 'string', description: 'Drill name.' },
          drill_steps: {
            type: 'string',
            description: 'Step-by-step practice routine with sets and goals.',
          },
          drill_duration_minutes: { type: 'integer' },
          in_game_cue: {
            type: 'string',
            description: 'Short phrase to say before each round (max 8 words).',
          },
        },
        required: ['drill_name', 'drill_steps', 'drill_duration_minutes', 'in_game_cue'],
      },
      match_verdict: { type: 'string', description: '2-3 sentence coaching summary of the match.' },
      coaching_continuity: {
        type: 'object',
        description: 'Progress note on coaching journey.',
        properties: {
          progress_note: { type: 'string', description: '1-2 sentences on progress.' },
        },
        required: ['progress_note'],
      },
    },
    required: [
      'priority_pattern',
      'secondary_patterns',
      'strengths',
      'session_focus',
      'match_verdict',
      'coaching_continuity',
    ],
  };
}

// ── Full Coaching Prompt ────────────────────────────────────────────────────

// Anti-hallucination rules adapted for high-res enrichment frames (4x crop zoom)
const ENRICHMENT_ANTI_HALLUCINATION = `═══ WHAT YOU CAN AND CANNOT SEE (HIGH-RES CROPS) ═══
These are 4x zoomed crops from high-resolution screenshots — NOT 720p video.
You CAN see much more than in a video pass:
  ✓ Death banner text ("ELIMINATED BY [agent]" + weapon name)
  ✓ Kill feed entries (weapon icons, agent names)
  ✓ Weapon HUD text (bottom-right)
  ✓ Ability bar (lit = available, dark = used/cooldown)
  ✓ Minimap details (player position, callout areas)
  ✓ Crosshair placement relative to walls/corners
  ✓ Player position (behind cover or exposed)
  ✓ Movement direction across temporal sequence
  ✓ Large and small ability effects

You still CANNOT reliably see:
  ✗ Exact HP numbers (too small even in crops)
  ✗ Round timer values
  ✗ Exact player names (only agent names)

═══ WEAPONS & ENEMY AGENTS — STRICT IDENTIFICATION RULES ═══
WEAPONS:
  • CHECK crop_deathbanner FIRST — the weapon name is displayed in the death screen
  • CHECK crop_weapon_hud — shows what the PLAYER was holding
  • If you can CLEARLY read the weapon name → use it with confidence "certain"
  • If ambiguous → use the weapon CLASS: "unknown_rifle", "unknown_sidearm", "unknown_smg", "unknown_sniper", "unknown_shotgun"
  • Common confusion: Sheriff ≠ Classic (revolver vs semi-auto), Phantom ≠ Vandal. When unsure, use "uncertain".

ENEMY AGENTS:
  • CHECK crop_deathbanner FIRST — "ELIMINATED BY [AGENT]" in large text
  • If you can CLEARLY read the agent name → use it with confidence "certain"
  • If you CANNOT read it → say "an enemy" with confidence "uncertain"
  • Do NOT guess from kill feed icons alone — trust the death banner text

ABILITIES — STRICT VISUAL-ONLY RULE:
  • Report ONLY what you can SEE in the ability bar crop: lit icons = available, dark/grayed = used/cooldown.
  • Do NOT use your knowledge of the agent's kit to INFER ability states. For example, if you identify the player as Jett, do NOT assume Tailwind (E) is available just because "Jett usually has dash." READ the actual icon brightness.
  • If the ability bar crop is blurry, too dark, or icons are ambiguous → set abilities_confidence to "uncertain" and abilities_available to [].
  • NEVER fill in abilities based on what the agent "should" have. Only report what the pixels show.

  ⚠️ EMPTY ABILITY BAR INTERPRETATION:
  • If ALL 4 ability icons are DARK/GRAYED → the player ALREADY USED their abilities before dying.
  • This is NOT a mistake — it means the player DID use their utility. Do NOT say "didn't use abilities."
  • Only criticize unused abilities if you can see ready (lit, full saturation) ability icons in the predeath frame
    that the player failed to use before dying.
  • An empty bar near death = utility was expended (often a GOOD sign).`;

// Coaching quality rules for enrichment (same standards as main prompts)
const ENRICHMENT_COACHING_DEPTH = `═══ COACHING QUALITY ═══

You are a paid VOD coach — not a match summarizer. The player is PAYING for this.
Every sentence must teach something the player could NOT figure out alone.

═══ BANNED LANGUAGE — IMMEDIATE REJECTION ═══
NEVER use these words or phrases in ANY output field:
  likely, probably, possibly, perhaps, maybe, might have, could have been,
  appears to, seems to, it looks like, unclear, not clear, hard to tell,
  it's possible that, may have been, suggesting that
NEVER use the internal jargon "LIT" in coaching prose — the player has no idea
what it means. Always write "ready" or "available" instead. (Internal schema
fields may use LIT/DIMMED/UNREADABLE — those are tokens, not user prose.)
Every claim MUST be a statement of fact. You have HIGH-RES FRAMES — use them.
If you cannot determine something from the frames, say "unknown" — do NOT hedge.

═══ COACHING METHOD — ACT LIKE A REAL COACH ═══

REAL coaches don't just say "bad positioning." They build HABITS.

For every death, your coaching must follow this structure:
1. SITUATION: Describe what the player was doing in natural coaching language.
   Mention the weapon, map area, and what they were attempting. Use ability NAMES
   (smoke, tripwire, flash) not slot keys (C, Q, E, X). Do NOT include frame timestamps
   like "t-2.5" or ultimate charge numbers. Write as if reviewing a VOD with the player.
2. MISTAKE (Root Cause): Identify the DECISION that led to the death, not the symptom.
   BAD: "Player was in a bad position"
   GOOD examples (showing DIFFERENT categories — vary your analysis like this):
   • CROSSHAIR: "Your crosshair was at chest height when you swung that corner —
     at this rank, head-level pre-aim is the difference between winning and losing the duel"
   • POSITIONING: "You were standing in the open at Mid with no cover within reach. If
     the enemy peeks, your only option is to win the aim duel — no fallback position"
   • MOVEMENT: "You ran through the choke without counter-strafing. Moving accuracy
     with a Vandal is near zero — the enemy just had to hold the angle"
   • PEEKING: "You wide-swung past the corner, exposing yourself to two angles at once.
     A tight shoulder-peek would check one angle at a time"
   • GAME SENSE: "You pushed aggressively after winning the pistol round instead of
     holding the advantage — traded 1-for-1 turning a 5v4 into 4v4"
3. CORRECTION (Habit Builder): Give a CONCRETE RULE the player can follow EVERY round.
   BAD: "Improve crosshair placement"
   GOOD: "When walking toward any corner, pre-aim at head height where an enemy would
   stand. Use the wall edge as your guide — where wall meets floor is roughly head height
   at medium range."

═══ ANTI-REPETITION RULE (CRITICAL) ═══
If the same root cause explains multiple deaths:
• Include that death ONCE as the best example
• In the situation field, note "This pattern occurred in deaths X, Y, Z (~N times total)"
• Then move on to a DIFFERENT coaching insight for the next death
• EVERY death entry in your output MUST teach something NEW
• If 5 deaths are all "didn't use utility" — report ONE, then find what ELSE went wrong
  in the other deaths (crosshair? positioning? timing? economy? movement?)
• A player who dies 7 times has AT LEAST 2-3 different problems. Find them.

ABILITY AVAILABILITY IS CONTEXT, NOT ALWAYS THE MISTAKE:
• Yes, note which abilities were available — but the mistake is not always "didn't use E"
• Ask: even IF they used their utility, would they have survived? If yes → utility is the issue
• If no (bad position, bad crosshair, bad movement) → utility is secondary, the REAL
  mistake is something else. Coach THAT instead.

AGENT ROLE & UTILITY TIMING — CRITICAL:
• You only see ~7 seconds before death. You CANNOT see what happened earlier in the round.
• SENTINEL/CONTROLLER agents (Cypher, Killjoy, Sage, Viper, Astra, Omen, etc.) deploy
  utility at ROUND START (traps, smokes, walls). Abilities on cooldown = already deployed.
  Do NOT blame them for "not using utility before peeking" — their kit doesn't work that way.
• DUELIST/INITIATOR agents (Jett, Reyna, Sova, Breach, etc.) use utility mid-fight.
  "Not using utility" is valid IF their abilities were available and unused.
• The "utility" category should be RARE for Sentinels and Controllers.

PATTERN ANALYSIS:
• Look across ALL deaths for the player's #1 bad habit
• The priority_pattern should identify the BEHAVIORAL TRIGGER — what makes them
  repeat the mistake? (e.g., "after winning a round you get aggressive", "when the
  spike is planted you always push instead of holding")
• The fix must be a RULE they can repeat to themselves: "When [trigger], do [action]"

DEATH SELECTION (CRITICAL):
• Report UP TO 8 deaths maximum — pick the most DIVERSE and instructive ones.
• If the same mistake happens repeatedly, list the BEST example ONCE with
  "this pattern occurred ~N times."
• Each death entry must describe a DIFFERENT coaching insight.
• A few insightful deaths beat many repetitive ones.
• AIM FOR AT LEAST 3 DIFFERENT CATEGORIES across your death entries.

DRILL / SESSION FOCUS:
• The drill must target the priority_pattern — the #1 most impactful habit to fix.
• Must be something they can practice ALONE in a custom game or the Range.
• Include SPECIFIC steps with numbers, sets, and measurable goals.
  Example: "In The Range: Set 30 bots to strafe. Practice counter-strafing: run right,
  tap A+D to stop, fire one bullet, then reposition. Do 3 sets of 30.
  Goal: 20+ headshots per set."
• The in_game_cue must be a SHORT phrase (max 8 words) they say to themselves.`;

/** Build coaching knowledge block for a single detected agent. */
function buildSingleAgentBlock(agentName: string | undefined): string {
  if (!agentName || agentName === 'unknown') return '';
  const key = agentName.toLowerCase() === 'kay/o' ? 'kay/o' : agentName.toLowerCase();
  const info = AGENTS[key];
  if (!info) return '';
  return `
═══ PLAYER'S AGENT: ${agentName.toUpperCase()} (${info.role}) ═══
Expectation: ${info.expectation}
Abilities:
${info.abilities}
Coaching Flags (reference only — DO NOT apply unless ability bar confirms it):
${info.flags}
⚠️ These flags are SUGGESTIONS, not conclusions. You MUST check the ability bar
state (ability_observation) BEFORE applying any flag. If the ability was used (on cooldown),
the flag does NOT apply to this death.
`;
}

/** Build round utility context block from Pass 1 observations. */
function buildRoundUtilityBlock(
  events:
    | { ability_name: string; approximate_time: string; usage_description: string }[]
    | undefined,
  deathNumber: number,
): string {
  if (!events || events.length === 0) return '';

  const lines = events.map(
    (e, i) =>
      `  • ${e.ability_name} at ~${e.approximate_time}: ${e.usage_description}` +
      ` [see frames: death_${deathNumber}_util_${i + 1}_t+0.0, death_${deathNumber}_util_${i + 1}_t+2.0 if available]`,
  );

  return `═══ UTILITY USED THIS ROUND (from full-game video analysis — TRUST THIS) ═══
The following utility was deployed by the player EARLIER in this round, before the death:
${lines.join('\n')}

⚠️ This data comes from watching the FULL GAME VIDEO — not just the 7-second death window.
If utility frames are included below (death_${deathNumber}_util_*), they show these deployments.
These abilities are now on cooldown BECAUSE they were already used.
Do NOT categorize this death as "utility" for abilities that were ALREADY DEPLOYED.
Only blame "utility" if a DIFFERENT available ability could have changed the outcome.
Focus on what ACTUALLY caused the death: positioning, peeking, crosshair, movement, or game sense.
`;
}

/** Build rank-calibrated coaching guidance. */
function buildRankCalibrationBlock(rank: string | undefined): string {
  if (!rank || rank === 'unknown') return '';
  const lower = rank.toLowerCase();
  if (['iron', 'bronze', 'silver'].some((r) => lower.includes(r))) {
    return `
═══ RANK CONTEXT: ${rank} ═══
This is a lower-rank player. Focus on FUNDAMENTALS:
• Crosshair placement (head height, pre-aiming corners) — explain what it is if violated
• Basic positioning (not standing in the open, using cover)
• Ability usage (are they using abilities at all?)
• Economy basics (are they buying with the team?)
Keep coaching language simple and specific. One concept per death.
`;
  }
  if (['gold', 'platinum'].some((r) => lower.includes(r))) {
    return `
═══ RANK CONTEXT: ${rank} ═══
This player has fundamentals but inconsistent habits. Focus on:
• Consistency (are they doing the right thing EVERY round, not just sometimes?)
• Trade timing and team coordination
• Ability usage timing (early vs late, proactive vs reactive)
• Economy optimization (force buys, save discipline)
`;
  }
  if (['diamond', 'ascendant', 'immortal', 'radiant'].some((r) => lower.includes(r))) {
    return `
═══ RANK CONTEXT: ${rank} ═══
This player has strong mechanics. Focus on DECISION-MAKING:
• Macro reads (when to rotate, when to lurk, when to commit)
• Ability sequencing in executes
• Adaptation (are they adjusting to enemy tendencies?)
• Timing exploitation (peek timing, trade windows, post-plant positioning)
`;
  }
  return `\n═══ RANK CONTEXT: ${rank} ═══\nCalibrate coaching depth to this rank.\n`;
}

function buildFullCoachingPromptLegacy(
  deathTimestamps: { death_number: number; approximate_time: string }[],
  gameMode: string,
  coachingHistory?: CoachingHistory | null,
  rank?: string,
  detectedAgent?: string,
  detectedMap?: string,
): string {
  const deathList = deathTimestamps
    .map((d) => `• Death ${d.death_number} at ${d.approximate_time}`)
    .join('\n');

  const isDeathmatch = gameMode === 'deathmatch' || gameMode === 'team_deathmatch';
  const isSpikeRush = gameMode === 'spike_rush';

  // Do NOT inject agent/map knowledge based on Pass 1's guess — it anchors the model
  // to confirm the guess instead of verifying from frames. The model knows agents
  // from training data. Agent/map knowledge will be provided AFTER identification
  // in the prompt text instead.
  const agentBlock = '';
  const mapBlock = '';
  const rankBlock = buildRankCalibrationBlock(rank);

  // Build game mechanics block (exclude economy/round for modes that don't have them)
  const mechanicsBlock = `═══ VALORANT GAME KNOWLEDGE ═══
${VALORANT_MECHANICS}
${!isDeathmatch && !isSpikeRush ? `\n${VALORANT_ECONOMY}` : ''}
${!isDeathmatch ? `\n${VALORANT_ROUND}` : ''}`;

  // Pass 2 has HIGH-RES crops — it is the authority on agent/map identification.
  // Pass 1's low-res guess is provided as a HINT only, not confirmation.
  // The model MUST verify independently from the high-res portrait/ability bar crops.
  const agentHint =
    detectedAgent && detectedAgent !== 'unknown'
      ? `A low-resolution video pass suggested the player might be **${detectedAgent}**, but this is NOT confirmed. Verify independently from the HIGH-RES portrait and ability bar crops. If the portrait/abilities clearly show a DIFFERENT agent → use what YOU see. Do NOT use the death banner — that shows the ENEMY.`
      : 'Identify the player agent from the agent_id frames below. Do NOT use the death banner — that shows the ENEMY.';
  const mapHint =
    detectedMap && detectedMap !== 'unknown'
      ? `A low-resolution video pass suggested the map might be **${detectedMap}**. Verify from the HIGH-RES minimap crops. If you can clearly identify the map → confirm or correct.`
      : 'Identify the map from minimap crops below.';

  return `You are a Valorant VOD coach. You are reviewing HIGH-RESOLUTION key frames from ${deathTimestamps.length} deaths in a ${gameMode} match.${rank && rank !== 'unknown' ? ` Player rank: ${rank}.` : ''}

═══ STEP 0: IDENTIFY THE PLAYER (DO THIS FIRST) ═══
Before analyzing ANY deaths, you MUST identify the player's agent and the map.

AGENT IDENTIFICATION — use the ZOOMED CROPS (they appear FIRST in the image sequence):
  agent_id_3s, agent_id_10s: Full buy phase screenshots (overview).
  agent_id_3s_crop_portrait, agent_id_10s_crop_portrait: ZOOMED agent portrait + name (bottom-left of HUD).
    → This shows the PLAYER's agent face/icon AND agent name text. READ THE TEXT if visible — it is the most reliable way to identify the agent, especially for newer agents.
  agent_id_3s_crop_ability_bar, agent_id_10s_crop_ability_bar: ZOOMED ability bar (bottom-center).
    → Shows 4 ability icons unique to each agent. Match these to an agent.

  ⚠️ CRITICAL: The death banner "ELIMINATED BY [AGENT]" shows the ENEMY who KILLED the player.
  It does NOT show the player's agent. NEVER confuse these. If every death shows
  "ELIMINATED BY Cypher", that means the ENEMY is Cypher, NOT the player.
  The player's agent is ONLY visible in the agent_id crop_portrait and crop_ability_bar images.

  ${agentHint}
  Fill verified_agent FIRST, then use that agent consistently in ALL coaching text.

MAP IDENTIFICATION — use the ZOOMED MINIMAP CROPS:
  agent_id_3s_crop_minimap, agent_id_10s_crop_minimap: ZOOMED minimap (top-left of HUD).
    → Shows map outline and callout labels. Match the shape to a known map.
  Also check death crop_minimap images for additional minimap views.
  ${mapHint}
  ${!isDeathmatch ? `GAME MODE: ${gameMode} — one map for the entire match.` : ''}
  Fill verified_map FIRST, then use that map's callouts in coaching text.

═══ FRAME LAYOUT PER DEATH ═══
For each death you have a SEQUENCE + CROPS:

TEMPORAL SEQUENCE (2fps, 7 seconds before death → death moment):
  death_N_t-7.0 through death_N_t0.0 (15 frames per death)
  These show the FULL PLAY unfolding — the decision to push/hold, positioning setup,
  movement, crosshair placement, enemy peeks, and the death itself.

  ⚠️ SPECTATING WARNING: After the player dies, the camera switches to spectate a teammate.
  Any frames showing a DIFFERENT player's HUD/perspective are spectating frames — do NOT
  use them for coaching the player. Only use pre-death frames for gameplay analysis.

  ⚠️ TAB SCOREBOARD WARNING: Sometimes players press Tab before dying, showing the scoreboard
  overlay with round kills/deaths/assists. Do NOT confuse scoreboard stats with live gameplay
  events. The scoreboard shows CUMULATIVE match stats, not what just happened.

ZOOMED-IN CROPS (4x more readable — CHECK THESE FIRST):
  death_N_crop_deathbanner: "ELIMINATED BY [AGENT]" + weapon. Shows the ENEMY, NOT the player.
  death_N_crop_killfeed: Kill feed (top-right). Shows ENEMY weapon icons and agent names.
  death_N_crop_weapon_hud: Weapon HUD (bottom-right). The weapon the PLAYER was holding.
  death_N_crop_ability_bar: Ability bar (bottom-center). Lit = available, dark = used/cooldown.
  death_N_crop_minimap: Minimap for position/location on the current map.
  death_N_crop_center: Center of death screen.

${ENRICHMENT_ANTI_HALLUCINATION}

═══ COACHING METHOD (after identifying agent and map) ═══
1. CHECK crop_deathbanner — read the ENEMY agent name and weapon that killed the player. This is the ENEMY, not the player.
2. CHECK crop_weapon_hud — read what weapon the PLAYER was holding.
3. CHECK crop_ability_bar — note which abilities were VISIBLY LIT UP (available) vs DARK (used/cooldown). Use ability NAMES in output, not slot keys (C/Q/E/X). Do NOT infer ability availability from agent knowledge — only report what you can SEE in the crop pixels. If the crop is unclear, say abilities were unknown. IMPORTANT: If all abilities are dark/empty, the player ALREADY USED them — do NOT criticize "didn't use abilities" when the bar shows they were expended. Only criticize unused abilities if they are visibly LIT.
4. CHECK crop_minimap — identify the player's position using callouts for the verified map.
5. WATCH the temporal sequence — understand what the player did leading up to the death: movement, crosshair height, positioning, when they committed.
6. For each death: explain the ROOT CAUSE decision in coaching language. Do NOT put frame timestamps (t-2.5) or ability slot letters in the situation/mistake/correction fields — those are for the player to read.
7. Each death MUST describe a DIFFERENT coaching insight. If the same mistake repeats, pick the clearest example and note the count.

${ENRICHMENT_COACHING_DEPTH}

${mechanicsBlock}
${agentBlock}${mapBlock}${rankBlock}
═══ DEATHS TO ANALYZE ═══
${deathList}

Select up to 8 most coaching-relevant deaths showing DIFFERENT mistakes.
REMINDER: NEVER use "likely", "probably", "possibly", "appears to", "seems to" — state FACTS from frames or say "unknown."
Every situation/mistake/correction must reference what you SEE in the frames, not what you imagine.
Use the agent from your verified_agent field in all coaching text. Use the map from your verified_map field for all callouts.
${
  isDeathmatch
    ? 'Categories for deathmatch: crosshair | peeking | movement | game_sense | unclear. Do NOT use economy, utility, rotation, or trading.'
    : isSpikeRush
      ? 'Categories for Spike Rush: crosshair | positioning | utility | movement | game_sense | peeking | trading | unclear. Do NOT use economy.'
      : 'Categories: crosshair | positioning | utility | economy | movement | game_sense | peeking | trading | unclear'
}
⚠️ CATEGORY RULE: You MUST assign a specific category to each death. "unclear" is ONLY for deaths where you genuinely cannot determine the mistake type. If the player was peeked → "peeking". If they were in a bad position → "positioning". If they didn't use utility → "utility". If they had bad crosshair placement → "crosshair". NEVER default to "unclear" when you have enough information to categorize.
${coachingHistory ? formatCoachingHistoryBlock(coachingHistory) : ''}
Valid weapons: ${VALID_WEAPONS.join(', ')}
Valid agents: ${VALID_AGENTS.join(', ')}

Output valid JSON matching the schema.`;
}

// ── Multi-Phase Prompt Builders ─────────────────────────────────────────────

/** Phase A prompt: focused agent + map identification from buy-phase frames */
function buildIdentityPrompt(
  detectedAgent?: string,
  detectedMap?: string,
  deathBannerCount = 0,
): string {
  const agentHint =
    detectedAgent && detectedAgent !== 'unknown'
      ? `A low-resolution video pass suggested the player might be **${detectedAgent}**, but this is NOT confirmed — low-res analysis frequently misidentifies agents. You MUST verify independently from the HIGH-RES frames below.`
      : '';
  const mapHint =
    detectedMap && detectedMap !== 'unknown'
      ? `A low-resolution video pass suggested the map might be **${detectedMap}**. Verify from the minimap crops.`
      : '';

  return `You are identifying a Valorant player's agent and map from high-resolution buy-phase screenshots.

═══ YOUR TASK ═══
Look at the attached frames and identify:
1. The PLAYER'S agent (from portrait and ability bar)
2. The MAP (from minimap layout)

═══ FRAMES PROVIDED ═══
You have 2 full buy-phase screenshots + zoomed crops:
  agent_id_3s, agent_id_10s: Full HUD during buy phase
  agent_id_Xs_crop_portrait: ZOOMED agent portrait (bottom-left)
  agent_id_Xs_crop_ability_bar: ZOOMED ability bar (bottom-center, 4 unique icons)
  agent_id_Xs_crop_minimap: ZOOMED minimap (top-left)

═══ AGENT IDENTIFICATION (follow this order) ═══
STEP 1 — CHECK THE PORTRAIT (crop_portrait):
  Shows the agent icon. Match to a known agent's appearance.

STEP 2 — CHECK THE ABILITY BAR (crop_ability_bar):
  4 unique ability icons. Match these to a known agent's kit to confirm Step 1.

• ⚠️ CRITICAL: Do NOT confuse death banners with player identity. Death banners
  ("ELIMINATED BY [AGENT]") show the ENEMY who killed the player, NOT the player's agent.
${agentHint}

⚠️ CRITICAL: If the portrait looks unfamiliar, output "unknown" rather than guessing a similar-looking agent. Getting the agent WRONG is worse than saying "unknown".
${
  deathBannerCount > 0
    ? `
═══ DEATH BANNERS (enemy agents — use as cross-reference) ═══
Below the agent_id frames, you also have ${deathBannerCount} DEATH BANNER crops from the match.
Each shows "ELIMINATED BY [AGENT]" — these are ENEMY agents who killed the player.

Use these as a STRONG HINT: if you see "ELIMINATED BY Clove" → Clove is an enemy.
While mirror matches (same agent on both teams) are technically possible, they are
uncommon. If your identification from the portrait matches an enemy agent
from the death banners, DOUBLE-CHECK the ability bar icons carefully.
It is more likely you misidentified than that it's a mirror match.
`
    : ''
}
═══ MAP IDENTIFICATION ═══
• The crop_minimap shows the map layout from the top-left corner of the HUD.
• Match the outline shape and any visible callout text to a known Valorant map.
${mapHint}

═══ VALID NAMES ═══
Valid agents: ${VALID_AGENTS.join(', ')}
Valid maps: ${VALID_MAPS.join(', ')}
If you cannot identify → use "unknown". Do NOT invent names.

Output valid JSON matching the schema.`;
}

/** Phase B prompt: focused single-death coaching with confirmed agent/map context */
function buildPerDeathPrompt(
  deathNumber: number,
  approximateTime: string,
  agentName: string,
  mapName: string,
  gameMode: string,
  rank?: string,
  abilityContext?: string,
  playerMemoryContext?: string,
  roundUtilityEvents?: {
    ability_name: string;
    approximate_time: string;
    usage_description: string;
  }[],
): string {
  const isDeathmatch = gameMode === 'deathmatch' || gameMode === 'team_deathmatch';
  const isSpikeRush = gameMode === 'spike_rush';

  // Now that agent is confirmed, inject ability knowledge so the model knows what icons represent
  const agentBlock = buildSingleAgentBlock(agentName);
  const rankBlock = buildRankCalibrationBlock(rank);
  const callouts = mapName && mapName !== 'unknown' ? mapCalloutsBlock(mapName, null) : '';

  const categoryList = isDeathmatch
    ? 'crosshair | peeking | movement | game_sense | unclear'
    : isSpikeRush
      ? 'crosshair | positioning | utility | movement | game_sense | peeking | trading | unclear'
      : 'crosshair | positioning | utility | economy | movement | game_sense | peeking | trading | unclear';

  return `You are a Valorant VOD coach analyzing ONE death in detail.

═══ CONFIRMED CONTEXT ═══
Player agent: **${agentName}**${agentName === 'unknown' ? ' (could not be identified)' : ''}
Map: **${mapName}**${mapName === 'unknown' ? ' (could not be identified)' : ''}
Game mode: ${gameMode}
${rank && rank !== 'unknown' ? `Rank: ${rank}` : ''}

═══ DEATH TO ANALYZE ═══
Death ${deathNumber} at ~${approximateTime}

═══ FRAMES PROVIDED ═══
You have a TEMPORAL SEQUENCE (2fps, 7 seconds before death ��� death moment) + ZOOMED CROPS:

TEMPORAL SEQUENCE (15 frames):
  death_${deathNumber}_t-7.0 through death_${deathNumber}_t0.0
  These show the FULL PLAY unfolding — the decision to push/hold, positioning setup,
  movement, crosshair placement, enemy peeks, and the death itself.

  ⚠️ SPECTATING DETECTION (CRITICAL — read carefully):
  After the player dies, the camera switches to spectate a TEAMMATE. This means:
  - The confirmed player agent is **${agentName}**
  - If ANY frame shows a DIFFERENT agent name/portrait in the bottom-left HUD → that's a spectator frame
  - Spectator frames also show a different ability bar (teammate's abilities, not ${agentName}'s)
  - The DEATH MOMENT frame often shows "YOU WERE ELIMINATED" text overlay
  - Frames AFTER the death banner are likely spectating
  - You MUST analyze the death from the PLAYER'S perspective (${agentName}), not the spectated teammate
  - If most frames are spectating, use the EARLIEST frames (t-7.0 to t-4.0) which show the player alive

  ⚠️ TAB SCOREBOARD WARNING: If any frame shows a scoreboard overlay, that is CUMULATIVE
  match stats (Tab key), not live events. IGNORE these for coaching analysis.

ZOOMED CROPS (4x more readable — CHECK THESE FIRST):
  death_${deathNumber}_crop_deathbanner: "ELIMINATED BY [AGENT]" + weapon. Shows the ENEMY, NOT the player.
  death_${deathNumber}_crop_killfeed: Kill feed (top-right). Shows ENEMY weapon icons and agent names.
  death_${deathNumber}_crop_weapon_hud: Weapon HUD (bottom-right). The weapon the PLAYER was holding.
  death_${deathNumber}_crop_ability_bar: Ability bar (bottom-center). Lit = available, dark = used/cooldown.
  death_${deathNumber}_crop_minimap: Minimap for position/location.
  death_${deathNumber}_crop_center: Center of death screen.

${ENRICHMENT_ANTI_HALLUCINATION}

═══ ABILITY STATE (pre-analyzed from pixel data — TRUST THIS) ═══
${abilityContext || 'Ability state: could not be determined from frame analysis.'}

${agentBlock || ''}

${
  abilityContext?.includes('AVAILABLE at death')
    ? '⚠️ The player had unused abilities at death. If any of those abilities could have changed the outcome (smoke for cover, flash before peek, etc.), this IS a coaching point.'
    : abilityContext?.includes('Already on cooldown')
      ? '✅ The player USED abilities before dying. Do NOT say they failed to use abilities that are on cooldown. Check if they were used effectively or wasted.'
      : 'If ability state is uncertain, do NOT criticize ability usage. Focus on positioning, movement, and decision-making.'
}

${buildRoundUtilityBlock(roundUtilityEvents, deathNumber)}

${
  playerMemoryContext
    ? `═══ PLAYER MEMORY (from past coaching sessions) ═══
${playerMemoryContext}

Use these observations to personalize your coaching. If you see the same habit recurring, reference it directly (e.g., "this is the same mistake from your last sessions"). If a past habit has improved, acknowledge it.
`
    : ''
}═══ COACHING METHOD ═══
You are a paid VOD coach — not a match summarizer. Every sentence must teach something.

**STEP 0 (MANDATORY — do this FIRST before anything else):**
Fill the "ability_observation" field. Check the ability bar crops and the pre-analyzed pixel data above.
Report which abilities are on cooldown (dark/used) and which are available (lit).
This MUST be done BEFORE you write situation, mistake, or choose a category.

1. CHECK crop_deathbanner — read ENEMY agent name + weapon.
2. CHECK crop_weapon_hud — read what weapon the PLAYER was holding.
3. CHECK crop_minimap — identify position using ${mapName !== 'unknown' ? `${mapName} callouts` : 'visible landmarks'}.
4. WATCH the temporal sequence — understand movement, crosshair height, positioning, timing.
5. USE the ability state above (pre-analyzed) — do NOT try to read the ability bar icons yourself.
6. Write the ROOT CAUSE decision error, not just "bad positioning."

BANNED LANGUAGE: Never use "likely", "probably", "appears to", "seems to", "possibly", "suggesting". State FACTS from frames or say "unknown."

${rankBlock}
${callouts}

Categories: ${categoryList}

═══ CATEGORY GATING RULES (CRITICAL) ═══
⚠️ HARD RULE — "utility" category requires PROOF of unused ability:
  • If an ability is ON COOLDOWN or was USED (dark in ability bar, confirmed by pixel data above),
    you CANNOT say the player "failed to use" that ability. It was ALREADY used.
  • Category "utility" is ONLY valid when: a specific ability was AVAILABLE (lit) AND using it
    would have clearly changed the outcome. You must NAME the unused ability.
  • If the player used all their abilities and still died → the mistake is NOT "utility".
    Look for positioning, peeking, crosshair, movement, or game_sense instead.
  • Do NOT let agent coaching flags override what you SEE in the ability bar.
    The pixel data and crops are ground truth — coaching flags are just reminders.

═══ AGENT ROLE & UTILITY CONTEXT (READ THIS CAREFULLY) ═══
⚠️ You can ONLY see ~7 seconds before death. You CANNOT see what happened earlier in the round.
This means you CANNOT know whether the player deployed utility at round start.

SENTINEL agents (Cypher, Killjoy, Chamber, Sage, Deadlock, Vyse):
  Their utility (traps, turrets, tripwires, walls, barriers) is deployed at ROUND START.
  If abilities are on cooldown at death time → they were ALREADY DEPLOYED earlier.
  Do NOT blame a Sentinel for "not using utility before peeking" — their kit is not designed
  for mid-fight utility like flashes or dashes. Their traps were likely already placed.
  Only blame "utility" if they had abilities AVAILABLE (lit) that could help in THIS moment.

CONTROLLER agents (Viper, Astra, Omen, Brimstone, Harbor, Clove):
  Their smokes/walls are often placed at round start or pre-planned timings.
  Abilities on cooldown = already deployed. Do NOT assume they "forgot" to smoke.
  Only blame "utility" if a smoke/wall was clearly AVAILABLE and would have covered the angle.

INITIATOR agents (Sova, Breach, Skye, Fade, KAY/O, Gekko):
  Their utility (flashes, recon, stuns) IS typically used mid-fight before peeking.
  "Utility" category is more appropriate here IF abilities were available and unused.

DUELIST agents (Jett, Raze, Reyna, Phoenix, Neon, Yoru, Iso):
  Their utility is personal and mid-fight (dash, dismiss, flash, satchel).
  "Utility" category is appropriate IF their escape/entry abilities were available but unused.

BOTTOM LINE: The "utility" category should be RARE for Sentinels and Controllers.
For these roles, if abilities are on cooldown, the DEFAULT assumption is they were used
correctly earlier. Focus on positioning, peeking, crosshair, movement, or game_sense instead.

⚠️ ANTI-BIAS: Do NOT default to "utility". Most deaths are caused by positioning, peeking,
or crosshair errors. Only choose "utility" when you have concrete evidence of a wasted ability.
When in doubt between "utility" and another category, prefer the non-utility category.

⚠️ CATEGORY RULE: You MUST assign a specific category. "unclear" is ONLY for deaths where you genuinely cannot determine the mistake type. If the player was peeked → "peeking". Bad position → "positioning". Didn't use utility → "utility". Bad crosshair → "crosshair". NEVER default to "unclear".

Valid weapons: ${VALID_WEAPONS.join(', ')}
Valid agents: ${VALID_AGENTS.join(', ')}

═══ DEATHS TO ANALYZE ═══
Analyze death ${deathNumber} at ~${approximateTime}. Output valid JSON matching the schema.`;
}

/** Phase C prompt: text-only pattern synthesis across death coaching entries */
function buildSynthesisPrompt(
  deathSummaries: {
    death_number: number;
    category: string;
    situation: string;
    mistake: string;
    correction: string;
    weapon_used: string;
    killed_by: string;
    map_location?: string;
  }[],
  agentName: string,
  mapName: string,
  gameMode: string,
  rank?: string,
  coachingHistory?: CoachingHistory | null,
  playerMemoryContext?: string,
): string {
  const deathList = deathSummaries
    .map(
      (d) =>
        `Death ${d.death_number} [${d.category}]${d.map_location ? ` at ${d.map_location}` : ''}:
  Weapon: ${d.weapon_used} | Killed by: ${d.killed_by}
  Situation: ${d.situation}
  Mistake: ${d.mistake}
  Correction: ${d.correction}`,
    )
    .join('\n\n');

  return `You are a Valorant coach synthesizing patterns across ${deathSummaries.length} analyzed deaths.

═══ CONTEXT ═══
Player: **${agentName}** on **${mapName}** (${gameMode})${rank && rank !== 'unknown' ? ` | Rank: ${rank}` : ''}

═══ DEATH COACHING (already analyzed individually) ═══
${deathList}

═══ YOUR TASK ═══
Looking across ALL deaths above, identify:

1. PRIORITY PATTERN: The #1 recurring bad habit seen in 2+ deaths.
   - What BEHAVIORAL TRIGGER makes them repeat this mistake?
   - Example: "after winning a round you get aggressive", "when spike is planted you always push"
   - The fix must be a RULE: "When [trigger], do [action]"
   - ⚠️ If the player is a Sentinel (Cypher, Killjoy, Sage, etc.) or Controller (Viper, Astra, Omen, etc.),
     "utility" is UNLIKELY to be their priority pattern — their utility is deployed at round start,
     not mid-fight. Look for positioning, peeking, crosshair, or game_sense patterns instead.

2. SECONDARY PATTERNS: Up to 2 other recurring issues (different category from priority).

3. STRENGTHS: 1-3 specific good habits you noticed (not generic praise).

4. SESSION FOCUS: A practice drill targeting the priority pattern.
   - Must be something they can practice ALONE in The Range or custom game.
   - Include SPECIFIC steps with numbers, sets, and measurable goals.
   - The in_game_cue must be a SHORT phrase (max 8 words) to say before each round.

5. MATCH VERDICT: 2-3 sentence coaching summary of the match.

6. COACHING CONTINUITY: Brief progress note for tracking improvement.

${coachingHistory ? formatCoachingHistoryBlock(coachingHistory) : ''}
${
  playerMemoryContext
    ? `
═══ PLAYER COACHING MEMORY ═══
${playerMemoryContext}

REFERENCE these observations in your synthesis. If the priority pattern matches a known recurring habit, call it out explicitly. If a known habit has improved this session, mention the improvement in coaching_continuity.
`
    : ''
}
Output valid JSON matching the schema.`;
}

// ── Verification Schema (legacy fact-fixing mode) ───────────────────────────

const weaponEnum = [
  ...VALID_WEAPONS,
  'unknown_rifle',
  'unknown_sidearm',
  'unknown_smg',
  'unknown_sniper',
  'unknown_shotgun',
  'unknown_heavy',
  'unknown_melee',
  'unknown',
];

const ENRICHMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    enriched_deaths: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          death_number: {
            type: 'integer',
            description: 'Matches the death_N in the frame labels.',
          },
          weapon_used: {
            type: 'string',
            enum: weaponEnum,
            description:
              'Weapon name READ from the kill feed or death screen. Use "unknown" if unreadable.',
          },
          weapon_confidence: {
            type: 'string',
            enum: ['certain', 'uncertain'],
            description:
              '"certain" = you can clearly read the weapon name/icon. "uncertain" = guessing.',
          },
          killed_by: {
            type: 'string',
            enum: [...VALID_AGENTS, 'an enemy', 'unknown'],
            description: 'Enemy agent name READ from the kill feed. "an enemy" if unreadable.',
          },
          killed_by_confidence: {
            type: 'string',
            enum: ['certain', 'uncertain'],
            description: '"certain" = you can clearly read the agent name. "uncertain" = guessing.',
          },
          map_location: {
            type: 'string',
            description:
              'Map area from minimap/scene in predeath frame. E.g. "A Site", "Mid", "B Long". "unknown" if unclear.',
          },
          abilities_available: {
            type: 'array',
            items: { type: 'string', enum: ['C', 'Q', 'E', 'X'] },
            description:
              'Ability slots that were VISIBLY LIT UP in the predeath ability bar crop. Empty array if the crop is unclear or you cannot distinguish lit from dark.',
          },
          abilities_confidence: {
            type: 'string',
            enum: ['certain', 'uncertain'],
            description:
              '"certain" = you can clearly distinguish lit vs dark icons in the ability bar crop. "uncertain" = icons are ambiguous or crop is unclear. Use "uncertain" and empty array rather than guessing.',
          },
          situation: {
            type: 'string',
            description:
              'Rewrite in natural coaching language. Describe what the player was doing — map position, weapon, what they were attempting. Use ability NAMES not slot keys. No frame timestamps. 2-3 sentences.',
          },
          mistake: {
            type: 'string',
            description:
              'Rewrite the mistake as coaching advice. What decision went wrong and why? Keep the original coaching insight but fix factual claims. 1-2 sentences.',
          },
          correction: {
            type: 'string',
            description:
              'Rewrite the correction as direct coaching advice. What should the player do differently? Specific to the verified facts. 1-2 sentences.',
          },
        },
        required: [
          'death_number',
          'weapon_used',
          'weapon_confidence',
          'killed_by',
          'killed_by_confidence',
          'map_location',
          'abilities_available',
          'abilities_confidence',
          'situation',
          'mistake',
          'correction',
        ],
      },
    },
  },
  required: ['enriched_deaths'],
};

// ── Verification Prompt ──────────────────────────────────────────────────────

function buildEnrichmentPrompt(
  deathCoaching: any[],
  isHighFps = false,
  _detectedAgent?: string,
  _detectedMap?: string,
): string {
  // Build the original coaching context per death
  const deathContext = deathCoaching
    .map((d) => {
      return `Death ${d.death_number} [${d.category ?? 'unknown'}, ~${d.approximate_time ?? '??:??'}]:
  Situation: ${d.situation ?? 'N/A'}
  Mistake: ${d.mistake ?? 'N/A'}
  Correction: ${d.correction ?? 'N/A'}`;
    })
    .join('\n\n');

  // Do NOT lock agent/map from Pass 1 — it may be wrong.
  // The model should identify from the high-res frames.
  const lockedBlock = '';

  return `You are a Valorant coaching enrichment system. You have two inputs:
1. HIGH-RESOLUTION keyframes from specific death moments (frames attached below)
2. ORIGINAL COACHING from a low-resolution video analysis (included below)

The original coaching was generated from 100px thumbnail frames. It captures the COACHING INSIGHT (what category of mistake, tactical patterns, timing issues) but its FACTUAL CLAIMS are often wrong — wrong weapon names, wrong enemy agents, wrong map locations, wrong scenarios.

YOUR TASK: Read the FACTS from the high-res frames, then REWRITE the coaching text (situation, mistake, correction) to be factually accurate while preserving the original coaching insight.
${lockedBlock}
═══ ANTI-HALLUCINATION RULES ═══
- The "ELIMINATED BY [AGENT]" death banner shows the ENEMY who killed you, NOT the player's agent.
- Do NOT invent ability states you cannot see. If the ability bar crop is unclear, use an empty array [].
- Do NOT copy facts from the original coaching — READ them from frames. If unreadable, use "unknown".
- BANNED LANGUAGE: Never use "likely", "probably", "appears to", "seems to", "possibly", "suggesting". State what you see or say "unknown".
- Every death MUST have a DIFFERENT coaching insight. Do NOT repeat the same advice across deaths.

═══ HOW TO READ THE FRAMES ═══
${
  isHighFps
    ? `
For each death, you have a SEQUENCE of frames showing the play unfold:
- death_N_t-7.0 through death_N_t0.0: The 7 seconds BEFORE death at 2fps.
  These capture movement, positioning, ability usage, crosshair placement, and enemy peeks.

⚠️ SPECTATING WARNING: After the player dies, the camera may switch to spectate a teammate.
Do NOT use spectated frames for coaching — they show a DIFFERENT player's perspective.
Only pre-death frames (t-7.0 through t0.0) show the player's own gameplay.

⚠️ TAB SCOREBOARD WARNING: If any frame shows a scoreboard overlay (round kills/deaths/assists),
that is the Tab scoreboard showing CUMULATIVE match stats. Do NOT confuse this with live events.

ZOOMED-IN CROPS (4x more readable than full frames — CHECK THESE FIRST):
- death_N_crop_deathbanner: The "ELIMINATED BY [AGENT]" banner. Shows the ENEMY agent name and weapon. This is the MOST RELIABLE source for who killed the player and with what weapon.
- death_N_crop_killfeed: ZOOMED-IN kill feed (top-right). READ weapon icons and agent names.
- death_N_crop_weapon_hud: ZOOMED-IN weapon HUD (bottom-right). READ the weapon name the player was HOLDING before death.
- death_N_crop_ability_bar: ZOOMED-IN ability bar (bottom-center). Check which abilities are LIT UP (available) vs DARK/GRAYED (on cooldown or used). Report ONLY lit-up abilities. Do NOT infer from agent knowledge — only report what you SEE in the pixels. If unclear, return empty array and set abilities_confidence to "uncertain". NOTE: If ALL icons are dark, the player USED their abilities — this is not a mistake. Only criticize unused abilities if they are visibly LIT in this crop.
- death_N_crop_minimap: ZOOMED-IN minimap — use for map location.
- death_N_crop_center: ZOOMED-IN center of death screen.

IMPORTANT: Use the frame sequence to understand what CHANGED — the player's movement,
positioning, and decisions leading up to the death. Write your coaching in natural language
(not frame timestamps). Example coaching output:
"You were walking toward A Long, then started sprinting into the open. You swung the corner
without stopping and your crosshair was at chest level — the Chamber had a free headshot."
`
    : `
For each DEATH (frames labeled death_N_*):
- death_N_pre_5s through death_N_pre_2s: Player's view 5-2 seconds BEFORE death.
- death_N_predeath: Player's view 1 second BEFORE death.
- death_N_moment: The instant of death.
- death_N_deathscreen / death_N_deathscreen_late: The death/kill screen.

ZOOMED-IN CROPS (4x more readable than full frames — CHECK THESE FIRST):
- death_N_deathscreen_crop_deathbanner: The "ELIMINATED BY [AGENT]" banner. Shows the ENEMY agent name and weapon.
- death_N_deathscreen_crop_killfeed: ZOOMED-IN kill feed — READ weapon icons and agent names.
- death_N_predeath_crop_weapon_hud: ZOOMED-IN weapon HUD (bottom-right). READ the weapon name the player was HOLDING.
- death_N_predeath_crop_ability_bar: ZOOMED-IN ability bar. Report ONLY lit-up abilities. If unclear, return empty array.
- death_N_predeath_crop_minimap: ZOOMED-IN minimap crop — use for map location.
- death_N_deathscreen_crop_center: ZOOMED-IN center death banner.
`
}
PRIORITY: Check _crop_deathbanner and _crop_weapon_hud and _crop_ability_bar FIRST — they contain the exact facts you need in readable text.

═══ DEATHS TO ANALYZE ═══

═══ ORIGINAL COACHING (facts may be WRONG, coaching insight is valuable) ═══
${deathContext}

═══ REWRITING RULES ═══
1. READ facts from frames: weapon (from kill feed/death banner), enemy agent, map location (from minimap), abilities available.
2. KEEP the original coaching INSIGHT: the category of mistake, the tactical pattern, the type of correction.
3. REPLACE all factual claims with what you actually see: correct weapon name, correct enemy agent, correct location, correct scenario description.
4. If you CANNOT read a fact clearly, use "unknown"/"uncertain" — do NOT copy the original coaching's guess.
5. Write situation/mistake/correction in the same style as the originals — concise, actionable, specific.
6. Reference specific abilities if available (e.g., "had Q and E available but didn't use smoke before peeking").
7. Each death must have UNIQUE coaching — do NOT give the same advice twice.

Valid weapons: ${VALID_WEAPONS.join(', ')}
Valid agents: ${VALID_AGENTS.join(', ')}
`;
}

// ── Multi-Phase Helpers ──────────────────────────────────────────────────────

type FrameEntry = { label: string; base64: string; timestampSec: number; mimeType: string };

/** Group death frames by death number (e.g. "death_3_t-2.0" → group 3) */
function groupFramesByDeath(deathFrames: FrameEntry[]): Map<number, FrameEntry[]> {
  const groups = new Map<number, FrameEntry[]>();
  for (const frame of deathFrames) {
    const match = frame.label.match(/^death_(\d+)/);
    if (!match) continue;
    const deathNum = Number.parseInt(match[1]);
    if (!groups.has(deathNum)) groups.set(deathNum, []);
    groups.get(deathNum)!.push(frame);
  }
  return groups;
}

interface PhaseCost {
  costUsd: number;
  tokensUsed: { input: number; output: number };
}

/** Sum costs across all VLM phases */
function accumulateCosts(phases: PhaseCost[]): PhaseCost {
  return {
    costUsd: phases.reduce((sum, p) => sum + p.costUsd, 0),
    tokensUsed: {
      input: phases.reduce((sum, p) => sum + p.tokensUsed.input, 0),
      output: phases.reduce((sum, p) => sum + p.tokensUsed.output, 0),
    },
  };
}

/** Generate fallback synthesis when Phase C fails — derives patterns from Phase B categories */
function buildFallbackSynthesis(deathResults: any[]): Record<string, unknown> {
  // Count categories
  const catCounts: Record<string, number> = {};
  for (const d of deathResults) {
    const cat = d.category ?? 'unclear';
    if (cat !== 'unclear') catCounts[cat] = (catCounts[cat] ?? 0) + 1;
  }
  const sorted = Object.entries(catCounts).sort(([, a], [, b]) => b - a);
  const topCat = sorted[0]?.[0] ?? 'game_sense';
  const topCount = sorted[0]?.[1] ?? deathResults.length;
  const secondCat = sorted[1]?.[0];

  return {
    priority_pattern: {
      category: topCat,
      death_count: topCount,
      title: `Recurring ${topCat} issues`,
      what_happened: `The player made ${topCat}-related mistakes in ${topCount} deaths.`,
      why_it_hurts: `Repeated ${topCat} errors give free kills to the enemy.`,
      fix: `Focus on improving ${topCat} fundamentals each round.`,
    },
    secondary_patterns: secondCat
      ? [
          {
            category: secondCat,
            death_count: sorted[1]![1],
            title: `${secondCat} mistakes`,
            what_happened: `Multiple deaths involved ${secondCat} errors.`,
            fix: `Work on ${secondCat} alongside the primary focus.`,
          },
        ]
      : [],
    strengths: ['Completed the match and engaged in fights.'],
    session_focus: {
      drill_name: `${topCat} practice`,
      drill_steps: `Focus on ${topCat} in your next few games. Review each death for ${topCat} mistakes.`,
      drill_duration_minutes: 15,
      in_game_cue: `Check my ${topCat}`,
    },
    match_verdict: `Analysis of ${deathResults.length} deaths. Primary area to improve: ${topCat}.`,
    coaching_continuity: { progress_note: 'Continue working on fundamentals.' },
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

export class FactVerificationService {
  constructor(private vlm: GeminiProvider) {}

  /**
   * Extract key frames from the video at death timestamps and verify
   * factual details using flash-lite with high-resolution images.
   *
   * Returns null if verification is skipped or fails (graceful degradation).
   */
  async verify(
    videoBuffer: Buffer,
    deathCoaching: any[],
    videoDurationSec?: number,
  ): Promise<VerificationResult | null> {
    if (!env.FACT_VERIFICATION_ENABLED) return null;
    if (deathCoaching.length === 0) return null;

    try {
      // Parse death timestamps
      const deathTimestamps: { deathNumber: number; timestampSec: number }[] = [];
      for (const d of deathCoaching) {
        const sec = parseTimestamp(d.approximate_time);
        if (sec !== null) {
          deathTimestamps.push({ deathNumber: d.death_number, timestampSec: sec });
        }
      }

      if (deathTimestamps.length === 0) {
        console.log('[FactVerification] no valid death timestamps, skipping');
        return null;
      }

      // Build frame requests and extract
      const requests = buildFrameRequests(deathTimestamps, videoDurationSec);
      const frames = await extractFrames(videoBuffer, requests);

      if (frames.length === 0) {
        console.log('[FactVerification] no frames extracted, skipping');
        return null;
      }

      return this.verifyFrames(frames, deathCoaching);
    } catch (err) {
      console.warn(
        '[FactVerification] failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Verify using pre-extracted images from the clip builder.
   * Skips the frame extraction step entirely — images are already at correct timestamps.
   */
  async verifyWithClipImages(
    clipImages: ExtractedImage[],
    deathCoaching: any[],
    detectedAgent?: string,
    detectedMap?: string,
  ): Promise<VerificationResult | null> {
    if (!env.FACT_VERIFICATION_ENABLED) return null;
    if (deathCoaching.length === 0 || clipImages.length === 0) return null;

    try {
      // Convert ExtractedImage → ExtractedFrame format
      const frames: ExtractedFrame[] = clipImages.map((img) => ({
        timestampSec: img.originalTimestampSec,
        label: img.label,
        base64: img.base64,
        mimeType: img.mimeType,
      }));

      console.log(
        '[FactVerification] using %d pre-extracted clip images (skipping frame extraction)',
        frames.length,
      );
      return this.verifyFrames(frames, deathCoaching, detectedAgent, detectedMap);
    } catch (err) {
      console.warn(
        '[FactVerification] clip image verification failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Full coaching from high-res frames — produces the COMPLETE coaching report.
   * Uses a multi-phase pipeline for focused quality, with legacy fallback.
   */
  async fullCoach(
    clipImages: ExtractedImage[],
    deathTimestamps: {
      death_number: number;
      approximate_time: string;
      round_utility_events?: {
        ability_name: string;
        approximate_time: string;
        usage_description: string;
      }[];
    }[],
    gameMode: string,
    coachingHistory?: CoachingHistory | null,
    rank?: string,
    detectedAgent?: string,
    detectedMap?: string,
    playerMemoryContext?: string,
  ): Promise<FullCoachingResult | null> {
    if (clipImages.length === 0 || deathTimestamps.length === 0) return null;

    // Try multi-phase pipeline first (focused calls → better quality)
    try {
      const result = await this.fullCoachMultiPhase(
        clipImages,
        deathTimestamps,
        gameMode,
        coachingHistory,
        rank,
        detectedAgent,
        detectedMap,
        playerMemoryContext,
      );
      if (result && result.deathCoaching.length > 0) return result;
      console.warn('[FullCoaching] multi-phase returned no deaths, falling back to legacy');
    } catch (err) {
      console.error(
        '[FullCoaching] multi-phase failed, falling back to legacy:',
        err instanceof Error ? err.message : err,
      );
    }

    // Fallback: legacy single-call approach
    return this.fullCoachLegacy(
      clipImages,
      deathTimestamps,
      gameMode,
      coachingHistory,
      rank,
      detectedAgent,
      detectedMap,
    );
  }

  /**
   * Multi-phase coaching pipeline:
   *   Phase A: Agent/map identification from agent_id frames (~8 images)
   *   Phase B: Per-death coaching in parallel (~21 images each)
   *   Phase C: Pattern synthesis from text (no images)
   */
  private async fullCoachMultiPhase(
    clipImages: ExtractedImage[],
    deathTimestamps: {
      death_number: number;
      approximate_time: string;
      round_utility_events?: {
        ability_name: string;
        approximate_time: string;
        usage_description: string;
      }[];
    }[],
    gameMode: string,
    coachingHistory?: CoachingHistory | null,
    rank?: string,
    detectedAgent?: string,
    detectedMap?: string,
    playerMemoryContext?: string,
  ): Promise<FullCoachingResult | null> {
    const pipelineStart = Date.now();
    const costs: PhaseCost[] = [];

    // ── Separate frames ─────────────────────────────────────────────────────
    const allFrames: FrameEntry[] = clipImages.map((img) => ({
      timestampSec: img.originalTimestampSec,
      label: img.label,
      base64: img.base64,
      mimeType: img.mimeType,
    }));
    const agentIdFrames = allFrames.filter((f) => f.label.startsWith('agent_id'));
    const deathFrames = allFrames.filter((f) => !f.label.startsWith('agent_id'));

    // Generate zoomed crops from agent_id frames
    const agentIdCrops = await generateAgentIdCrops(agentIdFrames);

    // Group death frames by death number
    const deathGroups = groupFramesByDeath(deathFrames);

    // Extract death banner crops for process-of-elimination in Phase A.
    // Death banners show "ELIMINATED BY [ENEMY]" — if the model sees
    // the enemy IS agent X, then the player CANNOT be agent X.
    const deathBannerCrops = deathFrames
      .filter((f) => f.label.includes('crop_deathbanner'))
      .slice(0, 5); // up to 5 unique death banners

    console.log(
      '[FullCoaching:MultiPhase] starting 3-phase pipeline: %d deaths, %d agent_id frames, %d agent_id crops, %d death banners, %d death frames, mode=%s',
      deathTimestamps.length,
      agentIdFrames.length,
      agentIdCrops.length,
      deathBannerCrops.length,
      deathFrames.length,
      gameMode,
    );

    // ═══ PHASE A: Identity (agent + map) ════════════════════════════════════
    // Agent comes from user selection (UI dropdown) or Pass 1 detection.
    // Map comes from Pass 1 detection (reliable from loading screen text).
    // When both are known, skip Phase A entirely — saves ~$0.003 and ~3 seconds.
    let agentName = detectedAgent ?? 'unknown';
    let agentConfidence: 'certain' | 'uncertain' =
      detectedAgent && detectedAgent !== 'unknown' ? 'certain' : 'uncertain';
    let agentEvidence =
      detectedAgent && detectedAgent !== 'unknown' ? 'User-selected or Pass 1 detection' : '';
    let mapName = detectedMap ?? 'unknown';

    const needsPhaseA = agentName === 'unknown' || mapName === 'unknown';

    if (needsPhaseA) {
      // Only run VLM Phase A if we're missing agent or map
      try {
        const identityImages = [...agentIdFrames, ...agentIdCrops, ...deathBannerCrops];
        const identityPrompt = buildIdentityPrompt(
          detectedAgent,
          detectedMap,
          deathBannerCrops.length,
        );
        const identitySchema = buildIdentitySchema();

        console.log(
          '[FullCoaching:PhaseA] agent or map unknown — running VLM identity (%d images)',
          identityImages.length,
        );
        const phaseAStart = Date.now();

        const phaseA = await this.vlm.verifyWithImages(
          identityImages,
          identityPrompt,
          identitySchema,
          30_000,
          'gemini-2.5-flash-lite',
          4096,
          512,
        );
        costs.push(phaseA);

        const id = phaseA.result;
        if (agentName === 'unknown' && id.agent_name && (id.agent_name as string) !== 'unknown') {
          agentName = id.agent_name as string;
          agentConfidence = (id.agent_confidence as 'certain' | 'uncertain') ?? 'uncertain';
          agentEvidence = (id.agent_evidence as string) ?? 'VLM identification';
        }
        if (mapName === 'unknown' && id.map_name && (id.map_name as string) !== 'unknown') {
          mapName = id.map_name as string;
        }

        console.log(
          '[FullCoaching:PhaseA] result: agent=%s(%s), map=%s, cost=$%s, %dms',
          agentName,
          agentConfidence,
          mapName,
          phaseA.costUsd.toFixed(4),
          Date.now() - phaseAStart,
        );
      } catch (err) {
        console.warn('[FullCoaching:PhaseA] failed:', err instanceof Error ? err.message : err);
      }
    } else {
      console.log(
        '[FullCoaching:PhaseA] SKIPPED — agent=%s, map=%s (both known)',
        agentName,
        mapName,
      );
    }

    // ═══ PHASE B: Per-Death Coaching (parallel) ═════════════════════════════
    const phaseBStart = Date.now();
    console.log(
      '[FullCoaching:PhaseB] launching %d parallel death analyses (agent=%s, map=%s)',
      deathTimestamps.length,
      agentName,
      mapName,
    );

    const perDeathSchema = buildPerDeathSchema();
    const deathPromises = deathTimestamps.map(async (dt) => {
      const frames = deathGroups.get(dt.death_number) ?? [];
      if (frames.length === 0) {
        throw new Error(`No frames for death ${dt.death_number}`);
      }

      // ── Ability bar brightness analysis ──────────────────────────────────
      // Compare earliest frame (t-7.0) and predeath frame (t-1.0 or closest)
      // to determine which abilities were used vs available at death.
      let abilityContext = '';
      try {
        const fullFrames = frames.filter((f) => !f.label.includes('crop_'));
        const earlyFrame = fullFrames[0]; // t-7.0 (earliest)
        const lateFrame =
          fullFrames.length > 2
            ? fullFrames[fullFrames.length - 2] // second-to-last (roughly t-1.0)
            : fullFrames[fullFrames.length - 1]; // fallback to last

        const [earlyAnalysis, lateAnalysis] = await Promise.all([
          earlyFrame ? analyzeAbilityBar(earlyFrame.base64) : null,
          lateFrame ? analyzeAbilityBar(lateFrame.base64) : null,
        ]);

        abilityContext = compareAbilityStates(earlyAnalysis, lateAnalysis, agentName);
        console.log('[FullCoaching:PhaseB:Death%d:Abilities] %s', dt.death_number, abilityContext);
      } catch {
        // Non-critical — continue without ability context
      }

      const prompt = buildPerDeathPrompt(
        dt.death_number,
        dt.approximate_time,
        agentName,
        mapName,
        gameMode,
        rank,
        abilityContext,
        playerMemoryContext,
        dt.round_utility_events,
      );

      const result = await this.vlm.verifyWithImages(
        frames,
        prompt,
        perDeathSchema,
        60_000, // 60s timeout per death
        'gemini-2.5-flash', // flash: Phase B needs full model for quality coaching analysis (lite too generic)
        8192, // maxOutputTokens
        1024, // thinking budget — hard cap keeps cost predictable
      );
      return { ...result, deathNumber: dt.death_number };
    });

    const settled = await Promise.allSettled(deathPromises);
    const deathCoaching: any[] = [];

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        const { result, costUsd, tokensUsed, deathNumber } = outcome.value;
        costs.push({ costUsd, tokensUsed });

        // Validate the result has coaching content
        if (result.situation && result.mistake && result.correction) {
          // ── Post-VLM enforcement: ability bar reality check ──────────────
          // If VLM categorized as "utility" but pixel analysis shows abilities
          // were on cooldown (already used), override the category.
          let finalCategory = result.category as string;
          const abilityObs = result.ability_observation as any;
          if (finalCategory === 'utility' && abilityObs) {
            const available = Array.isArray(abilityObs.abilities_available)
              ? abilityObs.abilities_available
              : [];
            const onCooldown = Array.isArray(abilityObs.abilities_on_cooldown)
              ? abilityObs.abilities_on_cooldown
              : [];
            // If most/all abilities were on cooldown and few available, "utility" is likely wrong
            if (onCooldown.length > 0 && available.length <= 1) {
              console.log(
                '[FullCoaching:PhaseB:Death%d] OVERRIDE: category "utility" → "peeking" (abilities on cooldown: %s, available: %s)',
                deathNumber,
                onCooldown.join(','),
                available.join(','),
              );
              finalCategory = 'peeking'; // Default fallback — most common actual mistake
            }
          }

          deathCoaching.push({
            ...result,
            category: finalCategory,
            death_number: result.death_number ?? deathNumber,
          });
          console.log(
            '[FullCoaching:PhaseB:Death%d] category=%s, weapon=%s, killed_by=%s, cost=$%s',
            deathNumber,
            finalCategory,
            result.weapon_used,
            result.killed_by,
            costUsd.toFixed(4),
          );
        } else {
          console.warn('[FullCoaching:PhaseB:Death%d] empty coaching — skipping', deathNumber);
        }
      } else {
        const deathNum = deathTimestamps[settled.indexOf(outcome)]?.death_number ?? '?';
        console.warn(
          '[FullCoaching:PhaseB:Death%s] FAILED: %s',
          deathNum,
          outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
        );
      }
    }

    // Preserve priority ordering from coaching.routes.ts (highest coaching_priority first).
    // Do NOT re-sort by death_number — that would undo priority sorting.

    console.log(
      '[FullCoaching:PhaseB] %d/%d deaths succeeded, total_cost=$%s, wall_clock=%dms',
      deathCoaching.length,
      deathTimestamps.length,
      costs
        .filter((_, i) => i > 0)
        .reduce((s, c) => s + c.costUsd, 0)
        .toFixed(4),
      Date.now() - phaseBStart,
    );

    if (deathCoaching.length === 0) {
      console.error('[FullCoaching:PhaseB] ALL deaths failed — aborting multi-phase');
      return null;
    }

    // ═══ PHASE C: Pattern Synthesis (text only) ═════════════════════════════
    let synthesisResult: Record<string, unknown>;
    try {
      const deathSummaries = deathCoaching.map((d) => ({
        death_number: d.death_number ?? 0,
        category: d.category ?? 'unclear',
        situation: d.situation ?? '',
        mistake: d.mistake ?? '',
        correction: d.correction ?? '',
        weapon_used: d.weapon_used ?? 'unknown',
        killed_by: d.killed_by ?? 'unknown',
        map_location: d.map_location as string | undefined,
      }));

      const synthesisPrompt = buildSynthesisPrompt(
        deathSummaries,
        agentName,
        mapName,
        gameMode,
        rank,
        coachingHistory,
        playerMemoryContext,
      );
      const synthesisSchema = buildSynthesisSchema();

      console.log('[FullCoaching:PhaseC] sending text synthesis (%d deaths)', deathCoaching.length);
      const phaseCStart = Date.now();

      const phaseC = await this.vlm.verifyWithImages(
        [], // NO images — text only
        synthesisPrompt,
        synthesisSchema,
        30_000, // 30s timeout
        'gemini-2.5-flash-lite', // text-only synthesis — no need for expensive model
        8192, // maxOutputTokens
        0, // no thinking needed
      );
      costs.push(phaseC);
      synthesisResult = phaseC.result;

      console.log(
        '[FullCoaching:PhaseC] result: priority=%s, %d secondary, cost=$%s, %dms',
        (synthesisResult.priority_pattern as any)?.category ?? '?',
        ((synthesisResult.secondary_patterns as any[]) ?? []).length,
        phaseC.costUsd.toFixed(4),
        Date.now() - phaseCStart,
      );
    } catch (err) {
      console.warn(
        '[FullCoaching:PhaseC] failed — using fallback synthesis:',
        err instanceof Error ? err.message : err,
      );
      synthesisResult = buildFallbackSynthesis(deathCoaching);
    }

    // ═══ Assembly ════════════════════════════════════════════════════════════
    const totalCost = accumulateCosts(costs);
    const playerAgent: VerifiedPlayerAgent | null =
      agentName !== 'unknown'
        ? {
            name: agentName,
            confidence: agentConfidence,
            evidence: agentEvidence || 'Identified from high-res agent_id frames (Phase A)',
          }
        : null;

    console.log(
      '[FullCoaching:MultiPhase] complete: %d deaths, agent=%s(%s), map=%s, total_cost=$%s, total_time=%dms',
      deathCoaching.length,
      agentName,
      agentConfidence,
      mapName,
      totalCost.costUsd.toFixed(4),
      Date.now() - pipelineStart,
    );

    return {
      deathCoaching,
      priorityPattern: synthesisResult.priority_pattern ?? null,
      secondaryPatterns: (synthesisResult.secondary_patterns ?? []) as any[],
      strengths: (synthesisResult.strengths ?? []) as string[],
      sessionFocus: synthesisResult.session_focus ?? null,
      matchVerdict: (synthesisResult.match_verdict as string) ?? '',
      coachingContinuity: synthesisResult.coaching_continuity ?? null,
      playerAgent,
      verifiedMap: mapName,
      costUsd: totalCost.costUsd,
      tokensUsed: totalCost.tokensUsed,
    };
  }

  /**
   * Legacy: Full coaching in a single monolithic VLM call.
   * Kept as fallback if multi-phase pipeline fails.
   */
  private async fullCoachLegacy(
    clipImages: ExtractedImage[],
    deathTimestamps: { death_number: number; approximate_time: string }[],
    gameMode: string,
    coachingHistory?: CoachingHistory | null,
    rank?: string,
    detectedAgent?: string,
    detectedMap?: string,
  ): Promise<FullCoachingResult | null> {
    if (clipImages.length === 0 || deathTimestamps.length === 0) return null;

    try {
      // Sort frames: agent_id FIRST so the model sees the player's agent portrait
      // BEFORE any death frames (which contain enemy agents in death banners).
      // This prevents the model from anchoring on enemy agent names.
      const allFrames = clipImages.map((img) => ({
        timestampSec: img.originalTimestampSec,
        label: img.label,
        base64: img.base64,
        mimeType: img.mimeType,
      }));
      const agentIdFrames = allFrames.filter((f) => f.label.startsWith('agent_id'));
      const deathFrames = allFrames.filter((f) => !f.label.startsWith('agent_id'));

      // Generate zoomed crops from agent_id frames for reliable identification
      const agentIdCrops = await generateAgentIdCrops(agentIdFrames);
      // Order: agent_id full frames → zoomed crops → death frames
      const frames = [...agentIdFrames, ...agentIdCrops, ...deathFrames];

      const prompt = buildFullCoachingPromptLegacy(
        deathTimestamps,
        gameMode,
        coachingHistory,
        rank,
        detectedAgent,
        detectedMap,
      );
      const schema = buildFullCoachingSchemaLegacy();

      console.log(
        '[FullCoaching] sending %d frames (%d agent_id + %d agent_id_crops + %d death) for full coaching (%d deaths, mode=%s)',
        frames.length,
        agentIdFrames.length,
        agentIdCrops.length,
        deathFrames.length,
        deathTimestamps.length,
        gameMode,
      );

      const { result, costUsd, tokensUsed } = await this.vlm.verifyWithImages(
        frames,
        prompt,
        schema,
        240_000, // 4min timeout — full frame set + thinking
        'gemini-2.5-flash-lite', // flash-lite: 84% cheaper, sufficient for coaching extraction
        65536, // maxOutputTokens (must exceed thinking + response)
        4096, // thinking budget — legacy fallback, moderate reasoning
      );

      // Determine best agent: Pass 2 has HIGH-RES crops and is the authority.
      // Pass 1 (low-res video) is a fallback only when Pass 2 can't identify.
      const pass2Agent = result.verified_agent as any;
      const pass2Map = result.verified_map as any;
      let playerAgent: VerifiedPlayerAgent | null = null;

      if (
        pass2Agent?.confidence === 'certain' &&
        pass2Agent.agent_name &&
        pass2Agent.agent_name !== 'unknown'
      ) {
        // Pass 2 identified from high-res crops — trust it (it can read text)
        playerAgent = {
          name: pass2Agent.agent_name,
          confidence: 'certain',
          evidence: 'Verified from high-res agent_id frames and ability bar crops (Pass 2)',
        };
        if (
          detectedAgent &&
          detectedAgent !== 'unknown' &&
          pass2Agent.agent_name !== detectedAgent
        ) {
          console.log(
            '[FullCoaching] Pass 2 CORRECTED agent: Pass 1="%s" → Pass 2="%s" (high-res crops are authoritative)',
            detectedAgent,
            pass2Agent.agent_name,
          );
        }
      } else if (detectedAgent && detectedAgent !== 'unknown') {
        // Pass 2 couldn't identify — fall back to Pass 1's low-res guess
        playerAgent = {
          name: detectedAgent,
          confidence: 'uncertain',
          evidence: 'From low-resolution video analysis (Pass 1) — Pass 2 could not verify',
        };
        console.log(
          '[FullCoaching] Pass 2 couldn\'t identify agent — falling back to Pass 1 guess "%s"',
          detectedAgent,
        );
      }

      // Map: Pass 2 can also correct
      let verifiedMap = detectedMap ?? 'unknown';
      if (
        pass2Map?.confidence === 'certain' &&
        pass2Map.map_name &&
        pass2Map.map_name !== 'unknown'
      ) {
        if (verifiedMap !== pass2Map.map_name) {
          console.log(
            '[FullCoaching] CORRECTED map: Pass 1 said "%s" → Pass 2 sees "%s" (high-res minimap)',
            verifiedMap,
            pass2Map.map_name,
          );
        }
        verifiedMap = pass2Map.map_name;
      }

      const deathCoaching = (result.death_coaching ?? []) as any[];
      const strengths = (result.strengths ?? []) as string[];

      console.log(
        '[FullCoaching] complete: %d deaths, agent=%s(%s), map=%s, cost=$%s',
        deathCoaching.length,
        playerAgent?.name ?? 'unknown',
        playerAgent?.confidence ?? 'n/a',
        verifiedMap,
        costUsd.toFixed(4),
      );

      return {
        deathCoaching,
        priorityPattern: result.priority_pattern ?? null,
        secondaryPatterns: (result.secondary_patterns ?? []) as any[],
        strengths,
        sessionFocus: result.session_focus ?? null,
        matchVerdict: (result.match_verdict as string) ?? '',
        coachingContinuity: result.coaching_continuity ?? null,
        playerAgent,
        verifiedMap,
        costUsd,
        tokensUsed,
      };
    } catch (err) {
      console.error('[FullCoaching] failed (non-fatal):', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Shared enrichment logic — sends frames + original coaching to flash, parses enriched results. */
  private async verifyFrames(
    frames: ExtractedFrame[],
    deathCoaching?: any[],
    detectedAgent?: string,
    detectedMap?: string,
  ): Promise<VerificationResult | null> {
    // Log frame composition being sent to enrichment
    const fullFrames = frames.filter((f) => !f.label.includes('crop_'));
    const cropFrames = frames.filter((f) => f.label.includes('crop_'));
    console.log(
      '[Enrichment] sending %d frames (%d full + %d crops), lockedAgent=%s, lockedMap=%s',
      frames.length,
      fullFrames.length,
      cropFrames.length,
      detectedAgent ?? 'none',
      detectedMap ?? 'none',
    );
    if (cropFrames.length > 0) {
      console.log('[Enrichment] crop labels: %s', cropFrames.map((f) => f.label).join(', '));
    } else {
      console.warn('[Enrichment] WARNING: no crop frames — text readability will be limited');
    }

    // Detect high-fps frames from client (labels like "death_1_t-3.0")
    const isHighFps = frames.some((f) => /death_\d+_t-?\d/.test(f.label));
    const prompt = buildEnrichmentPrompt(
      deathCoaching ?? [],
      isHighFps,
      detectedAgent,
      detectedMap,
    );
    const { result, costUsd, tokensUsed } = await this.vlm.verifyWithImages(
      frames,
      prompt,
      ENRICHMENT_SCHEMA,
      env.FACT_VERIFICATION_TIMEOUT_MS,
    );

    const verifiedDeaths: VerifiedDeath[] = ((result.enriched_deaths ?? []) as any[]).map(
      (d: any) => ({
        death_number: d.death_number ?? 0,
        weapon_used: d.weapon_used ?? null,
        weapon_confidence: d.weapon_confidence ?? 'uncertain',
        killed_by: d.killed_by ?? null,
        killed_by_confidence: d.killed_by_confidence ?? 'uncertain',
        map_location: d.map_location ?? null,
        abilities_available: d.abilities_available ?? [],
        situation: d.situation ?? undefined,
        mistake: d.mistake ?? undefined,
        correction: d.correction ?? undefined,
      }),
    );

    // Diagnostic: compare main analysis vs enrichment for each death
    if (deathCoaching && deathCoaching.length > 0) {
      console.log('[Enrichment] ──── COMPARISON: original vs enriched ────');
      for (const vd of verifiedDeaths) {
        const original = deathCoaching.find((d: any) => d.death_number === vd.death_number);
        if (original) {
          const weaponChanged = original.weapon_used !== vd.weapon_used;
          const killedByChanged = original.killed_by !== vd.killed_by;
          console.log(
            '[Enrichment] Death %d: weapon %s→%s(%s)%s | killed_by %s→%s(%s)%s | location=%s',
            vd.death_number,
            original.weapon_used,
            vd.weapon_used,
            vd.weapon_confidence,
            weaponChanged ? ' CORRECTED' : '',
            original.killed_by,
            vd.killed_by,
            vd.killed_by_confidence,
            killedByChanged ? ' CORRECTED' : '',
            vd.map_location ?? 'unknown',
          );
          if (vd.situation) {
            console.log(
              '[Enrichment]   situation: %s → %s',
              (original.situation ?? '').slice(0, 60),
              (vd.situation ?? '').slice(0, 60),
            );
          }
        }
      }
      console.log('[Enrichment] ──────────────────────────────────────────');
    }

    console.log(
      '[Enrichment] enriched %d deaths, cost=$%s',
      verifiedDeaths.length,
      costUsd.toFixed(6),
    );

    // Agent comes from Pass 1 — enrichment does NOT re-identify
    return { deaths: verifiedDeaths, buyPhases: [], playerAgent: null, costUsd, tokensUsed };
  }
}
