/**
 * Death Context Extractor
 *
 * Takes HSV-detected death timestamps + video buffer, extracts per-death
 * context via frame extraction + VLM single-frame reading + pixel analysis.
 *
 * For each death, extracts:
 *   - Enemy agent + weapon (VLM reads deathscreen, $0.0002)
 *   - Player positioning + movement (VLM observes predeath frames, $0.0003)
 *   - Ability bar state (pixel analysis, $0)
 *   - Map location, score, economy (VLM reads HUD text, $0.0002)
 *
 * Total per death: ~$0.0007 | Per game (10 deaths): ~$0.007
 */

import { GeminiProvider, type GeminiModelId } from '../vlm/gemini.provider.js';
import { buildFrameRequests, extractFrames, type ExtractedFrame } from './frame-extractor.js';
import {
  analyzeAbilityBar,
  compareAbilityStates,
  type AbilityBarAnalysis,
} from './ability-analysis.js';
import { VALID_AGENTS, VALID_WEAPONS } from '../../games/valorant/knowledge.js';
import { logger } from '../../shared/logger.js';
// X1b deferred: weapon-classifier.onnx classes include "enemy" / "enemy_head"
// alongside actual weapons, suggesting the model was trained on combined
// deathscreen crops, not isolated weapon icons. Without a known crop region
// we'd be feeding the wrong input. VLM weapon reads at ~80% accuracy are
// adequate until we either retrain or document the expected input region.
// import { classify as onnxClassify } from './model-loader.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeathContext {
  deathNumber: number;
  timestampSec: number;
  round: number;

  // From VLM reading deathscreen frame
  enemyAgent: string | null;
  enemyAgentConfidence: 'certain' | 'uncertain';
  killedByWeapon: string | null;
  killedByWeaponConfidence: 'certain' | 'uncertain';

  // From VLM multi-frame observation (positioning, movement, crosshair)
  visualObservation: {
    coverStatus: string; // "exposed" | "partially_covered" | "behind_cover"
    environment: string; // "corridor", "open site", "chokepoint"
    crosshairHeight: string; // "head_height" | "body_height" | "ground_level"
    playerAction: string; // "holding angle", "pushing", "peeking"
    enemiesVisible: boolean;
    observationNote: string; // 1-2 sentence description
  } | null;

  // From VLM reading gameplay frame HUD
  mapLocation: string | null;
  roundScore: string | null;
  playerEconomy: string | null;

  // From pixel analysis (zero cost)
  abilityState: AbilityBarAnalysis | null;
  abilityComparison: string;

  // Cost tracking
  vlmCostUsd: number;

  // Error tracking — number of VLM calls that failed for this death
  errorCount: number;
  errors: string[];
}

// ── VLM schemas (minimal, focused) ──────────────────────────────────────────

const DEATHSCREEN_SCHEMA = {
  type: 'object',
  properties: {
    enemy_agent: {
      type: 'string',
      enum: [...VALID_AGENTS, 'an enemy', 'unknown'],
      description: 'Agent that killed the player (from combat report "KILLED BY [AGENT]").',
    },
    weapon: {
      type: 'string',
      enum: [...VALID_WEAPONS, 'unknown'],
      description: 'Weapon used for the kill (from combat report).',
    },
    confidence: { type: 'string', enum: ['certain', 'uncertain'] },
  },
  required: ['enemy_agent', 'weapon', 'confidence'],
};

const VISUAL_OBSERVATION_SCHEMA = {
  type: 'object',
  properties: {
    cover_status: { type: 'string', enum: ['exposed', 'partially_covered', 'behind_cover'] },
    environment: { type: 'string', description: 'Brief area description' },
    crosshair_height: {
      type: 'string',
      enum: ['head_height', 'body_height', 'ground_level', 'above_head'],
    },
    player_action: { type: 'string', description: 'What the player is doing' },
    enemies_visible: { type: 'boolean' },
    observation_note: {
      type: 'string',
      description: '1-2 sentence description of what you see across frames',
    },
    mistake: {
      type: 'string',
      description: 'What positioning/movement mistake likely led to the death',
    },
  },
  required: [
    'cover_status',
    'environment',
    'crosshair_height',
    'player_action',
    'enemies_visible',
    'observation_note',
    'mistake',
  ],
};

const GAME_STATE_SCHEMA = {
  type: 'object',
  properties: {
    location: { type: 'string', description: 'Map callout text from top of screen, or "unknown"' },
    round_score: { type: 'string', description: 'Score like "5 - 3", or "unknown"' },
    economy: { type: 'string', description: 'Player money (credits number), or "unknown"' },
  },
  required: ['location', 'round_score', 'economy'],
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract rich context for each detected death.
 *
 * @param videoBuffer - The video file (MP4)
 * @param deaths - Death timestamps from HSV detector
 * @param videoDurationSec - Total video duration
 * @param agentName - Player's agent (from user selection), for ability name lookup
 * @param vlm - GeminiProvider instance
 * @returns Per-death context with visual observations, killer info, abilities, etc.
 */
/** Minimal death info — compatible with both HSV and VLM classifier output. */
interface DeathInput {
  timestampSec: number;
  round: number;
  confidence: number;
}

export async function extractDeathContexts(
  videoBuffer: Buffer,
  deaths: DeathInput[],
  videoDurationSec: number,
  agentName: string,
  vlm: GeminiProvider,
  /** Pre-extracted frames from the pipeline — avoids redundant ffmpeg extraction */
  preExtractedFrames?: ExtractedFrame[],
  /** Pre-written video path to avoid redundant disk write */
  sharedVideoPath?: string,
): Promise<DeathContext[]> {
  if (deaths.length === 0) return [];

  const maxDeaths = Math.min(deaths.length, 8); // Cap at 8 to control cost
  const deathsToProcess = deaths.slice(0, maxDeaths);

  console.log('[DeathContext] extracting context for %d deaths...', deathsToProcess.length);

  // ── Step 1: Extract frames (or reuse pre-extracted) ──
  let frames: ExtractedFrame[];
  if (preExtractedFrames && preExtractedFrames.length > 0) {
    frames = preExtractedFrames;
    console.log('[DeathContext] reusing %d pre-extracted frames (incl crops)', frames.length);
  } else {
    const deathTimestamps = deathsToProcess.map((d, i) => ({
      deathNumber: i + 1,
      timestampSec: d.timestampSec,
    }));
    const requests = buildFrameRequests(deathTimestamps, videoDurationSec);
    frames = await extractFrames(videoBuffer, requests, sharedVideoPath);
    console.log('[DeathContext] extracted %d frames (incl crops)', frames.length);
  }

  // ── Step 2: Process each death (parallel, max 3 concurrent) ──
  const CONCURRENCY = 3;
  const contexts: DeathContext[] = [];

  for (let i = 0; i < deathsToProcess.length; i += CONCURRENCY) {
    const batch = deathsToProcess.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((death, batchIdx) => {
        const deathNum = i + batchIdx + 1;
        return processOneDeath(deathNum, death, frames, agentName, vlm);
      }),
    );
    contexts.push(...batchResults);
  }

  const totalCost = contexts.reduce((sum, c) => sum + c.vlmCostUsd, 0);
  console.log(
    '[DeathContext] done: %d deaths, total VLM cost=$%s',
    contexts.length,
    totalCost.toFixed(6),
  );

  return contexts;
}

// ── Internal: Process one death ──────────────────────────────────────────────

async function processOneDeath(
  deathNum: number,
  death: DeathInput,
  frames: ExtractedFrame[],
  agentName: string,
  vlm: GeminiProvider,
): Promise<DeathContext> {
  const prefix = `death_${deathNum}`;
  let totalCost = 0;
  let errorCount = 0;
  const errors: string[] = [];

  // Find frames for this death
  const deathscreen = frames.find((f) => f.label === `${prefix}_deathscreen`);
  const predeath = frames.find((f) => f.label === `${prefix}_predeath`);
  const preFrames = ['pre_5s', 'pre_4s', 'pre_3s', 'pre_2s', 'predeath', 'moment']
    .map((suffix) => frames.find((f) => f.label === `${prefix}_${suffix}`))
    .filter((f): f is ExtractedFrame => f != null);
  const earlyFrame = frames.find((f) => f.label === `${prefix}_pre_5s`);

  // ── Task A: Read death screen (enemy agent + weapon) ──
  let enemyAgent: string | null = null;
  let enemyAgentConf: 'certain' | 'uncertain' = 'uncertain';
  let killedByWeapon: string | null = null;
  let killedByWeaponConf: 'certain' | 'uncertain' = 'uncertain';

  if (deathscreen) {
    try {
      const resp = await vlm.verifyWithImages(
        [{ label: 'deathscreen', base64: deathscreen.base64, mimeType: 'image/jpeg' }],
        'Valorant death/spectating screen. Find the COMBAT REPORT panel (right side). Read: (1) agent name from "KILLED BY [AGENT]" header, (2) weapon used. Check killfeed top-right too. Say "unknown" if unreadable.',
        DEATHSCREEN_SCHEMA,
        15000,
        'gemini-2.5-flash-lite' as GeminiModelId,
        256,
        0,
      );
      totalCost += resp.costUsd;
      const r = resp.result as any;
      enemyAgent = r.enemy_agent !== 'unknown' ? r.enemy_agent : null;
      enemyAgentConf = r.confidence ?? 'uncertain';
      killedByWeapon = r.weapon !== 'unknown' ? r.weapon : null;
      killedByWeaponConf = r.confidence ?? 'uncertain';
    } catch (err) {
      logger.warn({ err, deathIndex: deathNum }, 'Death context deathscreen read failed');
      errorCount++;
      errors.push(`deathscreen: ${(err as Error).message}`);
    }
  }

  // ── Task B: Visual observation from predeath frames ──
  let visualObs: DeathContext['visualObservation'] = null;

  // Use only predeath + moment (2 frames) to reduce cost while preserving key context
  const keyFrames = [predeath, frames.find((f) => f.label === `${prefix}_moment`)].filter(
    (f): f is ExtractedFrame => f != null,
  );
  if (keyFrames.length >= 1) {
    try {
      const images = keyFrames.map((f) => ({
        label: f.label,
        base64: f.base64,
        mimeType: 'image/jpeg' as const,
      }));
      const resp = await vlm.verifyWithImages(
        images,
        `Valorant gameplay frames just before a death. The first frame is 1 second before death, the second is the death moment. Observe: player positioning relative to cover, crosshair height, what the player was doing (pushing, peeking, holding), and the environment. Be specific.`,
        VISUAL_OBSERVATION_SCHEMA,
        25000,
        'gemini-2.5-flash-lite' as GeminiModelId,
        512,
        0,
      );
      totalCost += resp.costUsd;
      const r = resp.result as any;
      visualObs = {
        coverStatus: r.cover_status ?? 'exposed',
        environment: r.environment ?? 'unknown',
        crosshairHeight: r.crosshair_height ?? 'body_height',
        playerAction: r.player_action ?? 'unknown',
        enemiesVisible: r.enemies_visible ?? false,
        observationNote: r.observation_note ?? '',
      };
    } catch (err) {
      logger.warn({ err, deathIndex: deathNum }, 'Death context visual observation failed');
      errorCount++;
      errors.push(`visual_observation: ${(err as Error).message}`);
    }
  }

  // ── Task C: Game state from a gameplay frame (location, score, economy) ──
  let mapLocation: string | null = null;
  let roundScore: string | null = null;
  let playerEconomy: string | null = null;

  // Use a frame 3-5 seconds before death (more likely to show clean gameplay HUD)
  const gameStateFrame =
    frames.find((f) => f.label === `${prefix}_pre_3s`) ??
    frames.find((f) => f.label === `${prefix}_pre_4s`) ??
    predeath;

  if (gameStateFrame) {
    try {
      const resp = await vlm.verifyWithImages(
        [{ label: 'gameplay', base64: gameStateFrame.base64, mimeType: 'image/jpeg' }],
        'Valorant gameplay frame. Read HUD info: (1) location callout text at top of screen, (2) round score at top-center (two numbers), (3) player money at bottom-right (small number). Say "unknown" if unreadable.',
        GAME_STATE_SCHEMA,
        15000,
        'gemini-2.5-flash-lite' as GeminiModelId,
        256,
        0,
      );
      totalCost += resp.costUsd;
      const r = resp.result as any;
      mapLocation = r.location !== 'unknown' ? r.location : null;
      roundScore = r.round_score !== 'unknown' ? r.round_score : null;
      playerEconomy = r.economy !== 'unknown' ? r.economy : null;
    } catch (err) {
      logger.warn({ err, deathIndex: deathNum }, 'Death context game state read failed');
      errorCount++;
      errors.push(`game_state: ${(err as Error).message}`);
    }
  }

  // ── Task D: Ability bar pixel analysis ($0) ──
  let abilityState: AbilityBarAnalysis | null = null;
  let abilityComparison = '';

  if (predeath) {
    abilityState = await analyzeAbilityBar(predeath.base64);
    if (earlyFrame) {
      const earlyState = await analyzeAbilityBar(earlyFrame.base64);
      abilityComparison = compareAbilityStates(earlyState, abilityState, agentName);
    } else if (abilityState) {
      abilityComparison = `At death: ${abilityState.summary}`;
    }
  }

  return {
    deathNumber: deathNum,
    timestampSec: death.timestampSec,
    round: death.round,
    enemyAgent,
    enemyAgentConfidence: enemyAgentConf,
    killedByWeapon,
    killedByWeaponConfidence: killedByWeaponConf,
    visualObservation: visualObs,
    mapLocation,
    roundScore,
    playerEconomy,
    abilityState,
    abilityComparison,
    vlmCostUsd: totalCost,
    errorCount,
    errors,
  };
}
