/**
 * Ability Positive-Pattern Rules (X4 — paired with X3b anti-patterns)
 *
 * Mirrors the anti-pattern engine but flags WHAT WORKED. Same input shape,
 * same emit-only-when-notable philosophy — except positives gate on
 * cross-match consistency thresholds rather than per-round incidents.
 * Praise that fires every game becomes noise; praise that fires only on
 * a real consistent habit becomes coaching gold ("keep doing this").
 *
 * Three detectors in v1, each the inverse of an anti-pattern:
 *   1. setup_deployed_consistently — counterpart to setup_griefed
 *   2. intel_first                 — counterpart to pre_aim_no_intel
 *   3. ult_used_actively           — counterpart to ult_hoarded
 *
 * By construction these are MUTUALLY EXCLUSIVE with their anti-pattern
 * counterpart on the same behaviour, so the report never says contradictory
 * things in the same match.
 */

import type { CastEvent, AbilityTimeline, AbilitySlot } from './ability-timeline.service.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type PositiveKind = 'setup_deployed_consistently' | 'intel_first' | 'ult_used_actively';

export interface PositiveFinding {
  kind: PositiveKind;
  /** Human-readable cross-match claim — for prompt + UI. */
  text: string;
  /** Stable habit key for brain dedup (parallels anti-patterns). */
  habitKey: string;
  /** Numerator / denominator behind the claim — for transparency in UI. */
  ratio: { numerator: number; denominator: number };
}

interface RoundWindow {
  round: number;
  startSec: number;
  endSec: number;
  /** When the player died this round (or null if survived). */
  deathSec: number | null;
}

export interface PositiveRuleInputs {
  timeline: AbilityTimeline;
  rounds: RoundWindow[];
  /** Player kills timeline, same shape as anti-patterns expects. */
  playerKills: { sec: number; round: number }[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Consistency floor — a positive must hold across this fraction of applicable rounds to fire. */
const CONSISTENCY_THRESHOLD = 0.6;
/** Setup ability is "deployed in time" when cast within this many seconds of round start. */
const SETUP_DEPLOY_WINDOW_SEC = 10;
/** Info-tool is "before push" when cast within this many seconds of the death/engagement. */
const INTEL_LOOKBACK_SEC = 5;
/** Minimum applicable rounds for a positive to be statistically meaningful. */
const MIN_APPLICABLE_ROUNDS = 3;
/** Minimum total rounds before ult-used-actively can fire. */
const ULT_MIN_ROUNDS_IN_MATCH = 6;

// ── Public API ──────────────────────────────────────────────────────────────

export function detectPositivePatterns(inputs: PositiveRuleInputs): PositiveFinding[] {
  const findings: PositiveFinding[] = [];
  const setup = detectSetupDeployedConsistently(inputs);
  const intel = detectIntelFirst(inputs);
  const ult = detectUltUsedActively(inputs);
  if (setup) findings.push(setup);
  if (intel) findings.push(intel);
  if (ult) findings.push(ult);
  return findings;
}

/**
 * Format positives into the coaching-prompt "WHAT WORKED" block. Caller can
 * omit the block entirely when no findings (don't manufacture filler praise).
 */
export function formatPositiveFindings(findings: PositiveFinding[]): string {
  if (findings.length === 0) return '';
  const lines: string[] = [];
  lines.push('ABILITY USAGE — WHAT WORKED (consistent positive habits this match):');
  lines.push('');
  for (const f of findings) {
    lines.push(`✓ ${f.text}`);
  }
  lines.push('');
  lines.push(
    'Acknowledge these BRIEFLY in coaching — one short sentence each. The player should know what to keep doing. Do NOT spend more than 1-2 sentences total on positives; the focus stays on improvement.',
  );
  return lines.join('\n');
}

// ── Rule 1: setup_deployed_consistently ─────────────────────────────────────

function detectSetupDeployedConsistently({
  timeline,
  rounds,
}: PositiveRuleInputs): PositiveFinding | null {
  const setupSlots = timeline.profile.setupSlots;
  if (setupSlots.length === 0) return null;

  let applicableRounds = 0;
  let timelyDeployments = 0;

  for (const r of rounds) {
    // Find each setup slot's state at round start
    for (const slot of setupSlots) {
      const slotTimeline = timeline.slotTimelines.find((t) => t.slot === slot);
      if (!slotTimeline) continue;
      const startReading = slotTimeline.readings.find((rd) => rd.sec >= r.startSec);
      if (!startReading?.lit) continue; // not lit at round start = nothing to deploy

      applicableRounds++;
      // Was there a cast of this slot within the deploy window?
      const cast = timeline.casts.find(
        (c) =>
          c.round === r.round &&
          c.slot === slot &&
          c.sec >= r.startSec &&
          c.sec <= r.startSec + SETUP_DEPLOY_WINDOW_SEC,
      );
      if (cast) timelyDeployments++;
    }
  }

  if (applicableRounds < MIN_APPLICABLE_ROUNDS) return null;
  const ratio = timelyDeployments / applicableRounds;
  if (ratio < CONSISTENCY_THRESHOLD) return null;

  return {
    kind: 'setup_deployed_consistently',
    text: `Setup utility deployed in the first ${SETUP_DEPLOY_WINDOW_SEC}s of the round in ${timelyDeployments} of ${applicableRounds} applicable rounds (${Math.round(ratio * 100)}%). Strong setup discipline.`,
    habitKey: 'setup_consistency',
    ratio: { numerator: timelyDeployments, denominator: applicableRounds },
  };
}

// ── Rule 2: intel_first ─────────────────────────────────────────────────────

function detectIntelFirst({ timeline, rounds }: PositiveRuleInputs): PositiveFinding | null {
  const infoSlots = timeline.profile.infoSlots;
  if (infoSlots.length === 0) return null;

  let applicableRounds = 0;
  let intelBeforeDeath = 0;

  for (const r of rounds) {
    if (r.deathSec === null) continue;
    applicableRounds++;
    // Was an info-tool cast in the 5s before the death?
    const cast = timeline.casts.find(
      (c) =>
        c.round === r.round &&
        infoSlots.includes(c.slot as 'C' | 'Q' | 'E') &&
        c.sec <= r.deathSec! &&
        c.sec >= r.deathSec! - INTEL_LOOKBACK_SEC,
    );
    if (cast) intelBeforeDeath++;
  }

  if (applicableRounds < MIN_APPLICABLE_ROUNDS) return null;
  const ratio = intelBeforeDeath / applicableRounds;
  if (ratio < CONSISTENCY_THRESHOLD) return null;

  return {
    kind: 'intel_first',
    text: `Info-tool used in the ${INTEL_LOOKBACK_SEC}s before engagement on ${intelBeforeDeath} of ${applicableRounds} death rounds (${Math.round(ratio * 100)}%). Good habit of prepping the peek.`,
    habitKey: 'intel_first',
    ratio: { numerator: intelBeforeDeath, denominator: applicableRounds },
  };
}

// ── Rule 3: ult_used_actively ───────────────────────────────────────────────

/**
 * Inverse of ult_hoarded. Fires when the player cast their ult at least once
 * across the match — proves they don't sit on it.
 *
 * Avoid double-coaching: skip this detector if any of the recent rounds shows
 * the ult sitting lit at end (which would have triggered ult_hoarded).
 */
function detectUltUsedActively({ timeline, rounds }: PositiveRuleInputs): PositiveFinding | null {
  if (rounds.length < ULT_MIN_ROUNDS_IN_MATCH) return null;

  const ultCasts = timeline.casts.filter((c) => c.slot === 'X');
  if (ultCasts.length === 0) return null;

  // Mutual exclusion: if the trailing rounds show ult lit at end (the
  // hoarded shape), don't claim "used actively" — the anti-pattern owns it.
  const trailingHoard = timeline.roundEnds.slice(-3).every((re) => re.slots.X);
  if (trailingHoard) return null;

  return {
    kind: 'ult_used_actively',
    text: `Ult cast ${ultCasts.length}× across ${rounds.length} rounds — actively spending economy rather than hoarding it.`,
    habitKey: 'ult_active',
    ratio: { numerator: ultCasts.length, denominator: rounds.length },
  };
}
