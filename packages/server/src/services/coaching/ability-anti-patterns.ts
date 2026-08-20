/**
 * Ability Anti-Pattern Rules (X3b)
 *
 * Pure functions over (cast events, deaths, round windows, agent profile).
 * Returns human-readable findings for the coaching prompt's
 * "ABILITY USAGE NOTES" block. ONLY notable / bad usage is surfaced —
 * anything done correctly stays silent so the coach doesn't waste tokens
 * narrating wins.
 *
 * Rules (v1):
 *   1. setup_griefed       — setup ability still lit at first contact
 *   2. pre_aim_no_intel    — died <15s into round with NO ability used first
 *   3. spam_cast           — 2+ casts within 5s with no kill/death in next 10s
 *   4. ult_hoarded         — ult slot lit at end of ≥3 consecutive rounds
 *
 * Each rule produces a `Finding` (or none). The set of findings is
 * formatted into the prompt block by the caller.
 */

import type { AbilitySlot, AbilityTimeline } from './ability-timeline.service.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type AntiPatternKind = 'setup_griefed' | 'pre_aim_no_intel' | 'spam_cast' | 'ult_hoarded';

export interface Finding {
  kind: AntiPatternKind;
  round: number; // -1 for cross-round findings (e.g. ult hoarding)
  text: string; // human-readable line for the prompt
  /** Identifier used to bump observation occurrences in the brain. */
  habitKey: string;
}

interface RoundWindow {
  round: number;
  startSec: number;
  endSec: number;
  /** When the player died this round (or null if survived). */
  deathSec: number | null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const SPAM_WINDOW_SEC = 5; // ≥2 casts within this window
const SPAM_GRACE_SEC = 10; // and no kill/death within this many seconds after
const FIRST_CONTACT_GRACE_SEC = 15; // "early death" threshold for pre_aim_no_intel
const ULT_HOARD_MIN_RUN = 3; // consecutive rounds with X lit at end
const _SETUP_GRIEFED_SLOT_TYPES: ('C' | 'Q' | 'E')[] = ['C', 'Q', 'E'];

// ── Public API ──────────────────────────────────────────────────────────────

export interface RuleInputs {
  timeline: AbilityTimeline;
  rounds: RoundWindow[];
  /** Player kills timeline — used to anchor "no kill/death in window". */
  playerKills: { sec: number; round: number }[];
}

export function detectAntiPatterns(inputs: RuleInputs): Finding[] {
  const findings: Finding[] = [];
  findings.push(...detectSetupGriefed(inputs));
  findings.push(...detectPreAimNoIntel(inputs));
  findings.push(...detectSpamCast(inputs));
  findings.push(...detectUltHoarded(inputs));
  return findings;
}

/**
 * Format findings into the coaching-prompt ABILITY USAGE NOTES block.
 * Returns empty string if no findings — caller can omit the block entirely.
 */
export function formatFindings(findings: Finding[], totalRounds: number): string {
  if (findings.length === 0) return '';

  const perRound = findings.filter((f) => f.round > 0).sort((a, b) => a.round - b.round);
  const crossRound = findings.filter((f) => f.round === -1);

  const lines: string[] = [];
  lines.push('ABILITY USAGE NOTES (issues only — other rounds were fine):');
  lines.push('');
  for (const f of perRound) {
    lines.push(`• Round ${f.round}: ${f.text}`);
  }
  for (const f of crossRound) {
    lines.push(`• Cross-match: ${f.text}`);
  }
  lines.push('');
  lines.push(
    `(${perRound.length} of ${totalRounds} rounds had notable ability-usage issues. Other rounds: utility usage was acceptable — no need to narrate.)`,
  );
  return lines.join('\n');
}

// ── Rule 1: setup_griefed ───────────────────────────────────────────────────

/**
 * For agents with setup-style slots (Killjoy, Cypher, Sage walls, Viper), if
 * a setup slot is STILL LIT at the moment of first contact (player's first
 * death or first kill), the player griefed their setup duty.
 */
function detectSetupGriefed({ timeline, rounds, playerKills }: RuleInputs): Finding[] {
  const findings: Finding[] = [];
  const setupSlots = timeline.profile.setupSlots;
  if (setupSlots.length === 0) return findings;

  for (const r of rounds) {
    // First contact in the round = first death OR first kill (whichever earlier).
    const firstKill = playerKills.find((k) => k.round === r.round)?.sec ?? Number.POSITIVE_INFINITY;
    const firstContact = Math.min(r.deathSec ?? Number.POSITIVE_INFINITY, firstKill);
    if (!Number.isFinite(firstContact) || firstContact > r.endSec) continue;

    // Find the bar reading nearest to first contact.
    const stillLit: AbilitySlot[] = [];
    for (const slot of setupSlots) {
      const slotTimeline = timeline.slotTimelines.find((t) => t.slot === slot);
      if (!slotTimeline) continue;
      const reading = [...slotTimeline.readings].reverse().find((rd) => rd.sec <= firstContact);
      if (reading?.lit) stillLit.push(slot);
    }

    if (stillLit.length > 0) {
      const slotNames = stillLit.join(', ');
      findings.push({
        kind: 'setup_griefed',
        round: r.round,
        text: `Setup ability${stillLit.length > 1 ? 'ies' : ''} (${slotNames}) still on the bar at first contact. ${timeline.agent}'s setup utility must deploy in buy phase, not held mid-round.`,
        habitKey: 'setup_griefed',
      });
    }
  }
  return findings;
}

// ── Rule 2: pre_aim_no_intel ────────────────────────────────────────────────

/**
 * Player died early in the round with no info-tool used beforehand.
 * Suggests dry-peeking without preparation — the canonical entry mistake.
 */
function detectPreAimNoIntel({ timeline, rounds }: RuleInputs): Finding[] {
  const findings: Finding[] = [];
  const infoSlots = timeline.profile.infoSlots;
  if (infoSlots.length === 0) return findings; // agent has no info tools

  for (const r of rounds) {
    if (r.deathSec === null) continue;
    const elapsedAtDeath = r.deathSec - r.startSec;
    if (elapsedAtDeath > FIRST_CONTACT_GRACE_SEC) continue;

    const castsBeforeDeath = timeline.casts.filter(
      (c) =>
        c.round === r.round && c.sec < r.deathSec! && infoSlots.includes(c.slot as 'C' | 'Q' | 'E'),
    );
    if (castsBeforeDeath.length === 0) {
      findings.push({
        kind: 'pre_aim_no_intel',
        round: r.round,
        text: `Died ${Math.round(elapsedAtDeath)}s into the round with no info-tool used first. Entry duels start blind unless you flash, recon, or fake — pick one before peeking.`,
        habitKey: 'pre_aim_no_intel',
      });
    }
  }
  return findings;
}

// ── Rule 3: spam_cast ───────────────────────────────────────────────────────

/**
 * Two or more casts within SPAM_WINDOW_SEC, with no kill/death in the
 * SPAM_GRACE_SEC after — abilities burned without follow-through.
 */
function detectSpamCast({ timeline, rounds, playerKills }: RuleInputs): Finding[] {
  const findings: Finding[] = [];
  const seenRounds = new Set<number>();

  for (let i = 1; i < timeline.casts.length; i++) {
    const a = timeline.casts[i - 1];
    const b = timeline.casts[i];
    if (a.round !== b.round || a.round < 1) continue;
    if (b.sec - a.sec > SPAM_WINDOW_SEC) continue;
    if (seenRounds.has(a.round)) continue;

    const round = rounds.find((r) => r.round === a.round);
    if (!round) continue;

    const windowEnd = b.sec + SPAM_GRACE_SEC;
    const killInWindow = playerKills.some(
      (k) => k.round === a.round && k.sec >= a.sec && k.sec <= windowEnd,
    );
    const deathInWindow =
      round.deathSec !== null && round.deathSec >= a.sec && round.deathSec <= windowEnd;

    if (!killInWindow && !deathInWindow) {
      seenRounds.add(a.round);
      findings.push({
        kind: 'spam_cast',
        round: a.round,
        text: `Used ${a.slot} and ${b.slot} within ${(b.sec - a.sec).toFixed(0)}s, no fight in the next ${SPAM_GRACE_SEC}s — utility burned without commit.`,
        habitKey: 'utility_spam',
      });
    }
  }
  return findings;
}

// ── Rule 4: ult_hoarded ─────────────────────────────────────────────────────

/**
 * Ult slot lit at the end of N or more consecutive rounds. If the player
 * has the ult ready and never burns it across multiple rounds, the orb
 * economy is going to waste.
 */
function detectUltHoarded({ timeline }: RuleInputs): Finding[] {
  const findings: Finding[] = [];
  let run = 0;
  let runStart = -1;
  let runEnd = -1;

  for (const re of timeline.roundEnds) {
    if (re.slots.X) {
      if (run === 0) runStart = re.round;
      run++;
      runEnd = re.round;
    } else {
      if (run >= ULT_HOARD_MIN_RUN) {
        findings.push({
          kind: 'ult_hoarded',
          round: -1,
          text: `Ult ready and held for ${run} consecutive rounds (R${runStart}-R${runEnd}) without casting. Ult value decays the longer you hold it — earlier use trades better.`,
          habitKey: 'ult_hoarding',
        });
      }
      run = 0;
    }
  }
  if (run >= ULT_HOARD_MIN_RUN) {
    findings.push({
      kind: 'ult_hoarded',
      round: -1,
      text: `Ended the match with ult held for ${run} consecutive rounds (R${runStart}-R${runEnd}) without casting. That's wasted economy — push the ult earlier next time.`,
      habitKey: 'ult_hoarding',
    });
  }
  return findings;
}
