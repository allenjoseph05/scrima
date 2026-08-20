/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * HSV Color-Based Game State Detector
 *
 * Replaces the unreliable brightness/saturation threshold approach with
 * targeted HSV color analysis on specific screen regions (ROIs).
 *
 * Based on proven techniques:
 * - valorant-timestamp-finder: HSV kill banner detection (~95% accuracy)
 * - Valoscribe: state machine game phase tracking
 * - Research: ROI-based analysis >> whole-frame statistics
 *
 * Detection targets:
 *   1. Death screen: full-frame desaturation + center overlay
 *   2. Buy phase: blue/teal shop UI
 *   3. Spectating: HUD change after death
 *   4. Round end: victory/defeat banner
 *   5. Loading/agent select: dark, static
 *
 * Runs on CPU. Zero AI cost. ~5-15 seconds for a 40-minute game.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Thumbnail config ─────────────────────────────────────────────────────────
// 320×180 thumbnails — sufficient for color analysis on ROIs. Fast to process.
const THUMB_W = 320;
const THUMB_H = 180;
const FRAME_BYTES = THUMB_W * THUMB_H * 3; // RGB24

// ── ROI definitions (at 160×90 scale, mapped from 1920×1080) ─────────────────
// Each ROI targets a specific HUD region whose appearance changes with game state.

const ROI = {
  /** Top-right killfeed / kill banner area. Yellow banner = player got a kill. */
  killfeed: { x1: 262, y1: 6, x2: 320, y2: 64 },
  /** Center of screen where "ELIMINATED BY" text overlay appears during death. */
  deathCenter: { x1: 96, y1: 50, x2: 224, y2: 130 },
  /** Bottom-center ability bar. Disappears on death screen. */
  abilityBar: { x1: 110, y1: 152, x2: 210, y2: 180 },
  /** Bottom-left health/shield bar. Disappears on death screen. */
  healthBar: { x1: 44, y1: 152, x2: 100, y2: 180 },
  /** Bottom-right weapon HUD. Disappears on death screen. */
  weaponHud: { x1: 260, y1: 150, x2: 320, y2: 180 },
  /** Top-left minimap. Changes appearance during death/spectating. */
  minimap: { x1: 0, y1: 0, x2: 56, y2: 56 },
  /** Top-center round score area. */
  roundScore: { x1: 120, y1: 0, x2: 200, y2: 20 },
  /** Upper-center area where round end banners (WIN/LOSS) appear. */
  roundBanner: { x1: 70, y1: 30, x2: 250, y2: 90 },
  /** Left half of screen where buy menu panel appears. */
  buyPanel: { x1: 0, y1: 20, x2: 150, y2: 160 },
} as const;

// ── HSV color ranges for game states ─────────────────────────────────────────
// Each range defines what HSV values indicate a specific game element.

/** Kill banner yellow highlight — from valorant-timestamp-finder (proven ~95%). */
const KILL_BANNER_HSV = { hMin: 20, hMax: 50, sMin: 0.18, sMax: 0.55, vMin: 0.73, vMax: 1.0 };

/**
 * Buy phase UI: dark navy/teal panel on left side of screen.
 * Tightened from broad blue to specific Valorant shop panel colors.
 * Requires higher saturation to avoid matching blue skies/maps.
 */
const BUY_PHASE_HSV = { hMin: 190, hMax: 230, sMin: 0.3, sMax: 0.85, vMin: 0.08, vMax: 0.45 };

/** Death screen red vignette flash at onset (appears for 1-2 frames). */
const DEATH_RED_FLASH = { hMin: 340, hMax: 20, sMin: 0.3, sMax: 1.0, vMin: 0.15, vMax: 0.6 };

// ── Types ────────────────────────────────────────────────────────────────────

export type GamePhase =
  | 'loading'
  | 'agent_select'
  | 'buy_phase'
  | 'gameplay'
  | 'death'
  | 'spectating'
  | 'round_end'
  | 'unknown';

export interface HsvFrameAnalysis {
  index: number;

  // Whole-frame statistics
  meanSaturation: number; // 0-1, mean saturation across all pixels
  meanValue: number; // 0-1, mean brightness (V channel)
  saturationDrop: number; // ratio vs running median (< 1.0 = desaturated)

  // ROI-specific signals
  hudPresent: boolean; // 2+ of 3 HUD regions have texture
  hudCompletelyGone: boolean; // ALL 3 HUD regions near-zero variance (death signal)
  abilityBarVariance: number; // pixel variance in ability bar region
  healthBarVariance: number; // pixel variance in health bar region
  weaponHudVariance: number; // pixel variance in weapon HUD region
  sharpness: number; // frame sharpness (low = blurred death screen)
  killBannerRatio: number; // % of killfeed ROI pixels matching yellow HSV
  buyPanelRatio: number; // % of buy panel ROI pixels matching blue HSV
  deathOverlayScore: number; // combined death overlay detection score (0-1)
  redFlashRatio: number; // % of frame pixels matching death red flash

  // Scene dynamics
  sceneDiff: number; // frame-to-frame pixel difference
  isStatic: boolean; // very low scene change (loading, buy phase)

  // Classified state
  detectedPhase: GamePhase;
  phaseConfidence: number; // 0-1
}

export interface GameTimelinePhase {
  type: GamePhase;
  startSec: number;
  endSec: number;
  round?: number;
  confidence: number;
}

export interface DetectedDeathHsv {
  timestampSec: number;
  confidence: number;
  durationFrames: number;
  round: number;
}

export interface DetectedBuyPhaseHsv {
  timestampSec: number;
  round: number;
  confidence: number;
}

export interface GameTimeline {
  phases: GameTimelinePhase[];
  deaths: DetectedDeathHsv[];
  buyPhases: DetectedBuyPhaseHsv[];
  rounds: { round: number; startSec: number; endSec: number; deathSec: number | null }[];
  gameplayStartSec: number;
  videoDurationSec: number;
  processingMs: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect game events and build a structured timeline from a video buffer.
 * Uses HSV color analysis on specific screen regions + a state machine.
 *
 * @param videoBuffer - Raw video file bytes (MP4)
 * @returns Structured game timeline with phases, deaths, buy phases, and rounds
 */
export async function detectGameTimeline(videoBuffer: Buffer): Promise<GameTimeline> {
  const startMs = Date.now();
  const tmpVideo = path.join(os.tmpdir(), `scrima-hsv-${Date.now()}.mp4`);
  const tmpRaw = path.join(os.tmpdir(), `scrima-hsv-${Date.now()}.rgb`);

  try {
    fs.writeFileSync(tmpVideo, videoBuffer);

    // Extract all frames as 160×90 RGB thumbnails at 1fps.
    await extractFrames(tmpVideo, tmpRaw);

    const rawBuffer = fs.readFileSync(tmpRaw);
    const numFrames = Math.floor(rawBuffer.length / FRAME_BYTES);

    if (numFrames < 10) {
      return emptyTimeline(numFrames, Date.now() - startMs);
    }

    // Phase 1: Compute HSV statistics for every frame
    const frameAnalyses = analyzeAllFrames(rawBuffer, numFrames);

    // Phase 2: Run state machine to build timeline
    const timeline = buildTimeline(frameAnalyses, numFrames);
    timeline.processingMs = Date.now() - startMs;

    console.log(
      '[HsvDetector] %d frames → %d deaths, %d buy phases, %d rounds in %dms',
      numFrames,
      timeline.deaths.length,
      timeline.buyPhases.length,
      timeline.rounds.length,
      timeline.processingMs,
    );

    return timeline;
  } finally {
    fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpRaw, { force: true });
  }
}

/**
 * Export raw per-frame HSV analysis for debugging/calibration.
 * Run on a test video to verify ROI positions and HSV thresholds.
 */
export async function extractHsvStats(videoBuffer: Buffer): Promise<{
  frames: HsvFrameAnalysis[];
  numFrames: number;
  processingMs: number;
}> {
  const startMs = Date.now();
  const tmpVideo = path.join(os.tmpdir(), `scrima-hsvdbg-${Date.now()}.mp4`);
  const tmpRaw = path.join(os.tmpdir(), `scrima-hsvdbg-${Date.now()}.rgb`);

  try {
    fs.writeFileSync(tmpVideo, videoBuffer);
    await extractFrames(tmpVideo, tmpRaw);
    const rawBuffer = fs.readFileSync(tmpRaw);
    const numFrames = Math.floor(rawBuffer.length / FRAME_BYTES);
    const frames = analyzeAllFrames(rawBuffer, numFrames);

    return { frames, numFrames, processingMs: Date.now() - startMs };
  } finally {
    fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpRaw, { force: true });
  }
}

// ── Frame extraction ─────────────────────────────────────────────────────────

async function extractFrames(videoPath: string, rawPath: string): Promise<void> {
  // Try CUDA hardware decode first, fall back to CPU
  let extracted = false;
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hwaccel',
        'cuda',
        '-i',
        videoPath,
        '-vf',
        `fps=1,scale=${THUMB_W}:${THUMB_H}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-v',
        'quiet',
        '-y',
        rawPath,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
    extracted = true;
  } catch {
    /* CUDA unavailable */
  }

  if (!extracted) {
    await execFileAsync(
      'ffmpeg',
      [
        '-i',
        videoPath,
        '-vf',
        `fps=1,scale=${THUMB_W}:${THUMB_H}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-v',
        'quiet',
        '-y',
        rawPath,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
  }
}

// ── HSV conversion ───────────────────────────────────────────────────────────

/** Convert RGB (0-255) to HSV (h: 0-360, s: 0-1, v: 0-1). */
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d > 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / d) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / d + 2);
    } else {
      h = 60 * ((rn - gn) / d + 4);
    }
    if (h < 0) h += 360;
  }

  return { h, s: max > 0 ? d / max : 0, v: max };
}

/** Check if a hue value falls within a range (handles wraparound at 360). */
function hueInRange(h: number, hMin: number, hMax: number): boolean {
  if (hMin <= hMax) {
    return h >= hMin && h <= hMax;
  }
  // Wraparound (e.g., red: 340-20)
  return h >= hMin || h <= hMax;
}

// ── ROI analysis ─────────────────────────────────────────────────────────────

interface RoiHsvStats {
  meanH: number;
  meanS: number;
  meanV: number;
  /** Fraction of pixels matching a specific HSV range (0-1). */
  matchRatio: number;
  /** Pixel intensity variance (high = textured, low = uniform). */
  variance: number;
  pixelCount: number;
}

/**
 * Compute HSV statistics for a rectangular ROI, optionally counting
 * pixels that match a given HSV color range.
 */
function analyzeRoi(
  frame: Buffer,
  roi: { x1: number; y1: number; x2: number; y2: number },
  colorRange?: {
    hMin: number;
    hMax: number;
    sMin: number;
    sMax: number;
    vMin: number;
    vMax: number;
  },
): RoiHsvStats {
  let sumH = 0;
  let sumS = 0;
  let sumV = 0;
  let sumV2 = 0; // for variance
  let matchCount = 0;
  let count = 0;

  for (let y = roi.y1; y < roi.y2 && y < THUMB_H; y++) {
    for (let x = roi.x1; x < roi.x2 && x < THUMB_W; x++) {
      const pi = (y * THUMB_W + x) * 3;
      const r = frame[pi];
      const g = frame[pi + 1];
      const b = frame[pi + 2];
      const { h, s, v } = rgbToHsv(r, g, b);

      sumH += h;
      sumS += s;
      sumV += v;
      sumV2 += v * v;
      count++;

      if (colorRange) {
        if (
          hueInRange(h, colorRange.hMin, colorRange.hMax) &&
          s >= colorRange.sMin &&
          s <= colorRange.sMax &&
          v >= colorRange.vMin &&
          v <= colorRange.vMax
        ) {
          matchCount++;
        }
      }
    }
  }

  if (count === 0) {
    return { meanH: 0, meanS: 0, meanV: 0, matchRatio: 0, variance: 0, pixelCount: 0 };
  }

  const meanV = sumV / count;
  const variance = Math.max(0, sumV2 / count - meanV * meanV);

  return {
    meanH: sumH / count,
    meanS: sumS / count,
    meanV,
    matchRatio: matchCount / count,
    variance,
    pixelCount: count,
  };
}

// ── Per-frame analysis ───────────────────────────────────────────────────────

function analyzeAllFrames(raw: Buffer, numFrames: number): HsvFrameAnalysis[] {
  const results: HsvFrameAnalysis[] = [];

  // Running saturation median for adaptive thresholds
  const recentSaturations: number[] = [];
  const WINDOW = 30; // 30-second window for median

  for (let i = 0; i < numFrames; i++) {
    const offset = i * FRAME_BYTES;
    const frame = raw.subarray(offset, offset + FRAME_BYTES);

    // ── Whole-frame saturation and brightness ──
    const fullFrame = analyzeRoi(frame, { x1: 0, y1: 0, x2: THUMB_W, y2: THUMB_H });
    const meanSaturation = fullFrame.meanS;
    const meanValue = fullFrame.meanV;

    // Adaptive saturation baseline
    recentSaturations.push(meanSaturation);
    if (recentSaturations.length > WINDOW) recentSaturations.shift();
    const medianSat = median(recentSaturations);
    const saturationDrop = medianSat > 0.01 ? meanSaturation / medianSat : 1.0;

    // ── ROI analyses ──

    // Kill banner (yellow) in killfeed area
    const killfeedStats = analyzeRoi(frame, ROI.killfeed, KILL_BANNER_HSV);
    const killBannerRatio = killfeedStats.matchRatio;

    // Buy phase (blue/teal) in buy panel area
    const buyStats = analyzeRoi(frame, ROI.buyPanel, BUY_PHASE_HSV);
    const buyPanelRatio = buyStats.matchRatio;

    // Ability bar variance (high = HUD present, low = death/spectating)
    const abilityBarStats = analyzeRoi(frame, ROI.abilityBar);
    const abilityBarVariance = abilityBarStats.variance;

    // Health bar variance
    const healthBarStats = analyzeRoi(frame, ROI.healthBar);
    const healthBarVariance = healthBarStats.variance;

    // Weapon HUD variance
    const weaponHudStats = analyzeRoi(frame, ROI.weaponHud);
    const weaponHudVariance = weaponHudStats.variance;

    // HUD presence: require at least 2 of 3 HUD regions to have texture.
    // At 320×180, regions are 4x bigger → variance is much more stable.
    const abilityActive = abilityBarVariance > 0.003;
    const healthActive = healthBarVariance > 0.002;
    const weaponActive = weaponHudVariance > 0.003;
    const hudActiveCount =
      (abilityActive ? 1 : 0) + (healthActive ? 1 : 0) + (weaponActive ? 1 : 0);
    const hudPresent = hudActiveCount >= 2;
    // ALL HUD gone = strong death signal (no other game event removes ALL HUD)
    const hudCompletelyGone = hudActiveCount === 0;

    // Center region analysis for death overlay text detection
    const centerStats = analyzeRoi(frame, ROI.deathCenter);

    // Sharpness: low = blurred death screen background, high = sharp gameplay
    let sharpness = 0;
    {
      let diffSum = 0;
      let cnt = 0;
      for (let y = 0; y < THUMB_H; y++) {
        for (let x = 1; x < THUMB_W; x++) {
          const pi = (y * THUMB_W + x) * 3;
          const pj = (y * THUMB_W + (x - 1)) * 3;
          diffSum += Math.abs(frame[pi] - frame[pj]);
          diffSum += Math.abs(frame[pi + 1] - frame[pj + 1]);
          diffSum += Math.abs(frame[pi + 2] - frame[pj + 2]);
          cnt += 3;
        }
      }
      sharpness = cnt > 0 ? diffSum / cnt : 0;
    }

    // Death overlay score: HUD absence is now PRIMARY signal
    const deathOverlayScore = computeDeathOverlayScore(
      meanSaturation,
      saturationDrop,
      centerStats,
      hudPresent,
      hudCompletelyGone,
      sharpness,
    );

    // Red flash (death onset indicator)
    const redFlashStats = analyzeRoi(
      frame,
      { x1: 0, y1: 0, x2: THUMB_W, y2: THUMB_H },
      DEATH_RED_FLASH,
    );
    const redFlashRatio = redFlashStats.matchRatio;

    // Scene difference from previous frame
    let sceneDiff = 0;
    if (i > 0) {
      const prevOffset = (i - 1) * FRAME_BYTES;
      let diffSum = 0;
      // Sample every 4th pixel for speed (160×90 = 14400 pixels, sample 3600)
      for (let p = 0; p < FRAME_BYTES; p += 12) {
        diffSum += Math.abs(frame[p] - raw[prevOffset + p]);
        diffSum += Math.abs(frame[p + 1] - raw[prevOffset + p + 1]);
        diffSum += Math.abs(frame[p + 2] - raw[prevOffset + p + 2]);
      }
      sceneDiff = diffSum / (FRAME_BYTES / 4);
    }
    const isStatic = sceneDiff < 3;

    // ── Classify phase ──
    const { phase, confidence } = classifyFrame({
      meanSaturation,
      meanValue,
      saturationDrop,
      hudPresent,
      abilityBarVariance,
      healthBarVariance,
      killBannerRatio,
      buyPanelRatio,
      deathOverlayScore,
      redFlashRatio,
      sceneDiff,
      isStatic,
    });

    results.push({
      index: i,
      meanSaturation,
      meanValue,
      saturationDrop,
      hudPresent,
      hudCompletelyGone,
      abilityBarVariance,
      healthBarVariance,
      weaponHudVariance,
      sharpness,
      killBannerRatio,
      buyPanelRatio,
      deathOverlayScore,
      redFlashRatio,
      sceneDiff,
      isStatic,
      detectedPhase: phase,
      phaseConfidence: confidence,
    });
  }

  return results;
}

// ── Death overlay scoring ────────────────────────────────────────────────────

/**
 * Compute death overlay score.
 *
 * Key insight from testing: saturation alone fails on muted maps (Abyss, Pearl).
 * HUD absence is the ONLY signal that reliably distinguishes death from gameplay,
 * because no other game event removes ALL HUD elements simultaneously.
 *
 * Signal priority:
 *   1. ALL HUD regions gone (ability bar + health bar + weapon HUD) — STRONGEST
 *   2. Low saturation — confirms death but NOT sufficient alone
 *   3. Background blur (low sharpness) — weak but helps
 *   4. Center region characteristics — weak
 */
function computeDeathOverlayScore(
  frameSaturation: number,
  saturationDrop: number,
  centerStats: RoiHsvStats,
  _hudPresent: boolean,
  hudCompletelyGone: boolean,
  sharpness: number,
): number {
  // PRIMARY: ALL HUD regions must be gone. This is the only reliable signal.
  // During gameplay, smokes, flashes, round banners — HUD stays visible.
  // ONLY during death screen does ALL HUD disappear.
  if (!hudCompletelyGone) {
    // HUD is at least partially present → almost certainly NOT a death screen.
    if (frameSaturation < 0.05) return 0.4; // Very rare edge case
    return 0.0; // Not a death screen
  }

  // FILTER: Bright ability washes (Phoenix flash, Breach aftershock, etc.)
  // temporarily white-out the screen, hiding HUD. But they're BRIGHT.
  // Death screens are DARK (mean value < 0.50). Ability washes are bright (> 0.60).
  if (centerStats.meanV > 0.6) {
    return 0.0; // Bright screen = ability effect, NOT death
  }

  // HUD is completely gone. Now check secondary signals for confidence.
  let score = 0.5; // Base score for HUD absence alone

  // Saturation confirmation
  if (frameSaturation < 0.08) score += 0.25;
  else if (frameSaturation < 0.15) score += 0.15;
  else if (saturationDrop < 0.7) score += 0.1;

  // Low sharpness = blurred background (death screen effect)
  // Gameplay sharpness is typically 8-20, death screen 3-8
  if (sharpness < 6) score += 0.1;

  // Center region: low saturation + moderate brightness = overlay text
  if (centerStats.meanS < 0.1 && centerStats.meanV > 0.15) {
    score += 0.05;
  }

  return Math.min(1.0, score);
}

// ── Per-frame classification ─────────────────────────────────────────────────

interface ClassifyInput {
  meanSaturation: number;
  meanValue: number;
  saturationDrop: number;
  hudPresent: boolean;
  abilityBarVariance: number;
  healthBarVariance: number;
  killBannerRatio: number;
  buyPanelRatio: number;
  deathOverlayScore: number;
  redFlashRatio: number;
  sceneDiff: number;
  isStatic: boolean;
}

function classifyFrame(input: ClassifyInput): { phase: GamePhase; confidence: number } {
  // ── Death screen: highest priority (desaturated + no HUD + overlay) ──
  if (input.deathOverlayScore >= 0.5) {
    return { phase: 'death', confidence: Math.min(1.0, input.deathOverlayScore + 0.1) };
  }

  // ── Buy phase: strong blue panel + relatively static scene ──
  // Require high buy panel ratio to avoid false positives from blue maps/skies.
  // Buy phase is also relatively static (player standing in shop).
  if (input.buyPanelRatio > 0.35 && input.sceneDiff < 15) {
    const conf = Math.min(1.0, 0.5 + input.buyPanelRatio);
    return { phase: 'buy_phase', confidence: conf };
  }
  // Weaker buy phase signal: moderate blue + very static
  if (input.buyPanelRatio > 0.2 && input.isStatic && input.meanValue < 0.45) {
    return { phase: 'buy_phase', confidence: 0.6 };
  }

  // ── Loading / agent select: very dark, very static ──
  if (input.meanValue < 0.08 && input.isStatic) {
    return { phase: 'loading', confidence: 0.7 };
  }

  // ── Round end: brief banner, no HUD, moderate saturation ──
  // Round end shows a banner but doesn't desaturate as much as death
  if (
    !input.hudPresent &&
    input.saturationDrop > 0.7 &&
    input.saturationDrop < 1.1 &&
    input.deathOverlayScore < 0.4 &&
    input.deathOverlayScore > 0.1
  ) {
    return { phase: 'round_end', confidence: 0.5 };
  }

  // ── Spectating: HUD is present but different from gameplay ──
  // Hard to distinguish from gameplay at this resolution.
  // Will be inferred by the state machine (after death, before buy phase).

  // ── Gameplay: normal saturation + dynamic scene (not static) ──
  // Even without HUD detection (which can be noisy), normal saturation + motion = gameplay
  if (input.saturationDrop > 0.75 && input.sceneDiff > 3) {
    const conf = input.hudPresent ? 0.85 : 0.65;
    return { phase: 'gameplay', confidence: conf };
  }

  // ── Gameplay: HUD present with normal saturation (even if static — could be holding angle) ──
  if (input.hudPresent && input.saturationDrop > 0.8) {
    return { phase: 'gameplay', confidence: 0.75 };
  }

  // ── Fallback: probably gameplay if saturation is normal ──
  if (input.saturationDrop > 0.85) {
    return { phase: 'gameplay', confidence: 0.5 };
  }

  return { phase: 'unknown', confidence: 0.3 };
}

// ── State machine & timeline builder ─────────────────────────────────────────

/**
 * Build a structured game timeline from per-frame classifications.
 *
 * The state machine:
 * - Requires N consecutive frames of the same classification to confirm a transition
 * - Tracks round numbers (increments on each buy_phase after death or round_end)
 * - Distinguishes spectating from gameplay (after death, before next buy phase)
 * - Produces a clean timeline with deaths, buy phases, and rounds
 */
function buildTimeline(frames: HsvFrameAnalysis[], numFrames: number): GameTimeline {
  const CONFIRM_FRAMES = 2; // Require 2 consecutive frames for most state changes
  const DEATH_CONFIRM_FRAMES = 1; // Death needs only 1 frame (HUD-gone is very specific)

  const phases: GameTimelinePhase[] = [];
  const deaths: DetectedDeathHsv[] = [];
  const buyPhases: DetectedBuyPhaseHsv[] = [];

  let currentPhase: GamePhase = 'loading';
  let phaseStartSec = 0;
  let phaseConfidence = 0;
  let round = 0;
  let pendingPhase: GamePhase | null = null;
  let pendingCount = 0;
  let playerDead = false;
  let deathStartFrame = 0;
  let gameplayStartSec = 0;
  let gameplayStartFound = false;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let detectedPhase = f.detectedPhase;

    // ── State machine overrides ──

    // After death, gameplay-classified frames are spectating...
    // BUT only for a limited time. If we've been "dead" for 15+ seconds
    // and see gameplay-like frames, the player likely respawned (new round)
    // and we missed the buy phase detection.
    if (playerDead && detectedPhase === 'gameplay') {
      const deadDuration = i - deathStartFrame;
      if (deadDuration > 15) {
        // Too long dead — assume new round started, buy phase was missed
        playerDead = false;
        round++;
        buyPhases.push({ timestampSec: i, round, confidence: 0.3 }); // low confidence = inferred
      } else {
        detectedPhase = 'spectating';
      }
    }

    // ── Confirmation logic: require N consecutive frames ──
    if (detectedPhase !== currentPhase) {
      if (detectedPhase === pendingPhase) {
        pendingCount++;
      } else {
        pendingPhase = detectedPhase;
        pendingCount = 1;
      }

      const requiredFrames = pendingPhase === 'death' ? DEATH_CONFIRM_FRAMES : CONFIRM_FRAMES;
      if (pendingCount >= requiredFrames) {
        // Transition confirmed — close current phase, start new one
        const confirmCount = pendingPhase === 'death' ? DEATH_CONFIRM_FRAMES : CONFIRM_FRAMES;
        const transitionSec = i - confirmCount + 1; // start of the confirmed run

        if (phaseStartSec < transitionSec) {
          phases.push({
            type: currentPhase,
            startSec: phaseStartSec,
            endSec: transitionSec,
            round: round > 0 ? round : undefined,
            confidence: phaseConfidence,
          });
        }

        // ── Handle specific transitions ──

        // Entering death
        if (detectedPhase === 'death') {
          playerDead = true;
          deathStartFrame = i;
        }

        // Entering buy phase = new round
        if (detectedPhase === 'buy_phase') {
          round++;
          playerDead = false;
          buyPhases.push({
            timestampSec: transitionSec,
            round,
            confidence: f.phaseConfidence,
          });
          if (!gameplayStartFound) {
            gameplayStartSec = transitionSec;
          }
        }

        // Entering gameplay from buy phase
        if (detectedPhase === 'gameplay' && currentPhase === 'buy_phase') {
          if (!gameplayStartFound) {
            gameplayStartSec = transitionSec;
            gameplayStartFound = true;
          }
        }

        currentPhase = detectedPhase;
        phaseStartSec = transitionSec;
        phaseConfidence = f.phaseConfidence;
        pendingPhase = null;
        pendingCount = 0;
      }
    } else {
      // Same phase continues — update confidence (use max)
      phaseConfidence = Math.max(phaseConfidence, f.phaseConfidence);
      pendingPhase = null;
      pendingCount = 0;
    }
  }

  // Close final phase
  if (phaseStartSec < numFrames) {
    phases.push({
      type: currentPhase,
      startSec: phaseStartSec,
      endSec: numFrames,
      round: round > 0 ? round : undefined,
      confidence: phaseConfidence,
    });
  }

  // ── Extract deaths from death phases ──
  for (const phase of phases) {
    if (phase.type === 'death') {
      // Filter: match end screens (last 15 seconds) are NOT deaths
      if (phase.startSec > numFrames - 15) continue;
      deaths.push({
        timestampSec: phase.startSec,
        confidence: phase.confidence,
        durationFrames: phase.endSec - phase.startSec,
        round: phase.round ?? 0,
      });
    }
  }

  // ── Build round structure ──
  const rounds: GameTimeline['rounds'] = [];
  for (let r = 1; r <= round; r++) {
    const buyPhase = buyPhases.find((bp) => bp.round === r);
    const nextBuyPhase = buyPhases.find((bp) => bp.round === r + 1);
    const death = deaths.find((d) => d.round === r);

    if (buyPhase) {
      rounds.push({
        round: r,
        startSec: buyPhase.timestampSec,
        endSec: nextBuyPhase ? nextBuyPhase.timestampSec : numFrames,
        deathSec: death?.timestampSec ?? null,
      });
    }
  }

  return {
    phases,
    deaths,
    buyPhases,
    rounds,
    gameplayStartSec,
    videoDurationSec: numFrames,
    processingMs: 0, // filled by caller
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function emptyTimeline(numFrames: number, processingMs: number): GameTimeline {
  return {
    phases: [],
    deaths: [],
    buyPhases: [],
    rounds: [],
    gameplayStartSec: 0,
    videoDurationSec: numFrames,
    processingMs,
  };
}
