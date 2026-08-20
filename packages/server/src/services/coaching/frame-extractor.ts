/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * Frame Extractor
 *
 * Extracts specific frames from a video buffer using ffmpeg.
 * Used by the fact verification pipeline to grab death screens,
 * pre-death ability bars, and buy phase screenshots.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Cache CUDA hardware acceleration availability (probe once per process)
let cudaAvailable: boolean | null = null;
async function isCudaAvailable(): Promise<boolean> {
  if (cudaAvailable !== null) return cudaAvailable;
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-hwaccel',
        'cuda',
        '-f',
        'lavfi',
        '-i',
        'nullsrc=s=64x64:d=0.04',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { windowsHide: true, timeout: 5000 },
    );
    cudaAvailable = true;
  } catch {
    cudaAvailable = false;
  }
  console.log('[FrameExtractor] CUDA hwaccel available:', cudaAvailable);
  return cudaAvailable;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FrameExtractionRequest {
  timestampSec: number;
  label: string; // e.g. "death_1_deathscreen", "death_1_predeath", "buyphase_round_3"
}

export interface ExtractedFrame {
  timestampSec: number;
  label: string;
  base64: string;
  mimeType: 'image/jpeg';
}

// ── Crop Regions ─────────────────────────────────────────────────────────────

/**
 * Crop regions for death screen frames (proportional to any resolution).
 * On 1280×720: center≈768×216 at (256,202), killfeed≈422×288 at (858,14).
 * Small crops fit in a single Gemini tile at near-native resolution,
 * making text ~4x more readable than the downscaled full frame.
 */
const DEATH_SCREEN_CROPS = [
  { suffix: 'crop_center', filter: 'crop=iw*0.6:ih*0.3:iw*0.2:ih*0.28' },
  { suffix: 'crop_killfeed', filter: 'crop=iw*0.33:ih*0.4:iw*0.67:ih*0.02' },
  // Death banner — "ELIMINATED BY [AGENT]" text + weapon icon, center of screen
  { suffix: 'crop_deathbanner', filter: 'crop=iw*0.4:ih*0.12:iw*0.3:ih*0.4' },
];

/** Crop regions for predeath frames — HUD elements visible right before death */
const PREDEATH_CROPS = [
  { suffix: 'crop_minimap', filter: 'crop=iw*0.18:ih*0.3:0:0' },
  // Weapon HUD — bottom-right shows weapon name, ammo count, weapon icon
  { suffix: 'crop_weapon_hud', filter: 'crop=iw*0.2:ih*0.15:iw*0.8:ih*0.85' },
  // Ability bar — bottom-center shows 4 ability icons (C, Q, E, X) with availability state
  { suffix: 'crop_ability_bar', filter: 'crop=iw*0.3:ih*0.1:iw*0.35:ih*0.88' },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse "MM:SS" or "HH:MM:SS" timestamp to seconds. Returns null for "unknown" or invalid.
 */
export function parseTimestamp(approxTime: string): number | null {
  if (!approxTime || approxTime === 'unknown') return null;
  const parts = approxTime.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Build the list of frames to extract from the video based on death timestamps.
 *
 * For each death:
 *   - T-1s: pre-death frame (ability bar + minimap crop)
 *   - T+2s: death screen (+ center crop + killfeed crop)
 *   - T+4s: death screen late (full frame only, no crops)
 *
 * Buy phases: every ~240s from video start (up to 8 rounds)
 */
export function buildFrameRequests(
  deathTimestamps: { deathNumber: number; timestampSec: number }[],
  videoDurationSec?: number,
): FrameExtractionRequest[] {
  const requests: FrameExtractionRequest[] = [];

  // Death-related frames — 8 frames per death for tactical context
  // Pre-death: T-5 through T-1 (movement, positioning, ability bar)
  // Death moment: T+0
  // Death screen: T+2 (readable HUD), T+4 (late, full frame only)
  const DEATH_OFFSETS = [
    { offset: -5, suffix: 'pre_5s' },
    { offset: -4, suffix: 'pre_4s' },
    { offset: -3, suffix: 'pre_3s' },
    { offset: -2, suffix: 'pre_2s' },
    { offset: -1, suffix: 'predeath' },
    { offset: 0, suffix: 'moment' },
    { offset: 2, suffix: 'deathscreen' },
    { offset: 4, suffix: 'deathscreen_late' },
  ];

  for (const { deathNumber, timestampSec } of deathTimestamps) {
    for (const { offset, suffix } of DEATH_OFFSETS) {
      const t = timestampSec + offset;
      if (t < 0) continue;
      requests.push({
        timestampSec: t,
        label: `death_${deathNumber}_${suffix}`,
      });
    }
  }

  // Agent identification frames — early game, full-res for reliable agent detection
  // The ability bar (bottom-center) and agent portrait (bottom-left) are clearly visible
  // during the first buy phase. These frames are the BEST source for agent identification.
  const AGENT_ID_OFFSETS = [3, 10];
  for (const t of AGENT_ID_OFFSETS) {
    if (t < (videoDurationSec ?? 3600)) {
      requests.push({ timestampSec: t, label: `agent_id_${t}s` });
    }
  }

  // Buy phase frames: every ~240s, starting at 5s
  const maxDuration = videoDurationSec ?? 3600;
  const maxBuyFrames = 8;
  for (let i = 0; i < maxBuyFrames; i++) {
    const t = 5 + i * 240;
    if (t >= maxDuration) break;
    requests.push({ timestampSec: t, label: `buyphase_${i}` });
  }

  // Cap total frames (crops are generated during extraction, not counted here)
  return requests.slice(0, 120);
}

/**
 * Extract frames from a video buffer at specified timestamps using ffmpeg.
 * Returns base64-encoded JPEG images.
 */
export async function extractFrames(
  videoBuffer: Buffer,
  requests: FrameExtractionRequest[],
  /** Optional pre-written video path to avoid redundant disk write */
  sharedVideoPath?: string,
): Promise<ExtractedFrame[]> {
  if (requests.length === 0) return [];

  const ownsVideo = !sharedVideoPath;
  const tmpVideoPath = sharedVideoPath ?? path.join(os.tmpdir(), `scrima-verify-${Date.now()}.mp4`);
  const framesDir = path.join(os.tmpdir(), `scrima-frames-${Date.now()}`);

  try {
    if (ownsVideo) await fs.promises.writeFile(tmpVideoPath, videoBuffer);
    fs.mkdirSync(framesDir, { recursive: true });

    const frames: ExtractedFrame[] = [];

    // Extract frames in parallel batches of 4 for speed
    const CONCURRENCY = 4;
    for (let i = 0; i < requests.length; i += CONCURRENCY) {
      const batch = requests.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (req) => {
          const extracted: ExtractedFrame[] = [];
          const outputPath = path.join(framesDir, `${req.label}.jpg`);
          try {
            const cuda = await isCudaAvailable();
            const ffmpegArgs = [
              ...(cuda ? ['-hwaccel', 'cuda'] : []),
              '-ss',
              String(req.timestampSec),
              '-i',
              tmpVideoPath,
              '-frames:v',
              '1',
              '-q:v',
              '2',
              '-f',
              'image2',
              '-y',
              outputPath,
            ];
            await execFileAsync('ffmpeg', ffmpegArgs, { windowsHide: true, timeout: 5000 });

            if (fs.existsSync(outputPath)) {
              const imageBuffer = fs.readFileSync(outputPath);
              extracted.push({
                timestampSec: req.timestampSec,
                label: req.label,
                base64: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg',
              });

              // Extract crops from specific frames only (not _late — one crop set per death is enough).
              const crops =
                req.label.includes('deathscreen') && !req.label.includes('_late')
                  ? DEATH_SCREEN_CROPS
                  : req.label.includes('predeath')
                    ? PREDEATH_CROPS
                    : null;
              if (crops) {
                for (const crop of crops) {
                  const cropLabel = `${req.label}_${crop.suffix}`;
                  const cropPath = path.join(framesDir, `${cropLabel}.jpg`);
                  try {
                    await execFileAsync(
                      'ffmpeg',
                      ['-i', outputPath, '-vf', crop.filter, '-q:v', '1', '-y', cropPath],
                      { windowsHide: true, timeout: 3000 },
                    );

                    if (fs.existsSync(cropPath)) {
                      const cropBuffer = fs.readFileSync(cropPath);
                      extracted.push({
                        timestampSec: req.timestampSec,
                        label: cropLabel,
                        base64: cropBuffer.toString('base64'),
                        mimeType: 'image/jpeg',
                      });
                    }
                  } catch {
                    // Crop failed — non-critical
                  }
                }
              }
            }
          } catch {
            console.warn(
              '[FrameExtractor] failed to extract frame at %ds (%s), skipping',
              req.timestampSec,
              req.label,
            );
          }
          return extracted;
        }),
      );
      for (const batch of results) frames.push(...batch);
    }

    const fullCount = frames.filter((f) => !f.label.includes('crop_')).length;
    const cropCount = frames.filter((f) => f.label.includes('crop_')).length;
    console.log(
      '[FrameExtractor] extracted %d frames (%d full + %d crops) from %d requests',
      frames.length,
      fullCount,
      cropCount,
      requests.length,
    );
    return frames;
  } finally {
    if (ownsVideo) fs.rmSync(tmpVideoPath, { force: true });
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
}
