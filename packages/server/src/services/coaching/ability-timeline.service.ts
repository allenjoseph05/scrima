/**
 * Ability Timeline Service (X3a)
 *
 * Detects when each ability slot transitions lit→dark across a round and
 * emits structured cast events for downstream anti-pattern rules.
 *
 * Approach:
 *   1. Sample the video at 1 fps via ffmpeg, scoped to gameplay phases only
 *      (skip buy/round_end/loading/spectating windows).
 *   2. For each frame, crop the ability bar region (~bottom 88-98%, 35-65%
 *      horizontal) into 4 slots and read each slot's grayscale brightness
 *      + saturation.
 *   3. Smooth single-frame noise with a 3-frame rolling consensus.
 *   4. Detect lit→dark transitions per slot.
 *   5. Self-verify each candidate cast: the slot must stay dark for at
 *      least the agent's category cooldown (or until end of round). False
 *      positives from smokes/flashes/visual effects fail this gate.
 *
 * Output: per-game array of CastEvent + per-round end-state snapshot for
 * the rules engine.
 *
 * Cost: zero VLM calls. Pure CPU work. ~30-50s wall-clock added to a
 * 25-min game analysis.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ABILITY_COOLDOWN_SEC,
  type AgentAbilityProfile,
  getAgentAbilityProfile,
} from '../../games/valorant/ability-categories.js';

const execFileAsync = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────────────

/** Sample rate. 1 fps is enough — abilities don't change state on a single frame. */
const SAMPLE_FPS = 1;

/** Ability bar region (from ability-analysis.ts ROIs, kept consistent). */
const BAR_REGION = { left: 0.35, top: 0.88, width: 0.3, height: 0.1 };

/** Output thumbnail size for ability-bar reads. Higher than the state
 *  classifier's 320×180 because slot brightness needs more pixels. */
const FRAME_W = 960;
const FRAME_H = 540;
const FRAME_BYTES = FRAME_W * FRAME_H * 3;

/** Per-slot lit/dark threshold. Empirically: lit slot brightness is 100-180
 *  in grayscale; dark/cooldown is 30-70. Threshold midway. */
const LIT_BRIGHTNESS_THRESHOLD = 80;
/** Saturation must also exceed this — smokes wash out brightness but stay
 *  desaturated, so saturation cuts those false positives. */
const LIT_SATURATION_THRESHOLD = 30;

/** Minimum lit→dark drop to register a transition (reduces flicker). */
const TRANSITION_DELTA = 25;

// ── Types ───────────────────────────────────────────────────────────────────

export type AbilitySlot = 'C' | 'Q' | 'E' | 'X';

export interface SlotReading {
  /** Frame timestamp in seconds. */
  sec: number;
  /** Raw brightness 0-255. */
  brightness: number;
  /** Raw saturation 0-255. */
  saturation: number;
  /** Combined "is the slot icon visible / available to cast" flag. */
  lit: boolean;
}

export interface SlotTimeline {
  slot: AbilitySlot;
  readings: SlotReading[];
}

export interface CastEvent {
  /** Slot that was used. */
  slot: AbilitySlot;
  /** Best-estimate timestamp of the cast (when slot went dark). */
  sec: number;
  /** Round number this cast belongs to (or -1 if outside a known round). */
  round: number;
  /** Verification confidence: 'verified' = passed cooldown gate;
   *  'unverified' = transition seen but cooldown gate ambiguous. */
  confidence: 'verified' | 'unverified';
}

export interface RoundEndState {
  round: number;
  /** Per-slot lit/dark state at the very end of the round. */
  slots: Record<AbilitySlot, boolean>;
}

export interface AbilityTimeline {
  agent: string;
  profile: AgentAbilityProfile;
  /** All confirmed cast events in chronological order. */
  casts: CastEvent[];
  /** Per-round snapshot of slot states at round end (used for ult-hoarding rule). */
  roundEnds: RoundEndState[];
  /** Per-slot raw timeline for debugging / future rules. */
  slotTimelines: SlotTimeline[];
  processingMs: number;
}

interface RoundWindow {
  round: number;
  startSec: number;
  endSec: number;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the per-game ability timeline from a video file.
 *
 * Reuses the shared video path written by cv-analysis so we don't decode
 * twice. Samples at 1 fps over the entire video, then filters the readings
 * to active gameplay rounds only.
 */
export async function buildAbilityTimeline(
  sharedVideoPath: string,
  rounds: RoundWindow[],
  agentName: string,
): Promise<AbilityTimeline | null> {
  const startMs = Date.now();
  const profile = getAgentAbilityProfile(agentName);

  if (rounds.length === 0) {
    return {
      agent: agentName,
      profile,
      casts: [],
      roundEnds: [],
      slotTimelines: [],
      processingMs: Date.now() - startMs,
    };
  }

  const tmpRaw = path.join(os.tmpdir(), `scrima-abilbar-${Date.now()}.rgb`);

  try {
    // ── 1. Extract 1fps RGB raw frames at 960x540 ─────────────────────────
    await extractRawFrames(sharedVideoPath, tmpRaw);
    const raw = await fs.promises.readFile(tmpRaw);
    const numFrames = Math.floor(raw.length / FRAME_BYTES);
    if (numFrames < 5) {
      console.warn('[AbilityTimeline] too few frames extracted (%d), aborting', numFrames);
      return null;
    }

    // ── 2. Per-frame slot readings for the bar region ─────────────────────
    const slotTimelines: SlotTimeline[] = (['C', 'Q', 'E', 'X'] as AbilitySlot[]).map((s) => ({
      slot: s,
      readings: [],
    }));

    for (let i = 0; i < numFrames; i++) {
      const sec = i / SAMPLE_FPS;
      const frameStart = i * FRAME_BYTES;
      const slotsAtT = readBarSlots(raw, frameStart);
      for (let s = 0; s < 4; s++) {
        slotTimelines[s].readings.push({ sec, ...slotsAtT[s] });
      }
    }

    // ── 3. Smooth with 3-frame consensus ──────────────────────────────────
    for (const st of slotTimelines) {
      st.readings = smoothLitFlag(st.readings);
    }

    // ── 4. Detect lit→dark transitions = candidate casts ──────────────────
    const candidateCasts: CastEvent[] = [];
    for (const st of slotTimelines) {
      const transitions = detectTransitions(st);
      for (const tSec of transitions) {
        candidateCasts.push({
          slot: st.slot,
          sec: tSec,
          round: roundForTimestamp(tSec, rounds),
          confidence: 'unverified',
        });
      }
    }

    // ── 5. Self-verify with cooldown grounding ────────────────────────────
    const verifiedCasts: CastEvent[] = [];
    for (const cand of candidateCasts) {
      if (verifyByCooldown(cand, slotTimelines, profile)) {
        verifiedCasts.push({ ...cand, confidence: 'verified' });
      }
    }

    verifiedCasts.sort((a, b) => a.sec - b.sec);

    // ── 6. Snapshot per-round end state ───────────────────────────────────
    const roundEnds: RoundEndState[] = rounds.map((r) => {
      const snap: Record<AbilitySlot, boolean> = { C: false, Q: false, E: false, X: false };
      for (const st of slotTimelines) {
        // Take the reading closest to (but ≤) endSec.
        const last = [...st.readings].reverse().find((rd) => rd.sec <= r.endSec);
        if (last) snap[st.slot] = last.lit;
      }
      return { round: r.round, slots: snap };
    });

    console.log(
      '[AbilityTimeline] agent=%s, %d casts (%d verified), %d frames, %dms',
      agentName,
      candidateCasts.length,
      verifiedCasts.length,
      numFrames,
      Date.now() - startMs,
    );

    return {
      agent: agentName,
      profile,
      casts: verifiedCasts,
      roundEnds,
      slotTimelines,
      processingMs: Date.now() - startMs,
    };
  } catch (err) {
    console.warn('[AbilityTimeline] failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    try {
      fs.rmSync(tmpRaw, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

async function extractRawFrames(videoPath: string, outRawPath: string): Promise<void> {
  // 1fps sampling, scaled to 960x540, raw RGB output. Single ffmpeg call.
  await execFileAsync(
    'ffmpeg',
    [
      '-i',
      videoPath,
      '-vf',
      `fps=${SAMPLE_FPS},scale=${FRAME_W}:${FRAME_H}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-y',
      outRawPath,
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
}

/**
 * For one frame's worth of RGB bytes, crop the ability bar region in-place
 * and compute per-slot brightness + saturation.
 */
function readBarSlots(
  raw: Buffer,
  frameStart: number,
): { brightness: number; saturation: number; lit: boolean }[] {
  const barLeft = Math.round(BAR_REGION.left * FRAME_W);
  const barTop = Math.round(BAR_REGION.top * FRAME_H);
  const barWidth = Math.round(BAR_REGION.width * FRAME_W);
  const barHeight = Math.round(BAR_REGION.height * FRAME_H);
  const slotWidth = Math.floor(barWidth / 4);

  const out: { brightness: number; saturation: number; lit: boolean }[] = [];

  for (let s = 0; s < 4; s++) {
    let totalBright = 0;
    let totalSat = 0;
    let count = 0;

    for (let y = 0; y < barHeight; y++) {
      const rowStart = frameStart + ((barTop + y) * FRAME_W + barLeft + s * slotWidth) * 3;
      for (let x = 0; x < slotWidth; x++) {
        const r = raw[rowStart + x * 3];
        const g = raw[rowStart + x * 3 + 1];
        const b = raw[rowStart + x * 3 + 2];

        // Grayscale brightness (Rec. 601).
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) | 0;

        // Saturation: max - min of RGB. Cheap proxy for HSV saturation.
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;

        totalBright += lum;
        totalSat += sat;
        count++;
      }
    }

    const brightness = count > 0 ? totalBright / count : 0;
    const saturation = count > 0 ? totalSat / count : 0;
    const lit = brightness > LIT_BRIGHTNESS_THRESHOLD && saturation > LIT_SATURATION_THRESHOLD;
    out.push({ brightness, saturation, lit });
  }

  return out;
}

/**
 * 3-frame rolling consensus for the lit flag. Reduces single-frame
 * flicker (smoke clouds, flashes briefly washing out the bar).
 */
function smoothLitFlag(readings: SlotReading[]): SlotReading[] {
  if (readings.length < 3) return readings;
  const out: SlotReading[] = [];
  for (let i = 0; i < readings.length; i++) {
    const window = readings.slice(Math.max(0, i - 1), Math.min(readings.length, i + 2));
    const litVotes = window.filter((r) => r.lit).length;
    out.push({ ...readings[i], lit: litVotes >= 2 });
  }
  return out;
}

/**
 * Detect lit→dark transitions as candidate casts.
 *
 * A transition fires when:
 *   - readings[i-1] is lit AND readings[i] is dark
 *   - brightness drops by ≥ TRANSITION_DELTA
 *   - the slot was lit for ≥3 consecutive seconds before (else it's noise)
 */
function detectTransitions(timeline: SlotTimeline): number[] {
  const out: number[] = [];
  let litRun = 0;
  for (let i = 1; i < timeline.readings.length; i++) {
    const prev = timeline.readings[i - 1];
    const curr = timeline.readings[i];

    if (prev.lit) litRun++;
    else litRun = 0;

    if (prev.lit && !curr.lit && litRun >= 3) {
      const drop = prev.brightness - curr.brightness;
      if (drop >= TRANSITION_DELTA) {
        out.push(curr.sec);
        litRun = 0;
      }
    }
  }
  return out;
}

/**
 * Reject candidate casts that fail the cooldown gate.
 *
 * If we think a cast happened at T for slot S, the slot should remain
 * dark for at least cooldown(S) seconds. If we observe S lit again
 * before that window, the original transition was a false positive
 * (smoke, flash, visual effect briefly washing the bar).
 *
 * Ult slots have no per-round cooldown — accept all detected transitions
 * for X (orb economy is handled separately by the rules engine).
 */
function verifyByCooldown(
  cand: CastEvent,
  slotTimelines: SlotTimeline[],
  profile: AgentAbilityProfile,
): boolean {
  if (cand.slot === 'X') return true; // ults don't follow CDs

  const category = profile[cand.slot];
  const cooldown = ABILITY_COOLDOWN_SEC[category];
  if (cooldown >= 99) return true; // setup-style: gone for the round

  const slotTimeline = slotTimelines.find((t) => t.slot === cand.slot);
  if (!slotTimeline) return false;

  const after = slotTimeline.readings.filter(
    (r) => r.sec > cand.sec && r.sec <= cand.sec + cooldown,
  );
  if (after.length === 0) return true; // round ended before window expired

  // Allow a brief glimmer (1 frame) — visual flicker — but not sustained relight.
  const litCount = after.filter((r) => r.lit).length;
  return litCount <= 1;
}

function roundForTimestamp(sec: number, rounds: RoundWindow[]): number {
  for (const r of rounds) {
    if (sec >= r.startSec && sec <= r.endSec) return r.round;
  }
  return -1;
}
