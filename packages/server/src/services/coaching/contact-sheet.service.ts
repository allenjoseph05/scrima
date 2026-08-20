/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * Contact Sheet Service — VLM-based death detection
 *
 * Replaces CPU pixel heuristics with visual understanding:
 *   1. ffmpeg extracts video frames into tiled contact sheet images
 *   2. Flash-lite (cheapest VLM) classifies which frames are death screens
 *   3. Returns death timestamps compatible with the clip builder
 *
 * Why contact sheets instead of individual images:
 *   - 23 grid images vs 1140 individual images = ~10x fewer tokens
 *   - One API call for the entire video (~$0.002)
 *   - Flash-lite easily identifies death screens at 160×90 per thumbnail
 *
 * Reliability: VLM understands what a death screen looks like regardless
 * of recording software, game settings, brightness, or map. No thresholds.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GeminiProvider } from '../vlm/gemini.provider.js';
import type { DetectedDeath, DetectionResult } from './death-detector.js';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

export interface ContactSheet {
  base64: string;
  mimeType: 'image/jpeg';
  sheetIndex: number;
  frameStartIndex: number;
  framesOnSheet: number;
}

export interface ContactSheetResult {
  sheets: ContactSheet[];
  framesPerSheet: number;
  sampleIntervalSec: number;
  totalFrames: number;
  videoDurationSec: number;
  processingMs: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const THUMB_W = 160;
const THUMB_H = 90;
const DEFAULT_COLS = 10;
const DEFAULT_ROWS = 5;
const DEFAULT_SAMPLE_INTERVAL = 2; // seconds between frames

// ── Contact Sheet Extraction ───────────────────────────────────────────────

/**
 * Extract video frames into tiled contact sheet JPEG images.
 *
 * Each sheet is a grid of thumbnails (default 10×5 = 50 frames per sheet).
 * Frames are sampled every `sampleIntervalSec` seconds (default 2s).
 *
 * For a 38-minute video at 2s intervals: ~1140 frames → 23 sheets.
 */
export async function extractContactSheets(
  videoBuffer: Buffer,
  options?: { sampleIntervalSec?: number; cols?: number; rows?: number },
): Promise<ContactSheetResult> {
  const startMs = Date.now();
  const interval = options?.sampleIntervalSec ?? DEFAULT_SAMPLE_INTERVAL;
  const cols = options?.cols ?? DEFAULT_COLS;
  const rows = options?.rows ?? DEFAULT_ROWS;
  const framesPerSheet = cols * rows;

  const tmpDir = path.join(os.tmpdir(), `scrima-sheets-${Date.now()}`);
  const tmpVideo = path.join(tmpDir, 'input.mp4');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpVideo, videoBuffer);

    // Get video duration via ffprobe
    const { stdout: durationStr } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpVideo],
      { windowsHide: true, timeout: 15_000 },
    );

    const videoDurationSec = Math.floor(Number.parseFloat(durationStr.trim()) || 0);
    const totalFrames = Math.floor(videoDurationSec / interval);

    if (totalFrames < 5) {
      return {
        sheets: [],
        framesPerSheet,
        sampleIntervalSec: interval,
        totalFrames,
        videoDurationSec,
        processingMs: Date.now() - startMs,
      };
    }

    // Extract contact sheets using ffmpeg tile filter
    const sheetPattern = path.join(tmpDir, 'sheet_%03d.jpg');
    await execFileAsync(
      'ffmpeg',
      [
        '-i',
        tmpVideo,
        '-vf',
        `fps=1/${interval},scale=${THUMB_W}:${THUMB_H},tile=${cols}x${rows}`,
        '-q:v',
        '5',
        '-v',
        'quiet',
        '-y',
        sheetPattern,
      ],
      { windowsHide: true, timeout: 120_000 },
    );

    // Read all generated sheet files
    const sheetFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('sheet_') && f.endsWith('.jpg'))
      .sort();

    const sheets: ContactSheet[] = [];
    for (let i = 0; i < sheetFiles.length; i++) {
      const filePath = path.join(tmpDir, sheetFiles[i]);
      const data = fs.readFileSync(filePath);
      const frameStart = i * framesPerSheet;
      const framesRemaining = totalFrames - frameStart;

      sheets.push({
        base64: data.toString('base64'),
        mimeType: 'image/jpeg',
        sheetIndex: i,
        frameStartIndex: frameStart,
        framesOnSheet: Math.min(framesPerSheet, framesRemaining),
      });
    }

    console.log(
      '[ContactSheet] extracted %d sheets (%d frames, %ds interval) from %ds video in %dms',
      sheets.length,
      totalFrames,
      interval,
      videoDurationSec,
      Date.now() - startMs,
    );

    return {
      sheets,
      framesPerSheet,
      sampleIntervalSec: interval,
      totalFrames,
      videoDurationSec,
      processingMs: Date.now() - startMs,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── VLM Death Scanning ─────────────────────────────────────────────────────

const DEATH_SCAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    deaths: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sheet: { type: 'integer', description: 'Sheet number (1-indexed, matches the label).' },
          row: { type: 'integer', description: 'Row in the grid (1-indexed, top to bottom).' },
          col: { type: 'integer', description: 'Column in the grid (1-indexed, left to right).' },
          confidence: {
            type: 'string',
            enum: ['high', 'medium'],
            description: '"high" if clearly a death screen, "medium" if uncertain.',
          },
        },
        required: ['sheet', 'row', 'col', 'confidence'],
      },
      description:
        'All frames that show a death screen. Report each death screen frame individually.',
    },
  },
  required: ['deaths'],
};

function buildDeathScanPrompt(sheetResult: ContactSheetResult): string {
  const { framesPerSheet, sampleIntervalSec, sheets } = sheetResult;
  const cols = DEFAULT_COLS;
  const rows = DEFAULT_ROWS;

  return `You are analyzing Valorant gameplay video frames arranged in contact sheets.

Each sheet is a ${cols}×${rows} grid of video thumbnails sampled every ${sampleIntervalSec} seconds.
Frames are in READING ORDER: left-to-right, top-to-bottom.
There are ${sheets.length} sheets total.

TASK: Identify ALL frames that show a Valorant DEATH SCREEN.

A death screen has ALL of these:
- Screen is DARKENED and DESATURATED (gray, washed-out look)
- The ability bar (bottom-center) is NOT visible
- The health bar (bottom-left) is NOT visible
- The weapon/ammo HUD (bottom-right) is NOT visible
- May show blurred game world in background
- May show "KILLED BY" text or death recap UI
- Death screens last 3-7 seconds, so you may see 2-4 consecutive death frames

Do NOT count these as deaths:
- SPECTATING another player (HUD is visible for the spectated player, "SPECTATING" text at bottom)
- Buy phase (buy menu UI visible)
- Loading screens (map name, loading bar)
- Smoke, flash, or ability effects (HUD remains visible)
- Settings menu or pause screen (has menu buttons)
- Round-end or scoreboard screens
- Agent select screen

For each death frame, report its sheet number (1-indexed), row (1-indexed), and column (1-indexed).
If multiple consecutive frames show the same death, report ALL of them — deduplication is handled downstream.`;
}

/**
 * Send contact sheets to flash-lite to identify death screen frames.
 *
 * Returns death timestamps compatible with the clip builder pipeline.
 * Cost: ~$0.002 for a 38-minute video (23 contact sheets on flash-lite).
 */
export async function detectDeathsFromSheets(
  vlm: GeminiProvider,
  sheetResult: ContactSheetResult,
): Promise<{ deaths: DetectedDeath[]; costUsd: number; processingMs: number }> {
  const startMs = Date.now();

  if (sheetResult.sheets.length === 0) {
    return { deaths: [], costUsd: 0, processingMs: 0 };
  }

  const prompt = buildDeathScanPrompt(sheetResult);
  const images = sheetResult.sheets.map((s) => ({
    label: `sheet_${s.sheetIndex + 1}`,
    base64: s.base64,
    mimeType: s.mimeType as string,
  }));

  const { result, costUsd } = await vlm.verifyWithImages(
    images,
    prompt,
    DEATH_SCAN_SCHEMA,
    30_000, // 30s timeout — more sheets than fact verification
  );

  // Parse VLM response → frame indices → timestamps
  const rawDeaths = (result.deaths ?? []) as Array<{
    sheet: number;
    row: number;
    col: number;
    confidence: string;
  }>;

  const cols = DEFAULT_COLS;
  const frameTimestamps: { timestampSec: number; confidence: number }[] = [];

  for (const d of rawDeaths) {
    // Convert 1-indexed sheet/row/col to 0-indexed frame number
    const sheetIdx = (d.sheet ?? 1) - 1;
    const rowIdx = (d.row ?? 1) - 1;
    const colIdx = (d.col ?? 1) - 1;

    if (sheetIdx < 0 || sheetIdx >= sheetResult.sheets.length) continue;

    const frameIndex = sheetIdx * sheetResult.framesPerSheet + rowIdx * cols + colIdx;
    if (frameIndex < 0 || frameIndex >= sheetResult.totalFrames) continue;

    const timestampSec = frameIndex * sheetResult.sampleIntervalSec;
    const confidence = d.confidence === 'high' ? 0.95 : 0.75;

    frameTimestamps.push({ timestampSec, confidence });
  }

  // Deduplicate: consecutive frames from the same death → keep the first
  const sorted = frameTimestamps.sort((a, b) => a.timestampSec - b.timestampSec);
  const deaths: DetectedDeath[] = [];
  let lastDeathSec = Number.NEGATIVE_INFINITY;

  for (const frame of sorted) {
    if (frame.timestampSec - lastDeathSec > 10) {
      // New death (>10s gap from previous)
      deaths.push({
        timestampSec: frame.timestampSec,
        confidence: frame.confidence,
        durationFrames: 5, // estimated — VLM doesn't report exact duration
      });
      lastDeathSec = frame.timestampSec;
    }
  }

  console.log(
    '[ContactSheet] VLM detected %d deaths from %d raw frames, cost=$%s, %dms',
    deaths.length,
    rawDeaths.length,
    costUsd.toFixed(6),
    Date.now() - startMs,
  );

  return { deaths, costUsd, processingMs: Date.now() - startMs };
}

/**
 * Build a DetectionResult from VLM-detected deaths.
 * Compatible with buildClipPlan() from death-detector.ts.
 */
export function toDetectionResult(
  deaths: DetectedDeath[],
  videoDurationSec: number,
): DetectionResult {
  return {
    deaths,
    buyPhases: [],
    gameplayStartSec: 0,
    videoDurationSec,
    processingMs: 0,
  };
}
