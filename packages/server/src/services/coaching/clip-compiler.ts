/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * Clip Compiler
 *
 * Takes detected death timestamps and compiles short video clips into
 * a single concatenated video with text markers between each death.
 *
 * Output: ONE short video (~3 min) containing all death clips with
 * verified facts burned as text overlays.
 *
 * This is uploaded to Gemini Files API as a single video for
 * temporal-aware analysis — NOT as individual frames.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Options to hide console windows on Windows */
const HIDDEN_OPTS = { windowsHide: true };

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeathClipInfo {
  deathNumber: number;
  timestampSec: number;
  round: number;
  /** Verified facts to burn as text overlay before the clip */
  overlayText: string;
}

export interface CompiledClipsResult {
  /** Path to the compiled MP4 video file (temp file, caller must delete) */
  videoPath: string;
  /** Total duration in seconds */
  durationSec: number;
  /** Map from death number to clip start time in the compiled video */
  clipMap: { deathNumber: number; startSec: number; endSec: number }[];
}

// ── Config ───────────────────────────────────────────────────────────────────

const PRE_DEATH_SEC = 15; // seconds of gameplay before death to include
const POST_DEATH_SEC = 3; // seconds after death (shows death screen)
const TITLE_CARD_SEC = 3; // seconds for the text overlay between clips
const MAX_CLIPS = 8; // max deaths to include

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compile death clips from a video into a single concatenated video.
 *
 * @param videoBuffer - Source video (analysis copy, 1fps 720p)
 * @param deaths - Death info with verified facts for overlays
 * @returns Compiled video file path + clip map
 */
export async function compileDeathClips(
  videoBuffer: Buffer,
  deaths: DeathClipInfo[],
  /** Optional pre-written video path to avoid redundant disk write */
  sharedVideoPath?: string,
): Promise<CompiledClipsResult> {
  const tmpDir = path.join(os.tmpdir(), `scrima-clips-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Use shared path or write our own copy
  const srcVideo = sharedVideoPath ?? path.join(tmpDir, 'source.mp4');
  if (!sharedVideoPath) fs.writeFileSync(srcVideo, videoBuffer);

  const clipsToProcess = deaths.slice(0, MAX_CLIPS);
  const clipFiles: string[] = [];
  const clipMap: CompiledClipsResult['clipMap'] = [];
  let currentTime = 0;

  for (let i = 0; i < clipsToProcess.length; i++) {
    const death = clipsToProcess[i];
    const clipStart = Math.max(0, death.timestampSec - PRE_DEATH_SEC);
    const clipEnd = death.timestampSec + POST_DEATH_SEC;
    const clipDuration = clipEnd - clipStart;

    // 1. Create title card (black frame with text overlay)
    const titlePath = path.join(tmpDir, `title_${i}.mp4`);
    const escapedText = death.overlayText
      .replace(/\\/g, '\\\\\\\\')
      .replace(/'/g, "'\\\\\\''")
      .replace(/:/g, '\\\\:')
      .replace(/%/g, '%%')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/;/g, '\\;')
      .replace(/\n/g, ' ');

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=black:s=1280x720:d=${TITLE_CARD_SEC}:r=1`,
          '-vf',
          `drawtext=text='${escapedText}':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=10`,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-an',
          '-y',
          titlePath,
        ],
        { windowsHide: true, timeout: 10000 },
      );
    } catch {
      // Fallback: title card without text (if text rendering fails)
      await execFileAsync(
        'ffmpeg',
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=black:s=1280x720:d=${TITLE_CARD_SEC}:r=1`,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-an',
          '-y',
          titlePath,
        ],
        { windowsHide: true, timeout: 10000 },
      );
    }

    // 2. Cut the gameplay clip
    const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-ss',
          String(clipStart),
          '-i',
          srcVideo,
          '-t',
          String(clipDuration),
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-an',
          '-y',
          clipPath,
        ],
        { windowsHide: true, timeout: 30000 },
      );
    } catch (err) {
      console.warn(
        '[ClipCompiler] failed to cut clip %d: %s',
        i,
        (err as Error).message?.slice(0, 60),
      );
      continue;
    }

    if (fs.existsSync(titlePath) && fs.existsSync(clipPath)) {
      clipFiles.push(titlePath, clipPath);

      clipMap.push({
        deathNumber: death.deathNumber,
        startSec: currentTime + TITLE_CARD_SEC, // skip title card
        endSec: currentTime + TITLE_CARD_SEC + clipDuration,
      });

      currentTime += TITLE_CARD_SEC + clipDuration;
    }
  }

  if (clipFiles.length === 0) {
    // Cleanup and return empty
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('No clips could be compiled');
  }

  // 3. Concatenate all clips into one video
  const concatList = path.join(tmpDir, 'concat.txt');
  fs.writeFileSync(concatList, clipFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

  const outputPath = path.join(tmpDir, 'compiled.mp4');
  await execFileAsync(
    'ffmpeg',
    [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatList,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-y',
      outputPath,
    ],
    { windowsHide: true, timeout: 60000 },
  );

  // Get duration
  let durationSec = currentTime;
  try {
    const out = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath],
      { windowsHide: true, timeout: 5000 },
    );
    durationSec = Math.floor(parseFloat(out.stdout.trim()));
  } catch {}

  console.log(
    '[ClipCompiler] compiled %d deaths into %ds video (%s)',
    clipMap.length,
    durationSec,
    (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1) + 'MB',
  );

  return {
    videoPath: outputPath,
    durationSec,
    clipMap,
  };
}

/**
 * Clean up compiled clips temp directory.
 */
export function cleanupClips(videoPath: string): void {
  const dir = path.dirname(videoPath);
  if (dir.includes('scrima-clips-')) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
