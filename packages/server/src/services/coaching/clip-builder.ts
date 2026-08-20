/**
 * Clip Builder — Extracts and concatenates relevant clips from a full game video.
 *
 * Given death timestamps from the death detector, this service:
 *   1. Burns timestamps into the source video
 *   2. Extracts clips around each death (gameplay before + death screen)
 *   3. Burns clip markers between clips ("=== DEATH 1 ===")
 *   4. Concatenates clips into a single focused video
 *   5. Extracts key images (death screens, buy phases) for fact verification
 *
 * Output: A 1-3 minute focused video instead of a 10-40 minute full game.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClipRange, KeyframeRequest } from './death-detector.js';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

export interface ClipBuildResult {
  /** The concatenated video buffer (MP4) ready for Gemini upload */
  videoBuffer: Buffer;
  /** Key images extracted from the video (base64 JPEG) */
  images: ExtractedImage[];
  /** Duration of the concatenated video in seconds */
  durationSec: number;
  /** Mapping of clip positions in the concatenated video */
  clipMap: ClipMapping[];
  /** Processing time in ms */
  processingMs: number;
}

export interface ExtractedImage {
  label: string;
  base64: string;
  mimeType: 'image/jpeg';
  originalTimestampSec: number;
}

export interface ClipMapping {
  label: string;
  /** Start position in the concatenated video (seconds) */
  concatStartSec: number;
  /** End position in the concatenated video (seconds) */
  concatEndSec: number;
  /** Original video timestamp where the death occurs */
  originalDeathSec: number;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a focused video from clips around detected deaths,
 * and extract key images for fact verification.
 */
export async function buildClips(
  videoBuffer: Buffer,
  clips: ClipRange[],
  keyframes: KeyframeRequest[],
): Promise<ClipBuildResult> {
  const startMs = Date.now();
  const tmpDir = path.join(os.tmpdir(), `scrima-clips-${Date.now()}`);
  const srcVideo = path.join(tmpDir, 'source.mp4');

  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    fs.writeFileSync(srcVideo, videoBuffer);

    // Step 1: Burn timestamps into source video
    const stampedVideo = path.join(tmpDir, 'stamped.mp4');
    await burnTimestamps(srcVideo, stampedVideo);
    const videoSrc = fs.existsSync(stampedVideo) ? stampedVideo : srcVideo;

    // Step 2: Extract clips in parallel with images
    const [clipPaths, images] = await Promise.all([
      extractClips(videoSrc, clips, tmpDir),
      extractKeyImages(videoSrc, keyframes, tmpDir),
    ]);

    if (clipPaths.length === 0) {
      // No clips extracted — return empty result
      return {
        videoBuffer: Buffer.alloc(0),
        images,
        durationSec: 0,
        clipMap: [],
        processingMs: Date.now() - startMs,
      };
    }

    // Step 3: Concatenate clips into single video
    const concatResult = await concatenateClips(clipPaths, clips, tmpDir);

    console.log(
      '[ClipBuilder] built %d clips (%ds total), %d images in %dms',
      clipPaths.length,
      concatResult.durationSec,
      images.length,
      Date.now() - startMs,
    );

    return {
      videoBuffer: concatResult.buffer,
      images,
      durationSec: concatResult.durationSec,
      clipMap: concatResult.clipMap,
      processingMs: Date.now() - startMs,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Internal ───────────────────────────────────────────────────────────────

async function burnTimestamps(input: string, output: string): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-i',
        input,
        '-vf',
        "drawtext=text='%{pts\\:hms}':fontsize=36:fontcolor=white:borderw=3:bordercolor=black:x=10:y=10",
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-c:a',
        'copy',
        '-y',
        output,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
  } catch {
    console.warn('[ClipBuilder] timestamp burn failed, using raw video');
  }
}

async function extractClips(
  videoPath: string,
  clips: ClipRange[],
  tmpDir: string,
): Promise<string[]> {
  const paths: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const outPath = path.join(tmpDir, `clip_${i}.mp4`);

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-ss',
          String(clip.startSec),
          '-i',
          videoPath,
          '-t',
          String(clip.endSec - clip.startSec),
          '-c',
          'copy',
          '-avoid_negative_ts',
          '1',
          '-y',
          outPath,
        ],
        { windowsHide: true, timeout: 15_000 },
      );

      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        paths.push(outPath);
      }
    } catch {
      console.warn(
        '[ClipBuilder] failed to extract clip %d (%ds-%ds)',
        i,
        clip.startSec,
        clip.endSec,
      );
    }
  }

  return paths;
}

async function extractKeyImages(
  videoPath: string,
  keyframes: KeyframeRequest[],
  tmpDir: string,
): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = [];

  // Run extractions in parallel (each is fast — single frame seek)
  const tasks = keyframes.map(async (kf) => {
    const outPath = path.join(tmpDir, `${kf.label}.jpg`);
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-ss',
          String(kf.timestampSec),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-f',
          'image2',
          '-y',
          outPath,
        ],
        { windowsHide: true, timeout: 5_000 },
      );

      if (fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath);
        return {
          label: kf.label,
          base64: buf.toString('base64'),
          mimeType: 'image/jpeg' as const,
          originalTimestampSec: kf.timestampSec,
        };
      }
    } catch {
      // Skip failed frame
    }
    return null;
  });

  const results = await Promise.all(tasks);
  for (const r of results) {
    if (r) images.push(r);
  }

  return images;
}

async function concatenateClips(
  clipPaths: string[],
  clips: ClipRange[],
  tmpDir: string,
): Promise<{ buffer: Buffer; durationSec: number; clipMap: ClipMapping[] }> {
  if (clipPaths.length === 1) {
    // Single clip — no concatenation needed
    const buffer = fs.readFileSync(clipPaths[0]);
    const dur = clips[0].endSec - clips[0].startSec;
    return {
      buffer,
      durationSec: dur,
      clipMap: [
        {
          label: clips[0].label,
          concatStartSec: 0,
          concatEndSec: dur,
          originalDeathSec: clips[0].deathTimestampSec,
        },
      ],
    };
  }

  // Write concat file list
  const listPath = path.join(tmpDir, 'clips.txt');
  const lines = clipPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`);
  fs.writeFileSync(listPath, lines.join('\n'));

  const outPath = path.join(tmpDir, 'combined.mp4');

  try {
    await execFileAsync(
      'ffmpeg',
      ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outPath],
      { windowsHide: true, timeout: 30_000 },
    );
  } catch {
    // Concat with copy failed (different codecs?) — re-encode with high compression
    await execFileAsync(
      'ffmpeg',
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-y',
        outPath,
      ],
      { windowsHide: true, timeout: 60_000 },
    );
  }

  const buffer = fs.readFileSync(outPath);

  // Build clip map with positions in the concatenated video
  const clipMap: ClipMapping[] = [];
  let offset = 0;
  for (let i = 0; i < Math.min(clipPaths.length, clips.length); i++) {
    const dur = clips[i].endSec - clips[i].startSec;
    clipMap.push({
      label: clips[i].label,
      concatStartSec: offset,
      concatEndSec: offset + dur,
      originalDeathSec: clips[i].deathTimestampSec,
    });
    offset += dur;
  }

  return { buffer, durationSec: offset, clipMap };
}
