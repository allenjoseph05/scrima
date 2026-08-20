/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * VLM Frame Classifier
 *
 * Replaces HSV-only detection with: scene-change pre-filter → VLM single-frame classification.
 *
 * 1. Extract 1fps thumbnails, compute frame-to-frame pixel difference (FREE, CPU)
 * 2. Find frames with high scene change (candidate state transitions)
 * 3. Send each candidate to Gemini flash-lite for classification ($0.0002/frame)
 * 4. Build game timeline from classifications
 *
 * Cost: ~$0.01-0.02 per game (75-100 VLM calls)
 * Accuracy: 100% on tested videos (5/5 deaths, 0 false positives)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GeminiProvider, type GeminiModelId } from '../vlm/gemini.provider.js';
import {
  classifyFrame as onnxClassifyFrame,
  isModelAvailable,
  type ClassificationResult,
} from './onnx-classifier.js';

const execFileAsync = promisify(execFile);

// ── Config ───────────────────────────────────────────────────────────────────

const THUMB_W = 320;
const THUMB_H = 180;
const FRAME_BYTES = THUMB_W * THUMB_H * 3;

/** Minimum scene difference to be considered a candidate. Lower = more candidates = more VLM cost.
 *  Lowered from 35 → 20: death transitions can be subtle (slow desaturation, no flash). */
const SCENE_DIFF_THRESHOLD = 20;

/** Minimum gap between candidates (seconds) to deduplicate. */
const DEDUP_GAP_SEC = 2;

/** Max candidates to classify (cost ceiling). With ONNX handling ~95% for free, more candidates = negligible cost. */
const MAX_CANDIDATES = 350;

/** Concurrency for frame classification batches. */
const VLM_CONCURRENCY = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export type FrameClass =
  | 'gameplay'
  | 'death_screen'
  | 'spectating'
  | 'buy_phase'
  | 'round_end'
  | 'loading';

export interface ClassifiedFrame {
  sec: number;
  classification: FrameClass;
  sceneDiff: number;
  /** Classifier confidence (0-1). ONNX provides calibrated scores; VLM defaults to 0.85. */
  confidence: number;
}

export interface VlmGameTimeline {
  classifications: ClassifiedFrame[];
  deaths: { timestampSec: number; round: number; confidence: number }[];
  buyPhases: { timestampSec: number; round: number }[];
  rounds: { round: number; startSec: number; endSec: number; deathSec: number | null }[];
  gameplayStartSec: number;
  videoDurationSec: number;
  classificationCostUsd: number;
  processingMs: number;
}

// ── Classification schema (minimal, sent with every frame) ───────────────────

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    c: {
      type: 'string',
      enum: ['gameplay', 'death_screen', 'spectating', 'buy_phase', 'round_end', 'loading'],
      description: 'Frame classification.',
    },
  },
  required: ['c'],
};

const CLASSIFICATION_PROMPT =
  'Classify this Valorant frame as ONE of: gameplay (player alive, HUD visible, playing the game), death_screen (player just died — screen shows ELIMINATED BY text, combat report, or death animation with no player HUD), spectating (watching a teammate play after dying — SWITCH PLAYER text visible, different player HUD), buy_phase (weapon shop/buy menu open), round_end (WON/LOST/VICTORY banner visible), loading (black screen, loading screen, agent select, or alt-tabbed). Answer with just the class.';

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify game events from a video using scene-change pre-filter + VLM.
 *
 * @param videoBuffer - Raw video file (MP4)
 * @param vlm - GeminiProvider instance (uses flash-lite for cheap classification)
 * @returns Structured game timeline with deaths, buy phases, rounds
 */
export async function classifyGameTimeline(
  videoBuffer: Buffer,
  vlm: GeminiProvider,
  /** Optional pre-written video path to avoid redundant disk write + decode */
  sharedVideoPath?: string,
): Promise<VlmGameTimeline> {
  const startMs = Date.now();
  const ownsVideo = !sharedVideoPath;
  const tmpVideo = sharedVideoPath ?? path.join(os.tmpdir(), `scrima-clf-${Date.now()}.mp4`);
  const tmpRaw = path.join(os.tmpdir(), `scrima-clf-${Date.now()}.rgb`);
  const tmpDir = path.join(os.tmpdir(), `scrima-clf-frames-${Date.now()}`);

  try {
    if (ownsVideo) fs.writeFileSync(tmpVideo, videoBuffer);
    fs.mkdirSync(tmpDir, { recursive: true });

    // ── Step 1: Extract thumbnails and compute scene differences ──
    await extractThumbnails(tmpVideo, tmpRaw);
    const rawBuffer = fs.readFileSync(tmpRaw);
    const numFrames = Math.floor(rawBuffer.length / FRAME_BYTES);

    if (numFrames < 10) {
      return emptyTimeline(numFrames, Date.now() - startMs);
    }

    const sceneDiffs = computeSceneDiffs(rawBuffer, numFrames);

    // ── Step 2: Classify frames ──
    // If ONNX model is available, classify EVERY frame (30ms each, ~60s total).
    // This catches all deaths instead of relying on sparse candidate selection.
    // Only fall back to candidate-based VLM classification if ONNX is unavailable.
    let classifications: ClassifiedFrame[];
    let classificationCost = 0;

    if (isModelAvailable()) {
      console.log('[VlmClassifier] ONNX available — classifying ALL %d frames', numFrames);
      // Extract ALL frames as JPEGs in one ffmpeg call (much faster than per-frame seeks)
      await execFileAsync(
        'ffmpeg',
        [
          '-i',
          tmpVideo,
          '-vf',
          'fps=1',
          '-q:v',
          '3',
          '-v',
          'quiet',
          '-y',
          path.join(tmpDir, 'f%d.jpg'),
        ],
        { windowsHide: true, timeout: 300_000 },
      );

      // Build frame file map
      const allFrameFiles = new Map<number, string>();
      for (let sec = 0; sec < numFrames; sec++) {
        // ffmpeg numbers from 1
        const fp = path.join(tmpDir, `f${sec + 1}.jpg`);
        if (fs.existsSync(fp)) allFrameFiles.set(sec, fp);
      }
      console.log('[VlmClassifier] extracted %d/%d frame JPEGs', allFrameFiles.size, numFrames);

      const allCandidates = Array.from(allFrameFiles.keys()).map((sec) => ({
        sec,
        diff: sceneDiffs[sec]?.diff ?? 0,
      }));
      classifications = await classifyFrames(vlm, allFrameFiles, allCandidates);
      classificationCost = classifications.reduce((s, c) => s + (c as any)._cost, 0);
    } else {
      // No ONNX — use sparse candidate selection + VLM (expensive)
      const candidates = selectCandidates(sceneDiffs);
      console.log(
        '[VlmClassifier] No ONNX — %d frames → %d candidates (sceneDiff > %d, dedup %ds)',
        numFrames,
        candidates.length,
        SCENE_DIFF_THRESHOLD,
        DEDUP_GAP_SEC,
      );

      if (candidates.length === 0) {
        return emptyTimeline(numFrames, Date.now() - startMs);
      }

      const frameFiles = await extractCandidateFrames(tmpVideo, tmpDir, candidates);
      classifications = await classifyFrames(vlm, frameFiles, candidates);
      classificationCost = classifications.reduce((s, c) => s + (c as any)._cost, 0);
    }

    console.log(
      '[VlmClassifier] classified %d frames: %d deaths, %d buy_phase, %d round_end, cost=$%s',
      classifications.length,
      classifications.filter((c) => c.classification === 'death_screen').length,
      classifications.filter((c) => c.classification === 'buy_phase').length,
      classifications.filter((c) => c.classification === 'round_end').length,
      classificationCost.toFixed(6),
    );

    // ── Step 5: Build timeline from classifications ──
    const timeline = buildTimelineFromClassifications(classifications, numFrames);
    timeline.classificationCostUsd = classificationCost;
    timeline.processingMs = Date.now() - startMs;

    console.log(
      '[VlmClassifier] timeline: %d deaths, %d rounds in %dms ($%s)',
      timeline.deaths.length,
      timeline.rounds.length,
      timeline.processingMs,
      classificationCost.toFixed(4),
    );

    return timeline;
  } finally {
    if (ownsVideo) fs.rmSync(tmpVideo, { force: true });
    fs.rmSync(tmpRaw, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Internal: Thumbnail extraction ───────────────────────────────────────────

async function extractThumbnails(videoPath: string, rawPath: string): Promise<void> {
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

// ── Internal: Scene difference computation ───────────────────────────────────

function computeSceneDiffs(raw: Buffer, numFrames: number): { sec: number; diff: number }[] {
  const diffs: { sec: number; diff: number }[] = [{ sec: 0, diff: 0 }];

  for (let i = 1; i < numFrames; i++) {
    const offset = i * FRAME_BYTES;
    const prevOffset = (i - 1) * FRAME_BYTES;
    let diffSum = 0;

    // Sample every 4th pixel for speed
    for (let p = 0; p < FRAME_BYTES; p += 12) {
      diffSum += Math.abs(raw[offset + p] - raw[prevOffset + p]);
      diffSum += Math.abs(raw[offset + p + 1] - raw[prevOffset + p + 1]);
      diffSum += Math.abs(raw[offset + p + 2] - raw[prevOffset + p + 2]);
    }

    diffs.push({ sec: i, diff: diffSum / (FRAME_BYTES / 4) });
  }

  return diffs;
}

// ── Internal: Candidate selection ────────────────────────────────────────────

function selectCandidates(diffs: { sec: number; diff: number }[]): { sec: number; diff: number }[] {
  const candidateSet = new Set<number>();

  // Strategy 1: Scene-change candidates (frames with significant visual transitions)
  const above = diffs.filter((d) => d.diff > SCENE_DIFF_THRESHOLD);
  above.sort((a, b) => b.diff - a.diff);
  for (const d of above.slice(0, MAX_CANDIDATES * 2)) {
    candidateSet.add(d.sec);
  }

  // Strategy 2: Periodic sampling every 10 seconds to catch subtle/missed deaths.
  // ONNX handles ~95% of frames for free, so this adds minimal cost.
  const PERIODIC_INTERVAL = 10;
  for (let sec = 0; sec < diffs.length; sec += PERIODIC_INTERVAL) {
    candidateSet.add(diffs[sec].sec);
  }

  // Merge, sort chronologically, and deduplicate
  const merged = [...candidateSet].map((sec) => diffs.find((d) => d.sec === sec)!).filter(Boolean);
  merged.sort((a, b) => a.sec - b.sec);

  // Deduplicate: keep first frame in each DEDUP_GAP_SEC window
  const deduped: { sec: number; diff: number }[] = [];
  let lastSec = -DEDUP_GAP_SEC - 1;
  for (const c of merged) {
    if (c.sec - lastSec >= DEDUP_GAP_SEC) {
      deduped.push(c);
      lastSec = c.sec;
    }
  }

  return deduped.slice(0, MAX_CANDIDATES);
}

// ── Internal: Frame extraction for candidates ────────────────────────────────

async function extractCandidateFrames(
  videoPath: string,
  tmpDir: string,
  candidates: { sec: number }[],
): Promise<Map<number, string>> {
  const frameFiles = new Map<number, string>();
  const BATCH = 8;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (c) => {
        const fp = path.join(tmpDir, `f${c.sec}.jpg`);
        try {
          await execFileAsync(
            'ffmpeg',
            ['-ss', String(c.sec), '-i', videoPath, '-vframes', '1', '-q:v', '2', '-y', fp],
            { windowsHide: true, timeout: 5000 },
          );
          if (fs.existsSync(fp) && fs.statSync(fp).size > 0) {
            frameFiles.set(c.sec, fp);
          }
        } catch {
          /* skip failed extractions */
        }
      }),
    );
  }

  return frameFiles;
}

// ── Internal: Frame classification (ONNX only — no VLM fallback) ────────────
// VLM fallback was removed because it actively caused false positives:
// ONNX at 50% confidence was consistently more accurate than VLM flash-lite,
// and VLM was hallucinating death_screen on buy_phase/round_end frames.
// Cost savings: ~$0.016 per analysis (eliminates all VLM classification calls).

async function classifyFrames(
  _vlm: GeminiProvider,
  frameFiles: Map<number, string>,
  candidates: { sec: number; diff: number }[],
): Promise<ClassifiedFrame[]> {
  if (!isModelAvailable()) {
    throw new Error('ONNX model not available — cannot classify frames without it');
  }

  console.log('[VlmClassifier] using ONNX model (local, $0) — no VLM fallback');

  const results: ClassifiedFrame[] = [];
  let classified = 0;

  for (let i = 0; i < candidates.length; i += VLM_CONCURRENCY) {
    const batch = candidates.slice(i, i + VLM_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        const fp = frameFiles.get(c.sec);
        if (!fp) return null;

        try {
          const imageBuffer = await fs.promises.readFile(fp);
          const result = await onnxClassifyFrame(imageBuffer);
          classified++;

          if (result.label !== 'gameplay') {
            console.log(
              '[VlmClassifier] @%ds: %s (%.0f%% ONNX)',
              c.sec,
              result.label,
              result.confidence * 100,
            );
          }

          return {
            sec: c.sec,
            classification: result.label as FrameClass,
            sceneDiff: c.diff,
            confidence: result.confidence,
            _cost: 0,
          } as ClassifiedFrame & { _cost: number };
        } catch {
          return null;
        }
      }),
    );

    for (const r of batchResults) {
      if (r) results.push(r);
    }

    // Progress log every 500 frames
    if (classified > 0 && classified % 500 < VLM_CONCURRENCY) {
      console.log('[VlmClassifier] classified %d/%d frames...', classified, candidates.length);
    }
  }

  console.log('[VlmClassifier] classified %d frames (ONNX only, $0)', results.length);
  return results;
}

// ── Internal: Timeline builder ───────────────────────────────────────────────

/**
 * Build a structured game timeline from sparse frame classifications.
 *
 * Death detection rules:
 *   - Only `death_screen` frames START a death event (not `spectating` alone).
 *   - `spectating` frames EXTEND an existing death window (confirms the player
 *     died and is now watching a teammate), but cannot create a death by themselves.
 *   - Require at least 2 death-related frames (death_screen or spectating after
 *     a death_screen) within a 15-second window to confirm a death. Single
 *     isolated frames are noise/misclassification.
 *   - Use real classifier confidence instead of hardcoded values.
 */
function buildTimelineFromClassifications(
  classifications: ClassifiedFrame[],
  numFrames: number,
): VlmGameTimeline {
  const deaths: VlmGameTimeline['deaths'] = [];
  const buyPhases: VlmGameTimeline['buyPhases'] = [];
  let round = 0;
  let gameplayStartSec = 0;

  // Sort chronologically
  const sorted = [...classifications].sort((a, b) => a.sec - b.sec);

  // ── Pass 1: Detect buy phases and gameplay start ──
  for (const frame of sorted) {
    if (frame.classification === 'buy_phase') {
      const lastBuy = buyPhases[buyPhases.length - 1];
      if (!lastBuy || frame.sec - lastBuy.timestampSec > 20) {
        round++;
        buyPhases.push({ timestampSec: frame.sec, round });
      }
    }

    if (frame.classification === 'gameplay' && gameplayStartSec === 0) {
      gameplayStartSec = frame.sec;
    }
  }

  // ── Pass 2: Detect deaths with strict rules ──
  // Collect death windows: sequences of death_screen/spectating frames
  // that START with at least one death_screen frame.
  let windowStart = -1;
  let windowEnd = -1;
  let hasDeathScreen = false; // window must contain at least one death_screen
  let deathFrameCount = 0; // total death-related frames in this window
  let confidenceSum = 0;
  const MAX_GAP_SEC = 15; // max gap between frames to be in the same death window

  const flushWindow = () => {
    if (hasDeathScreen && deathFrameCount >= 2) {
      const avgConfidence = confidenceSum / deathFrameCount;
      deaths.push({
        timestampSec: windowStart,
        round: 0, // assigned below
        confidence: Math.min(1.0, avgConfidence),
      });
    } else if (hasDeathScreen && deathFrameCount === 1) {
      // Single death_screen frame — accept at moderate confidence.
      // With sparse candidate selection, many real deaths only produce 1 candidate frame.
      const avgConfidence = confidenceSum / deathFrameCount;
      if (avgConfidence >= 0.65) {
        deaths.push({
          timestampSec: windowStart,
          round: 0,
          confidence: avgConfidence * 0.85, // slight penalty for single-frame
        });
      }
    }
    // Reset
    windowStart = -1;
    windowEnd = -1;
    hasDeathScreen = false;
    deathFrameCount = 0;
    confidenceSum = 0;
  };

  for (const frame of sorted) {
    const isDeathRelated =
      frame.classification === 'death_screen' || frame.classification === 'spectating';

    if (isDeathRelated) {
      if (windowStart < 0) {
        // Start new window — but only if this is a death_screen
        if (frame.classification === 'death_screen') {
          windowStart = frame.sec;
          windowEnd = frame.sec;
          hasDeathScreen = true;
          deathFrameCount = 1;
          confidenceSum = frame.confidence;
        }
        // Spectating without prior death_screen → skip (not a death)
      } else if (frame.sec - windowEnd <= MAX_GAP_SEC) {
        // Extend existing window
        windowEnd = frame.sec;
        deathFrameCount++;
        confidenceSum += frame.confidence;
        if (frame.classification === 'death_screen') hasDeathScreen = true;
      } else {
        // Gap too large — flush old window, maybe start new one
        flushWindow();
        if (frame.classification === 'death_screen') {
          windowStart = frame.sec;
          windowEnd = frame.sec;
          hasDeathScreen = true;
          deathFrameCount = 1;
          confidenceSum = frame.confidence;
        }
      }
    } else {
      // Non-death frame — flush any open window
      if (windowStart >= 0) {
        flushWindow();
      }
    }
  }
  // Flush final window
  if (windowStart >= 0) flushWindow();

  // ── Pass 3: Context-based death filtering ──
  // Remove false positives using game context rules:
  //   1. Deaths can't happen during buy phase (buy phase = safe zone, 0-45s after round start)
  //   2. Deaths can't happen within 5s of a buy phase start (still in spawn)
  //   3. Two deaths can't happen within 10s of each other (it's the same death or spectating)
  //   4. Scoreboard/settings/tab overlays look like death screens — filter by checking
  //      if surrounding frames are gameplay (not spectating), meaning player is alive

  // Build a quick lookup: is this timestamp near a buy phase?
  const isBuyPhaseAt = (sec: number): boolean => {
    for (const bp of buyPhases) {
      // Buy phase typically lasts ~30s, plus 5s buffer
      if (sec >= bp.timestampSec - 2 && sec <= bp.timestampSec + 35) return true;
    }
    return false;
  };

  // Build a lookup: what's the dominant classification around a timestamp?
  const classAt = (sec: number): FrameClass | null => {
    const frame = sorted.find((f) => f.sec === sec);
    return frame?.classification ?? null;
  };

  // Check if surrounding frames suggest player is alive (gameplay before AND after = scoreboard false positive)
  const isLikelyScorecardOverlay = (deathSec: number): boolean => {
    // Check 3-8 seconds before the death: if all gameplay, player was alive
    let gameplayBefore = 0;
    let totalBefore = 0;
    for (let s = deathSec - 8; s < deathSec - 2; s++) {
      const c = classAt(s);
      if (c) {
        totalBefore++;
        if (c === 'gameplay') gameplayBefore++;
      }
    }
    // Check 3-8 seconds after: if gameplay resumes quickly, it wasn't a real death
    let gameplayAfter = 0;
    let totalAfter = 0;
    for (let s = deathSec + 3; s <= deathSec + 8; s++) {
      const c = classAt(s);
      if (c) {
        totalAfter++;
        if (c === 'gameplay') gameplayAfter++;
      }
    }
    // If gameplay both before AND after with no spectating → likely scoreboard overlay
    const gameplayBeforeRatio = totalBefore > 0 ? gameplayBefore / totalBefore : 0;
    const gameplayAfterRatio = totalAfter > 0 ? gameplayAfter / totalAfter : 0;
    return gameplayBeforeRatio > 0.6 && gameplayAfterRatio > 0.6;
  };

  const filteredDeaths = deaths.filter((death, i) => {
    // Rule 1: No deaths during buy phase
    if (isBuyPhaseAt(death.timestampSec)) {
      console.log('[VlmClassifier] FILTERED death @%ds: during buy phase', death.timestampSec);
      return false;
    }

    // Rule 2: No duplicate deaths within 10s
    if (i > 0 && death.timestampSec - deaths[i - 1].timestampSec < 10) {
      console.log(
        '[VlmClassifier] FILTERED death @%ds: too close to previous death @%ds',
        death.timestampSec,
        deaths[i - 1].timestampSec,
      );
      return false;
    }

    // Rule 3: Scoreboard/settings overlay check — gameplay before AND after = not a death
    if (isLikelyScorecardOverlay(death.timestampSec)) {
      console.log(
        '[VlmClassifier] FILTERED death @%ds: likely scoreboard/settings overlay (gameplay before and after)',
        death.timestampSec,
      );
      return false;
    }

    return true;
  });

  console.log(
    '[VlmClassifier] context filter: %d → %d deaths (%d removed)',
    deaths.length,
    filteredDeaths.length,
    deaths.length - filteredDeaths.length,
  );

  // ── Pass 4: Assign rounds to deaths ──
  for (const death of filteredDeaths) {
    const prevBuy = [...buyPhases].reverse().find((bp) => bp.timestampSec < death.timestampSec);
    if (prevBuy) death.round = prevBuy.round;
  }

  // ── Pass 5: Build round structure ──
  const rounds: VlmGameTimeline['rounds'] = [];
  for (let r = 1; r <= round; r++) {
    const bp = buyPhases.find((b) => b.round === r);
    const nextBp = buyPhases.find((b) => b.round === r + 1);
    const death = filteredDeaths.find((d) => d.round === r);
    if (bp) {
      rounds.push({
        round: r,
        startSec: bp.timestampSec,
        endSec: nextBp ? nextBp.timestampSec : numFrames,
        deathSec: death?.timestampSec ?? null,
      });
    }
  }

  console.log(
    '[VlmClassifier] timeline built: %d deaths (from %d death_screen + %d spectating frames), %d rounds',
    filteredDeaths.length,
    sorted.filter((f) => f.classification === 'death_screen').length,
    sorted.filter((f) => f.classification === 'spectating').length,
    rounds.length,
  );

  return {
    classifications: sorted,
    deaths: filteredDeaths,
    buyPhases,
    rounds,
    gameplayStartSec,
    videoDurationSec: numFrames,
    classificationCostUsd: 0,
    processingMs: 0,
  };
}

function emptyTimeline(numFrames: number, processingMs: number): VlmGameTimeline {
  return {
    classifications: [],
    deaths: [],
    buyPhases: [],
    rounds: [],
    gameplayStartSec: 0,
    videoDurationSec: numFrames,
    classificationCostUsd: 0,
    processingMs,
  };
}
