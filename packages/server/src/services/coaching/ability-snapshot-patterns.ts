/**
 * Snapshot-based ability patterns (v2-pipeline analogue of X3/X4)
 *
 * The X3/X4 detectors live in `ability-anti-patterns.ts` and
 * `ability-positive-patterns.ts` and operate on a per-second cast timeline
 * built by `ability-timeline.service.ts` from the original video.
 *
 * The v2 pipeline (`frame-analysis.service.ts`) doesn't have access to the
 * raw video — it processes already-extracted death frames sent by the
 * client. What it DOES have is per-death snapshots:
 *   `abilityStatus: { C, Q, E, X: 'LIT' | 'DIMMED' | 'UNREADABLE' }`
 *
 * This module derives a useful subset of X3/X4 from those snapshots alone.
 * We can detect "what was ready at the moment of death" but NOT "when was
 * it cast during the round" — fewer rules, but the high-impact ones still
 * work.
 *
 * Output shape is intentionally identical to X3/X4 so the existing
 * observation-extraction pipeline (`observation.service.ts`) consumes
 * them without changes — `abilityFindings` flow as habits,
 * `abilityWins` as strengths.
 */

import { getAgentAbilityProfile } from '../../games/valorant/ability-categories.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Subset of the per-death record we need for snapshot rules. */
export interface SnapshotDeath {
  deathNumber: number;
  abilityStatus: { C: string; Q: string; E: string; X: string };
}

export interface SnapshotFinding {
  kind: string;
  text: string;
  habitKey: string;
  /** Numerator/denominator behind the claim, for transparency. */
  ratio: { numerator: number; denominator: number };
  /** -1 → cross-match (not tied to a single round), to match Finding shape. */
  round: number;
}

export interface SnapshotResult {
  antiPatterns: SnapshotFinding[]; // → habit observations
  positives: SnapshotFinding[]; // → strength observations
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Consistency threshold for both anti-patterns and positives. */
const CONSISTENCY_THRESHOLD = 0.6;
/** Minimum readable deaths required before we make any claims. */
const MIN_READABLE_DEATHS = 3;
/** Min times an ult was ready at death to fire `ult_unused_at_death`. */
const ULT_READY_AT_DEATH_THRESHOLD = 3;

// ── Public API ──────────────────────────────────────────────────────────────

export function detectSnapshotPatterns(deaths: SnapshotDeath[], agentName: string): SnapshotResult {
  if (deaths.length === 0) return { antiPatterns: [], positives: [] };
  const profile = getAgentAbilityProfile(agentName);

  const antiPatterns: SnapshotFinding[] = [];
  const positives: SnapshotFinding[] = [];

  // ── Aggregate per-slot states across deaths ─────────────────────────────
  // For each slot we count how many deaths had it LIT, DIMMED, or
  // UNREADABLE. Anti/positive rules consume these counts.
  const counts = countSlotStates(deaths);

  // ── Setup slots (sentinel/init/controller setup utility) ───────────────
  if (profile.setupSlots.length > 0) {
    const setup = aggregateSlots(counts, profile.setupSlots);
    if (setup.readable >= MIN_READABLE_DEATHS) {
      const litRatio = setup.lit / setup.readable;
      if (litRatio >= CONSISTENCY_THRESHOLD) {
        antiPatterns.push({
          kind: 'setup_unused_at_death',
          round: -1,
          habitKey: 'setup_unused',
          text: `Setup utility was ready at death in ${setup.lit} of ${setup.readable} readable deaths (${pct(litRatio)}). Setup ability isn't being deployed when it should be — costing the round before contact.`,
          ratio: { numerator: setup.lit, denominator: setup.readable },
        });
      } else if (setup.dimmed / setup.readable >= CONSISTENCY_THRESHOLD) {
        positives.push({
          kind: 'setup_used_consistently',
          round: -1,
          habitKey: 'setup_used',
          text: `Setup utility was already deployed before death in ${setup.dimmed} of ${setup.readable} readable deaths (${pct(setup.dimmed / setup.readable)}). Strong setup discipline.`,
          ratio: { numerator: setup.dimmed, denominator: setup.readable },
        });
      }
    }
  }

  // ── Info slots (flashes, recon, info tools) ─────────────────────────────
  if (profile.infoSlots.length > 0) {
    const info = aggregateSlots(counts, profile.infoSlots);
    if (info.readable >= MIN_READABLE_DEATHS) {
      const litRatio = info.lit / info.readable;
      if (litRatio >= CONSISTENCY_THRESHOLD) {
        antiPatterns.push({
          kind: 'info_unused_before_death',
          round: -1,
          habitKey: 'info_unused',
          text: `Info-tool was ready at death in ${info.lit} of ${info.readable} readable deaths (${pct(litRatio)}). Peeks happened without flashing or prepping the angle first.`,
          ratio: { numerator: info.lit, denominator: info.readable },
        });
      } else if (info.dimmed / info.readable >= CONSISTENCY_THRESHOLD) {
        positives.push({
          kind: 'info_used_before_engagement',
          round: -1,
          habitKey: 'info_used',
          text: `Info-tool was already used before death in ${info.dimmed} of ${info.readable} readable deaths (${pct(info.dimmed / info.readable)}). Good habit of prepping engagements.`,
          ratio: { numerator: info.dimmed, denominator: info.readable },
        });
      }
    }
  }

  // ── Ult slot (X) ────────────────────────────────────────────────────────
  const ult = counts.X;
  if (ult.readable >= MIN_READABLE_DEATHS) {
    if (ult.lit >= ULT_READY_AT_DEATH_THRESHOLD) {
      antiPatterns.push({
        kind: 'ult_unused_at_death',
        round: -1,
        habitKey: 'ult_unused_at_death',
        text: `Ult was ready at ${ult.lit} of ${ult.readable} readable deaths — ult is being held past the moments it could have flipped.`,
        ratio: { numerator: ult.lit, denominator: ult.readable },
      });
    } else if (ult.dimmed >= 1) {
      positives.push({
        kind: 'ult_used_actively',
        round: -1,
        habitKey: 'ult_active',
        text: `Ult was used at least once across the match — actively spending orb economy rather than hoarding.`,
        ratio: { numerator: ult.dimmed, denominator: ult.readable },
      });
    }
  }

  // ── Full-kit unused (all 4 slots ready at death across many deaths) ────
  // Strongest signal of "playing without using utility at all."
  let fullKitDeaths = 0;
  let readableForFullKit = 0;
  for (const d of deaths) {
    const slots = ['C', 'Q', 'E', 'X'] as const;
    const allReadable = slots.every((s) => d.abilityStatus[s] !== 'UNREADABLE');
    if (!allReadable) continue;
    readableForFullKit++;
    if (slots.every((s) => d.abilityStatus[s] === 'LIT')) fullKitDeaths++;
  }
  if (readableForFullKit >= MIN_READABLE_DEATHS && fullKitDeaths >= 3) {
    antiPatterns.push({
      kind: 'full_kit_unused',
      round: -1,
      habitKey: 'full_kit_unused',
      text: `Full kit (all 4 abilities) ready at ${fullKitDeaths} of ${readableForFullKit} readable deaths — utility wasn't part of the engagement at all in those rounds.`,
      ratio: { numerator: fullKitDeaths, denominator: readableForFullKit },
    });
  }

  return { antiPatterns, positives };
}

/**
 * Format snapshot findings into prompt blocks. Keeps the same surface
 * vocabulary as X3/X4 so synthesis prompts can reuse the same headings.
 */
export function formatSnapshotFindings(result: SnapshotResult): {
  antiPatternBlock: string;
  positiveBlock: string;
} {
  const antiPatternBlock =
    result.antiPatterns.length === 0
      ? ''
      : [
          'ABILITY USAGE — ANTI-PATTERN FLAGS (cross-death snapshots — only what consistently went wrong):',
          '',
          ...result.antiPatterns.map((f) => `• ${f.text}`),
          '',
          'Use these to inform priorityIssue / secondaryIssues when the issue is utility-related. They are aggregated across deaths — do not say "in round X" unless you have round-level facts. DO NOT narrate good ability use — the player only needs to hear what to fix.',
        ].join('\n');

  const positiveBlock =
    result.positives.length === 0
      ? ''
      : [
          'ABILITY USAGE — WHAT WORKED (consistent positive habits — keep these):',
          '',
          ...result.positives.map((f) => `✓ ${f.text}`),
          '',
          'Acknowledge these BRIEFLY in coaching — one short sentence each. Do NOT spend more than 1-2 sentences total on positives; the focus stays on improvement.',
        ].join('\n');

  return { antiPatternBlock, positiveBlock };
}

// ── Internals ───────────────────────────────────────────────────────────────

interface SlotStateCounts {
  lit: number;
  dimmed: number;
  unreadable: number;
  readable: number; // lit + dimmed
}

interface PerSlotCounts {
  C: SlotStateCounts;
  Q: SlotStateCounts;
  E: SlotStateCounts;
  X: SlotStateCounts;
}

function emptyCounts(): SlotStateCounts {
  return { lit: 0, dimmed: 0, unreadable: 0, readable: 0 };
}

function countSlotStates(deaths: SnapshotDeath[]): PerSlotCounts {
  const out: PerSlotCounts = {
    C: emptyCounts(),
    Q: emptyCounts(),
    E: emptyCounts(),
    X: emptyCounts(),
  };
  for (const d of deaths) {
    for (const slot of ['C', 'Q', 'E', 'X'] as const) {
      const v = d.abilityStatus?.[slot];
      if (v === 'LIT') {
        out[slot].lit++;
        out[slot].readable++;
      } else if (v === 'DIMMED') {
        out[slot].dimmed++;
        out[slot].readable++;
      } else {
        out[slot].unreadable++;
      }
    }
  }
  return out;
}

/** Aggregate counts across multiple slots (e.g. all setup slots for an agent). */
function aggregateSlots(counts: PerSlotCounts, slots: ('C' | 'Q' | 'E')[]): SlotStateCounts {
  const out = emptyCounts();
  for (const s of slots) {
    out.lit += counts[s].lit;
    out.dimmed += counts[s].dimmed;
    out.unreadable += counts[s].unreadable;
    out.readable += counts[s].readable;
  }
  return out;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
