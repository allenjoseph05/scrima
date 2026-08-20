/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * Death Detector — Identifies deaths, buy phases, and loading screens
 * from Valorant gameplay video using pixel-level analysis.
 *
 * No ML, no AI cost. Runs on CPU in ~2 seconds for a 10-minute video.
 *
 * How it works:
 *   1. ffmpeg extracts all frames as tiny 160×90 RGB thumbnails
 *   2. Per-frame statistics: brightness, saturation, scene-change score
 *   3. Death screens detected by: abrupt scene change → sustained low saturation
 *   4. Buy phases detected by: specific blue/teal color distribution + low motion
 *
 * The Valorant death screen is a full-screen overlay (dark, desaturated,
 * blurred background) lasting 3-7 seconds. Even at 160×90, the brightness
 * and saturation drop is unmistakable.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────────────────────────────────

const THUMB_W = 160;
const THUMB_H = 90;
const FRAME_BYTES = THUMB_W * THUMB_H * 3; // RGB24

// Center region for analysis (middle 40% of frame)
const CX1 = Math.floor(THUMB_W * 0.3);
const CX2 = Math.floor(THUMB_W * 0.7);
const CY1 = Math.floor(THUMB_H * 0.3);
const CY2 = Math.floor(THUMB_H * 0.7);

// HUD regions at 160×90 thumbnail scale (mapped from 1920×1080 game resolution).
// During gameplay these regions contain persistent HUD elements.
// During death screen, all HUD elements disappear — this is the KEY differentiator
// from smoke/flash/bright effects which keep HUD visible.
const HUD_REGIONS = {
  minimap: { x1: 0, y1: 0, x2: 22, y2: 22 }, // top-left minimap (green ally markers)
  abilityBar: { x1: 55, y1: 76, x2: 105, y2: 90 }, // bottom-center ability icons
  weaponHud: { x1: 130, y1: 75, x2: 160, y2: 90 }, // bottom-right weapon/ammo
  healthBar: { x1: 22, y1: 76, x2: 50, y2: 90 }, // bottom-left health/shield bars
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface DetectedDeath {
  /** Video timestamp in seconds where the death screen appears */
  timestampSec: number;
  /** How confident the detection is (0-1) */
  confidence: number;
  /** How many frames the death screen lasted */
  durationFrames: number;
}

export interface DetectedBuyPhase {
  /** Video timestamp in seconds where the buy phase starts */
  timestampSec: number;
}

export interface DetectionResult {
  deaths: DetectedDeath[];
  buyPhases: DetectedBuyPhase[];
  /** Estimated second where gameplay starts (after loading screen) */
  gameplayStartSec: number;
  /** Total video duration in seconds (frame count at 1fps) */
  videoDurationSec: number;
  /** Processing time in milliseconds */
  processingMs: number;
}

interface RegionStats {
  brightness: number;
  saturation: number;
  contrast: number; // std dev of brightness within the region
}

interface FrameStats {
  index: number;
  brightness: number; // mean of (R+G+B)/3 across all pixels
  saturation: number; // mean of (max-min)/max per pixel
  centerBrightness: number; // brightness of center 40% region
  edgeBrightness: number; // brightness of outer 60% region
  sceneDiff: number; // mean absolute pixel diff from previous frame
  blueRatio: number; // meanB / (meanR + meanG + meanB) — for buy phase detection
  redRatio: number; // meanR / (meanR + meanG + meanB) — for death flash detection
  hudScore: number; // 0-1, proportion of HUD regions detected active (0 = dead)
  sharpness: number; // mean pixel-to-neighbor difference (low = blurred death screen)
  abilityBarVar: number; // pixel intensity variance in ability bar region (high = HUD icons present)
  healthBarVar: number; // pixel intensity variance in health bar region (high = health/shield visible)
}

/** Baselines computed from gameplay-only frames (where HUD is active). */
interface GameplayBaseline {
  medSaturation: number;
  medBrightness: number;
  medSharpness: number;
  medSceneChange: number;
  medAbilityBarVar: number;
  medHealthBarVar: number;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect game events (deaths, buy phases) from a video buffer.
 *
 * @param videoBuffer - Raw video file bytes (MP4)
 * @returns Detected events with timestamps
 */
export async function detectEvents(videoBuffer: Buffer): Promise<DetectionResult> {
  const startMs = Date.now();
  const tmpVideo = path.join(os.tmpdir(), `scrima-detect-${Date.now()}.mp4`);
  const tmpRaw = path.join(os.tmpdir(), `scrima-detect-${Date.now()}.rgb`);

  try {
    fs.writeFileSync(tmpVideo, videoBuffer);

    // Extract all frames as 160×90 RGB thumbnails at 1fps.
    // Try CUDA hardware-accelerated decode first (10-20x faster), fall back to CPU.
    let extracted = false;
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hwaccel',
          'cuda',
          '-i',
          tmpVideo,
          '-vf',
          `fps=1,scale=${THUMB_W}:${THUMB_H}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-v',
          'quiet',
          '-y',
          tmpRaw,
        ],
        { windowsHide: true, timeout: 60_000 },
      );
      extracted = true;
    } catch {
      // CUDA unavailable — fall back to CPU decode
    }

    if (!extracted) {
      await execFileAsync(
        'ffmpeg',
        [
          '-i',
          tmpVideo,
          '-vf',
          `fps=1,scale=${THUMB_W}:${THUMB_H}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-v',
          'quiet',
          '-y',
          tmpRaw,
        ],
        { windowsHide: true, timeout: 60_000 },
      );
    }

    const rawBuffer = fs.readFileSync(tmpRaw);
    const numFrames = Math.floor(rawBuffer.length / FRAME_BYTES);

    if (numFrames < 10) {
      return {
        deaths: [],
        buyPhases: [],
        gameplayStartSec: 0,
        videoDurationSec: numFrames,
        processingMs: Date.now() - startMs,
      };
    }

    // Compute per-frame statistics
    const stats = computeAllStats(rawBuffer, numFrames);

    // Detect events
    const deaths = detectDeaths(stats);
    const buyPhases = detectBuyPhases(stats);
    const gameplayStartSec = detectGameplayStart(stats);

    console.log(
      '[DeathDetector] %d frames analyzed in %dms: %d deaths, %d buy phases, gameplay starts at %ds',
      numFrames,
      Date.now() - startMs,
      deaths.length,
      buyPhases.length,
      gameplayStartSec,
    );

    return {
      deaths,
      buyPhases,
      gameplayStartSec,
      videoDurationSec: numFrames,
      processingMs: Date.now() - startMs,
    };
  } finally {
    fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpRaw, { force: true });
  }
}

/**
 * Build a clip plan for AI analysis based on detected events.
 * Returns clip ranges (start/end seconds) and key frame timestamps.
 */
export function buildClipPlan(
  result: DetectionResult,
  preDeathSec = 15,
  postDeathSec = 5,
): { clips: ClipRange[]; keyframes: KeyframeRequest[] } {
  const clips: ClipRange[] = [];
  const keyframes: KeyframeRequest[] = [];

  // Loading screen / first buy phase → images for agent/map detection
  if (result.gameplayStartSec > 2) {
    keyframes.push({ timestampSec: 1, label: 'loading_screen' });
  }
  if (result.buyPhases.length > 0) {
    keyframes.push({ timestampSec: result.buyPhases[0].timestampSec, label: 'buy_phase_1' });
    keyframes.push({
      timestampSec: result.buyPhases[0].timestampSec + 2,
      label: 'buy_phase_1_late',
    });
  }

  // Death clips — extract gameplay before + death screen for each death
  for (let i = 0; i < result.deaths.length; i++) {
    const death = result.deaths[i];
    const clipStart = Math.max(0, death.timestampSec - preDeathSec);
    const clipEnd = Math.min(result.videoDurationSec, death.timestampSec + postDeathSec);

    clips.push({
      startSec: clipStart,
      endSec: clipEnd,
      label: `death_${i + 1}`,
      deathTimestampSec: death.timestampSec,
    });

    // Death screen images for fact verification
    keyframes.push({ timestampSec: death.timestampSec + 1, label: `death_${i + 1}_screen` });
    keyframes.push({ timestampSec: death.timestampSec + 3, label: `death_${i + 1}_screen_late` });
    // Pre-death frame for ability bar
    keyframes.push({
      timestampSec: Math.max(0, death.timestampSec - 1),
      label: `death_${i + 1}_predeath`,
    });
  }

  // Merge overlapping clips
  const merged = mergeOverlappingClips(clips);

  return { clips: merged, keyframes };
}

/**
 * Extract raw per-frame statistics for debugging/calibration.
 * Run this on a test video, then compare stats at known death timestamps
 * vs gameplay timestamps to verify thresholds.
 */
export async function extractFrameStats(videoBuffer: Buffer): Promise<{
  stats: Array<{
    index: number;
    brightness: number;
    saturation: number;
    sceneDiff: number;
    hudScore: number;
    sharpness: number;
    blueRatio: number;
    redRatio: number;
  }>;
  numFrames: number;
  processingMs: number;
}> {
  const startMs = Date.now();
  const tmpVideo = path.join(os.tmpdir(), `scrima-stats-${Date.now()}.mp4`);
  const tmpRaw = path.join(os.tmpdir(), `scrima-stats-${Date.now()}.rgb`);

  try {
    fs.writeFileSync(tmpVideo, videoBuffer);
    // Try CUDA hardware-accelerated decode first, fall back to CPU
    let statsExtracted = false;
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hwaccel',
          'cuda',
          '-i',
          tmpVideo,
          '-vf',
          `fps=1,scale=${THUMB_W}:${THUMB_H}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-v',
          'quiet',
          '-y',
          tmpRaw,
        ],
        { windowsHide: true, timeout: 60_000 },
      );
      statsExtracted = true;
    } catch {
      // CUDA unavailable
    }
    if (!statsExtracted) {
      await execFileAsync(
        'ffmpeg',
        [
          '-i',
          tmpVideo,
          '-vf',
          `fps=1,scale=${THUMB_W}:${THUMB_H}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-v',
          'quiet',
          '-y',
          tmpRaw,
        ],
        { windowsHide: true, timeout: 60_000 },
      );
    }

    const rawBuffer = fs.readFileSync(tmpRaw);
    const numFrames = Math.floor(rawBuffer.length / FRAME_BYTES);
    const allStats = computeAllStats(rawBuffer, numFrames);

    return {
      stats: allStats.map((s) => ({
        index: s.index,
        brightness: s.brightness,
        saturation: s.saturation,
        sceneDiff: s.sceneDiff,
        hudScore: s.hudScore,
        sharpness: s.sharpness,
        blueRatio: s.blueRatio,
        redRatio: s.redRatio,
      })),
      numFrames,
      processingMs: Date.now() - startMs,
    };
  } finally {
    fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpRaw, { force: true });
  }
}

export interface ClipRange {
  startSec: number;
  endSec: number;
  label: string;
  deathTimestampSec: number;
}

export interface KeyframeRequest {
  timestampSec: number;
  label: string;
}

// ── Internal: Frame Statistics ─────────────────────────────────────────────

/** Compute brightness, saturation, and contrast for a rectangular region of a frame. */
function computeRegionStats(
  frame: Buffer,
  region: { x1: number; y1: number; x2: number; y2: number },
): RegionStats {
  let sumBright = 0;
  let sumBright2 = 0;
  let sumSat = 0;
  let count = 0;

  for (let y = region.y1; y < region.y2 && y < THUMB_H; y++) {
    for (let x = region.x1; x < region.x2 && x < THUMB_W; x++) {
      const pi = (y * THUMB_W + x) * 3;
      const r = frame[pi];
      const g = frame[pi + 1];
      const b = frame[pi + 2];
      const bright = (r + g + b) / 3;
      sumBright += bright;
      sumBright2 += bright * bright;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      sumSat += max > 0 ? (max - min) / max : 0;
      count++;
    }
  }

  if (count === 0) return { brightness: 0, saturation: 0, contrast: 0 };

  const meanBright = sumBright / count;
  const variance = Math.max(0, sumBright2 / count - meanBright * meanBright);

  return {
    brightness: meanBright,
    saturation: sumSat / count,
    contrast: Math.sqrt(variance),
  };
}

/**
 * Compute pixel intensity variance for a region.
 * Uses per-channel variance averaged across R, G, B.
 *
 * High variance = distinct visual elements (HUD icons, health bars).
 * Low variance  = uniform area (blurred death overlay, empty region).
 *
 * This is the PRIMARY death detection signal: ability bar region has
 * ~5-10x higher variance during gameplay than during death screen.
 */
function computeRegionVariance(
  frame: Buffer,
  region: { x1: number; y1: number; x2: number; y2: number },
): number {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumR2 = 0;
  let sumG2 = 0;
  let sumB2 = 0;
  let count = 0;

  for (let y = region.y1; y < region.y2 && y < THUMB_H; y++) {
    for (let x = region.x1; x < region.x2 && x < THUMB_W; x++) {
      const pi = (y * THUMB_W + x) * 3;
      const r = frame[pi];
      const g = frame[pi + 1];
      const b = frame[pi + 2];
      sumR += r;
      sumG += g;
      sumB += b;
      sumR2 += r * r;
      sumG2 += g * g;
      sumB2 += b * b;
      count++;
    }
  }

  if (count === 0) return 0;

  const varR = Math.max(0, sumR2 / count - (sumR / count) ** 2);
  const varG = Math.max(0, sumG2 / count - (sumG / count) ** 2);
  const varB = Math.max(0, sumB2 / count - (sumB / count) ** 2);

  return (varR + varG + varB) / 3;
}

/** Compute image sharpness as mean horizontal pixel-to-neighbor difference. */
function computeSharpness(frame: Buffer): number {
  let diffSum = 0;
  let count = 0;

  for (let y = 0; y < THUMB_H; y++) {
    for (let x = 1; x < THUMB_W; x++) {
      const pi = (y * THUMB_W + x) * 3;
      const pj = (y * THUMB_W + (x - 1)) * 3;
      diffSum += Math.abs(frame[pi] - frame[pj]);
      diffSum += Math.abs(frame[pi + 1] - frame[pj + 1]);
      diffSum += Math.abs(frame[pi + 2] - frame[pj + 2]);
      count += 3;
    }
  }

  return count > 0 ? diffSum / count : 0;
}

/**
 * Compute HUD presence score for a frame.
 * Returns 0-1: proportion of HUD regions that appear "active" (have elements).
 * During gameplay, HUD is always visible (score ~0.5-1.0).
 * During death screen, HUD disappears (score ~0-0.25).
 */
function computeHudScore(frame: Buffer, frameSaturation: number): number {
  const minimap = computeRegionStats(frame, HUD_REGIONS.minimap);
  const abilities = computeRegionStats(frame, HUD_REGIONS.abilityBar);
  const weapon = computeRegionStats(frame, HUD_REGIONS.weaponHud);
  const health = computeRegionStats(frame, HUD_REGIONS.healthBar);

  let active = 0;

  // Minimap: green ally markers + colored terrain → elevated saturation or contrast
  if (minimap.saturation > Math.max(frameSaturation * 1.3, 0.08) || minimap.contrast > 15) active++;
  // Ability bar: colored icons on dark background → elevated saturation or high contrast
  if (abilities.saturation > 0.08 || abilities.contrast > 18) active++;
  // Weapon HUD: weapon outline + ammo numbers → high contrast
  if (weapon.contrast > 15) active++;
  // Health bar: green health + blue/purple shield → elevated saturation or contrast
  if (health.saturation > 0.12 || health.contrast > 15) active++;

  return active / 4;
}

function computeAllStats(raw: Buffer, numFrames: number): FrameStats[] {
  const stats: FrameStats[] = [];

  for (let i = 0; i < numFrames; i++) {
    const offset = i * FRAME_BYTES;
    const frame = raw.subarray(offset, offset + FRAME_BYTES);

    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalSat = 0;
    let centerBright = 0;
    let centerCount = 0;
    let edgeBright = 0;
    let edgeCount = 0;
    const numPixels = THUMB_W * THUMB_H;

    for (let y = 0; y < THUMB_H; y++) {
      for (let x = 0; x < THUMB_W; x++) {
        const pi = (y * THUMB_W + x) * 3;
        const r = frame[pi];
        const g = frame[pi + 1];
        const b = frame[pi + 2];
        totalR += r;
        totalG += g;
        totalB += b;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        totalSat += max > 0 ? (max - min) / max : 0;

        const px = (r + g + b) / 3;
        if (x >= CX1 && x < CX2 && y >= CY1 && y < CY2) {
          centerBright += px;
          centerCount++;
        } else {
          edgeBright += px;
          edgeCount++;
        }
      }
    }

    const meanR = totalR / numPixels;
    const meanG = totalG / numPixels;
    const meanB = totalB / numPixels;
    const total = meanR + meanG + meanB;
    const frameSaturation = totalSat / numPixels;

    // Scene change: mean absolute pixel difference from previous frame
    let sceneDiff = 0;
    if (i > 0) {
      const prevOffset = (i - 1) * FRAME_BYTES;
      let diffSum = 0;
      for (let p = 0; p < FRAME_BYTES; p++) {
        diffSum += Math.abs(frame[p] - raw[prevOffset + p]);
      }
      sceneDiff = diffSum / FRAME_BYTES;
    }

    // HUD presence and sharpness — the critical death screen signals
    const hudScore = computeHudScore(frame, frameSaturation);
    const sharpness = computeSharpness(frame);

    // Per-region pixel variance — primary death detection signal
    const abilityBarVar = computeRegionVariance(frame, HUD_REGIONS.abilityBar);
    const healthBarVar = computeRegionVariance(frame, HUD_REGIONS.healthBar);

    stats.push({
      index: i,
      brightness: (meanR + meanG + meanB) / 3,
      saturation: frameSaturation,
      centerBrightness: centerBright / (centerCount || 1),
      edgeBrightness: edgeBright / (edgeCount || 1),
      sceneDiff,
      blueRatio: total > 0 ? meanB / total : 0,
      redRatio: total > 0 ? meanR / total : 0,
      hudScore,
      sharpness,
      abilityBarVar,
      healthBarVar,
    });
  }

  return stats;
}

// ── Internal: Death Detection ──────────────────────────────────────────────

/**
 * Multi-signal death detection with relative thresholds.
 *
 * Signals used (in priority order):
 *   1. RELATIVE SATURATION DROP — frame sat < 75% of video median
 *   2. SCENE CHANGE — abrupt transition at death onset/exit
 *   3. LOW SHARPNESS — death screen applies Gaussian blur
 *   4. HUD ABSENCE — confidence booster when HUD regions go inactive
 *
 * Handles both raw game recordings (Tauri client) and YouTube/stream recordings
 * with webcam/overlays that prevent HUD regions from going fully inactive.
 *
 * Uses a seed-and-expand approach: find frames below the primary saturation
 * threshold, then expand the window in both directions using a more permissive
 * continuation threshold to capture the full death screen duration.
 */
function detectDeaths(stats: FrameStats[]): DetectedDeath[] {
  if (stats.length < 10) return [];

  // Compute adaptive baselines from the video's own statistics
  const medSaturation = median(stats.map((s) => s.saturation));
  const medSharpness = median(stats.map((s) => s.sharpness));
  const medBrightness = median(stats.map((s) => s.brightness));
  const sceneChanges = stats.filter((s) => s.sceneDiff > 0).map((s) => s.sceneDiff);
  const medSceneChange = median(sceneChanges);

  // Primary threshold: saturation drops to ~60-70% of gameplay median during death.
  // Stream overlays (webcam, alerts) keep global sat higher than raw recordings.
  const satThreshold = Math.min(medSaturation * 0.75, 0.18);

  // Continuation: tight — only bridge frames slightly above the seed threshold.
  // Old value (1.4x) was almost at the median, causing 30-40 frame false runs.
  const satContinuation = satThreshold * 1.2;

  // Scene change must be WELL above median to indicate death transition.
  // Normal gameplay has sceneDiff 20-40 from camera movement / abilities.
  // Death onset produces 40-100+ from the full-screen overlay transition.
  const sceneChangeThreshold = medSceneChange * 1.2;

  // Max death screen duration: competitive 5-7s, deathmatch 3s. Cap at 10.
  const MAX_DEATH_FRAMES = 10;

  // Score each frame for "death likelihood" — combines all signals
  const deathScores = stats.map((s) => {
    let score = 0;
    score += Math.max(0, 1 - s.saturation / medSaturation) * 0.35;
    score += Math.max(0, 1 - s.brightness / medBrightness) * 0.15;
    score += Math.max(0, 1 - s.sharpness / medSharpness) * 0.15;
    score += (1 - s.hudScore) * 0.15;
    score += Math.min(1, s.sceneDiff / (medSceneChange * 3)) * 0.2;
    return score;
  });

  console.log(
    '[DeathDetector] baselines: medSat=%.3f medBright=%.1f medSharp=%.1f medScene=%.1f | satThreshold=%.3f satContinuation=%.3f sceneThreshold=%.1f',
    medSaturation,
    medBrightness,
    medSharpness,
    medSceneChange,
    satThreshold,
    satContinuation,
    sceneChangeThreshold,
  );

  // Count how many frames pass the saturation gate
  const belowThreshold = stats.filter((s) => s.saturation < satThreshold).length;
  console.log(
    '[DeathDetector] frames below satThreshold: %d / %d (%.1f%%)',
    belowThreshold,
    stats.length,
    (belowThreshold / stats.length) * 100,
  );

  const deaths: DetectedDeath[] = [];
  const visited = new Set<number>();
  let candidateCount = 0;
  let i = 0;

  while (i < stats.length) {
    if (visited.has(i)) {
      i++;
      continue;
    }

    const s = stats[i];

    // Primary gate: saturation below threshold
    if (s.saturation < satThreshold) {
      // Expand backward while below continuation.
      // Only expand if the preceding frame is ALSO below the primary threshold
      // (not just the continuation threshold). This prevents pulling in normal
      // gameplay frames that happen to be slightly desaturated (e.g., dim maps).
      let start = i;
      while (start > 0 && i - start < 3 && stats[start - 1].saturation < satThreshold) {
        start--;
      }

      // Expand forward while below continuation, capped at MAX_DEATH_FRAMES
      let end = i + 1;
      while (
        end < stats.length &&
        end - start < MAX_DEATH_FRAMES &&
        stats[end].saturation < satContinuation
      ) {
        end++;
      }

      const duration = end - start;
      for (let j = start; j < end; j++) visited.add(j);

      // Scene change at onset or exit (must be substantial)
      const hasOnsetChange =
        stats[start].sceneDiff > sceneChangeThreshold ||
        (start > 0 && stats[start - 1].sceneDiff > sceneChangeThreshold);
      const hasExitChange = end < stats.length && stats[end].sceneDiff > sceneChangeThreshold;
      const hasSceneChange = hasOnsetChange || hasExitChange;

      // Average death score across the window
      let avgScore = 0;
      let peakScore = 0;
      let hasDarkFrame = false;
      let allBlack = true;
      let darkestFrame = start;
      let darkestBrightness = Number.POSITIVE_INFINITY;
      for (let j = start; j < end; j++) {
        avgScore += deathScores[j];
        peakScore = Math.max(peakScore, deathScores[j]);
        if (stats[j].brightness < darkestBrightness) {
          darkestBrightness = stats[j].brightness;
          darkestFrame = j;
        }
        // Death screen darkens the game area — at least one frame should be very dark.
        // In streamer videos, the webcam keeps a small bright area but the overall
        // brightness drops heavily. In raw recordings, the entire frame darkens.
        if (stats[j].brightness < medBrightness * 0.3) hasDarkFrame = true;
        // Track if ALL frames are near-black (editor transitions, not deaths)
        if (stats[j].brightness > 12) allBlack = false;
      }
      avgScore /= duration;

      candidateCount++;

      // Filter: pure black screens are editor transitions (title cards, fades),
      // not death screens. Real deaths show the blurred game world (brightness 15-50).
      // Only apply to multi-frame windows — single dark frames are death flashes,
      // not editor transitions (which last 2+ seconds).
      if (allBlack && duration >= 2) {
        console.log(
          '[DeathDetector] candidate @%ds rejected: allBlack (dur=%d, darkest=%.1f)',
          start,
          duration,
          darkestBrightness,
        );
        i = end + 1;
        continue;
      }

      // Validation: dark frame + scene change required for ALL paths.
      // Every Valorant death transitions through a genuinely dark frame.
      // Removing non-dark-frame paths eliminates settings menu false positives
      // (which have moderate darkness 25-40 but not the deep dark of death).
      const isValid =
        hasDarkFrame &&
        hasSceneChange &&
        // Standard: multi-frame death with decent average score
        ((duration >= 2 && avgScore >= 0.2) ||
          // Brief but intense: single frame with very strong peak
          (duration >= 1 && peakScore >= 0.45));

      if (!isValid) {
        console.log(
          '[DeathDetector] candidate @%ds rejected: dur=%d avgScore=%.3f peakScore=%.3f hasDark=%s hasScene=%s darkestBright=%.1f sat=%.3f',
          start,
          duration,
          avgScore,
          peakScore,
          hasDarkFrame,
          hasSceneChange,
          darkestBrightness,
          stats[start].saturation,
        );
      }

      if (isValid) {
        let confidence = avgScore;
        if (duration >= 5) confidence += 0.1;
        if (hasSceneChange) confidence += 0.05;
        confidence = Math.min(1, confidence);

        // Report the darkest frame as the death timestamp — this is the actual
        // moment of death, not the start of the desaturated window (which may
        // include slightly-desaturated gameplay frames that got pulled in).
        deaths.push({
          timestampSec: darkestFrame,
          confidence,
          durationFrames: duration,
        });

        // Skip past death + spectating buffer (8s generous)
        i = end + 8;
        continue;
      }
    }

    i++;
  }

  console.log(
    '[DeathDetector] %d candidates evaluated, %d deaths accepted',
    candidateCount,
    deaths.length,
  );

  return deaths;
}

// ── Internal: Buy Phase Detection ──────────────────────────────────────────

function detectBuyPhases(stats: FrameStats[]): DetectedBuyPhase[] {
  if (stats.length < 10) return [];

  // Buy phase UI has a distinctive blue/teal color distribution
  // and is relatively static (low scene change between consecutive buy frames)
  const phases: DetectedBuyPhase[] = [];
  let lastBuyEnd = -30; // prevent detecting consecutive frames as separate buy phases

  for (let i = 1; i < stats.length; i++) {
    // Skip if too close to the last detected buy phase
    if (i - lastBuyEnd < 15) continue;

    const s = stats[i];

    // Buy phase signals:
    // 1. Higher blue ratio than normal gameplay (teal/blue store UI)
    // 2. Low scene change (static UI, player standing still)
    // 3. Specific brightness range (UI is moderately bright)
    const isBluish = s.blueRatio > 0.36;
    const isStatic = s.sceneDiff < 5 && i > 0 && stats[i - 1].sceneDiff < 10;
    const brightRange = s.brightness > 40 && s.brightness < 160;

    // Check if 2+ consecutive frames match (buy phase lasts several seconds)
    if (isBluish && isStatic && brightRange) {
      let end = i + 1;
      while (end < stats.length && stats[end].blueRatio > 0.35 && stats[end].sceneDiff < 8) {
        end++;
      }
      if (end - i >= 2) {
        phases.push({ timestampSec: i });
        lastBuyEnd = end;
      }
    }
  }

  return phases;
}

// ── Internal: Loading Screen Detection ─────────────────────────────────────

function detectGameplayStart(stats: FrameStats[]): number {
  // Loading screens are typically dark, low saturation, at the start of the video
  // Gameplay starts when brightness and saturation increase significantly

  if (stats.length < 5) return 0;

  const gameplayBrightness = median(
    stats.slice(Math.floor(stats.length * 0.3)).map((s) => s.brightness),
  );

  for (let i = 0; i < Math.min(30, stats.length); i++) {
    // Once brightness reaches ~70% of median gameplay brightness, gameplay has started
    if (stats[i].brightness > gameplayBrightness * 0.7 && stats[i].saturation > 0.1) {
      return Math.max(0, i - 1);
    }
  }

  return 0;
}

// ── Internal: Clip Merging ─────────────────────────────────────────────────

function mergeOverlappingClips(clips: ClipRange[]): ClipRange[] {
  if (clips.length <= 1) return clips;

  const sorted = [...clips].sort((a, b) => a.startSec - b.startSec);
  const merged: ClipRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    if (curr.startSec <= prev.endSec + 3) {
      // Overlapping or very close — merge
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      prev.label += `+${curr.label}`;
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

// ── Utility ────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
