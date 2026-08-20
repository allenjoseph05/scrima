/**
 * Frame Analysis Service — New simplified pipeline for frame-based coaching.
 *
 * Replaces: cv-analysis + deep-analysis + fact-verification.
 *
 * The client extracts 1080p JPEG frames around each death and sends them
 * as base64. This service sends frames directly to Gemini Flash for
 * per-death analysis, then generates a coaching synthesis.
 *
 * No video storage, no ffmpeg, no ONNX classification on server.
 */

import { GoogleGenAI, MediaResolution } from '@google/genai';
import { AppError } from '@scrima/shared';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { coachingReports, matches } from '../../db/schema.js';
import {
  type AbilityCategory,
  getAgentAbilityProfile,
} from '../../games/valorant/ability-categories.js';
import {
  AGENTS,
  MAP_CALLOUTS,
  VALID_AGENTS,
  VALID_MAPS,
  VALID_WEAPONS,
} from '../../games/valorant/knowledge.js';
import { logger } from '../../shared/logger.js';
import {
  type SnapshotResult,
  detectSnapshotPatterns,
  formatSnapshotFindings,
} from './ability-snapshot-patterns.js';
import { BrainContextService } from './brain-context.service.js';

// ── Agent abilities — derived from knowledge.ts AGENTS so EVERY agent is
// covered (Miks, Clove, Waylay, Veto, Tejo, Vyse, KAY/O, etc.). Previously
// the analysis service had a hardcoded list of just 10 old agents, which
// meant any newer agent — like Miks — would fall into the "unknown abilities"
// branch and every per-death prompt would re-identify from frames (causing
// the "played 5 different agents" hallucination seen in reports).
//
// Format out: "C Name, Q Name, E Name, X Name" — matches what the prompt
// and the ability-slot validation expect.

/** Extract slot → ability-name from a knowledge.ts abilities string.
 *  Each line in the source looks like `C Leer (250cr): nearsight orb — ...`
 *  We take the first line starting with each C/Q/E/X letter.
 *  Returns a Record<slot, name> with ONLY the slots we could parse. */
function parseAbilitiesString(abilities: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of abilities.split('\n')) {
    const m = line.match(/^\s*([CQEX])\s+([A-Z][^\n(:]*?)\s*(?:\(|:|$)/);
    if (m && !(m[1] in out)) {
      out[m[1]] = m[2].trim();
    }
  }
  return out;
}

/** Build the "Name (C), Name (Q), ..." string used inside the per-death prompt. */
function formatAgentAbilities(agentKey: string): string | null {
  const info = AGENTS[agentKey.toLowerCase()];
  if (!info) return null;
  const slots = parseAbilitiesString(info.abilities);
  const parts: string[] = [];
  for (const slot of ['C', 'Q', 'E', 'X']) {
    if (slots[slot]) parts.push(`${slots[slot]} (${slot})`);
  }
  return parts.length >= 3 ? parts.join(', ') : null;
}

/** Get just the ordered [C, Q, E, X] ability-name list for cleanAbilities /
 *  derivedAvailable use. Returns empty list on unknown agent. */
function agentAbilityList(agentKey: string): string[] {
  const info = AGENTS[agentKey.toLowerCase()];
  if (!info) return [];
  const slots = parseAbilitiesString(info.abilities);
  return ['C', 'Q', 'E', 'X'].map((s) => slots[s]).filter((n): n is string => !!n);
}

/** Scrub ONLY player-identifying references to an agent that isn't the locked
 *  agent — leaves enemy references, teammate references, and comparisons alone.
 *
 *  Why this is narrow:
 *  The previous version replaced ANY occurrence of a non-locked agent name,
 *  which clobbered enemy-killer references like "the Viper held a static
 *  angle" → "the Miks held..." (grammatical nonsense). In a single death
 *  sentence, agent names can refer to:
 *    • the player (should scrub if it disagrees with the lock)
 *    • the enemy killer (MUST NOT scrub — these are the VLM's correct
 *      readings of the killfeed)
 *    • teammates you spectated (MUST NOT scrub — correct visual readings)
 *    • enemy team composition mentions
 *
 *  The ONLY unambiguous "player subject" patterns we can safely replace are:
 *    • `As <X>,` or `As <X>:`
 *    • `Playing <X>` / `playing <X>`
 *    • `as a <X>` / `as an <X>`
 *    • `<X>'s kit`  / `<X>'s abilities`
 *    • `your <X>` / `You as <X>`
 *  We deliberately DO NOT touch bare `<X>` or `the <X>` — those are almost
 *  always enemy/teammate references in this corpus.
 *
 *  Returns the scrubbed text plus the list of agents we substituted, so the
 *  caller can log how often the VLM drifted despite systemInstruction. */
function scrubAgentNames(
  text: string,
  lockedAgent: string | null,
): {
  scrubbed: string;
  hits: string[];
} {
  if (!text || !lockedAgent) return { scrubbed: text, hits: [] };
  const others = VALID_AGENTS.filter((a) => a.toLowerCase() !== lockedAgent.toLowerCase());
  const hits: string[] = [];
  let out = text;

  for (const other of others) {
    const esc = other.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    // Build ONE alternation of player-subject patterns. Using capture groups
    // so we can preserve whatever prefix matched and just substitute the name.
    // Patterns covered (case-insensitive), each anchored by context:
    //   "As Iso,"          → "As Miks,"
    //   "As Iso "          → "As Miks "
    //   "Playing Iso"      → "Playing Miks"
    //   "playing Iso"      → "playing Miks"
    //   "as a Iso"         → "as a Miks"
    //   "as an Iso"        → "as an Miks"
    //   "Your Iso"         → "Your Miks"
    //   "your Iso"         → "your Miks"
    //   "You as Iso"       → "You as Miks"
    //   "Iso's kit"        → "Miks's kit"
    //   "Iso's abilities"  → "Miks's abilities"
    //   "Iso's utility"    → "Miks's utility"
    //   "Iso's playstyle"  → "Miks's playstyle"
    const playerPatterns = [
      // "As X" / "as X" when followed by comma / colon / whitespace (subject)
      new RegExp(`(\\bAs\\s+)${esc}(?=[,:\\s])`, 'g'),
      new RegExp(`(\\bas\\s+(?:a|an)\\s+)${esc}\\b`, 'g'),
      // "Playing X"
      new RegExp(`(\\b[Pp]laying\\s+)${esc}\\b`, 'g'),
      // "Your X" / "your X" (possessive addressed to player)
      new RegExp(`(\\b[Yy]our\\s+)${esc}\\b`, 'g'),
      // "You as X"
      new RegExp(`(\\bYou\\s+as\\s+)${esc}\\b`, 'g'),
      // "X's kit" / "X's abilities" / "X's utility" / "X's playstyle"
      new RegExp(`\\b${esc}(?='s\\s+(?:kit|abilities|utility|playstyle|ultimate|kit))`, 'g'),
    ];

    for (const re of playerPatterns) {
      if (re.test(out)) {
        hits.push(other);
        // Reset and substitute. Capture group 1 (if any) = preserved prefix.
        re.lastIndex = 0;
        out = out.replace(re, (_m, prefix = '') => `${prefix}${lockedAgent}`);
      }
    }
  }

  return { scrubbed: out, hits: [...new Set(hits)] };
}

/** Apply scrubAgentNames to a bundle of free-text fields on a parsed death
 *  result. Mutates the object in place. Logs the list of drift-hits per death
 *  so we can tell how often Gemma is ignoring the systemInstruction lock. */
function scrubDeathAgentDrift(parsed: any, lockedAgent: string | null, deathIndex: number): void {
  if (!lockedAgent) return;
  const fields = ['situation', 'mistake', 'improvement', 'correction'];
  const allHits: string[] = [];
  for (const f of fields) {
    if (typeof parsed[f] === 'string') {
      const { scrubbed, hits } = scrubAgentNames(parsed[f], lockedAgent);
      parsed[f] = scrubbed;
      allHits.push(...hits);
    }
  }
  if (allHits.length > 0) {
    const uniq = [...new Set(allHits)];
    logger.warn(
      { deathIndex, lockedAgent, drifts: uniq },
      'Scrubbed player-subject agent drift from death free-text (VLM ignored lock)',
    );
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnalyzeFramesInput {
  matchId: string;
  gameId: string;
  gameMode: string;
  durationMs: number;
  map: string;
  agent: string;
  rank: string;
  evidenceVersion?: number;
  deaths: Array<{
    timestampSec: number;
    frames: Array<{ offsetSec: number; base64Jpeg: string }>;
    /** Optional zoomed-in crop of the ability bar at the -1s frame.
     *  Dramatically improves Gemma's LIT/DIMMED reading — the ability icons
     *  are ~15px wide at full-frame HIGH resolution, which is under Gemma's
     *  legible threshold. A 512×256 crop of the bar gives 5-10× that size. */
    abilityBarCropBase64?: string;
    typedCrops?: {
      decisionAbilityBar?: string;
      decisionWeaponHud?: string;
      contactWeaponHud?: string;
      decisionMinimap?: string;
      decisionHpShield?: string;
      decisionCrosshair?: string;
      contactCrosshair?: string;
      deathKillfeed?: string;
      deathTopHud?: string;
    };
    fightPacket?: {
      version?: number;
      phaseFrames?: Array<{
        offsetSec: number;
        phase: string;
        role?: 'pre_outcome' | 'outcome';
      }>;
      focusCropRefs?: Array<{
        kind: string;
        phase: string;
        offsetSec: number;
        typedCropKey: string;
      }>;
    };
    localEvidence?: {
      candidateTimestampSec?: number;
      refinedTimestampSec?: number;
      decisionAnchorSec?: number;
      detectorFrameIndex?: number;
      detectorConfidence?: number;
      onsetConfidence?: number;
      refinementQuality?: 'high' | 'medium' | 'low' | 'fallback';
      lastAliveSec?: number | null;
      firstDeathSec?: number | null;
      postDeathDecisionFramesExcluded?: boolean;
    };
    /** Client-reported classifier confidence (softmax prob of death_screen)
     *  at the detected death frame. Used when >10 deaths are received — we
     *  prioritize high-confidence detections. Defaults to 0.5 when absent. */
    confidence?: number;
  }>;
  /** Legacy: single game-context frame. Kept for backwards compatibility. */
  gameContextFrame?: string;
  /** New: multiple game-context frames (buy phases, early rounds) for more
   *  robust agent/map identification via consensus vote. */
  gameContextFrames?: string[];
  roundCount: number;
  buyPhaseTimestamps: number[];
}

/**
 * Stage 1 output: PURE FACTS extracted from frames by Gemma. No coaching text.
 *
 * Every field is either a direct visual read or null/"unclear". Coaching text
 * (situation/mistake/improvement/correction/category) is generated by stage 2
 * from these facts — stage 1 leaves them as empty strings for the interface
 * contract but never populates them.
 *
 * The new observation fields (positionType, cover, movementState, peekType,
 * crosshairPlacement, engagementDistance, teammatesAlive, enemiesVisible,
 * utilityActive, hadPreInfo, mapLocation, decisionShield) are what stage 2
 * reasons over to produce coaching. Every one is enum-constrained so Gemma
 * cannot hallucinate free text.
 */
interface FightPhaseObservation {
  phase: string;
  finding: string;
  confidence: 'high' | 'medium' | 'low';
  evidenceFrame?: string;
}

interface SupportedFightProblem {
  problem: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

interface DeathAnalysis {
  deathIndex: number;
  death_number: number;
  timestampSec: number;
  /** Agent the VLM identified as the PLAYER for this death. When input.agent
   *  was known upfront this mirrors it; when unknown, per-death votes are
   *  aggregated into a match-level lock post-analysis. */
  playerAgent: string | null;
  killerAgent: string | null;
  killfeedMatchConfidence: string;
  /** Weapon the KILLER used — read from the icon between the two agent
   *  names in the top-right kill feed after death. */
  killerWeapon: string | null;
  /** Weapon the PLAYER was holding — read from the bottom-right HUD weapon
   *  slot at the decision-time frame. */
  playerWeapon: string | null;
  weaponAction: string | null;
  fireDiscipline: string | null;
  firstBulletThreat: string | null;
  /** Deprecated alias for killerWeapon — kept so existing UI/cache code
   *  continues to work without a migration. */
  weapon: string | null;
  wasHeadshot: boolean;
  /** HP before the engagement that killed the player (earliest pre-death frame). */
  decisionHP: number | null;
  /** Shield value at decision time. */
  decisionShield: number | null;
  /** HP right before death (latest pre-death frame) — after damage taken. */
  impactHP: number | null;
  /** Deprecated alias. Kept for downstream compatibility; equals decisionHP. */
  playerHP: number | null;
  /** Per-slot ability readiness at decision time. */
  abilityStatus?: { C?: string; Q?: string; E?: string; X?: string };
  abilitiesAvailable: string[];
  abilitiesUnused: string[];

  // ── Observation fields (new, enum-constrained) ───────────────────────────
  /** Position archetype at decision time. */
  positionType: string | null;
  /** Cover state. */
  cover: string | null;
  /** Movement at decision time. */
  movementState: string | null;
  /** How the player engaged / how they died while engaging. */
  peekType: string | null;
  /** Where the crosshair was relative to the expected angle. */
  crosshairPlacement: string | null;
  /** Rough distance of the engagement. */
  engagementDistance: string | null;
  /** Callout from the locked map's list, or null. */
  mapLocation: string | null;
  /** 0-4 teammates alive, or null if minimap unreadable. */
  teammatesAlive: number | null;
  /** 0-5 enemies visible on screen, or null if unreadable. */
  enemiesVisible: number | null;
  /** Utility effects visible in pre-death frames. */
  utilityActive: string[];
  utilityUsed: string[];
  utilityEffect: string | null;
  utilityEffectConfidence: string;
  /** True if the player had visible pre-info before the engagement. */
  hadPreInfo: boolean | null;
  /** Per-category self-reported confidence. */
  identityConfidence: string;
  stateConfidence: string;
  contextConfidence: string;

  // ── Coaching text fields (populated by STAGE 2 only; always "" from stage 1) ─
  situation: string;
  mistake: string;
  correction: string;
  improvement: string;
  /** Coaching category — assigned by stage 2. */
  category: string;
  /** Legacy overall confidence — kept for backwards compat. */
  confidence: string;
  /** Whether the death was avoidable — set by stage 2 from the facts. */
  avoidable?: boolean;
  /** Deterministic Valorant reasoning derived from verified facts. */
  tactical?: TacticalDeathRead;
  /** Client-side evidence metadata from the local frame pipeline. */
  localEvidence?: AnalyzeFramesInput['deaths'][number]['localEvidence'];
  /** Names of typed crops that were available for this death. */
  evidenceSources?: string[];
  /** V4 phase-by-phase fight read from pre-outcome evidence. */
  fightPhases?: FightPhaseObservation[];
  /** First visible coach pause point before the death result, if proven. */
  coachPausePoint?: string | null;
  /** Specific visible problems with evidence references. */
  supportedProblems?: SupportedFightProblem[];
  /** Claims the model was explicitly not allowed to make from the frames. */
  notProven?: string[];
  /** Which observation pipeline produced the facts. */
  observerVersion?: 'legacy' | 'fight-v4';
}

type TacticalCategory =
  | 'positioning'
  | 'crosshair'
  | 'utility'
  | 'economy'
  | 'movement'
  | 'game_sense'
  | 'peeking'
  | 'trading'
  | 'unclear';

interface TacticalFinding {
  code: string;
  category: TacticalCategory;
  severity: 1 | 2 | 3 | 4 | 5;
  title: string;
  evidence: string;
  rootCause: string;
  correction: string;
}

interface TacticalDeathRead {
  primary: TacticalFinding;
  findings: TacticalFinding[];
  avoidable: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

// ── Prompt builders (Gemma-tuned) ───────────────────────────────────────────

/** Assemble a rich systemInstruction for the per-death Gemma call.
 *
 *  The systemInstruction is where "teach the model the rules" material lives.
 *  Everything here is game-level static knowledge — cacheable across every
 *  death in the match — so we pack it heavily:
 *    • When the locked agent is known, inject THAT agent's role, expectation,
 *      abilities, and flags. Gives Gemma specific things to look for instead
 *      of generic "coach the player".
 *    • Always inject VALID_AGENTS / VALID_MAPS / VALID_WEAPONS allowlists.
 *      These ground identification for agents/maps/weapons added to the game
 *      AFTER Gemma's training cutoff (Miks, Waylay, Veto, Tejo, Corrode, etc.).
 *    • Always inject HUD element locations so Gemma knows where to look.
 *    • Inject map callouts when the map is confirmed; otherwise tell Gemma to
 *      describe position generically (never invent callouts).
 *
 *  We intentionally do NOT describe made-up UI elements (e.g. a big
 *  "ELIMINATED BY" overlay that Valorant does not actually show). Gemma is
 *  told what the kill feed format looks like — that's the real ground truth
 *  for kill attribution — and that after death the camera swings to the
 *  killcam / spectator view.
 */
function buildDeathSystemInstruction(context: AnalyzeFramesInput): string {
  const haveKnownAgent = context.agent && context.agent !== 'unknown';
  const agentKey = haveKnownAgent ? context.agent.toLowerCase() : null;
  const agentInfo = agentKey ? AGENTS[agentKey] : null;
  const haveAgentKnowledge = !!agentInfo;

  const mapKey = typeof context.map === 'string' ? context.map.toLowerCase().trim() : '';
  const haveKnownMap = mapKey && mapKey !== 'unknown';
  const mapCallouts = haveKnownMap ? (MAP_CALLOUTS[mapKey] ?? null) : null;

  const blocks: string[] = [];

  // ── Role: observation only ────────────────────────────────────────────────
  blocks.push(`You are a Valorant VISUAL OBSERVATION SYSTEM. Your ONLY job is to read pre-extracted still frames of a single death and output a strict JSON of FACTS.

You DO NOT coach. You DO NOT give opinions. You DO NOT describe mistakes or suggest improvements. A downstream coaching model reasons over your facts and produces the coaching narrative.

Your facts must be ACCURATE above everything else. NULLS ARE FREE; WRONG VALUES POISON COACHING. If a value is not clearly readable in the frames, the correct answer is null / "unclear" / "an enemy" — NEVER guess.`);

  // ── Input description ─────────────────────────────────────────────────────
  blocks.push(`═══ INPUT YOU RECEIVE ═══
• Up to 15 STILL FRAMES at 1080p, each labeled with its offset and, on V4 payloads, its fight phase (setup, approach, decision, contact, death confirm). Every frame is the player's own POV. There is NO killcam and NO spectating footage here — the pipeline already filtered those out.
• Optional typed HUD crops: ability bar, weapon HUD, minimap, HP/shield, killfeed, and top HUD. These crops are AUTHORITATIVE for their matching fields; if a full-frame read disagrees with a typed crop, the typed crop wins.
• Locked player agent and map (given in the user prompt, or "unknown"). If locked, do not override from the frames.

At 1080p stills EVERY HUD element is legible — HP digits, shield digits, ability charge bars, kill-feed text, weapon names, minimap icons. Do not refuse to read a value just because it "looks small"; check the frames carefully.`);

  // ── Agent lock ────────────────────────────────────────────────────────────
  if (haveKnownAgent && haveAgentKnowledge && agentInfo) {
    blocks.push(`═══ LOCKED PLAYER AGENT: ${context.agent} ═══
Role: ${agentInfo.role}
Abilities (in slot order C / Q / E / X):
${agentInfo.abilities}

HARD RULES:
• The player is ${context.agent} in every frame of this death.
• In the kill-feed entry that matches this death, the VICTIM is ${context.agent}. The OTHER name is the killer.
• Never report ${context.agent} as their own killer.
• abilityStatus keys are always C / Q / E / X (the slot letters), not ability names.`);
  } else if (haveKnownAgent) {
    blocks.push(`═══ LOCKED PLAYER AGENT: ${context.agent} ═══
The player is ${context.agent}. The kill-feed VICTIM is ${context.agent}; the OTHER name is the killer.`);
  } else {
    blocks.push(`═══ PLAYER AGENT: UNKNOWN ═══
Identify from the earliest pre-death frame: agent portrait at bottom-left + four ability icons at bottom-center. If you cannot confidently identify, set playerAgent to null. NEVER GUESS — a wrong lock corrupts every downstream read.`);
  }

  // ── HUD reading guide ─────────────────────────────────────────────────────
  blocks.push(`═══ HUD — WHERE TO READ EACH FIELD ═══
• TOP-LEFT: Minimap. Player icon (highlighted) + teammate icons. Use only when the map is confirmed.
• TOP-RIGHT: Kill feed. Each entry is formatted "[Killer agent] [weapon icon] [Victim agent]". A skull icon between the names = headshot. The entry at death-0s is the fresh ground truth for killerAgent, killerWeapon, wasHeadshot.
• BOTTOM-LEFT: Two large digits — HP (white) on the left, Shield (blue) on the right. Read them directly.
• BOTTOM-CENTER: Four ability icons in slot order C / Q / E / X.
   LIT   = full saturation, visible charge count, not greyed
   DIMMED = greyed out / desaturated, cooldown number visible, or empty charge bar
• BOTTOM-RIGHT: The currently-held weapon + ammo count.

Typed crops are stronger than full frames:
• decisionAbilityBar is authoritative for abilityStatus.
• decisionWeaponHud is authoritative for playerWeapon.
• decisionHpShield is authoritative for decisionHP / decisionShield.
• decisionMinimap is the best source for teammatesAlive and rough location.
• deathKillfeed is authoritative for killerAgent / killerWeapon / wasHeadshot.`);

  // ── Allowlists ────────────────────────────────────────────────────────────
  blocks.push(`═══ ALLOWLISTS — names MUST come from these lists ═══
Valid agents:  ${VALID_AGENTS.join(', ')}
Valid maps:    ${VALID_MAPS.join(', ')}
Valid weapons: ${VALID_WEAPONS.join(', ')}

If a name you'd write is not on its list, either:
  • For weapons, use a weapon CLASS: "sidearm", "rifle", "sniper", "smg", "shotgun", "heavy", "melee"
  • For killer agent, use "an enemy"
  • For any other name, use null / "unclear"
NEVER invent. Valorant has patched in new agents / maps / weapons since your training — trust the lists over your memory.`);

  // ── Map callouts ──────────────────────────────────────────────────────────
  if (mapCallouts) {
    blocks.push(`═══ MAP: ${context.map.toUpperCase()} — ALLOWED CALLOUTS ═══
${mapCallouts}
mapLocation MUST be either a callout from the list above OR null. If the minimap position does not clearly match one of these callouts, use null.`);
  } else {
    blocks.push(`═══ MAP IS NOT CONFIRMED ═══
Leave mapLocation as null. Do not invent map-specific callouts ("A long", "B short", "hookah", etc.).`);
  }

  // ── Enum vocabularies for observation fields ──────────────────────────────
  blocks.push(`═══ ENUM VOCABULARIES (use EXACTLY these strings) ═══
• positionType:        open | chokepoint | angle_hold | site_anchor | rotation | post_plant | mid | unclear
• cover:               exposed | partial | full | unclear
• movementState:       stationary | walking | running | counter_strafing | unclear
• peekType:            dry_swing | jiggle | shoulder | pre_aimed | hold | none | unclear
• crosshairPlacement:  head_level | above_head | below_head | scanning | unclear
• engagementDistance:  close | medium | long | unclear
• utilityActive items: smoke | flash | wall | poison | stun | trap | recon
• abilityStatus slots: LIT | DIMMED | UNREADABLE
• any *Confidence:     high | medium | low

Additional enums:
• weaponAction: ready | firing | reloading | switching_weapon | melee_out | ability_out | no_gun_ready | unknown
• fireDiscipline: tap | burst | spray | no_shot | unknown
• firstBulletThreat: on_head | on_body | off_target | unknown
• utilityEffect: proven_effective | proven_ineffective | used_effect_unknown | not_used | unknown

DEFINITIONS:
• peekType — how the player engaged:
   dry_swing  = fast wide peek with no utility used first
   jiggle     = peek + retreat without committing
   shoulder   = partial peek showing only the shoulder
   pre_aimed  = slow clear with crosshair pre-placed on the angle
   hold       = player was holding an angle and got peeked
   none       = no engagement (e.g. flanked, collateral, explosion)
• positionType — what the player's spatial role was:
   open         = out in the open with no cover
   chokepoint   = at a narrow passage
   angle_hold   = holding a pre-aimed angle
   site_anchor  = anchored on site in a fixed position
   rotation     = moving between sites / areas
   post_plant   = defending the planted spike
   mid          = contesting the mid area
• hadPreInfo — true if there is evidence the player knew an enemy was near BEFORE engaging:
   visible enemy silhouette in any pre-death frame (before the 0s frame), OR
   a very recent kill-feed entry showing a nearby teammate just died
   Otherwise false. If unreadable, null.`);

  // ── Output rules ──────────────────────────────────────────────────────────
  blocks.push(`═══ OUTPUT RULES ═══
1. Valid JSON only. No prose before or after. No markdown fences. No commentary.
2. Every factual field MUST come from a direct visual read. If not clearly readable, use null / "unclear" / "an enemy" — NEVER guess.
3. decisionHP must be ≥ impactHP. Damage cannot restore HP. If the earliest pre-death frame shows lower HP than a later pre-death frame, that's a misread — recheck.
4. Do NOT output situation, mistake, correction, improvement, or ANY coaching text. Those fields are downstream. Your job is facts only.
5. Use the exact enum strings listed above. Case-sensitive. Typos are treated as hallucinations and discarded.`);

  return blocks.join('\n\n');
}

// ── Stage 1.5: deterministic fact validation ───────────────────────────────
//
// Runs after each per-death Gemma call. Converts loosely-typed parsed JSON
// into a strictly-typed facts object with hard guarantees that prompting
// cannot deliver on its own:
//
//   • Every name field is allowlist-checked. Off-list → "an enemy" / class /
//     null. Gemma hallucinating "Vandal-Pro" or an invented agent name
//     cannot reach stage 2.
//   • HP monotonicity: decisionHP ≥ impactHP. If violated, both nulled and
//     logged as a temporal-inconsistency drift.
//   • Ability kit consistency: abilitiesAvailable is DERIVED from LIT slots
//     using the locked agent's ability list — the model cannot claim an
//     ability is available if that slot's icon was DIMMED.
//   • Map-callout membership: mapLocation must be in the locked map's
//     callouts. Off-list → null.
//   • Enum vocabularies: every observation field is coerced to a valid enum
//     value; invalid strings become "unclear" or null.
//   • Confidence gating: when a category's self-reported confidence is
//     "low", the fields in that category are nulled out — a low-confidence
//     read is worse than no read for downstream coaching.
//
// Every correction is logged so drift patterns are visible in production.

interface ValidatedDeathFacts {
  playerAgent: string | null;
  killerAgent: string | null;
  killerWeapon: string | null;
  playerWeapon: string | null;
  killfeedMatchConfidence: string;
  weaponAction: string | null;
  fireDiscipline: string | null;
  firstBulletThreat: string | null;
  wasHeadshot: boolean;
  decisionHP: number | null;
  decisionShield: number | null;
  impactHP: number | null;
  abilityStatus: { C: string; Q: string; E: string; X: string };
  abilitiesAvailable: string[];
  abilitiesUnused: string[];
  positionType: string | null;
  cover: string | null;
  movementState: string | null;
  peekType: string | null;
  crosshairPlacement: string | null;
  engagementDistance: string | null;
  mapLocation: string | null;
  teammatesAlive: number | null;
  enemiesVisible: number | null;
  utilityActive: string[];
  utilityUsed: string[];
  utilityEffect: string | null;
  utilityEffectConfidence: string;
  hadPreInfo: boolean | null;
  identityConfidence: string;
  stateConfidence: string;
  contextConfidence: string;
}

const WEAPON_CLASSES = ['sidearm', 'rifle', 'sniper', 'smg', 'shotgun', 'heavy', 'melee'];
const POSITION_ENUM = [
  'open',
  'chokepoint',
  'angle_hold',
  'site_anchor',
  'rotation',
  'post_plant',
  'mid',
  'unclear',
];
const COVER_ENUM = ['exposed', 'partial', 'full', 'unclear'];
const MOVEMENT_ENUM = ['stationary', 'walking', 'running', 'counter_strafing', 'unclear'];
const PEEK_ENUM = ['dry_swing', 'jiggle', 'shoulder', 'pre_aimed', 'hold', 'none', 'unclear'];
const CROSSHAIR_ENUM = ['head_level', 'above_head', 'below_head', 'scanning', 'unclear'];
const DISTANCE_ENUM = ['close', 'medium', 'long', 'unclear'];
const UTILITY_ENUM = ['smoke', 'flash', 'wall', 'poison', 'stun', 'trap', 'recon'];
const WEAPON_ACTION_ENUM = [
  'ready',
  'firing',
  'reloading',
  'switching_weapon',
  'melee_out',
  'ability_out',
  'no_gun_ready',
  'unknown',
];
const FIRE_DISCIPLINE_ENUM = ['tap', 'burst', 'spray', 'no_shot', 'unknown'];
const FIRST_BULLET_ENUM = ['on_head', 'on_body', 'off_target', 'unknown'];
const UTILITY_EFFECT_ENUM = [
  'proven_effective',
  'proven_ineffective',
  'used_effect_unknown',
  'not_used',
  'unknown',
];
const ABILITY_SLOT_ENUM = ['LIT', 'DIMMED', 'UNREADABLE'];
const CONFIDENCE_ENUM = ['high', 'medium', 'low'];

function coerceEnum(raw: unknown, allowed: string[], fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase();
  const match = allowed.find((a) => a.toLowerCase() === v);
  return match ?? fallback;
}

function coerceEnumOrNull(raw: unknown, allowed: string[]): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v || v === 'null' || v === 'unclear') return null;
  const match = allowed.find((a) => a.toLowerCase() === v);
  return match ?? null;
}

function coerceInt(raw: unknown, min: number, max: number): number | null {
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < min || i > max) return null;
  return i;
}

function canonicalizeKillerAgent(raw: unknown, lockedPlayer: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.toLowerCase() === 'null' || v.toLowerCase() === 'unclear') return null;
  if (v.toLowerCase() === 'an enemy' || v.toLowerCase() === 'enemy') return 'an enemy';
  // Exact allowlist match (case-insensitive)
  const match = VALID_AGENTS.find((a) => a.toLowerCase() === v.toLowerCase());
  if (!match) return 'an enemy'; // off-allowlist → generic (safer than null for coaching context)
  // Reject killer == player (misread)
  if (lockedPlayer && match.toLowerCase() === lockedPlayer.toLowerCase()) return 'an enemy';
  return match;
}

function canonicalizeWeapon(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (
    !v ||
    v.toLowerCase() === 'null' ||
    v.toLowerCase() === 'unclear' ||
    v.toLowerCase() === 'unknown'
  )
    return null;
  const lc = v.toLowerCase();
  // Exact weapon name (case-insensitive)
  const exact = VALID_WEAPONS.find((w) => w.toLowerCase() === lc);
  if (exact) return exact;
  // Weapon class fallback
  const cls = WEAPON_CLASSES.find((c) => c === lc);
  if (cls) return cls;
  // Try partial match against class keywords (handles "a rifle", "sidearm pistol", etc.)
  for (const c of WEAPON_CLASSES) {
    if (lc.includes(c)) return c;
  }
  // Off-list and no class match → null (stage 2 will describe as "unknown")
  return null;
}

function validateDeathFacts(
  parsed: any,
  context: AnalyzeFramesInput,
  index: number,
): ValidatedDeathFacts {
  const haveKnownAgent = !!(context.agent && context.agent !== 'unknown');
  const drifts: string[] = [];

  // ── Identity ─────────────────────────────────────────────────────────────
  let playerAgent: string | null;
  if (haveKnownAgent) {
    playerAgent = context.agent;
    // If the model claimed a different player agent, log it but override.
    const claimed = typeof parsed.playerAgent === 'string' ? parsed.playerAgent.trim() : '';
    if (
      claimed &&
      claimed.toLowerCase() !== context.agent.toLowerCase() &&
      claimed.toLowerCase() !== 'unknown'
    ) {
      drifts.push(`playerAgent_drift:${claimed}→${context.agent}`);
    }
  } else {
    const raw = typeof parsed.playerAgent === 'string' ? parsed.playerAgent.trim() : '';
    const match = VALID_AGENTS.find((a) => a.toLowerCase() === raw.toLowerCase());
    playerAgent = match ?? null;
  }

  const killerAgentRaw = parsed.killerAgent;
  let killerAgent = canonicalizeKillerAgent(killerAgentRaw, playerAgent);
  if (
    typeof killerAgentRaw === 'string' &&
    killerAgentRaw.trim() &&
    killerAgent !== killerAgentRaw.trim()
  ) {
    drifts.push(`killerAgent:${killerAgentRaw}→${killerAgent ?? 'null'}`);
  }

  const killerWeaponRaw = parsed.killerWeapon ?? parsed.weapon;
  let killerWeapon = canonicalizeWeapon(killerWeaponRaw);
  if (
    typeof killerWeaponRaw === 'string' &&
    killerWeaponRaw.trim() &&
    killerWeapon !== killerWeaponRaw.trim()
  ) {
    drifts.push(`killerWeapon:${killerWeaponRaw}→${killerWeapon ?? 'null'}`);
  }

  const playerWeaponRaw = parsed.playerWeapon;
  const playerWeapon = canonicalizeWeapon(playerWeaponRaw);
  if (
    typeof playerWeaponRaw === 'string' &&
    playerWeaponRaw.trim() &&
    playerWeapon !== playerWeaponRaw.trim()
  ) {
    drifts.push(`playerWeapon:${playerWeaponRaw}→${playerWeapon ?? 'null'}`);
  }

  const wasHeadshot = parsed.wasHeadshot === true;
  const killfeedMatchConfidence = coerceEnum(
    parsed.killfeedMatchConfidence,
    CONFIDENCE_ENUM,
    'medium',
  );
  if (killfeedMatchConfidence === 'low') {
    if (killerAgent || killerWeapon) drifts.push('killfeed_low_confidence:null_attribution');
    killerAgent = null;
    killerWeapon = null;
  }

  // ── HP / Shield with monotonicity check ──────────────────────────────────
  let decisionHP = coerceInt(parsed.decisionHP, 0, 100);
  let impactHP = coerceInt(parsed.impactHP, 0, 100);
  const decisionShield = coerceInt(parsed.decisionShield, 0, 100);

  // Fallback to legacy playerHP if model emitted the old schema
  if (decisionHP == null && typeof parsed.playerHP === 'number') {
    decisionHP = coerceInt(parsed.playerHP, 0, 100);
  }

  if (decisionHP != null && impactHP != null && impactHP > decisionHP) {
    drifts.push(`hp_monotonicity:decision=${decisionHP},impact=${impactHP}`);
    // When they disagree, trust the HIGHER value as decisionHP (HP cannot
    // increase) and null impactHP rather than lie with a fake-monotonic value.
    decisionHP = Math.max(decisionHP, impactHP);
    impactHP = null;
  }

  // ── Ability status per slot ──────────────────────────────────────────────
  const rawStatus = parsed.abilityStatus ?? {};
  const abilityStatus = {
    C: coerceEnum(rawStatus.C, ABILITY_SLOT_ENUM, 'UNREADABLE'),
    Q: coerceEnum(rawStatus.Q, ABILITY_SLOT_ENUM, 'UNREADABLE'),
    E: coerceEnum(rawStatus.E, ABILITY_SLOT_ENUM, 'UNREADABLE'),
    X: coerceEnum(rawStatus.X, ABILITY_SLOT_ENUM, 'UNREADABLE'),
  };

  // Derive abilitiesAvailable from LIT slots using the locked agent's kit.
  // This is the single source of truth — stage 1 never sees ability NAMES
  // from the model, only slot states. Unknown-agent case leaves the list
  // empty (stage 2 will coach around ability state words like "an ability"
  // rather than naming one).
  const agentAbilities = haveKnownAgent ? agentAbilityList(context.agent) : [];
  const abilitiesAvailable: string[] = [];
  const slotOrder: Array<'C' | 'Q' | 'E' | 'X'> = ['C', 'Q', 'E', 'X'];
  for (let i = 0; i < slotOrder.length; i++) {
    if (abilityStatus[slotOrder[i]] === 'LIT' && agentAbilities[i]) {
      abilitiesAvailable.push(agentAbilities[i]);
    }
  }
  // Player died shortly after decision time, so any LIT ability at decision
  // time is an ability that went unused relative to this death.
  const abilitiesUnused = [...abilitiesAvailable];

  // ── Observation enums ────────────────────────────────────────────────────
  const positionType = coerceEnumOrNull(parsed.positionType, POSITION_ENUM);
  const cover = coerceEnumOrNull(parsed.cover, COVER_ENUM);
  const movementState = coerceEnumOrNull(parsed.movementState, MOVEMENT_ENUM);
  const peekType = coerceEnumOrNull(parsed.peekType, PEEK_ENUM);
  const crosshairPlacement = coerceEnumOrNull(parsed.crosshairPlacement, CROSSHAIR_ENUM);
  const engagementDistance = coerceEnumOrNull(parsed.engagementDistance, DISTANCE_ENUM);
  const weaponAction = coerceEnumOrNull(parsed.weaponAction, WEAPON_ACTION_ENUM);
  const fireDiscipline = coerceEnumOrNull(parsed.fireDiscipline, FIRE_DISCIPLINE_ENUM);
  const firstBulletThreat = coerceEnumOrNull(parsed.firstBulletThreat, FIRST_BULLET_ENUM);

  // ── Map callout against locked map ───────────────────────────────────────
  const mapKey = typeof context.map === 'string' ? context.map.toLowerCase().trim() : '';
  const haveKnownMap = mapKey && mapKey !== 'unknown';
  const validCallouts = haveKnownMap ? (MAP_CALLOUTS[mapKey] ?? '') : '';
  let mapLocation: string | null = null;
  const rawCallout = typeof parsed.mapLocation === 'string' ? parsed.mapLocation.trim() : '';
  if (rawCallout && rawCallout.toLowerCase() !== 'null' && rawCallout.toLowerCase() !== 'unclear') {
    if (haveKnownMap && validCallouts) {
      // Callouts string is comma-separated inside parentheses, e.g.
      // "A site (A short, A lobby, A bath, ...)". Do a loose substring check.
      const haystack = validCallouts.toLowerCase();
      if (haystack.includes(rawCallout.toLowerCase())) {
        mapLocation = rawCallout;
      } else {
        drifts.push(`mapLocation_off_list:${rawCallout}`);
      }
    } else {
      drifts.push(`mapLocation_unknown_map:${rawCallout}`);
    }
  }

  // ── Counts ───────────────────────────────────────────────────────────────
  const teammatesAlive = coerceInt(parsed.teammatesAlive, 0, 4);
  const enemiesVisible = coerceInt(parsed.enemiesVisible, 0, 5);

  // ── Utility active (array of enum) ───────────────────────────────────────
  const utilityActive: string[] = Array.isArray(parsed.utilityActive)
    ? parsed.utilityActive
        .map((u: unknown) => coerceEnumOrNull(u, UTILITY_ENUM))
        .filter((u: string | null): u is string => u !== null)
    : [];
  const utilityUsed = sanitizeStringList(parsed.utilityUsed, 4, 60);
  const utilityEffect = coerceEnumOrNull(parsed.utilityEffect, UTILITY_EFFECT_ENUM);
  const utilityEffectConfidence = coerceEnum(
    parsed.utilityEffectConfidence,
    CONFIDENCE_ENUM,
    'medium',
  );

  // ── hadPreInfo (nullable bool) ───────────────────────────────────────────
  const hadPreInfo = parsed.hadPreInfo === true ? true : parsed.hadPreInfo === false ? false : null;

  // ── Confidence tags ──────────────────────────────────────────────────────
  const identityConfidence = coerceEnum(parsed.identityConfidence, CONFIDENCE_ENUM, 'medium');
  const stateConfidence = coerceEnum(parsed.stateConfidence, CONFIDENCE_ENUM, 'medium');
  const contextConfidence = coerceEnum(parsed.contextConfidence, CONFIDENCE_ENUM, 'medium');

  // Gate low-confidence category fields. A low-confidence observation is
  // worse than no observation — stage 2 would otherwise coach on noise.
  // Identity lock fields stay (playerAgent is from context; killerAgent
  // already falls back to "an enemy").
  const facts: ValidatedDeathFacts = {
    playerAgent,
    killerAgent,
    killerWeapon,
    playerWeapon,
    killfeedMatchConfidence,
    weaponAction: contextConfidence === 'low' ? null : weaponAction,
    fireDiscipline: contextConfidence === 'low' ? null : fireDiscipline,
    firstBulletThreat: contextConfidence === 'low' ? null : firstBulletThreat,
    wasHeadshot,
    decisionHP: stateConfidence === 'low' ? null : decisionHP,
    decisionShield: stateConfidence === 'low' ? null : decisionShield,
    impactHP: stateConfidence === 'low' ? null : impactHP,
    abilityStatus,
    abilitiesAvailable: stateConfidence === 'low' ? [] : abilitiesAvailable,
    abilitiesUnused: stateConfidence === 'low' ? [] : abilitiesUnused,
    positionType: contextConfidence === 'low' ? null : positionType,
    cover: contextConfidence === 'low' ? null : cover,
    movementState: contextConfidence === 'low' ? null : movementState,
    peekType: contextConfidence === 'low' ? null : peekType,
    crosshairPlacement: contextConfidence === 'low' ? null : crosshairPlacement,
    engagementDistance: contextConfidence === 'low' ? null : engagementDistance,
    mapLocation: contextConfidence === 'low' ? null : mapLocation,
    teammatesAlive: contextConfidence === 'low' ? null : teammatesAlive,
    enemiesVisible: contextConfidence === 'low' ? null : enemiesVisible,
    utilityActive: contextConfidence === 'low' ? [] : utilityActive,
    utilityUsed: contextConfidence === 'low' ? [] : utilityUsed,
    utilityEffect: contextConfidence === 'low' ? null : utilityEffect,
    utilityEffectConfidence,
    hadPreInfo: contextConfidence === 'low' ? null : hadPreInfo,
    identityConfidence,
    stateConfidence,
    contextConfidence,
  };

  if (drifts.length > 0) {
    logger.warn(
      { deathIndex: index, drifts, identityConfidence, stateConfidence, contextConfidence },
      'Stage 1.5 validation corrected Gemma drift',
    );
  }

  return facts;
}

function cleanShortText(raw: unknown, max = 220): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function sanitizeFightPhases(raw: unknown): FightPhaseObservation[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap((item): FightPhaseObservation[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const phase = cleanShortText(row.phase, 40);
    const finding = cleanShortText(row.finding, 220);
    if (!phase || !finding) return [];
    const confidence = coerceEnum(
      row.confidence,
      CONFIDENCE_ENUM,
      'medium',
    ) as FightPhaseObservation['confidence'];
    const evidenceFrame = cleanShortText(row.evidenceFrame ?? row.evidence_frame, 80) ?? undefined;
    return [{ phase, finding, confidence, evidenceFrame }];
  });
}

function sanitizeSupportedProblems(raw: unknown): SupportedFightProblem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).flatMap((item): SupportedFightProblem[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const problem = cleanShortText(row.problem, 180);
    const evidence = cleanShortText(row.evidence, 220);
    if (!problem || !evidence) return [];
    const confidence = coerceEnum(
      row.confidence,
      CONFIDENCE_ENUM,
      'medium',
    ) as SupportedFightProblem['confidence'];
    return [{ problem, evidence, confidence }];
  });
}

function sanitizeStringList(raw: unknown, maxItems = 6, maxLen = 160): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => cleanShortText(item, maxLen))
    .filter((item): item is string => !!item)
    .slice(0, maxItems);
}

// ── JSON extraction helper ──────────────────────────────────────────────────

/** Expected top-level keys in the per-death JSON response. If the returned
 *  object contains at least one of these, we treat it as the real payload.
 *  Extra aliases here are Gemma-variants we've observed in the wild — accept
 *  them so we don't throw away otherwise-valid analyses over key naming. */
// ── Tactical reasoning from validated facts ────────────────────────────────
//
// This layer converts verified visual facts into explicit Valorant diagnoses.
// It is intentionally deterministic: the model observes and writes, while code
// decides the core tactical label and evidence.

function joinEvidence(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join('; ');
}

type AvailableAbility = {
  slot: 'C' | 'Q' | 'E' | 'X';
  name: string;
  category: AbilityCategory;
};

function availableAbilityDetails(
  d: DeathAnalysis,
  agent: string | null | undefined,
): AvailableAbility[] {
  if (!agent || agent === 'unknown') return [];
  const names = agentAbilityList(agent);
  if (names.length === 0) return [];
  const profile = getAgentAbilityProfile(agent);
  const slots: Array<'C' | 'Q' | 'E' | 'X'> = ['C', 'Q', 'E', 'X'];
  return slots.flatMap((slot, i) => {
    if (d.abilityStatus?.[slot] !== 'LIT' || !names[i]) return [];
    return [{ slot, name: names[i], category: profile[slot] }];
  });
}

function isPostKillGatedAbility(a: AvailableAbility, agent: string | null | undefined): boolean {
  const key = (agent ?? '').toLowerCase();
  return key === 'reyna' && (a.slot === 'Q' || a.slot === 'E');
}

function isPreContactUtility(a: AvailableAbility, agent: string | null | undefined): boolean {
  if (isPostKillGatedAbility(a, agent)) return false;
  if (a.category === 'ult' || a.category === 'heal' || a.category === 'damage') return false;
  return a.category === 'info' || a.category === 'utility' || a.category === 'mobility';
}

function isPrepUtility(a: AvailableAbility): boolean {
  // This is the key expert-coach distinction:
  // - info/utility tools can prepare an angle or deny defender advantage
  // - mobility can prepare an entry/disengage for duelists
  // - setup is a pre-round/state problem, not "throw this before peeking"
  // - damage/heal/ult are not generic dry-swing fixes
  return a.category === 'info' || a.category === 'utility' || a.category === 'mobility';
}

function availableAbilityPhrase(abilities: AvailableAbility[]): string {
  if (abilities.length === 0) return 'available utility';
  const names = abilities.map((a) => a.name);
  if (names.length === 1) return names[0];
  return names.slice(0, 3).join(' / ');
}

function litSetupAbilities(d: DeathAnalysis, agent: string | null | undefined): AvailableAbility[] {
  return availableAbilityDetails(d, agent).filter((a) => a.category === 'setup');
}

function litUltAbilities(d: DeathAnalysis, agent: string | null | undefined): AvailableAbility[] {
  return availableAbilityDetails(d, agent).filter((a) => a.category === 'ult');
}

function buildFinding(
  code: string,
  category: TacticalCategory,
  severity: 1 | 2 | 3 | 4 | 5,
  title: string,
  evidence: string,
  rootCause: string,
  correction: string,
): TacticalFinding {
  return { code, category, severity, title, evidence, rootCause, correction };
}

function classifyTacticalDeath(d: DeathAnalysis, context: AnalyzeFramesInput): TacticalDeathRead {
  const findings: TacticalFinding[] = [];
  const evidence: string[] = [];
  const available = availableAbilityDetails(d, context.agent);
  const prepUtility = available.filter((a) => isPreContactUtility(a, context.agent));
  const setupUtility = litSetupAbilities(d, context.agent);
  const ultReady = litUltAbilities(d, context.agent);

  const confidence: TacticalDeathRead['confidence'] =
    d.contextConfidence === 'high' && d.stateConfidence !== 'low'
      ? 'high'
      : d.contextConfidence === 'low' || d.stateConfidence === 'low'
        ? 'low'
        : 'medium';

  const where = d.mapLocation
    ? `at ${d.mapLocation}`
    : d.positionType
      ? `from a ${d.positionType.replace(/_/g, ' ')} position`
      : null;
  const weapon = d.playerWeapon ? `with ${d.playerWeapon}` : null;
  const hp = d.decisionHP != null ? `${d.decisionHP} HP` : null;
  const baseEvidence = joinEvidence([where, weapon, hp]);
  if (baseEvidence) evidence.push(baseEvidence);

  if (d.weaponAction === 'reloading') {
    findings.push(
      buildFinding(
        'reload_during_contact',
        'game_sense',
        5,
        'Reload during contact',
        joinEvidence([
          'weapon_action=reloading',
          d.playerWeapon ? `player_weapon=${d.playerWeapon}` : null,
          d.enemiesVisible != null ? `enemies_visible=${d.enemiesVisible}` : null,
        ]),
        'You gave up gun readiness while the contact window was still dangerous.',
        'Delay the reload until you are behind cover or after the angle is cleared. If ammo is low in the open, either tuck first or hold the angle with the bullets you have.',
      ),
    );
  } else if (
    d.weaponAction === 'melee_out' ||
    d.weaponAction === 'switching_weapon' ||
    d.weaponAction === 'ability_out' ||
    d.weaponAction === 'no_gun_ready'
  ) {
    findings.push(
      buildFinding(
        'no_gun_ready_at_contact',
        'game_sense',
        5,
        'No gun ready at contact',
        joinEvidence([
          `weapon_action=${d.weaponAction}`,
          d.enemiesVisible != null ? `enemies_visible=${d.enemiesVisible}` : null,
        ]),
        'The fight started while your weapon state could not immediately punish the enemy.',
        'Do not expose to a live angle while swapping, holding melee, or pulling utility. Stage the action behind cover, then re-peek with the gun ready.',
      ),
    );
  }

  if (d.fireDiscipline === 'spray') {
    findings.push(
      buildFinding(
        'spray_discipline_breakdown',
        'crosshair',
        4,
        'Spray instead of reset',
        joinEvidence([
          'fire_discipline=spray',
          d.firstBulletThreat ? `first_bullet=${d.firstBulletThreat}` : null,
          d.playerWeapon ? `weapon=${d.playerWeapon}` : null,
        ]),
        'The duel became a recoil-control fight instead of a clean first-bullet fight.',
        'Fire a short burst, stop the spray when the first bullets miss, then strafe-reset before the next burst. With rifles/Guardian, do not drag the spray through a medium-range duel.',
      ),
    );
  }

  if (d.firstBulletThreat === 'off_target' || d.firstBulletThreat === 'on_body') {
    findings.push(
      buildFinding(
        'first_bullet_not_lethal',
        'crosshair',
        4,
        'First bullet did not threaten head',
        joinEvidence([
          `first_bullet=${d.firstBulletThreat}`,
          d.crosshairPlacement ? `crosshair=${d.crosshairPlacement}` : null,
        ]),
        'Your opening bullet did not force the enemy to respect an instant headshot.',
        'Pre-place the crosshair on the exact head line before exposure, then confirm with a tap or two-bullet burst instead of searching after the swing.',
      ),
    );
  }

  const usedPrepUtility = prepUtility.some((a) =>
    d.utilityUsed.some((u) => u.toLowerCase().includes(a.name.toLowerCase())),
  );

  if (d.utilityEffect === 'proven_ineffective' && d.utilityUsed.length > 0) {
    findings.push(
      buildFinding(
        'utility_used_but_ineffective',
        'utility',
        3,
        'Utility used but did not affect contact',
        joinEvidence([
          `utility_used=${d.utilityUsed.join(', ')}`,
          `utility_effect=${d.utilityEffect}`,
        ]),
        'The utility was spent, but the visible contact still gave the enemy a clean fight.',
        'Keep the ability advice specific: adjust timing or placement only when the frames prove the effect failed. Otherwise, review the clip for whether the enemy was actually blinded or displaced.',
      ),
    );
  }

  if (d.peekType === 'dry_swing' && prepUtility.length > 0 && !usedPrepUtility) {
    const ability = availableAbilityPhrase(prepUtility);
    findings.push(
      buildFinding(
        'dry_swing_with_utility_ready',
        'utility',
        3,
        'Dry swing with utility ready',
        joinEvidence([
          d.mapLocation ? `death happened at ${d.mapLocation}` : null,
          'peek=dry_swing',
          `ready prep utility=${ability}`,
          d.hadPreInfo === false ? 'no visible pre-info' : null,
        ]),
        'You committed to the fight before making the angle worse for the defender.',
        `Before committing to this kind of angle, spend ${ability} or shoulder/jiggle for contact first. The rule is: utility or info before the full swing.`,
      ),
    );
  } else if (d.peekType === 'dry_swing') {
    findings.push(
      buildFinding(
        'unprepared_dry_swing',
        'peeking',
        4,
        'Unprepared dry swing',
        joinEvidence([
          d.mapLocation ? `death happened at ${d.mapLocation}` : null,
          'peek=dry_swing',
          d.hadPreInfo === false ? 'no visible pre-info' : null,
        ]),
        'You turned the engagement into a raw reaction duel instead of lowering the defender advantage.',
        'Use a shoulder peek, jiggle, or teammate contact before the full swing. If nobody can trade, hold the angle instead of forcing it.',
      ),
    );
  }

  if (
    setupUtility.length > 0 &&
    (d.positionType === 'site_anchor' ||
      d.positionType === 'angle_hold' ||
      d.positionType === 'chokepoint') &&
    (!Array.isArray(d.utilityActive) || d.utilityActive.length === 0)
  ) {
    const ability = availableAbilityPhrase(setupUtility);
    findings.push(
      buildFinding(
        'setup_utility_still_ready_at_contact',
        'utility',
        4,
        'Setup utility still ready at contact',
        joinEvidence([
          `ready setup=${ability}`,
          d.positionType ? `position=${d.positionType}` : null,
          d.mapLocation ? `location=${d.mapLocation}` : null,
        ]),
        'Your setup value was still in your pocket when contact happened, so the fight started without your agent advantage already working.',
        `Place ${ability} before the contact timing, not during the fight. The goal is to make the enemy trigger your setup before they can freely swing you.`,
      ),
    );
  }

  if (ultReady.length > 0) {
    evidence.push(
      `ultimate ready: ${availableAbilityPhrase(ultReady)} (not treated as a default peek fix)`,
    );
  }

  if (d.crosshairPlacement === 'below_head' || d.crosshairPlacement === 'above_head') {
    findings.push(
      buildFinding(
        'crosshair_off_headline',
        'crosshair',
        4,
        'Crosshair off head line',
        joinEvidence([
          `crosshair=${d.crosshairPlacement}`,
          d.engagementDistance ? `distance=${d.engagementDistance}` : null,
        ]),
        'Your first bullet needed a correction before it could threaten a headshot.',
        'Pre-place the crosshair on the expected head line before exposing yourself. The peek should confirm the target, not search for it.',
      ),
    );
  }

  if (d.cover === 'exposed' && d.positionType !== 'post_plant') {
    findings.push(
      buildFinding(
        'exposed_fight',
        'positioning',
        4,
        'Fight taken away from cover',
        joinEvidence([
          'cover=exposed',
          d.positionType ? `position=${d.positionType}` : null,
          d.mapLocation ? `location=${d.mapLocation}` : null,
        ]),
        'You had no fast reset option after first contact, so the duel had to be won immediately.',
        'Take the same angle from partial cover, or clear it in slices so one missed shot does not leave you stranded in the open.',
      ),
    );
  }

  if (d.movementState === 'running') {
    findings.push(
      buildFinding(
        'running_engagement',
        'movement',
        3,
        'Movement before accuracy',
        joinEvidence(['movement=running', d.peekType ? `peek=${d.peekType}` : null]),
        'You were still moving during the engagement window, which weakens first-shot accuracy.',
        'Stop before the shot. Counter-strafe, fire the first accurate burst, then decide whether to recommit or reset.',
      ),
    );
  }

  if (
    d.hadPreInfo === false &&
    (d.positionType === 'chokepoint' || d.positionType === 'open' || d.positionType === 'mid')
  ) {
    findings.push(
      buildFinding(
        'first_contact_no_info',
        'game_sense',
        4,
        'Contact taken without information',
        joinEvidence([
          'had_pre_info=false',
          d.positionType ? `position=${d.positionType}` : null,
          d.enemiesVisible != null ? `enemies_visible=${d.enemiesVisible}` : null,
        ]),
        'You crossed into a contested space before confirming where the danger was.',
        'Before entering contested space, get one proof point: sound, teammate contact, a jiggle, or utility. If none exists, clear slower.',
      ),
    );
  }

  if (d.decisionHP != null && d.decisionHP <= 50) {
    findings.push(
      buildFinding(
        'low_hp_recommit',
        'game_sense',
        3,
        'Low HP fight commitment',
        joinEvidence([
          `decision_hp=${d.decisionHP}`,
          d.decisionShield != null ? `shield=${d.decisionShield}` : null,
        ]),
        'At low HP, even a body shot can end the round, so equal-looking duels are not equal.',
        'When under 50 HP, shift from first contact to trade support: hold crossfires, play off teammate contact, or force utility value instead of dry fighting.',
      ),
    );
  }

  if (findings.length === 0) {
    findings.push(
      buildFinding(
        'unclear_or_fair_duel',
        'unclear',
        1,
        'No clear tactical error from visible facts',
        joinEvidence([
          d.cover ? `cover=${d.cover}` : null,
          d.peekType ? `peek=${d.peekType}` : null,
          d.crosshairPlacement ? `crosshair=${d.crosshairPlacement}` : null,
          d.contextConfidence ? `context_confidence=${d.contextConfidence}` : null,
        ]),
        'The available frames do not prove a specific fixable mistake.',
        'Review the clip manually for audio, comms, and teammate context. Do not over-train this death unless it repeats elsewhere.',
      ),
    );
  }

  findings.sort((a, b) => b.severity - a.severity);
  const primary = findings[0];
  const avoidable = primary.severity >= 3 && primary.code !== 'unclear_or_fair_duel';

  return { primary, findings, avoidable, confidence, evidence };
}

function formatTacticalBrief(d: DeathAnalysis): string {
  const t = d.tactical;
  if (!t) return '';
  const lines = [
    `  tactical_primary: ${t.primary.title} (${t.primary.category}, severity=${t.primary.severity}, confidence=${t.confidence})`,
    `  tactical_evidence: ${t.primary.evidence || 'none'}`,
    `  tactical_root_cause: ${t.primary.rootCause}`,
    `  tactical_correction: ${t.primary.correction}`,
  ];
  const secondary = t.findings.slice(1, 3);
  if (secondary.length > 0) {
    lines.push(
      `  secondary_tactical_flags: ${secondary.map((f) => `${f.title} [${f.category}]`).join('; ')}`,
    );
  }
  return lines.join('\n');
}

function buildDeathEvidenceItems(d: DeathAnalysis): Array<{
  label: string;
  value: string;
  confidence: 'high' | 'medium' | 'low';
  source: string;
}> {
  const items: Array<{
    label: string;
    value: string;
    confidence: 'high' | 'medium' | 'low';
    source: string;
  }> = [];
  const stateConfidence = (d.stateConfidence as 'high' | 'medium' | 'low') || 'medium';
  const contextConfidence = (d.contextConfidence as 'high' | 'medium' | 'low') || 'medium';
  const identityConfidence = (d.identityConfidence as 'high' | 'medium' | 'low') || 'medium';

  if (d.localEvidence) {
    items.push({
      label: 'Death timing',
      value: `Refined from ${formatTime(d.localEvidence.candidateTimestampSec ?? d.timestampSec)} to ${formatTime(d.localEvidence.refinedTimestampSec ?? d.timestampSec)} (${d.localEvidence.refinementQuality ?? 'unknown'} onset).`,
      confidence:
        d.localEvidence.refinementQuality === 'high'
          ? 'high'
          : d.localEvidence.refinementQuality === 'fallback'
            ? 'low'
            : 'medium',
      source: 'local death-onset refiner',
    });
  }
  if (d.playerWeapon) {
    items.push({
      label: 'Player weapon',
      value: d.playerWeapon,
      confidence: stateConfidence,
      source: 'decision weapon HUD crop / frame',
    });
  }
  if (d.weaponAction || d.fireDiscipline || d.firstBulletThreat) {
    items.push({
      label: 'Weapon execution',
      value: [
        d.weaponAction ? `action=${d.weaponAction}` : null,
        d.fireDiscipline ? `fire=${d.fireDiscipline}` : null,
        d.firstBulletThreat ? `first_bullet=${d.firstBulletThreat}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
      confidence: contextConfidence,
      source: 'contact weapon HUD / center crop',
    });
  }
  if (d.killerWeapon || d.killerAgent) {
    items.push({
      label: 'Kill attribution',
      value: `${d.killerAgent ?? 'an enemy'}${d.killerWeapon ? ` with ${d.killerWeapon}` : ''}${d.wasHeadshot ? ' (headshot)' : ''}`,
      confidence: (d.killfeedMatchConfidence as 'high' | 'medium' | 'low') || identityConfidence,
      source: 'death killfeed crop / 0s frame',
    });
  }
  if (d.decisionHP != null) {
    items.push({
      label: 'Decision HP',
      value: `${d.decisionHP} HP${d.decisionShield != null ? ` / ${d.decisionShield} shield` : ''}`,
      confidence: stateConfidence,
      source: 'decision HP/shield crop / pre-death frames',
    });
  }
  if (d.abilityStatus) {
    items.push({
      label: 'Ability state',
      value: (['C', 'Q', 'E', 'X'] as const)
        .map((s) => `${s}:${d.abilityStatus?.[s] ?? 'UNREADABLE'}`)
        .join(' '),
      confidence: stateConfidence,
      source: 'decision ability-bar crop',
    });
  }
  if (d.tactical?.primary?.evidence) {
    items.push({
      label: 'Coach diagnosis evidence',
      value: d.tactical.primary.evidence,
      confidence: d.tactical.confidence,
      source: 'rule-derived validator hint',
    });
  }
  if (d.coachPausePoint) {
    items.push({
      label: 'Coach pause point',
      value: d.coachPausePoint,
      confidence: contextConfidence,
      source: d.observerVersion === 'fight-v4' ? 'V4 pre-outcome observer' : 'visual observer',
    });
  }
  if (Array.isArray(d.supportedProblems) && d.supportedProblems.length > 0) {
    for (const p of d.supportedProblems.slice(0, 3)) {
      items.push({
        label: 'Visible problem',
        value: `${p.problem} (${p.evidence})`,
        confidence: p.confidence,
        source: d.observerVersion === 'fight-v4' ? 'V4 fight packet' : 'visual observer',
      });
    }
  }
  if (d.evidenceSources && d.evidenceSources.length > 0) {
    items.push({
      label: 'Available source crops',
      value: d.evidenceSources.join(', '),
      confidence: 'high',
      source: 'client evidence payload',
    });
  }
  if (d.mapLocation || d.cover || d.peekType || d.crosshairPlacement) {
    items.push({
      label: 'Engagement read',
      value: [
        d.mapLocation ? `location=${d.mapLocation}` : null,
        d.cover ? `cover=${d.cover}` : null,
        d.peekType ? `peek=${d.peekType}` : null,
        d.crosshairPlacement ? `crosshair=${d.crosshairPlacement}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
      confidence: contextConfidence,
      source: 'pre-death frames / minimap crop',
    });
  }
  return items;
}

function buildDeathUnknowns(d: DeathAnalysis): string[] {
  const unknowns: string[] = [];
  if (!d.playerWeapon) unknowns.push('player weapon was not clearly readable');
  if (d.killfeedMatchConfidence === 'low')
    unknowns.push('player death row in killfeed was not clearly isolated');
  if (!d.killerWeapon) unknowns.push('killer weapon was not clearly readable');
  if (d.decisionHP == null) unknowns.push('decision HP/shield was not clearly readable');
  if (!d.mapLocation) unknowns.push('exact map callout was not proven');
  if (d.teammatesAlive == null) unknowns.push('teammate count/trade setup was not proven');
  if (
    !d.abilityStatus ||
    (['C', 'Q', 'E', 'X'] as const).some((s) => d.abilityStatus?.[s] === 'UNREADABLE')
  ) {
    unknowns.push('one or more ability slots were unreadable');
  }
  if (d.contextConfidence === 'low')
    unknowns.push('positioning/peek context had low visual confidence');
  if (d.stateConfidence === 'low') unknowns.push('HUD state had low visual confidence');
  if (!d.weaponAction) unknowns.push('weapon action during contact was not proven');
  if (!d.fireDiscipline) unknowns.push('tap/burst/spray pattern was not proven');
  if (
    d.utilityUsed.length > 0 &&
    (!d.utilityEffect || d.utilityEffect === 'used_effect_unknown' || d.utilityEffect === 'unknown')
  ) {
    unknowns.push('utility effect on the enemy was not proven');
  }
  if (Array.isArray(d.notProven)) unknowns.push(...d.notProven);
  return [...new Set(unknowns)];
}

function buildDeathTimeline(
  d: DeathAnalysis,
): Array<{ label: string; time: string; detail: string }> {
  const local = d.localEvidence;
  return [
    local?.decisionAnchorSec != null
      ? {
          label: 'Decision anchor',
          time: formatTime(local.decisionAnchorSec),
          detail: 'HUD/position/weapon/ability evidence is read from here first.',
        }
      : null,
    ...(Array.isArray(d.fightPhases)
      ? d.fightPhases.slice(0, 5).map((p) => ({
          label: p.phase.replace(/_/g, ' '),
          time: p.evidenceFrame ?? 'visual',
          detail: `${p.finding} (${p.confidence} confidence).`,
        }))
      : []),
    {
      label: 'Death onset',
      time: formatTime(d.timestampSec),
      detail: local?.postDeathDecisionFramesExcluded
        ? 'Post-death body/death-animation frames were excluded from decision reads.'
        : 'Death moment used for killfeed attribution.',
    },
  ].filter((x): x is { label: string; time: string; detail: string } => !!x);
}

function summarizeTacticalPatterns(deaths: DeathAnalysis[]): Array<{
  code: string;
  category: TacticalCategory;
  title: string;
  deathNumbers: number[];
  count: number;
  severity: number;
  evidence: string[];
  correction: string;
}> {
  const grouped = new Map<
    string,
    {
      code: string;
      category: TacticalCategory;
      title: string;
      deathNumbers: number[];
      severity: number;
      evidence: string[];
      correction: string;
    }
  >();

  for (const d of deaths) {
    const f = d.tactical?.primary;
    if (!f || f.code === 'unclear_or_fair_duel') continue;
    const row = grouped.get(f.code) ?? {
      code: f.code,
      category: f.category,
      title: f.title,
      deathNumbers: [],
      severity: f.severity,
      evidence: [],
      correction: f.correction,
    };
    row.deathNumbers.push(d.death_number);
    row.severity = Math.max(row.severity, f.severity);
    if (f.evidence) row.evidence.push(`death #${d.death_number}: ${f.evidence}`);
    grouped.set(f.code, row);
  }

  return [...grouped.values()]
    .map((p) => ({ ...p, count: p.deathNumbers.length }))
    .sort((a, b) => b.count * b.severity - a.count * a.severity);
}

const DEATH_JSON_KEYS = [
  'killerAgent',
  'weapon',
  'killerWeapon',
  'playerWeapon',
  'decisionHP',
  'impactHP',
  'playerHP',
  'abilityStatus',
  'abilitiesAvailable',
  'abilitiesUnused',
  'situation',
  'mistake',
  'improvement',
  // Gemma-variant keys we've seen in responses
  'correction',
  'reasoning',
  'category',
  'playerAgent',
  'avoidable',
  'wasHeadshot',
  'mapLocation',
  'phaseObservations',
  'supportedProblems',
  'coachPausePoint',
  'notProven',
];

/** Find the first balanced {...} block in `text` starting at `from` and return
 *  it, or null if the braces don't balance. Respects string literals (including
 *  escaped quotes) so stray braces inside strings don't trip the scanner. */
function findBalancedJson(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') isEscaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** Extract and parse the first JSON object from a model response that
 *  contains at least one known death-analysis key. Tolerates markdown fences,
 *  thinking text before the JSON, and field-order variations. Returns null
 *  on failure — caller decides whether to warn/throw. */
export function extractDeathJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip markdown fences (```json ... ``` or ``` ... ```)
  let text = raw;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1];

  // Walk every `{` in the text; try to parse the balanced block from there.
  // Accept the first one whose parsed object includes a known key.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const block = findBalancedJson(text, i);
    if (!block) continue;
    try {
      const parsed = JSON.parse(block);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (DEATH_JSON_KEYS.some((k) => k in obj)) return obj;
      }
    } catch {
      // Not valid JSON starting here; keep walking.
    }
  }
  return null;
}

// ── In-memory job tracking ──────────────────────────────────────────────────

export interface FrameAnalysisJobProgress {
  jobId: string;
  reportId: string;
  userId: string;
  matchId: string;
  status: 'processing' | 'completed' | 'failed';
  stage: 'analyzing' | 'retrying' | 'synthesizing' | 'saving';
  current: number;
  total: number;
  succeeded: number;
  failed: number;
  error?: string;
  startedAt: number;
}

export const frameAnalysisJobs = new Map<string, FrameAnalysisJobProgress>();

// Cleanup stale jobs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, job] of frameAnalysisJobs) {
    if (job.startedAt < cutoff) frameAnalysisJobs.delete(id);
  }
}, 1_800_000);

// ── Service ──────────────────────────────────────────────────────────────────

export class FrameAnalysisService {
  private ai: GoogleGenAI;
  private modelId: string;
  /**
   * Stash for the latest snapshot-pattern detection so it can flow from
   * generateCoaching() (where we have agent + deaths) up to
   * processAnalysisBackground() (where we attach to reportObj). Avoids
   * changing generateCoaching's string return type.
   */
  private _lastSnapshotResult: SnapshotResult | null = null;

  constructor() {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is required for frame analysis');
    }
    this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    // NOTE: historically the code comment said the default was Gemma (free),
    // but env.VLM_MODEL is set in .env to a paid Gemini model — check the
    // startup log below so the actual model used is unambiguous.
    this.modelId = env.VLM_MODEL;
    const isPaid = /^gemini-/i.test(this.modelId);
    logger.info(
      { model: this.modelId, paid: isPaid },
      isPaid
        ? `VLM: ${this.modelId} — PAID Gemini tier (per-call cost applies)`
        : `VLM: ${this.modelId} — free tier (no per-call cost)`,
    );
  }

  async startAnalysis(
    input: AnalyzeFramesInput,
    userId: string,
  ): Promise<{ jobId: string; reportId: string }> {
    const jobId = uuidv4();
    const reportId = uuidv4();

    const jobProgress: FrameAnalysisJobProgress = {
      jobId,
      reportId,
      userId,
      matchId: input.matchId,
      status: 'processing',
      stage: 'analyzing',
      current: 0,
      total: input.deaths.length,
      succeeded: 0,
      failed: 0,
      startedAt: Date.now(),
    };

    frameAnalysisJobs.set(jobId, jobProgress);

    // Fire-and-forget: process in background
    this.processAnalysisBackground(jobId, reportId, input, userId).catch((err) => {
      logger.error({ err, jobId, matchId: input.matchId }, 'Background frame analysis crashed');
      const job = frameAnalysisJobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = err?.message ?? 'Unknown error';
      }
    });

    return { jobId, reportId };
  }

  private async processAnalysisBackground(
    jobId: string,
    reportId: string,
    input: AnalyzeFramesInput,
    userId: string,
  ): Promise<void> {
    const startTime = Date.now();
    const job = () => frameAnalysisJobs.get(jobId);

    // 0a. Sanity-check any agent/map the client handed us. A match row's
    //     `agent` column may have been polluted by a PRE-FIX run that let
    //     identifyAgentAndMap store a hallucinated name (e.g. "Miks") — we
    //     reject anything not on the Valorant allowlist so downstream
    //     prompts can't be fed gibberish.
    const canonicalAgent = (name: string): string => {
      const lc = name.trim().toLowerCase();
      const match = VALID_AGENTS.find((v) => v.toLowerCase() === lc);
      return match ?? 'unknown';
    };
    const canonicalMap = (name: string): string => {
      const lc = name.trim().toLowerCase();
      const match = VALID_MAPS.find((v) => v.toLowerCase() === lc);
      return match ?? 'unknown';
    };
    const origAgent = input.agent;
    const origMap = input.map;
    input.agent = canonicalAgent(input.agent);
    input.map = canonicalMap(input.map);
    if (origAgent !== input.agent && origAgent !== 'unknown') {
      logger.warn(
        { origAgent, now: input.agent },
        'Rejected non-allowlist agent from request payload',
      );
    }
    if (origMap !== input.map && origMap !== 'unknown') {
      logger.warn({ origMap, now: input.map }, 'Rejected non-allowlist map from request payload');
    }

    // 0b. Identify agent/map if still unknown. Prefer multi-frame voting when
    //     the client sent multiple game-context frames (e.g. buy phases from
    //     rounds 1 and 2) — single-frame ID is unreliable.
    if (input.agent === 'unknown' || input.map === 'unknown') {
      const contextFrames: string[] = [];
      if (Array.isArray(input.gameContextFrames) && input.gameContextFrames.length > 0) {
        contextFrames.push(...input.gameContextFrames);
      } else if (input.gameContextFrame) {
        contextFrames.push(input.gameContextFrame);
      }

      if (contextFrames.length > 0) {
        const agentVotes = new Map<string, number>();
        const mapVotes = new Map<string, number>();
        for (const frame of contextFrames) {
          try {
            const r = await this.identifyAgentAndMap(frame);
            if (r.agent) agentVotes.set(r.agent, (agentVotes.get(r.agent) ?? 0) + 1);
            if (r.map) mapVotes.set(r.map, (mapVotes.get(r.map) ?? 0) + 1);
          } catch (err) {
            logger.warn({ err }, 'Context-frame identify call failed');
          }
        }
        const pickTop = (votes: Map<string, number>): string | null => {
          let best: string | null = null;
          let bestCount = 0;
          for (const [k, v] of votes) {
            if (v > bestCount) {
              best = k;
              bestCount = v;
            }
          }
          return best;
        };
        if (input.agent === 'unknown') {
          const agentWinner = pickTop(agentVotes);
          if (agentWinner) input.agent = agentWinner;
        }
        if (input.map === 'unknown') {
          const mapWinner = pickTop(mapVotes);
          if (mapWinner) input.map = mapWinner;
        }
        logger.info(
          {
            agent: input.agent,
            map: input.map,
            frames: contextFrames.length,
            agentBreakdown: Object.fromEntries(agentVotes),
            mapBreakdown: Object.fromEntries(mapVotes),
          },
          'Identified agent/map from context frames (multi-frame vote)',
        );
      }
    }

    // 0c. Select up to 10 deaths for coaching. If more than 10 were uploaded,
    //     pick by classifier confidence (descending), breaking ties by even
    //     distribution across the match so we keep a representative arc
    //     (not just the first 10). This reduces cost + latency AND focuses
    //     coaching on deaths the ONNX classifier was most confident about.
    const TARGET_DEATHS = 10;
    const deathsForAnalysis = (() => {
      if (input.deaths.length <= TARGET_DEATHS) return input.deaths;
      // Rank deaths by confidence desc, then take top TARGET_DEATHS, then
      // re-sort them in chronological order so death_number reads left-to-right.
      const ranked = input.deaths.map((d, origIdx) => ({
        ...d,
        _origIdx: origIdx,
        _conf: typeof d.confidence === 'number' ? d.confidence : 0.5,
      }));
      ranked.sort((a, b) => b._conf - a._conf);
      const top = ranked.slice(0, TARGET_DEATHS);
      top.sort((a, b) => a.timestampSec - b.timestampSec);
      return top.map(({ _origIdx: _oi, _conf: _c, ...rest }) => rest);
    })();

    if (deathsForAnalysis.length < input.deaths.length) {
      logger.info(
        {
          selected: deathsForAnalysis.length,
          received: input.deaths.length,
          matchId: input.matchId,
        },
        'Capped to top-confidence deaths for coaching',
      );
    }

    const totalDeathsInput = input.deaths.length;

    // 1. Analyze each selected death — callWithRetry handles transient 503/429
    const deathAnalyses: DeathAnalysis[] = [];

    {
      const j = job();
      if (j) j.total = deathsForAnalysis.length;
    }

    // Parallel per-death analysis with a concurrency limit. Gemma free tier
    // has a 16k input-tokens-per-minute quota. Each per-death call is
    // ~8-12k tokens (8 frames + ability crop + system instruction), so
    // concurrency > 2 will reliably hit 429s. We keep it at 2 and rely on
    // callWithRetry to honor Google's retryDelay when limits are hit.
    const PER_DEATH_CONCURRENCY = 2;
    const results: Array<DeathAnalysis | null> = new Array(deathsForAnalysis.length).fill(null);
    let completed = 0;

    const workers: Promise<void>[] = [];
    let nextIdx = 0;
    const takeNext = (): number | null => {
      if (nextIdx >= deathsForAnalysis.length) return null;
      return nextIdx++;
    };

    for (let w = 0; w < PER_DEATH_CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = takeNext();
            if (i == null) return;
            const death = deathsForAnalysis[i];
            try {
              const result = await this.analyzeOneDeath(death, i, input);
              results[i] = result;
              const j = job();
              if (j) {
                if (result) j.succeeded++;
                else j.failed++;
              }
            } catch (err) {
              logger.warn({ err, deathIndex: i }, 'Death analysis failed — skipping');
              const j = job();
              if (j) j.failed++;
            } finally {
              completed++;
              const j = job();
              if (j) {
                j.current = completed;
                j.stage = 'analyzing';
              }
            }
          }
        })(),
      );
    }

    await Promise.all(workers);

    // Preserve chronological order (matches deathsForAnalysis order).
    for (const r of results) {
      if (r) deathAnalyses.push(r);
    }

    logger.info(
      {
        succeeded: deathAnalyses.length,
        failed: deathsForAnalysis.length - deathAnalyses.length,
        selected: deathsForAnalysis.length,
        totalReceived: totalDeathsInput,
        matchId: input.matchId,
      },
      'Death analysis complete',
    );

    // If the client did NOT supply a ground-truth agent, take a
    // confidence-weighted vote over per-death playerAgent identifications.
    // A "high confidence" vote counts 3×, "medium" 2×, "low" 1× — this
    // prevents one low-confidence mis-read from overriding several strong
    // reads when all frames look similar (e.g. every death in one site).
    if (input.agent === 'unknown' && deathAnalyses.length > 0) {
      const votes = new Map<string, number>();
      for (const d of deathAnalyses) {
        if (d.playerAgent && VALID_AGENTS.includes(d.playerAgent)) {
          const conf = typeof d.confidence === 'string' ? d.confidence.toLowerCase() : '';
          const weight = conf === 'high' ? 3 : conf === 'medium' ? 2 : 1;
          votes.set(d.playerAgent, (votes.get(d.playerAgent) ?? 0) + weight);
        }
      }
      let winner: string | null = null;
      let winnerWeight = 0;
      for (const [agent, weight] of votes) {
        if (weight > winnerWeight) {
          winner = agent;
          winnerWeight = weight;
        }
      }
      if (winner) {
        logger.info(
          {
            winner,
            winnerWeight,
            votingDeaths: deathAnalyses.length,
            matchId: input.matchId,
            breakdown: Object.fromEntries(votes),
          },
          'Agent lock established by confidence-weighted vote',
        );
        input.agent = winner;
        // Overwrite every death's playerAgent to the locked value so the
        // synthesis summary is fully consistent.
        for (const d of deathAnalyses) d.playerAgent = winner;
      } else {
        logger.warn(
          { matchId: input.matchId },
          'No per-death agent identified — synthesis will proceed with agent=unknown',
        );
      }
    }

    // 3. Generate coaching synthesis — fallback to raw report if Gemini is down
    const j3 = job();
    if (j3) j3.stage = 'synthesizing';

    let coachingReport: string;
    if (deathAnalyses.length === 0) {
      // No deaths analyzed — generate minimal report without Gemini.
      // Use the UI-compatible shape so the frontend doesn't crash on missing fields.
      logger.warn({ matchId: input.matchId }, 'Zero deaths analyzed — generating minimal report');
      coachingReport = JSON.stringify({
        matchVerdict:
          'No deaths could be analyzed from this match — the AI provider may have been rate-limited or the recording did not contain detectable deaths. Please retry the analysis.',
        priorityIssue: {
          category: 'unclear',
          severity: 'minor',
          rounds_affected: 0,
          title: 'Analysis incomplete',
          what_happened: 'Zero deaths were successfully analyzed.',
          root_cause:
            'The AI provider may have been overloaded. This is not a reflection of your gameplay.',
          what_to_do:
            'Retry the analysis from the match history view. If the problem persists, contact support.',
        },
        secondaryIssues: [],
        strengths: ['The recording uploaded successfully — the pipeline works end-to-end.'],
        sessionFocus: {
          drill_name: 'Retry analysis',
          drill_steps:
            'Open this match in the history view and click "Re-analyze". If it fails again, wait a few minutes and try once more.',
          drill_duration_minutes: 1,
          in_game_cue: '',
        },
        coachingContinuity: {
          progress_note: 'No coaching delta this match — synthesis was unavailable.',
        },
        deathCoaching: [],
        rawDeathAnalyses: [],
        overallGrade: 'C',
        synthesisStatus: 'zero_deaths_analyzed',
      });
    } else {
      // Synthesis retry loop — Gemma occasionally emits malformed JSON under
      // load. One retry rescues most of those cases. On final failure we
      // build a structured fallback from the DeathAnalysis[] we have in
      // memory so the user always sees their per-death coaching.
      let generated: string | null = null;
      let lastErr: unknown = null;
      const MAX_SYNTHESIS_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt++) {
        try {
          generated = await this.generateCoaching(deathAnalyses, input);
          if (attempt > 1) {
            logger.info({ attempt, matchId: input.matchId }, 'Synthesis succeeded on retry');
          }
          break;
        } catch (err) {
          lastErr = err;
          const rawPreview = (err as any)?.rawPreview;
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              rawPreview,
              attempt,
              maxAttempts: MAX_SYNTHESIS_ATTEMPTS,
              matchId: input.matchId,
            },
            `Synthesis attempt ${attempt}/${MAX_SYNTHESIS_ATTEMPTS} failed`,
          );
        }
      }

      if (generated) {
        coachingReport = generated;
      } else {
        // Both synthesis attempts failed. Build a structured report directly
        // from the deathAnalyses we already have — the user's per-death
        // coaching is NOT lost, just the match-level pattern synthesis is.
        logger.warn(
          { err: lastErr, matchId: input.matchId, deathCount: deathAnalyses.length },
          'Synthesis failed after retry — using structured fallback from per-death analyses',
        );
        coachingReport = this.buildFallbackReport(deathAnalyses, input, lastErr);
      }

      // DIAGNOSTIC: log exactly what coachingReport contains before DB insert.
      // If deathCoaching is missing here but present in generateCoaching's
      // return, the issue is somewhere between return and this log. If
      // missing here AND in generateCoaching, the issue is in generateCoaching.
      try {
        const probe = JSON.parse(coachingReport);
        logger.info(
          {
            matchId: input.matchId,
            generatedBytes: coachingReport.length,
            keys: Object.keys(probe).sort(),
            deathCoachingLen: Array.isArray(probe.deathCoaching)
              ? probe.deathCoaching.length
              : 'not-array',
            hasPriorityIssue: probe.priorityIssue != null,
            hasMatchVerdict:
              typeof probe.matchVerdict === 'string' && probe.matchVerdict.length > 0,
            hasRawDeathAnalyses: Array.isArray(probe.rawDeathAnalyses)
              ? probe.rawDeathAnalyses.length
              : 'not-array',
            synthesisStatus: probe.synthesisStatus ?? 'none',
          },
          '[DIAG] coachingReport shape after synthesis',
        );
      } catch (probeErr) {
        logger.error(
          { probeErr, preview: coachingReport?.slice(0, 300), matchId: input.matchId },
          '[DIAG] coachingReport is not valid JSON',
        );
      }
    }

    // 4. Save to DB
    const j4 = job();
    if (j4) j4.stage = 'saving';

    await db
      .insert(matches)
      .values({
        id: input.matchId,
        userId,
        game: input.gameId,
        map: input.map !== 'unknown' ? input.map : null,
        agent: input.agent !== 'unknown' ? input.agent : null,
        rank: input.rank !== 'unknown' ? input.rank : null,
        gameMode: input.gameMode,
        durationMs: input.durationMs,
        deaths: deathAnalyses.length,
        playedAt: new Date(),
      })
      .onConflictDoNothing();

    const existing = await db
      .select({ userId: matches.userId })
      .from(matches)
      .where(eq(matches.id, input.matchId))
      .limit(1);
    if (existing.length > 0 && existing[0].userId !== userId) {
      throw new AppError('Match belongs to another user', 'MATCH_OWNERSHIP', 'medium');
    }

    await db
      .update(matches)
      .set({ analysisStatus: 'completed' })
      .where(eq(matches.id, input.matchId));

    let reportObj: Record<string, any> = {};
    try {
      const parsed: unknown = JSON.parse(coachingReport);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        reportObj = parsed as Record<string, any>;
      } else if (
        Array.isArray(parsed) &&
        parsed.length === 1 &&
        parsed[0] &&
        typeof parsed[0] === 'object' &&
        !Array.isArray(parsed[0])
      ) {
        // Last-chance unwrap in case an upstream path let an array through.
        logger.warn(
          { matchId: input.matchId },
          '[processAnalysisBackground] unwrapping array-wrapped coachingReport',
        );
        reportObj = parsed[0] as Record<string, any>;
      } else {
        // Parsed but shape is unusable — treat as parse failure so we use the
        // fallback we just built from per-death analyses.
        logger.error(
          {
            matchId: input.matchId,
            shape: Array.isArray(parsed) ? 'array' : typeof parsed,
            length: coachingReport.length,
          },
          '[processAnalysisBackground] coachingReport parsed to unusable shape; rebuilding from deathAnalyses',
        );
        reportObj = JSON.parse(
          this.buildFallbackReport(
            deathAnalyses,
            input,
            new Error('coachingReport parsed to non-object shape'),
          ),
        );
      }
    } catch {
      // Try stripping markdown code fences or whitespace
      try {
        const cleaned = coachingReport
          .replace(/^```json?\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        const parsed2: unknown = JSON.parse(cleaned);
        if (parsed2 && typeof parsed2 === 'object' && !Array.isArray(parsed2)) {
          reportObj = parsed2 as Record<string, any>;
        } else {
          reportObj = JSON.parse(
            this.buildFallbackReport(
              deathAnalyses,
              input,
              new Error('post-fence parse yielded non-object'),
            ),
          );
        }
      } catch {
        // Absolute last resort — build from per-death analyses we have in memory
        logger.error(
          { matchId: input.matchId, preview: coachingReport.slice(0, 200) },
          '[processAnalysisBackground] coachingReport unparseable; using full fallback',
        );
        reportObj = JSON.parse(
          this.buildFallbackReport(deathAnalyses, input, new Error('coachingReport unparseable')),
        );
      }
    }

    // Normalize: Gemini sometimes uses "deaths" instead of "deathCoaching"
    if (!reportObj.deathCoaching && Array.isArray(reportObj.deaths)) {
      reportObj.deathCoaching = reportObj.deaths;
      reportObj.deaths = undefined;
    }

    const totalFailed = input.deaths.length - deathAnalyses.length;
    reportObj.reportSchemaVersion = Math.max(
      Number(reportObj.reportSchemaVersion ?? 0),
      input.evidenceVersion && input.evidenceVersion >= 5
        ? 5
        : input.evidenceVersion && input.evidenceVersion >= 4
          ? 4
          : 3,
    );
    reportObj.analysisMetadata = {
      totalDeaths: input.deaths.length,
      analyzedDeaths: deathAnalyses.length,
      failedDeaths: totalFailed,
      evidenceVersion: input.evidenceVersion ?? 1,
      evidencePipeline:
        input.evidenceVersion && input.evidenceVersion >= 5
          ? 'fight-v5-evidence'
          : input.evidenceVersion && input.evidenceVersion >= 4
            ? 'fight-v4-evidence'
            : input.evidenceVersion && input.evidenceVersion >= 3
              ? 'frame-v3-evidence'
              : 'frame-legacy',
    };
    reportObj.tacticalPatterns =
      reportObj.tacticalPatterns ?? summarizeTacticalPatterns(deathAnalyses);

    // Lock the user-supplied agent/map into the top-level report so the Pass 2
    // enrichment route (coaching.routes.ts) reads them as ground truth and does
    // NOT let its VLM guess override them. If input was "unknown", we leave the
    // field null so enrichment is free to detect.
    reportObj.detectedAgent = input.agent && input.agent !== 'unknown' ? input.agent : null;
    reportObj.detectedMap = input.map && input.map !== 'unknown' ? input.map : null;

    // Attach snapshot-based ability findings + wins to the report. Same
    // shape as the cv-analysis pipeline's X3/X4 fields so observation
    // extraction (observation.service.ts) flows them into the brain
    // automatically — anti-patterns become habit observations, positives
    // become strength observations.
    if (this._lastSnapshotResult) {
      reportObj.abilityFindings = this._lastSnapshotResult.antiPatterns.map((f) => ({
        kind: f.kind,
        round: f.round,
        text: f.text,
        habitKey: f.habitKey,
      }));
      reportObj.abilityWins = this._lastSnapshotResult.positives.map((f) => ({
        kind: f.kind,
        text: f.text,
        habitKey: f.habitKey,
        ratio: f.ratio,
      }));
      logger.info(
        {
          matchId: input.matchId,
          findings: reportObj.abilityFindings.length,
          wins: reportObj.abilityWins.length,
        },
        '[FrameAnalysis] snapshot ability rules attached to report',
      );
    }

    // DIAGNOSTIC: log reportObj shape right before it's written to Postgres.
    // If deathCoaching etc. are here, the issue is in how Postgres/drizzle
    // serializes the JSONB. If missing here, something stripped them between
    // coachingReport (already logged above) and this point.
    logger.info(
      {
        matchId: input.matchId,
        reportId,
        keys: Object.keys(reportObj).sort(),
        deathCoachingLen: Array.isArray(reportObj.deathCoaching)
          ? reportObj.deathCoaching.length
          : 'not-array',
        hasPriorityIssue: reportObj.priorityIssue != null,
        hasMatchVerdict:
          typeof reportObj.matchVerdict === 'string' && reportObj.matchVerdict.length > 0,
        hasStrengths: Array.isArray(reportObj.strengths) ? reportObj.strengths.length : 'not-array',
        hasSessionFocus: reportObj.sessionFocus != null,
        hasCoachingContinuity: reportObj.coachingContinuity != null,
      },
      '[DIAG] reportObj shape just before DB insert',
    );

    const processingTimeMs = Date.now() - startTime;

    await db.insert(coachingReports).values({
      id: reportId,
      userId,
      type: 'game_analysis',
      trigger: 'manual',
      status: 'completed',
      matchIds: [input.matchId],
      report: reportObj,
      topIssues: reportObj.secondaryIssues ?? [],
      overallAssessment: reportObj.priorityIssue?.title ?? null,
      vlmModel: this.modelId,
      processingTimeMs,
      completedAt: new Date(),
    });

    this.updateBrain(reportId, userId, reportObj, input.agent, input.map).catch((err) => {
      logger.error({ err, reportId }, 'Brain update failed');
    });

    // Mark job complete
    const jDone = job();
    if (jDone) {
      jDone.status = 'completed';
    }

    logger.info(
      { jobId, reportId, matchId: input.matchId, processingTimeMs },
      'Background analysis complete',
    );
  }

  // ── Per-death analysis ──────────────────────────────────────────────────────

  private async analyzeOneDeath(
    death: AnalyzeFramesInput['deaths'][0],
    index: number,
    context: AnalyzeFramesInput,
  ): Promise<DeathAnalysis | null> {
    try {
      // Build parts in image-first-then-text order (Google recommendation for
      // visual analysis). Gameplay frames first, labelled. Then the optional
      // ability-bar crop labelled clearly. Then the slim text turn.
      const parts: any[] = [];

      const useFightPacket = !!(
        death.fightPacket?.version &&
        death.fightPacket.version >= 4 &&
        death.fightPacket.phaseFrames?.length
      );
      const promptFrames = useFightPacket
        ? (death.fightPacket?.phaseFrames ?? []).flatMap((pf) => {
            const frame = death.frames.find((f) => Math.abs(f.offsetSec - pf.offsetSec) < 0.01);
            return frame ? [{ ...frame, phase: pf.phase, role: pf.role ?? 'pre_outcome' }] : [];
          })
        : death.frames.map((f) => ({
            ...f,
            phase: null as string | null,
            role: f.offsetSec < 0 ? 'pre_outcome' : 'outcome',
          }));

      for (const f of promptFrames) {
        parts.push({
          inlineData: { mimeType: 'image/jpeg', data: f.base64Jpeg },
        });
        const sign = f.offsetSec >= 0 ? '+' : '';
        const phaseLabel = f.phase ? ` ${String(f.phase).replace(/_/g, ' ')}` : ' frame';
        const roleLabel = f.role === 'outcome' ? 'OUTCOME' : 'PRE-OUTCOME';
        parts.push({ text: `[${roleLabel}${phaseLabel} at death${sign}${f.offsetSec}s]` });
      }

      // Dedicated ability-bar crop — only sent when the client extracted it.
      // At 1080p source, the 4 ability icons are ~40-50px wide; after Gemma's
      // internal tiling at HIGH resolution they become ~10-15px and unreadable.
      // A 512×256 crop of just the ability bar gives 5-10× that size,
      // finally making LIT vs DIMMED reliably legible.
      if (death.abilityBarCropBase64) {
        parts.push({
          inlineData: { mimeType: 'image/jpeg', data: death.abilityBarCropBase64 },
        });
        parts.push({
          text: '[ABILITY-BAR CROP at the refined decision anchor — the four icons are C / Q / E / X in left-to-right order; this is the authoritative source for abilityStatus]',
        });
      }

      const cropLabels: Array<[keyof NonNullable<typeof death.typedCrops>, string]> = [
        [
          'decisionAbilityBar',
          'DECISION ABILITY-BAR CROP — authoritative for C/Q/E/X abilityStatus',
        ],
        [
          'decisionWeaponHud',
          'DECISION WEAPON-HUD CROP — authoritative for playerWeapon and ammo/readiness',
        ],
        [
          'contactWeaponHud',
          'CONTACT WEAPON-HUD CROP - best source for reload, ammo drop, weapon swap, and whether the gun was ready during contact',
        ],
        [
          'decisionMinimap',
          'DECISION MINIMAP CROP — best source for teammatesAlive and rough map position',
        ],
        [
          'decisionHpShield',
          'DECISION HP/SHIELD CROP — authoritative for decisionHP and decisionShield',
        ],
        [
          'deathKillfeed',
          'DEATH KILLFEED CROP — authoritative for killerAgent, killerWeapon, and headshot',
        ],
        ['deathTopHud', 'DEATH TOP-HUD CROP — support evidence for round/spike state if readable'],
        [
          'decisionCrosshair',
          'DECISION CENTER/CROSSHAIR CROP - best source for crosshair placement, exposed angle, and cover at the decision point',
        ],
        [
          'contactCrosshair',
          'CONTACT CENTER/CROSSHAIR CROP - best source for how the duel opened just before death',
        ],
      ];
      for (const [key, label] of cropLabels) {
        const data = death.typedCrops?.[key];
        if (!data) continue;
        parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
        parts.push({ text: `[${label}]` });
      }

      // Look up whether we know the agent (for JSON-template hints).
      const haveKnownAgent = !!(context.agent && context.agent !== 'unknown');

      // Identify the earliest and latest pre-death frame offsets so the prompt
      // can refer to them unambiguously. With the new offset array
      // [-5, -4, -3, -2, -1.5, -1, -0.5, 0], earliest = -5, latest = -0.5.
      const preDeathOffsets = death.frames
        .map((f) => f.offsetSec)
        .filter((o) => o < 0)
        .sort((a, b) => a - b); // most negative first
      const earliestOffset = preDeathOffsets[0] ?? -5;
      const latestOffset = preDeathOffsets[preDeathOffsets.length - 1] ?? -0.5;
      // Decision-time anchor: prefer -2s (just BEFORE the peek commits and
      // BEFORE any damage from the engagement). -1s is often DURING the
      // gunfight already — HP read there is wrong for "pushed with low HP"
      // coaching (user reported this 2026-04-20). -0.5s is even later.
      const decisionOffset = preDeathOffsets.includes(-2)
        ? -2
        : preDeathOffsets.includes(-2.5)
          ? -2.5
          : preDeathOffsets.includes(-1.5)
            ? -1.5
            : preDeathOffsets.includes(-1)
              ? -1
              : (preDeathOffsets[Math.floor(preDeathOffsets.length / 2)] ?? -2);
      const fmtOff = (n: number) => `${n >= 0 ? '+' : ''}${n}s`;

      const systemInstruction = buildDeathSystemInstruction(context);

      // Slim user prompt: per-death specifics + exact JSON shape. All pedagogy
      // (HUD locations, allowlists, agent lock, map callouts, enum vocab) is
      // in systemInstruction which is identical across every death.
      const frameLabels = death.frames
        .map((f) => `  • death${f.offsetSec >= 0 ? '+' : ''}${f.offsetSec}s`)
        .join('\n');
      const v4FrameLabels = promptFrames
        .map((f) => {
          const sign = f.offsetSec >= 0 ? '+' : '';
          const phase = f.phase ? ` ${String(f.phase).replace(/_/g, ' ')}` : '';
          const role = f.role === 'outcome' ? 'outcome' : 'pre-outcome';
          return `  - ${role}${phase}: death${sign}${f.offsetSec}s`;
        })
        .join('\n');
      const typedCropLines = cropLabels
        .filter(([key]) => !!death.typedCrops?.[key])
        .map(([, label]) => `  • ${label}`)
        .join('\n');

      const localEvidenceLines = death.localEvidence
        ? [
            `  • detector candidate: ${death.localEvidence.candidateTimestampSec?.toFixed?.(2) ?? 'unknown'}s`,
            `  • refined death onset: ${death.localEvidence.refinedTimestampSec?.toFixed?.(2) ?? death.timestampSec.toFixed(2)}s (${death.localEvidence.refinementQuality ?? 'unknown'} confidence)`,
            `  • decision anchor: ${death.localEvidence.decisionAnchorSec?.toFixed?.(2) ?? 'unknown'}s`,
            death.localEvidence.postDeathDecisionFramesExcluded
              ? '  • post-death body/death-animation frames were excluded from decision evidence'
              : null,
          ]
            .filter(Boolean)
            .join('\n')
        : '  • no local timing metadata was provided';

      const prompt = `DEATH #${index + 1} at ${formatTime(death.timestampSec)}${context.map && context.map !== 'unknown' ? ` on ${context.map}` : ''} (${context.gameMode}).

Local timing evidence:
${localEvidenceLines}

Frames provided (player-POV, pre-death through death):
${useFightPacket ? v4FrameLabels : frameLabels}${death.abilityBarCropBase64 ? '\n  • ABILITY-BAR CROP (zoomed C/Q/E/X from the decision-time frame)' : ''}${typedCropLines ? `\n${typedCropLines}` : ''}

${
  useFightPacket
    ? `V4 FIGHT-PACKET RULE:
- First, read the PRE-OUTCOME phase frames only and write phaseObservations, coachPausePoint, supportedProblems, and notProven.
- Do not let the fact that the player died change the pre-outcome judgment. A death result alone is not evidence of a bad peek.
- Use OUTCOME frames/crops only for killerAgent, killerWeapon, wasHeadshot, and death confirmation.`
    : ''
}

WHICH FRAME TO READ FOR EACH FIELD:
• decisionHP / decisionShield / playerWeapon / abilityStatus / positionType / cover / crosshairPlacement / mapLocation / teammatesAlive / utilityActive:
   → read from the ${fmtOff(decisionOffset)} frame primarily, cross-check with ${fmtOff(earliestOffset)}.
   → decisionHP is the HIGHEST HP value across the pre-death frames (BEFORE any engagement damage). If earlier frames show higher HP, use THAT value.
• movementState / peekType / engagementDistance / enemiesVisible / hadPreInfo:
   → read from the sequence of pre-death frames (how did the player engage?).
   → hadPreInfo=true only if an enemy silhouette is visible in any frame BEFORE the 0s frame, or a nearby teammate kill-feed entry precedes the peek.
• impactHP: HP value in the ${fmtOff(latestOffset)} frame (after damage). Must be ≤ decisionHP.
• killerAgent / killerWeapon / wasHeadshot:
   → read from the deathKillfeed crop first, then TOP-RIGHT in the 0s frame (the fresh entry).
   → killerAgent must be on the VALID AGENTS allowlist OR "an enemy". Never invent.
   → killerWeapon must be on VALID WEAPONS OR a weapon class OR "unknown".
• playerWeapon: trust decisionWeaponHud over the full-frame read.
• decisionHP / decisionShield: trust decisionHpShield over the full-frame read.
• abilityStatus: trust decisionAbilityBar / ABILITY-BAR CROP over the full-frame read. Every slot must be one of LIT / DIMMED / UNREADABLE.

OUTPUT — return ONLY this JSON (no prose, no markdown, no trailing text):
Extra V5 OBSERVATION FIELDS:
- weaponAction / fireDiscipline / firstBulletThreat: read from contactWeaponHud, contactCrosshair, and contact frames. Do not confuse reload with melee/sidearm. Use "unknown" when not proven.
- utilityUsed / utilityEffect: list only visibly used abilities. If Leer was used but effect is not proven, utilityEffect must be "used_effect_unknown", not "proven_ineffective".
- Killfeed attribution: if multiple killfeed rows appear near death, choose only the row where the victim is the locked player agent. If the player row is not clearly readable, set killerAgent/killerWeapon null/unknown.

{
  "playerAgent": ${haveKnownAgent ? `"${context.agent}"` : '"agent name from earliest frame, or null"'},
  "killerAgent": "agent from kill feed (allowlist) or \\"an enemy\\" or null",
  "killfeedMatchConfidence": "high|medium|low",
  "playerWeapon": "weapon name or class or \\"unknown\\"",
  "killerWeapon": "weapon name or class or \\"unknown\\"",
  "wasHeadshot": false,
  "weaponAction": "ready|firing|reloading|switching_weapon|melee_out|ability_out|no_gun_ready|unknown",
  "fireDiscipline": "tap|burst|spray|no_shot|unknown",
  "firstBulletThreat": "on_head|on_body|off_target|unknown",
  "decisionHP": 0,
  "decisionShield": 0,
  "impactHP": 0,
  "abilityStatus": { "C": "LIT|DIMMED|UNREADABLE", "Q": "LIT|DIMMED|UNREADABLE", "E": "LIT|DIMMED|UNREADABLE", "X": "LIT|DIMMED|UNREADABLE" },
  "positionType": "open|chokepoint|angle_hold|site_anchor|rotation|post_plant|mid|unclear",
  "cover": "exposed|partial|full|unclear",
  "movementState": "stationary|walking|running|counter_strafing|unclear",
  "peekType": "dry_swing|jiggle|shoulder|pre_aimed|hold|none|unclear",
  "crosshairPlacement": "head_level|above_head|below_head|scanning|unclear",
  "engagementDistance": "close|medium|long|unclear",
  "mapLocation": "callout from map list or null",
  "teammatesAlive": null,
  "enemiesVisible": null,
  "utilityActive": [],
  "utilityUsed": [],
  "utilityEffect": "proven_effective|proven_ineffective|used_effect_unknown|not_used|unknown",
  "utilityEffectConfidence": "high|medium|low",
  "hadPreInfo": null,
  "phaseObservations": [
    { "phase": "decision", "finding": "specific visible fact from that phase, or omit", "confidence": "high|medium|low", "evidenceFrame": "phase/offset label" }
  ],
  "coachPausePoint": "first visible fixable decision before the death, or null",
  "supportedProblems": [
    { "problem": "specific visible problem", "evidence": "frame/crop that proves it", "confidence": "high|medium|low" }
  ],
  "notProven": ["important claims that are not visible enough to make"],
  "identityConfidence": "high|medium|low",
  "stateConfidence": "high|medium|low",
  "contextConfidence": "high|medium|low"
}

REMEMBER: null and "unclear" are correct answers when a value is not legible. A wrong value is a hallucination and will mislead the coach. Do NOT output situation / mistake / improvement / correction / category — those fields are generated downstream from your facts.`;

      parts.push({ text: prompt });

      // Generous retry budget on Gemma free tier: 16k tok/min rate limit means
      // 429s will hit during bursts. callWithRetry honors Google's exact
      // retryDelay so we wait the right amount, not more, not less.
      const response = await this.callWithRetry(
        () =>
          this.ai.models.generateContent({
            model: this.modelId,
            contents: [{ parts }],
            config: {
              // Temperature 0.0 for fact extraction — we want the same JSON for
              // the same frames every call. Any creativity here IS hallucination.
              temperature: 0.0,
              maxOutputTokens: 2048,
              systemInstruction,
              // HIGH = reframed tiles focused on high-information regions.
              // Best setting for HUD reading at Gemma's token budget.
              mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
            },
          }),
        5,
      );

      const rawText =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';

      // Extract JSON from the model's response. Robust strategy:
      //   1. Strip markdown fences (```json ... ```).
      //   2. Find the first balanced {...} block that mentions at least one
      //      of our expected keys — this tolerates reordered fields, extra
      //      whitespace, or thinking text before the JSON.
      const parsedObj = extractDeathJson(rawText);
      if (!parsedObj) {
        // Preserve a preview of what the model actually said so we can see
        // whether it's a truncation, a format change, or a refusal.
        const preview = rawText.slice(0, 400).replace(/\s+/g, ' ').trim();
        logger.warn(
          { deathIndex: index, rawTextLength: rawText.length, preview },
          'Death analysis: no parseable JSON in model response',
        );
        throw new Error('No JSON found in model response');
      }
      // Downstream code was written against a loosely-typed object with
      // optional fields; keep the contract by treating the extracted JSON as
      // `any` here rather than rewriting every access site.
      const parsed: any = parsedObj;

      // ── Stage 1.5: deterministic fact validation ─────────────────────────
      // Runs on the parsed JSON to enforce hard guarantees that prompting alone
      // cannot guarantee: allowlist membership, HP monotonicity, ability kit
      // consistency, callout validity, enum vocabularies.
      const facts = validateDeathFacts(parsed, context, index);
      const fightPhases = sanitizeFightPhases(parsed.phaseObservations);
      const supportedProblems = sanitizeSupportedProblems(parsed.supportedProblems);
      const notProven = sanitizeStringList(parsed.notProven);
      const coachPausePoint = cleanShortText(parsed.coachPausePoint, 220);

      const analysis: DeathAnalysis = {
        deathIndex: index,
        death_number: index + 1,
        timestampSec: death.timestampSec,

        // Identity
        playerAgent: facts.playerAgent,
        killerAgent: facts.killerAgent,
        killfeedMatchConfidence: facts.killfeedMatchConfidence,
        killerWeapon: facts.killerWeapon,
        playerWeapon: facts.playerWeapon,
        weaponAction: facts.weaponAction,
        fireDiscipline: facts.fireDiscipline,
        firstBulletThreat: facts.firstBulletThreat,
        weapon: facts.killerWeapon, // legacy alias
        wasHeadshot: facts.wasHeadshot,

        // HP / shield
        decisionHP: facts.decisionHP,
        decisionShield: facts.decisionShield,
        impactHP: facts.impactHP,
        playerHP: facts.decisionHP, // legacy alias

        // Abilities
        abilityStatus: facts.abilityStatus,
        abilitiesAvailable: facts.abilitiesAvailable,
        abilitiesUnused: facts.abilitiesUnused,

        // Observations (all enum-constrained by stage 1.5)
        positionType: facts.positionType,
        cover: facts.cover,
        movementState: facts.movementState,
        peekType: facts.peekType,
        crosshairPlacement: facts.crosshairPlacement,
        engagementDistance: facts.engagementDistance,
        mapLocation: facts.mapLocation,
        teammatesAlive: facts.teammatesAlive,
        enemiesVisible: facts.enemiesVisible,
        utilityActive: facts.utilityActive,
        utilityUsed: facts.utilityUsed,
        utilityEffect: facts.utilityEffect,
        utilityEffectConfidence: facts.utilityEffectConfidence,
        hadPreInfo: facts.hadPreInfo,

        // Confidence tags (per category)
        identityConfidence: facts.identityConfidence,
        stateConfidence: facts.stateConfidence,
        contextConfidence: facts.contextConfidence,
        localEvidence: death.localEvidence,
        evidenceSources: [
          death.abilityBarCropBase64 ? 'ability_bar_crop' : null,
          death.typedCrops?.decisionAbilityBar ? 'decision_ability_bar' : null,
          death.typedCrops?.decisionWeaponHud ? 'decision_weapon_hud' : null,
          death.typedCrops?.contactWeaponHud ? 'contact_weapon_hud' : null,
          death.typedCrops?.decisionMinimap ? 'decision_minimap' : null,
          death.typedCrops?.decisionHpShield ? 'decision_hp_shield' : null,
          death.typedCrops?.decisionCrosshair ? 'decision_crosshair' : null,
          death.typedCrops?.contactCrosshair ? 'contact_crosshair' : null,
          death.typedCrops?.deathKillfeed ? 'death_killfeed' : null,
          death.typedCrops?.deathTopHud ? 'death_top_hud' : null,
        ].filter((s): s is string => !!s),
        fightPhases,
        coachPausePoint,
        supportedProblems,
        notProven,
        observerVersion: useFightPacket ? 'fight-v4' : 'legacy',

        // Coaching text — stage 1 NEVER populates these. Stage 2 writes them
        // from the facts above when it generates the final report. Keep the
        // interface shape consistent so downstream code doesn't break.
        situation: '',
        mistake: '',
        correction: '',
        improvement: '',
        category: '',
        confidence: facts.identityConfidence, // legacy field points at identity confidence
      };
      analysis.tactical = classifyTacticalDeath(analysis, context);
      analysis.avoidable = analysis.tactical.avoidable;
      analysis.category = analysis.tactical.primary.category;
      return analysis;
    } catch (err: any) {
      logger.warn({ err, deathIndex: index }, 'Death analysis failed');
      return null;
    }
  }

  // ── Coaching synthesis ─────────────────────────────────────────────────────

  private async generateCoaching(
    deaths: DeathAnalysis[],
    context: AnalyzeFramesInput,
  ): Promise<string> {
    // Build death summaries PURELY from stage-1 facts. No coaching text flows
    // in — situation/mistake/improvement are stage 2's job to generate here.
    // Each death summary is a dense fact brief the model reasons over.
    const formatDeathFacts = (d: DeathAnalysis): string => {
      const lines: string[] = [`Death #${d.death_number} at ${formatTime(d.timestampSec)}:`];

      // Identity
      const headshot = d.wasHeadshot ? ' (headshot)' : '';
      const killerWpn = d.killerWeapon ?? d.weapon ?? 'unknown';
      lines.push(`  killed_by: ${d.killerAgent ?? 'an enemy'}${headshot} with ${killerWpn}`);
      lines.push(`  killfeed_match_confidence: ${d.killfeedMatchConfidence}`);
      lines.push(`  player_weapon: ${d.playerWeapon ?? 'unknown'}`);
      if (d.weaponAction || d.fireDiscipline || d.firstBulletThreat) {
        lines.push(
          `  weapon_action: ${[
            d.weaponAction ? `action=${d.weaponAction}` : null,
            d.fireDiscipline ? `fire=${d.fireDiscipline}` : null,
            d.firstBulletThreat ? `first_bullet=${d.firstBulletThreat}` : null,
          ]
            .filter(Boolean)
            .join(' | ')}`,
        );
      }

      // HP / shield
      const shieldPart = d.decisionShield != null ? `, shield ${d.decisionShield}` : '';
      const hpLine =
        d.decisionHP != null
          ? `  decision_hp: ${d.decisionHP}${shieldPart}${d.impactHP != null ? ` → impact_hp: ${d.impactHP}` : ''}`
          : '  decision_hp: unclear';
      lines.push(hpLine);

      // Ability state — explicit per-slot state so model knows what was READY
      // vs on cooldown, AND which specific abilities (if agent known) were LIT.
      const slotStates = (['C', 'Q', 'E', 'X'] as const)
        .map((s) => `${s}=${d.abilityStatus?.[s] ?? 'UNREADABLE'}`)
        .join(' ');
      lines.push(`  ability_slots: ${slotStates}`);
      const abilityDetails = availableAbilityDetails(d, context.agent);
      if (abilityDetails.length > 0) {
        lines.push(
          `  abilities_ready_by_role: ${abilityDetails.map((a) => `${a.slot}:${a.name}[${a.category}]`).join(', ')}`,
        );
        const prep = abilityDetails.filter((a) => isPreContactUtility(a, context.agent));
        const setup = abilityDetails.filter((a) => a.category === 'setup');
        const ults = abilityDetails.filter((a) => a.category === 'ult');
        if (prep.length > 0)
          lines.push(`  prep_utility_ready: ${prep.map((a) => a.name).join(', ')}`);
        if (setup.length > 0)
          lines.push(`  setup_utility_still_ready: ${setup.map((a) => a.name).join(', ')}`);
        if (ults.length > 0)
          lines.push(
            `  ultimate_ready: ${ults.map((a) => a.name).join(', ')} (round-plan resource, not default peek prep)`,
          );
      }

      // Position / action — enum values from stage 1.5
      const posParts: string[] = [];
      if (d.positionType) posParts.push(`position=${d.positionType}`);
      if (d.cover) posParts.push(`cover=${d.cover}`);
      if (d.peekType) posParts.push(`peek=${d.peekType}`);
      if (d.crosshairPlacement) posParts.push(`crosshair=${d.crosshairPlacement}`);
      if (d.movementState) posParts.push(`movement=${d.movementState}`);
      if (d.engagementDistance) posParts.push(`distance=${d.engagementDistance}`);
      if (posParts.length > 0) lines.push(`  engagement: ${posParts.join(' | ')}`);

      // Location
      if (d.mapLocation) lines.push(`  map_location: ${d.mapLocation}`);

      // Context
      const ctxParts: string[] = [];
      if (d.teammatesAlive != null) ctxParts.push(`teammates_alive=${d.teammatesAlive}`);
      if (d.enemiesVisible != null) ctxParts.push(`enemies_visible=${d.enemiesVisible}`);
      if (Array.isArray(d.utilityActive) && d.utilityActive.length > 0) {
        ctxParts.push(`utility_on_screen=${d.utilityActive.join(',')}`);
      }
      if (d.hadPreInfo === true) ctxParts.push('had_pre_info=true');
      else if (d.hadPreInfo === false) ctxParts.push('had_pre_info=false');
      if (ctxParts.length > 0) lines.push(`  context: ${ctxParts.join(' | ')}`);
      if (d.utilityUsed.length > 0 || d.utilityEffect) {
        lines.push(
          `  utility_execution: used=${d.utilityUsed.length ? d.utilityUsed.join(', ') : 'none'} | effect=${d.utilityEffect ?? 'unknown'} | effect_confidence=${d.utilityEffectConfidence}`,
        );
      }

      if (d.coachPausePoint) {
        lines.push(`  coach_pause_point: ${d.coachPausePoint}`);
      }
      if (Array.isArray(d.fightPhases) && d.fightPhases.length > 0) {
        lines.push(
          `  fight_phase_read: ${d.fightPhases.map((p) => `${p.phase}=${p.finding} (${p.confidence})`).join(' | ')}`,
        );
      }
      if (Array.isArray(d.supportedProblems) && d.supportedProblems.length > 0) {
        lines.push(
          `  visible_problems: ${d.supportedProblems.map((p) => `${p.problem} [${p.evidence}; ${p.confidence}]`).join(' | ')}`,
        );
      }
      if (Array.isArray(d.notProven) && d.notProven.length > 0) {
        lines.push(`  not_proven: ${d.notProven.join(' | ')}`);
      }

      // Confidence tags — help the model down-weight low-confidence observations
      lines.push(
        `  confidence: id=${d.identityConfidence}, state=${d.stateConfidence}, ctx=${d.contextConfidence}`,
      );

      const tacticalBrief = formatTacticalBrief(d);
      if (tacticalBrief) lines.push(tacticalBrief);

      return lines.join('\n');
    };

    const deathSummaries = deaths.map(formatDeathFacts).join('\n\n');
    const tacticalPatterns = summarizeTacticalPatterns(deaths);
    const tacticalPatternBlock =
      tacticalPatterns.length > 0
        ? tacticalPatterns
            .map(
              (p) =>
                `- ${p.title}: deaths #${p.deathNumbers.join(', #')} (${p.count}x, category=${p.category}, severity=${p.severity}). Correction: ${p.correction}`,
            )
            .join('\n')
        : '- No repeated deterministic tactical pattern was proven from the visible facts.';

    // ── Snapshot-based ability findings (X3/X4 analogue for v2 pipeline) ──
    // The v2 pipeline doesn't have a cast timeline (no original video here),
    // but it does have per-death `abilityStatus` snapshots — enough to derive
    // a useful subset of anti-patterns + positives. Findings inject into the
    // synthesis prompt and get attached to reportObj downstream.
    const snapshotResult = detectSnapshotPatterns(
      deaths.map((d) => ({
        deathNumber: d.death_number,
        abilityStatus: {
          C: d.abilityStatus?.C ?? 'UNREADABLE',
          Q: d.abilityStatus?.Q ?? 'UNREADABLE',
          E: d.abilityStatus?.E ?? 'UNREADABLE',
          X: d.abilityStatus?.X ?? 'UNREADABLE',
        },
      })),
      context.agent ?? 'unknown',
    );
    const snapshotBlocks = formatSnapshotFindings(snapshotResult);
    // Stash on the instance so processAnalysisBackground can attach to reportObj
    // after synthesis — avoids changing the generateCoaching return shape.
    this._lastSnapshotResult = snapshotResult;

    const lockedAgent = context.agent && context.agent !== 'unknown' ? context.agent : null;
    const lockedAgentInfo = lockedAgent ? AGENTS[lockedAgent.toLowerCase()] : null;
    const mapKey = typeof context.map === 'string' ? context.map.toLowerCase().trim() : '';
    const mapCallouts = mapKey && mapKey !== 'unknown' ? (MAP_CALLOUTS[mapKey] ?? null) : null;

    // Rich systemInstruction: agent knowledge, allowlists, map callouts,
    // JSON shape contract. Everything Gemma needs to produce coaching grounded
    // in Valorant-accurate specifics.
    const synthesisSystemBlocks: string[] = [];

    synthesisSystemBlocks.push(
      `You are a professional Valorant VOD coach writing a coaching report for a single match.

The input below is a set of PER-DEATH FACTS, already visually verified by a separate observation pass. These facts are your ground truth. You DO NOT need to re-verify what was on screen — trust the facts. Your job is to:
  1. Identify the dominant mistake PATTERN across deaths (the priority issue)
  2. Identify up to 2 genuinely different secondary patterns
  3. For each death, WRITE the situation / mistake / improvement narrative grounded in that death's specific facts
  4. Write session focus (drill + cue), match verdict, strengths, coaching continuity

HARD RULES on grounding:
• Every coaching claim must be traceable to a specific fact in the input. If you cite "you dry-peeked without utility", that death's fact block must show peek=dry_swing AND abilities_LIT_but_unused must list relevant utility.
• Never invent a fact that is not in the input. If a field is missing or null, the fact is "unknown for this death" — coach around it or skip.
• NEVER recommend using an ability whose slot was DIMMED at decision time (it was on cooldown — the player LITERALLY COULD NOT use it).
• If the locked agent doesn't have a specific ability, don't recommend it. The agent's kit is listed below.
• Respect agent-specific ability legality. For Reyna, Dismiss and Devour require a recent kill/soul orb; they are NOT pre-fight tools and must not be recommended before contact.
• Do not treat every ready ability as correct before a peek. Only prep_utility_ready is a direct "use before swing" candidate. setup_utility_still_ready means the error was setup timing. ultimate_ready is a round-plan resource, not default single-angle prep.
• If confidence on a category is "low", be cautious — don't build a priority pattern primarily on low-confidence observations.
• The tactical_primary / tactical_evidence / tactical_root_cause / tactical_correction lines are rule-derived validator hints. Use them only when they agree with the phase read and supporting visible facts.`,
    );

    if (lockedAgent && lockedAgentInfo) {
      synthesisSystemBlocks.push(
        `═══ PLAYER AGENT: ${lockedAgent} (locked) ═══
Role: ${lockedAgentInfo.role}
Playstyle expectation: ${lockedAgentInfo.expectation}

${lockedAgent.toUpperCase()}'s ABILITIES:
${lockedAgentInfo.abilities}

COMMON ${lockedAgent.toUpperCase()} COACHING FLAGS:
${lockedAgentInfo.flags}

Every death in this match belongs to ${lockedAgent} — never anybody else. If a per-death summary below names a different agent in its situation/mistake/correction (misread from killcam footage), silently rewrite around ${lockedAgent}'s kit. Never list multiple agents as the player. Never mention other agents in strengths or priority issue text.`,
      );
    } else if (lockedAgent) {
      synthesisSystemBlocks.push(
        `═══ PLAYER AGENT: ${lockedAgent} (locked) ═══
Every death belongs to ${lockedAgent}. Never list multiple agents as the player.`,
      );
    } else {
      synthesisSystemBlocks.push(
        `═══ PLAYER AGENT: UNCERTAIN ═══
We could not confidently identify the agent. Write agent-neutral coaching — avoid agent-specific ability names. Do NOT list multiple agents as if the player swapped mid-match (that does not happen in competitive Valorant).`,
      );
    }

    synthesisSystemBlocks.push(
      `═══ ALLOWLISTS — use only these names ═══
Valid agents: ${VALID_AGENTS.join(', ')}
Valid maps: ${VALID_MAPS.join(', ')}
Valid weapons: ${VALID_WEAPONS.join(', ')}`,
    );

    if (mapCallouts) {
      synthesisSystemBlocks.push(
        `═══ MAP: ${context.map.toUpperCase()} — CALLOUTS ═══
${mapCallouts}
Use only these callout names when referencing positions. Never invent area names.`,
      );
    }

    synthesisSystemBlocks.push(
      `═══ OUTPUT RULES ═══
1. Return a SINGLE JSON OBJECT (starts with { and ends with }). NEVER wrap it in an array — do NOT output [{ ... }]. The very first character of your response must be "{" and the very last must be "}". Wrapping the object in an array produces an empty report for the user.
2. Return VALID JSON only — no prose before or after, no markdown fences, no commentary, no comments.
3. Populate EVERY top-level field shown in the JSON template below. Do not omit fields.
4. Ground every claim in the death summaries provided — reference specific death numbers ("in death #3", "during deaths #2 and #5").
5. "severity" must be exactly one of: "critical", "moderate", "minor". NEVER use "high" or "medium".
6. "sessionFocus" MUST be an object with drill_name, drill_steps, drill_duration_minutes, in_game_cue — NEVER a plain string.
7. "coachingContinuity.progress_note" is a short sentence about the player's arc across this match.`,
    );

    const synthesisSystem = synthesisSystemBlocks.join('\n\n');

    const coachingPrompt = `You are a paid Valorant VOD coach — not a match summarizer. Every sentence must teach the player something they could not figure out alone.

═══ MATCH CONTEXT ═══
Map: ${context.map} | Agent: ${lockedAgent ?? 'unknown'} | Mode: ${context.gameMode} | Rank: ${context.rank}
Duration: ${Math.round(context.durationMs / 60000)} minutes${context.roundCount > 0 ? ` | Rounds: ${context.roundCount}` : ''}
Deaths analyzed: ${deaths.length}

═══ COACHING QUALITY RULES ═══
1. ROOT CAUSE > SYMPTOM. "Bad positioning" is useless. "You pushed forward after every kill because winning makes aggression feel safe — which turns 5v4 advantages into trades" is real coaching.
2. REFERENCE MECHANICS. Explain WHY using Valorant mechanics: peek advantage, counter-strafe accuracy, trade windows, economy math, ability economy, pre-aim discipline, info denial.
3. ACTIONABLE. Every correction must be something the player can DO next game — not vague "work on positioning."
4. CONSOLIDATE REPEATED MISTAKES. If 5 deaths share the same root cause (e.g. all peek=dry_swing with utility ready but unused), that is ONE pattern — call it out as priorityIssue with rounds_affected: 5 and cite specific death numbers. Do NOT repeat. Find 1 dominant pattern + up to 2 genuinely DIFFERENT secondary patterns.
5. NO TEMPLATES. Never write output that could apply to any Valorant death. Every sentence must cite something specific from THIS match's facts. If you find yourself writing "ego peek" generically, stop and ground it ("in death #3 you dry-swung A main with your Leer ready").
6. PLAIN ENGLISH. Never use technical notation like "-1s", "t-1", "death-1", or offset references. Write player-friendly phrasing ("just before the peek", "at the moment of engagement"). NEVER use the internal jargon word "LIT" in coaching output — write "ready" or "available" instead. The player has no idea what LIT means.
7. FIND STRENGTHS. Every match has positives. Find at least 2 specific strengths with death/fact references (e.g. "in deaths #5 and #7 your crosshair was at head height and you got the first shot — that's the habit to keep").
8. AVOIDABILITY. "avoidable: false" only when the facts show a fair trade (similar positions, both had util, clean duel) or a no-win scenario. If abilities were ready, cover was available, or pre-info existed → avoidable: true.
9. DO NOT INVENT. Every claim must trace to a specific fact above. If you can't name the fact, you can't make the claim.
10. UTILITY PRECISION. Use ability roles correctly: info/flash/smoke/mobility may prepare a peek; setup utility should have been placed before contact; damage utility is for flushing known positions, not generic info; ultimates are round-plan resources and should not be prescribed for a single normal angle unless the facts show high value.
11. AVOID BIAS. Do not default to utility. If weapon_action, first_bullet, fire_discipline, or crosshair facts prove the mistake, those outrank generic "use utility" advice.

═══ PER-DEATH FACTS ═══
(Already visually verified. Trust these. Your narrative must stay grounded in them.)

${deathSummaries}

═══ DETERMINISTIC TACTICAL PATTERNS ═══
These are code-derived from verified facts. Use them as validator hints, not as the backbone, when the phase read proves the same mistake.

${tacticalPatternBlock}

${
  snapshotBlocks.positiveBlock
    ? `═══ ABILITY USAGE — WHAT WORKED ═══

${snapshotBlocks.positiveBlock}

`
    : ''
}${
  snapshotBlocks.antiPatternBlock
    ? `═══ ABILITY USAGE — ANTI-PATTERN FLAGS ═══

${snapshotBlocks.antiPatternBlock}

`
    : ''
}═══ OUTPUT JSON — EXACT SHAPE REQUIRED ═══
Return a single JSON object starting with { and ending with }. No prose, no markdown.

{
  "matchVerdict": "2-3 sentence summary of the match with the #1 takeaway",
  "priorityIssue": {
    "category": "positioning|crosshair|utility|economy|movement|game_sense|peeking|trading",
    "title": "5-10 word specific pattern title — NOT generic",
    "what_happened": "2-3 sentences explaining the pattern, citing specific death numbers and their facts (position, peek type, ability state, etc.)",
    "root_cause": "The underlying habit or belief — WHY the player keeps making this mistake",
    "what_to_do": "Step-by-step correction with a concrete Valorant example grounded in ${lockedAgent ?? 'the player'}'s kit and the specific facts above",
    "severity": "critical",
    "rounds_affected": ${deaths.length}
  },
  "secondaryIssues": [
    {
      "category": "one of the same list",
      "title": "...",
      "what_happened": "...",
      "root_cause": "...",
      "what_to_do": "...",
      "severity": "moderate",
      "rounds_affected": 0
    }
  ],
  "strengths": [
    "Specific positive grounded in specific deaths/facts",
    "Second specific positive"
  ],
  "sessionFocus": {
    "drill_name": "Short name of one focused drill",
    "drill_steps": "Step-by-step instructions the player can follow in a custom game or range, targeted at the priorityIssue",
    "drill_duration_minutes": 10,
    "in_game_cue": "≤6 words. A concrete trigger the player whispers before each round (e.g. 'C before W. Always.')"
  },
  "coachingContinuity": {
    "progress_note": "One sentence noting how the player evolved across this match or what to carry forward"
  },
  "overallGrade": "A|B|C|D|F",
  "deathCoaching": [
    {
      "death_number": 1,
      "situation": "1-3 sentences in plain English: where the player was, what they were doing, what info they had. Grounded in this death's facts.",
      "mistake": "1-3 sentences: the specific tactical error AND its root cause. Grounded in a specific fact (peek type, crosshair position, ability state, etc.).",
      "correction": "1-3 sentences: the concrete alternative the player HAD available. If an ability was ready, cite it by name. If a positional change was possible, describe it. End with a 'what would have happened' counterfactual when possible.",
      "category": "positioning|crosshair|utility|economy|movement|game_sense|peeking|trading|unclear",
      "avoidable": true
    }
  ]
}

IMPORTANT: emit one deathCoaching entry PER death in the facts above (${deaths.length} entries). Each entry must be grounded in that specific death's facts.`;

    // Synthesis call with primary model + fallback model + per-model retry.
    //
    // Strategy:
    //   1. Try primary model (SYNTHESIS_MODEL, default Gemini 2.5 Flash +
    //      thinking) with callWithRetry — honors Google's retryDelay for 429
    //      and exponential backoff for 503.
    //   2. If primary exhausts retries, fall to SYNTHESIS_FALLBACK_MODEL
    //      (default Gemma 3 27B — free, less rate-limited, text-only so no
    //      thinking config).
    //   3. If fallback also fails, the outer caller catches and uses the
    //      deterministic buildFallbackReport path.
    const callSynthesisModel = async (modelId: string): Promise<any> => {
      // Build thinkingConfig only for Gemini models — Gemma doesn't support it.
      //
      // Gemini 3.x uses thinkingLevel (MINIMAL/LOW/MEDIUM/HIGH) with no token
      // cap. Gemini 2.x uses thinkingBudget (integer token count).
      // Match both "gemini-3-flash-preview" (dash) and any future "gemini-3.1"
      // (dot) — the version separator after the "3" can be either.
      const isGemma = /^gemma-/i.test(modelId);
      const is3x = /^gemini-3[-.]/i.test(modelId);
      const thinkingConfig: Record<string, unknown> | undefined = isGemma
        ? undefined
        : is3x
          ? {
              thinkingLevel:
                env.SYNTHESIS_THINKING_BUDGET <= 0
                  ? 'MINIMAL'
                  : env.SYNTHESIS_THINKING_BUDGET <= 2048
                    ? 'LOW'
                    : 'MEDIUM',
            }
          : { thinkingBudget: env.SYNTHESIS_THINKING_BUDGET };

      const config: Record<string, unknown> = {
        temperature: 0.3,
        maxOutputTokens: 8192,
        systemInstruction: synthesisSystem,
        responseMimeType: 'application/json',
      };
      if (thinkingConfig) config.thinkingConfig = thinkingConfig;

      return this.ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: coachingPrompt }] }],
        config,
      });
    };

    let response: any;
    let usedModel: string = env.SYNTHESIS_MODEL;
    try {
      response = await this.callWithRetry(() => callSynthesisModel(env.SYNTHESIS_MODEL), 5);
    } catch (primaryErr: any) {
      const primaryStatus = primaryErr?.status ?? primaryErr?.code ?? '';
      const primaryMsg = String(primaryErr?.message ?? '').slice(0, 200);
      logger.warn(
        {
          primaryModel: env.SYNTHESIS_MODEL,
          fallbackModel: env.SYNTHESIS_FALLBACK_MODEL,
          primaryStatus,
          primaryMsg,
        },
        'Primary synthesis model exhausted retries — trying fallback model',
      );
      // Try fallback model. Same retry budget; if THIS fails too, throw
      // so the outer caller builds the deterministic fact-based report.
      response = await this.callWithRetry(
        () => callSynthesisModel(env.SYNTHESIS_FALLBACK_MODEL),
        3,
      );
      usedModel = env.SYNTHESIS_FALLBACK_MODEL;
      logger.info({ fallbackModel: usedModel }, 'Fallback synthesis model succeeded');
    }

    const rawReportText =
      response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
      response.text ||
      '{}';

    // Extract JSON using the same balanced-brace finder the per-death path
    // uses. Robust against: markdown fences, thinking text before/after JSON,
    // key-order variations. Previously a greedy regex matched from the first
    // `{"priorityIssue"` to the LAST `}` in the entire text, which broke when
    // Gemma appended stray JSON-like snippets after the main payload.
    // CRITICAL: this function MUST return a plain object (not array, not null,
    // not a primitive). Downstream code sets properties on the returned value
    // and then JSON.stringifies it — if the value is an array, the properties
    // are silently dropped by JSON.stringify, producing the 2026-04-20
    // "empty report but data was there" bug (stored JSONB was [{full report}]
    // instead of {full report}).
    //
    // Normalization handled here:
    //   - Strip markdown fences
    //   - Unwrap single-element arrays `[{...}]` → `{...}` (Gemma does this
    //     intermittently when responseMimeType='application/json' is set)
    //   - Reject arrays of 0 or 2+ elements, nulls, primitives
    //   - Walk balanced `{...}` blocks in prose as last resort
    const extractSynthesis = (raw: string): Record<string, any> | null => {
      if (!raw) return null;
      let text = raw;
      // Strip markdown fences
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence?.[1]) text = fence[1];

      // Helper: ensure the value is usable (object, not array/null/primitive).
      // Unwrap a single-element array around an object.
      const normalize = (v: unknown): Record<string, any> | null => {
        if (Array.isArray(v)) {
          // Gemma with responseMimeType:'application/json' sometimes returns
          // `[{...}]`. Unwrap if there's exactly one object inside.
          if (v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
            logger.warn(
              { wrapperArrayLength: v.length },
              '[extractSynthesis] unwrapped single-element array from Gemma response',
            );
            return v[0] as Record<string, any>;
          }
          return null;
        }
        if (v && typeof v === 'object') return v as Record<string, any>;
        return null;
      };

      // First try: plain parse of trimmed text, then normalize
      try {
        const parsed = JSON.parse(text.trim());
        const norm = normalize(parsed);
        if (norm) return norm;
        // If plain parse yielded something we can't use (e.g. empty array),
        // fall through to the balanced-brace walker.
      } catch {
        /* fall through */
      }

      // Walk every `{` and try balanced-brace parse, accept if it has any
      // known top-level synthesis key.
      const synthesisKeys = [
        'priorityIssue',
        'priority_issue',
        'matchVerdict',
        'match_verdict',
        'secondaryIssues',
        'strengths',
        'sessionFocus',
      ];
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        const block = findBalancedJson(text, i);
        if (!block) continue;
        try {
          const parsed = JSON.parse(block);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            if (synthesisKeys.some((k) => k in obj)) return obj as Record<string, any>;
          }
        } catch {
          /* keep walking */
        }
      }
      return null;
    };

    const parsedReport = extractSynthesis(rawReportText);
    const reportText = parsedReport ? JSON.stringify(parsedReport) : rawReportText;

    // Merge death analyses into report and ensure timestamps are present
    try {
      const rawParsed: unknown = parsedReport ?? JSON.parse(reportText.trim());

      // CRITICAL TYPE GUARD: if Gemma returned something that isn't a plain
      // object (array, null, primitive), we CANNOT set properties on it —
      // JSON.stringify would silently drop them and we'd land an empty report.
      // Throw so the retry + fallback path fires, guaranteeing the user
      // always sees a populated report built from the per-death analyses.
      if (!rawParsed || typeof rawParsed !== 'object' || Array.isArray(rawParsed)) {
        const shapeErr = new Error(
          `Synthesis output was not a plain JSON object (got ${Array.isArray(rawParsed) ? 'array' : typeof rawParsed})`,
        );
        (shapeErr as any).shape = Array.isArray(rawParsed) ? 'array' : typeof rawParsed;
        (shapeErr as any).rawPreview = rawReportText.slice(0, 300).replace(/\s+/g, ' ').trim();
        throw shapeErr;
      }
      const report = rawParsed as Record<string, any>;

      // Store raw death analyses separately
      report.rawDeathAnalyses = deaths;
      report.tacticalPatterns = tacticalPatterns;
      report.matchInfo = {
        gameMode: context.gameMode,
        map: context.map,
        agent: context.agent,
        durationMs: context.durationMs,
        deathCount: deaths.length,
      };

      // deathCoaching is now built DETERMINISTICALLY from the per-death analyses
      // we already ran. Previously we asked Gemma to re-emit all N death entries
      // in its synthesis JSON, but Gemma happily truncated to 5-6 entries on
      // long matches (an 18-death match produced only 5 in one test). Since
      // per-death analysis already has situation/mistake/correction/category
      // grounded in frames, rebuilding the timeline from that data guarantees
      // every successful death appears AND saves Gemma a heap of output
      // tokens on the synthesis call.
      //
      // We still merge any Gemma-supplied entries (e.g. overallGrade logic,
      // refinements) into the matching death, but the authoritative list of
      // entries comes from `deaths` — that's the non-negotiable contract.
      const synthEntries = (
        Array.isArray(report.deathCoaching)
          ? report.deathCoaching
          : Array.isArray(report.deaths)
            ? report.deaths
            : []
      ) as any[];
      const synthByNumber = new Map<number, any>();
      for (const e of synthEntries) {
        if (e && typeof e.death_number === 'number') synthByNumber.set(e.death_number, e);
      }
      report.deaths = undefined;

      const gradeForCategory = (cat: string | undefined, avoidable: boolean): string => {
        // Simple heuristic — only used when synthesis didn't emit a grade
        // for this death. Avoidable death = C-D; unavoidable trade = B.
        if (!avoidable) return 'B';
        if (cat === 'crosshair' || cat === 'decision') return 'D';
        return 'C';
      };

      report.deathCoaching = deaths.map((d) => {
        const synth = synthByNumber.get(d.death_number);
        const tactical = d.tactical;
        const deterministicPrimary =
          tactical?.primary && tactical.primary.code !== 'unclear_or_fair_duel'
            ? tactical.primary
            : null;
        const hasSynthMistake =
          typeof synth?.mistake === 'string' && synth.mistake.trim().length > 0;
        const hasSynthCorrection =
          typeof synth?.correction === 'string' && synth.correction.trim().length > 0;
        const hasSynthImprovement =
          typeof synth?.improvement === 'string' && synth.improvement.trim().length > 0;
        const avoidable =
          typeof synth?.avoidable === 'boolean' ? synth.avoidable : (tactical?.avoidable ?? true);
        const tacticalSituation = [
          d.mapLocation
            ? `At ${d.mapLocation}`
            : d.positionType
              ? `From a ${d.positionType.replace(/_/g, ' ')} position`
              : 'During this engagement',
          d.playerWeapon ? `with ${d.playerWeapon}` : '',
          d.decisionHP != null ? `at ${d.decisionHP} HP` : '',
          tactical?.primary.evidence ? `the visible facts show ${tactical.primary.evidence}.` : '',
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          death_number: d.death_number,
          approximate_time: formatTime(d.timestampSec),
          grade:
            typeof synth?.grade === 'string'
              ? synth.grade
              : gradeForCategory(d.category, avoidable),
          avoidable,
          killedBy: d.killerAgent ?? synth?.killedBy ?? null,
          killfeedMatchConfidence: d.killfeedMatchConfidence,
          weapon: d.killerWeapon ?? d.weapon ?? synth?.weapon ?? null, // legacy field = killer's weapon
          killerWeapon: d.killerWeapon ?? null,
          playerWeapon: d.playerWeapon ?? null,
          weaponAction: d.weaponAction ?? null,
          fireDiscipline: d.fireDiscipline ?? null,
          firstBulletThreat: d.firstBulletThreat ?? null,
          utilityUsed: d.utilityUsed ?? [],
          utilityEffect: d.utilityEffect ?? null,
          utilityEffectConfidence: d.utilityEffectConfidence,
          decisionHP: d.decisionHP ?? null,
          impactHP: d.impactHP ?? null,
          abilitiesUnused: Array.isArray(d.abilitiesUnused) ? d.abilitiesUnused : [],
          situation:
            typeof synth?.situation === 'string' && synth.situation.trim()
              ? synth.situation
              : d.situation || tacticalSituation || '',
          mistake: hasSynthMistake
            ? synth.mistake
            : d.mistake || deterministicPrimary?.rootCause || tactical?.primary.rootCause || '',
          correction: hasSynthCorrection
            ? synth.correction
            : hasSynthImprovement
              ? synth.improvement
              : d.correction ||
                d.improvement ||
                deterministicPrimary?.correction ||
                tactical?.primary.correction ||
                '',
          category:
            typeof synth?.category === 'string' && synth.category !== 'unclear'
              ? synth.category
              : (deterministicPrimary?.category ??
                tactical?.primary.category ??
                d.category ??
                'unclear'),
          confidence: tactical?.confidence ?? d.contextConfidence ?? 'medium',
          evidence: buildDeathEvidenceItems(d),
          unknowns: buildDeathUnknowns(d),
          timeline: buildDeathTimeline(d),
          sourceFrameRefs: d.evidenceSources ?? [],
          fightPhases: d.fightPhases ?? [],
          coachPausePoint: d.coachPausePoint ?? null,
          supportedProblems: d.supportedProblems ?? [],
          notProven: d.notProven ?? [],
          observerVersion: d.observerVersion,
          tactical: tactical
            ? {
                primary: tactical.primary,
                findings: tactical.findings,
                confidence: tactical.confidence,
              }
            : undefined,
        };
      });

      // ── Normalize shapes to what the UI actually consumes ────────────────
      // The UI (CoachingReportView.tsx + analysisStore.ts) expects:
      //   - sessionFocus: OBJECT with drill_name/drill_steps/drill_duration_minutes/in_game_cue
      //   - severity:     'critical' | 'moderate' | 'minor'  (never 'high'|'medium')
      //   - matchVerdict: string
      //   - coachingContinuity: { progress_note }
      // Gemma sometimes drifts on these (emits string sessionFocus, or severity='high').
      // We fix those deterministically without involving another LLM call.

      const normalizeSeverity = (v: unknown): 'critical' | 'moderate' | 'minor' => {
        if (typeof v !== 'string') return 'minor';
        const lc = v.trim().toLowerCase();
        if (lc === 'critical') return 'critical';
        if (lc === 'moderate' || lc === 'medium') return 'moderate';
        return 'minor';
      };

      const normalizeIssue = (issue: any): any => {
        if (!issue || typeof issue !== 'object') return issue;
        issue.severity = normalizeSeverity(issue.severity);
        if (typeof issue.rounds_affected !== 'number') {
          issue.rounds_affected =
            typeof issue.roundsAffected === 'number' ? issue.roundsAffected : 0;
        }
        return issue;
      };

      if (report.priorityIssue) normalizeIssue(report.priorityIssue);
      if (report.priority_issue) normalizeIssue(report.priority_issue);
      if (Array.isArray(report.secondaryIssues)) report.secondaryIssues.forEach(normalizeIssue);
      if (Array.isArray(report.secondary_issues)) report.secondary_issues.forEach(normalizeIssue);

      // sessionFocus must be an object. If Gemma returned a string, wrap it so
      // the UI's SessionFocusCard still renders something meaningful.
      if (report.sessionFocus && typeof report.sessionFocus === 'string') {
        report.sessionFocus = {
          drill_name: 'Session Focus',
          drill_steps: report.sessionFocus,
          drill_duration_minutes: 10,
          in_game_cue: '',
        };
      } else if (report.sessionFocus && typeof report.sessionFocus === 'object') {
        const sf = report.sessionFocus;
        if (typeof sf.drill_name !== 'string') sf.drill_name = 'Session Focus';
        if (typeof sf.drill_steps !== 'string') sf.drill_steps = '';
        if (typeof sf.drill_duration_minutes !== 'number') sf.drill_duration_minutes = 10;
        if (typeof sf.in_game_cue !== 'string') sf.in_game_cue = '';
      }

      // matchVerdict (camelCase) is what the UI reads. Ensure it's a string.
      if (typeof report.matchVerdict !== 'string' && typeof report.match_verdict === 'string') {
        report.matchVerdict = report.match_verdict;
      }
      if (typeof report.matchVerdict !== 'string') {
        report.matchVerdict = report.priorityIssue?.title ?? report.priority_issue?.title ?? '';
      }

      // coachingContinuity must be an object with progress_note string.
      if (!report.coachingContinuity || typeof report.coachingContinuity !== 'object') {
        if (report.coaching_continuity && typeof report.coaching_continuity === 'object') {
          report.coachingContinuity = report.coaching_continuity;
        } else {
          report.coachingContinuity = { progress_note: '' };
        }
      }
      if (typeof report.coachingContinuity.progress_note !== 'string') {
        report.coachingContinuity.progress_note = '';
      }

      // Final drift scrub on the synthesis output — catches any wrong-agent
      // leakage in priority/secondary issue text and per-death coaching entries.
      // With systemInstruction this should be a no-op; kept as belt-and-braces.
      if (lockedAgent) {
        const textFields = [
          'title',
          'what_happened',
          'root_cause',
          'what_to_do',
          'situation',
          'mistake',
          'correction',
          'improvement',
          'drill_name',
          'drill_steps',
          'in_game_cue',
          'progress_note',
        ];
        const scrubNode = (obj: any): void => {
          if (!obj || typeof obj !== 'object') return;
          for (const k of textFields) {
            if (typeof obj[k] === 'string') {
              const { scrubbed } = scrubAgentNames(obj[k], lockedAgent);
              obj[k] = scrubbed;
            }
          }
        };
        scrubNode(report.priorityIssue);
        scrubNode(report.priority_issue);
        if (Array.isArray(report.secondaryIssues)) report.secondaryIssues.forEach(scrubNode);
        if (Array.isArray(report.secondary_issues)) report.secondary_issues.forEach(scrubNode);
        if (Array.isArray(report.deathCoaching)) report.deathCoaching.forEach(scrubNode);
        if (Array.isArray(report.death_coaching)) report.death_coaching.forEach(scrubNode);
        scrubNode(report.sessionFocus);
        scrubNode(report.coachingContinuity);
        if (typeof report.matchVerdict === 'string') {
          report.matchVerdict = scrubAgentNames(report.matchVerdict, lockedAgent).scrubbed;
        }
        if (typeof report.match_verdict === 'string') {
          report.match_verdict = scrubAgentNames(report.match_verdict, lockedAgent).scrubbed;
        }
        if (Array.isArray(report.strengths)) {
          report.strengths = report.strengths.map((s: unknown) =>
            typeof s === 'string' ? scrubAgentNames(s, lockedAgent).scrubbed : s,
          );
        }
      }
      // DIAGNOSTIC: final shape generateCoaching is about to return.
      logger.info(
        {
          keys: Object.keys(report).sort(),
          deathCoachingLen: Array.isArray(report.deathCoaching)
            ? report.deathCoaching.length
            : 'not-array',
          hasPriorityIssue: (report as any).priorityIssue != null,
          rawResponseBytes: rawReportText.length,
          rawResponsePreview: rawReportText.slice(0, 200).replace(/\s+/g, ' ').trim(),
        },
        '[DIAG] generateCoaching returning',
      );
      return JSON.stringify(report);
    } catch (parseErr) {
      // Gemma occasionally emits malformed JSON under load (trailing commas,
      // stray quote-braces inside nested objects, truncated tokens, etc.).
      //
      // DO NOT silently return the raw unparseable text here — that swallows
      // the per-death analyses we already paid Gemma to produce. Instead,
      // throw with enough diagnostic info so the caller (processAnalysis-
      // Background) can decide: retry synthesis once, then fall back to a
      // structured report built deterministically from the DeathAnalysis[]
      // we hold in memory.
      //
      // Regression guard: if this catch ever goes back to `return reportText`,
      // any synthesis parse failure will strand the report in an empty state
      // in the DB and the UI will render blank (exact bug fixed 2026-04-19).
      const preview = rawReportText?.slice(0, 300).replace(/\s+/g, ' ').trim() ?? '';
      const synthErr = new Error(
        `Synthesis output was not parseable JSON: ${String(parseErr).slice(0, 120)}`,
      );
      (synthErr as any).cause = parseErr;
      (synthErr as any).rawPreview = preview;
      throw synthErr;
    }
  }

  // ── Structured fallback when synthesis fails ───────────────────────────────

  /** Build a complete, UI-compatible coaching report directly from the
   *  per-death DeathAnalysis[] we already have in memory. Fires when the
   *  Gemma synthesis call either errors or emits unparseable JSON twice in
   *  a row. Every field the UI reads is populated so the user still sees
   *  actionable per-death coaching instead of a blank page.
   *
   *  This is the LAST line of defense against Gemma JSON flakiness — it
   *  guarantees that if per-death analysis succeeded, the user sees that
   *  content no matter what happens in synthesis. */
  private buildFallbackReport(
    deaths: DeathAnalysis[],
    context: AnalyzeFramesInput,
    synthesisErr: unknown,
  ): string {
    const lockedAgent = context.agent && context.agent !== 'unknown' ? context.agent : null;

    // Stage 1 now produces FACTS only — situation/mistake/improvement/category
    // are always empty. When synthesis fails we deterministically derive
    // coaching strings from the facts. This is simpler than what stage 2
    // would have produced but still grounded and honest.
    const deriveFactCoaching = (
      d: DeathAnalysis,
    ): {
      situation: string;
      mistake: string;
      correction: string;
      category: string;
    } => {
      if (d.tactical) {
        const t = d.tactical.primary;
        const sitParts: string[] = [];
        if (d.mapLocation) sitParts.push(`At ${d.mapLocation}`);
        else if (d.positionType)
          sitParts.push(`From a ${d.positionType.replace(/_/g, ' ')} position`);
        if (d.playerWeapon) sitParts.push(`with a ${d.playerWeapon}`);
        if (d.decisionHP != null) sitParts.push(`at ${d.decisionHP} HP`);
        if (t.evidence) sitParts.push(`the visible facts show ${t.evidence}.`);
        return {
          situation:
            sitParts.length > 0
              ? sitParts.join(' ').replace(/\s+/g, ' ').trim()
              : 'Engagement details could not be fully extracted from the frames.',
          mistake: t.rootCause,
          correction: t.correction,
          category: t.category,
        };
      }

      // Situation: position + weapon + HP
      const sitParts: string[] = [];
      if (d.mapLocation) sitParts.push(`holding ${d.mapLocation}`);
      else if (d.positionType)
        sitParts.push(`playing a ${d.positionType.replace(/_/g, ' ')} position`);
      if (d.playerWeapon) sitParts.push(`with a ${d.playerWeapon}`);
      if (d.decisionHP != null) sitParts.push(`at ${d.decisionHP} HP`);
      const situation =
        sitParts.length > 0
          ? `${sitParts.join(' ').replace(/^([a-z])/, (c) => c.toUpperCase())}.`
          : 'Engagement details could not be fully extracted from the frames.';

      // Mistake + category: inferred from enum facts
      let mistake = '';
      let category = 'unclear';
      const prepAbilities = availableAbilityDetails(d, context.agent).filter((a) =>
        isPreContactUtility(a, context.agent),
      );
      if (d.weaponAction === 'reloading') {
        mistake =
          'Reloaded during the contact window while the angle was still dangerous; the gun was not ready when the enemy appeared.';
        category = 'game_sense';
      } else if (
        d.weaponAction === 'melee_out' ||
        d.weaponAction === 'switching_weapon' ||
        d.weaponAction === 'ability_out' ||
        d.weaponAction === 'no_gun_ready'
      ) {
        mistake = `Entered contact with weapon action=${d.weaponAction}, so the fight started before the gun was ready.`;
        category = 'game_sense';
      } else if (d.fireDiscipline === 'spray') {
        mistake =
          'Sprayed through the duel instead of resetting after the first bullets; the fight became recoil control instead of a clean tap/burst.';
        category = 'crosshair';
      } else if (d.firstBulletThreat === 'off_target' || d.firstBulletThreat === 'on_body') {
        mistake = `The first bullet did not threaten a headshot (${d.firstBulletThreat}), so the enemy got a full chance to fight back.`;
        category = 'crosshair';
      } else if (
        d.peekType === 'dry_swing' &&
        prepAbilities.length > 0 &&
        d.utilityUsed.length === 0
      ) {
        mistake = `Dry-swung into the angle with ${availableAbilityPhrase(prepAbilities)} ready — had role-appropriate utility to prep the peek but chose not to use it.`;
        category = 'utility';
      } else if (d.crosshairPlacement === 'below_head' || d.crosshairPlacement === 'above_head') {
        mistake = `Crosshair was ${d.crosshairPlacement.replace('_', ' ')} when the engagement started — lost the first-shot window before aiming up.`;
        category = 'crosshair';
      } else if (d.peekType === 'dry_swing') {
        mistake =
          'Wide-swung the angle with no utility and no info — turned the duel into a pure aim battle.';
        category = 'peeking';
      } else if (d.cover === 'exposed' && d.hadPreInfo === false) {
        mistake =
          'Pushed into an open sightline without pre-info — got caught before being able to react.';
        category = 'positioning';
      } else if (d.decisionHP != null && d.decisionHP < 50) {
        mistake = `Engaged at low HP (${d.decisionHP}) — a single successful shot from the enemy ended the fight.`;
        category = 'game_sense';
      } else if (d.movementState === 'running') {
        mistake = `Moving at full speed during the engagement — shots don't land accurately while running.`;
        category = 'movement';
      } else {
        mistake =
          "Facts for this death don't point to a single obvious root cause; see the death detail panel.";
      }

      // Correction: based on mistake + LIT abilities
      let correction = '';
      if (d.weaponAction === 'reloading') {
        correction =
          'Finish reloads only after tucking behind cover or after the angle is cleared. In contact, hold with the bullets you have or disengage first.';
      } else if (
        d.weaponAction === 'melee_out' ||
        d.weaponAction === 'switching_weapon' ||
        d.weaponAction === 'ability_out' ||
        d.weaponAction === 'no_gun_ready'
      ) {
        correction =
          'Do the swap/ability action behind cover, then re-peek with the gun ready. Never expose to a live angle during the equip animation.';
      } else if (
        d.fireDiscipline === 'spray' ||
        d.firstBulletThreat === 'off_target' ||
        d.firstBulletThreat === 'on_body'
      ) {
        correction =
          'Use a tap or short burst, then reset with a strafe if the first bullets miss. Do not drag a spray through a medium-range duel.';
      } else if (prepAbilities.length > 0 && d.utilityUsed.length === 0) {
        correction = `Next time, use ${availableAbilityPhrase(prepAbilities)} to prep the angle before committing — either gather info, deny vision, or create movement timing before you swing.`;
      } else if (d.cover !== 'full') {
        correction =
          'Take the fight from behind better cover, or hold the angle instead of swinging — let the enemy make the first move.';
      } else {
        correction =
          'Stronger pre-aim + counter-strafe before peeking. Keep crosshair at head height and stop moving the instant the enemy is visible.';
      }

      return { situation, mistake, correction, category };
    };

    // Most common derived category across deaths
    const factCoaching = deaths.map(deriveFactCoaching);
    const tacticalPatterns = summarizeTacticalPatterns(deaths);
    const catCount = new Map<string, number>();
    for (const fc of factCoaching) {
      if (fc.category && fc.category !== 'unclear') {
        catCount.set(fc.category, (catCount.get(fc.category) ?? 0) + 1);
      }
    }
    let topCategory = 'unclear';
    let topCount = 0;
    for (const [cat, count] of catCount) {
      if (count > topCount) {
        topCategory = cat;
        topCount = count;
      }
    }

    const mistakes = factCoaching.map((fc) => fc.mistake).filter((m) => m.length > 0);
    const improvements = factCoaching.map((fc) => fc.correction).filter((c) => c.length > 0);

    const matchVerdict = `Analyzed ${deaths.length} ${deaths.length === 1 ? 'death' : 'deaths'}${lockedAgent ? ` on ${lockedAgent}` : ''}. Match-level pattern synthesis was unavailable this run — the per-death breakdown below is fully grounded in the frames from each death.`;

    // Priority issue — use pattern when 2+ deaths share a category, else top death
    let priorityIssue: Record<string, unknown> | null = null;
    if (tacticalPatterns.length > 0) {
      const p = tacticalPatterns[0];
      priorityIssue = {
        category: p.category,
        severity: p.count >= deaths.length / 2 ? 'critical' : 'moderate',
        rounds_affected: p.count,
        title: p.title,
        what_happened: `${p.title} appeared in death${p.count > 1 ? 's' : ''} #${p.deathNumbers.join(', #')}. ${p.evidence.slice(0, 3).join(' ')}`,
        root_cause:
          deaths.find((d) => d.tactical?.primary.code === p.code)?.tactical?.primary.rootCause ??
          'The same tactical mistake repeated across multiple deaths.',
        what_to_do: p.correction,
      };
    } else if (topCount >= 2) {
      priorityIssue = {
        category: topCategory,
        severity: topCount >= deaths.length / 2 ? 'critical' : 'moderate',
        rounds_affected: topCount,
        title: `Recurring ${topCategory} issues across ${topCount} deaths`,
        what_happened:
          mistakes.slice(0, Math.min(3, topCount)).join(' — ') ||
          `${topCount} deaths categorized as ${topCategory}.`,
        root_cause:
          'Match-level root-cause synthesis was unavailable. The per-death breakdown ' +
          'below shows the exact observable for each death in this category.',
        what_to_do:
          improvements.slice(0, Math.min(3, topCount)).join(' — ') ||
          `Review each ${topCategory} death below and run the corrected play in a deathmatch warmup.`,
      };
    } else if (mistakes[0]) {
      priorityIssue = {
        category: deaths[0]?.category || 'unclear',
        severity: 'minor',
        rounds_affected: 1,
        title: mistakes[0].length > 80 ? `${mistakes[0].slice(0, 77)}...` : mistakes[0],
        what_happened: mistakes[0],
        root_cause:
          'Match-level synthesis was unavailable. See the per-death breakdown for full context.',
        what_to_do: improvements[0] || 'Review the death below and try the alternative play.',
      };
    }

    const secondaryIssues = mistakes.slice(1, 3).map((m, i) => ({
      category: deaths[i + 1]?.category || 'unclear',
      severity: 'minor' as const,
      rounds_affected: 1,
      title: m.length > 80 ? `${m.slice(0, 77)}...` : m,
      what_happened: m,
      root_cause: '',
      what_to_do: improvements[i + 1] || '',
    }));

    // Strengths — try to say something genuinely positive even on a rough match
    const strengths: string[] = [];
    const decisionHps = deaths
      .map((d) => d.decisionHP)
      .filter((hp): hp is number => typeof hp === 'number');
    if (decisionHps.length > 0) {
      const lowHpEngagements = decisionHps.filter((hp) => hp < 50).length;
      const goodHpEngagements = decisionHps.length - lowHpEngagements;
      if (goodHpEngagements > decisionHps.length / 2) {
        strengths.push(
          `${goodHpEngagements} of ${decisionHps.length} death engagements started with full or near-full HP — you were not consistently pushing fights at low HP.`,
        );
      }
    }
    // `avoidable` isn't in the DeathAnalysis type but flows through via the
    // `...parsed` spread in analyzeOneDeath — access with any-cast.
    const unavoidable = deaths.filter(
      (d) => typeof (d as any).avoidable === 'boolean' && !(d as any).avoidable,
    ).length;
    if (unavoidable > 0) {
      strengths.push(
        `${unavoidable} of ${deaths.length} deaths were clean trades or unavoidable engagements — you did not make a fixable mistake on those.`,
      );
    }
    if (strengths.length < 1) {
      strengths.push(
        'Keep playing and Scrima will build clearer patterns across matches as data grows.',
      );
    }

    const sessionFocus = {
      drill_name: priorityIssue
        ? `Fix the ${(priorityIssue as any).category} pattern`
        : 'Review per-death coaching',
      drill_steps:
        (priorityIssue as any)?.what_to_do ||
        'Open each death in the timeline below. Read the mistake and improvement fields. Re-watch the local clip from the recordings folder. Run the corrected play in a deathmatch warmup for 10 minutes.',
      drill_duration_minutes: 10,
      in_game_cue: priorityIssue
        ? `Before your next peek: check the ${(priorityIssue as any).category} cue.`
        : 'Before every engagement: pause, verify HP + abilities, commit only if both favor you.',
    };

    const coachingContinuity = {
      progress_note: `Analyzed ${deaths.length} of ${context.deaths.length} ${context.deaths.length === 1 ? 'death' : 'deaths'}. AI match-summary was unavailable — per-death coaching below is still fully grounded in frames.`,
    };

    const gradeForCat = (cat: string | undefined, avoidable: boolean): string => {
      if (!avoidable) return 'B';
      if (cat === 'crosshair' || cat === 'decision') return 'D';
      return 'C';
    };

    const deathCoaching = deaths.map((d, idx) => {
      const fc = factCoaching[idx];
      const avoidable = d.avoidable ?? true;
      return {
        death_number: d.death_number,
        approximate_time: formatTime(d.timestampSec),
        grade: gradeForCat(fc.category, avoidable),
        avoidable,
        killedBy: d.killerAgent ?? null,
        killfeedMatchConfidence: d.killfeedMatchConfidence,
        weapon: d.killerWeapon ?? d.weapon ?? null,
        killerWeapon: d.killerWeapon ?? null,
        playerWeapon: d.playerWeapon ?? null,
        weaponAction: d.weaponAction ?? null,
        fireDiscipline: d.fireDiscipline ?? null,
        firstBulletThreat: d.firstBulletThreat ?? null,
        utilityUsed: d.utilityUsed ?? [],
        utilityEffect: d.utilityEffect ?? null,
        utilityEffectConfidence: d.utilityEffectConfidence,
        decisionHP: d.decisionHP ?? null,
        impactHP: d.impactHP ?? null,
        abilitiesUnused: Array.isArray(d.abilitiesUnused) ? d.abilitiesUnused : [],
        situation: fc.situation,
        mistake: fc.mistake,
        correction: fc.correction,
        category: fc.category,
        confidence: d.tactical?.confidence ?? d.contextConfidence ?? 'medium',
        evidence: buildDeathEvidenceItems(d),
        unknowns: buildDeathUnknowns(d),
        timeline: buildDeathTimeline(d),
        sourceFrameRefs: d.evidenceSources ?? [],
        fightPhases: d.fightPhases ?? [],
        coachPausePoint: d.coachPausePoint ?? null,
        supportedProblems: d.supportedProblems ?? [],
        notProven: d.notProven ?? [],
        observerVersion: d.observerVersion,
        tactical: d.tactical
          ? {
              primary: d.tactical.primary,
              findings: d.tactical.findings,
              confidence: d.tactical.confidence,
            }
          : undefined,
      };
    });

    return JSON.stringify({
      reportSchemaVersion:
        context.evidenceVersion && context.evidenceVersion >= 5
          ? 5
          : context.evidenceVersion && context.evidenceVersion >= 4
            ? 4
            : 3,
      matchVerdict,
      priorityIssue,
      secondaryIssues,
      strengths,
      sessionFocus,
      coachingContinuity,
      deathCoaching,
      // Preserve the per-death analyses verbatim so any future retry-synthesis
      // endpoint can re-run the Gemma pass without re-billing per-death calls.
      rawDeathAnalyses: deaths,
      tacticalPatterns,
      analysisMetadata: {
        totalDeaths: context.deaths.length,
        analyzedDeaths: deaths.length,
        failedDeaths: Math.max(0, context.deaths.length - deaths.length),
        evidenceVersion: context.evidenceVersion ?? 1,
        evidencePipeline:
          context.evidenceVersion && context.evidenceVersion >= 5
            ? 'fight-v5-evidence'
            : context.evidenceVersion && context.evidenceVersion >= 4
              ? 'fight-v4-evidence'
              : context.evidenceVersion && context.evidenceVersion >= 3
                ? 'frame-v3-evidence'
                : 'frame-legacy',
      },
      matchInfo: {
        gameMode: context.gameMode,
        map: context.map,
        agent: context.agent,
        durationMs: context.durationMs,
        deathCount: deaths.length,
      },
      detectedAgent: lockedAgent,
      detectedMap: context.map && context.map !== 'unknown' ? context.map : null,
      overallGrade: 'C',
      // Analytics hook: lets us measure how often synthesis fallback fires in prod
      synthesisStatus: 'fallback_after_parse_failure',
      synthesisErrorPreview:
        synthesisErr instanceof Error
          ? String(synthesisErr.message).slice(0, 200)
          : String(synthesisErr ?? 'unknown').slice(0, 200),
    });
  }

  // ── Brain updates ──────────────────────────────────────────────────────────

  private async updateBrain(
    reportId: string,
    userId: string,
    reportObj: any,
    agent?: string,
    map?: string,
  ): Promise<void> {
    const brain = new BrainContextService(db);
    await brain.updateFromReport(userId, reportId, reportObj, agent, map);
  }

  // ── Agent/Map identification from context frame ────────────────────────────

  private async identifyAgentAndMap(
    base64Jpeg: string,
  ): Promise<{ agent: string | null; map: string | null }> {
    // Gemma will happily invent agent/map names ("Miks", "Ridge", etc.) if we
    // ask open-ended. We pass the full allowlist into the prompt AND validate
    // the response against it — anything not on the list becomes null.
    const agentList = VALID_AGENTS.join(', ');
    const mapList = VALID_MAPS.join(', ');

    const response = await this.ai.models.generateContent({
      model: this.modelId,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
            {
              text: `Screenshot from a Valorant match. Identify the PLAYER's agent and the MAP.

Agent portrait: bottom-left corner. Ability icons: bottom-center.
Minimap: top-left corner. Environment: the 3D scene itself.

Your answer MUST be drawn from these lists. Do NOT invent names.
Valid agents: ${agentList}
Valid maps: ${mapList}

If the agent OR map is not clearly one of those listed, use null for that
field. Never guess — null is always better than a wrong name.

Respond with ONLY this JSON, nothing else:
{"agent": "<exact name from list or null>", "map": "<exact name from list or null>"}`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 256,
        // Agent portrait is bottom-left (~5% of screen) and map loading text
        // is small — both need HIGH tiling to be legibly read by Gemma.
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
        responseMimeType: 'application/json',
      },
    });

    const rawText =
      response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
      response.text ||
      '{}';
    let parsed: { agent: string | null; map: string | null };
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText.trim());
    } catch {
      return { agent: null, map: null };
    }

    // Case-insensitive allowlist check. Normalise to the canonical casing
    // (KAY/O, Breach, etc.) by finding the matching entry in the valid list.
    const matchOrNull = (candidate: unknown, valid: string[]): string | null => {
      if (typeof candidate !== 'string') return null;
      const lc = candidate.trim().toLowerCase();
      if (!lc || lc === 'null' || lc === 'unknown') return null;
      return valid.find((v) => v.toLowerCase() === lc) ?? null;
    };

    const agent = matchOrNull(parsed.agent, VALID_AGENTS);
    const map = matchOrNull(parsed.map, VALID_MAPS);

    // If the model returned a string that wasn't on the list, log it once so
    // we can see what it's hallucinating. Helps us judge whether the prompt
    // needs another round of tightening.
    if (typeof parsed.agent === 'string' && !agent) {
      logger.warn({ candidate: parsed.agent }, 'Rejected hallucinated agent name');
    }
    if (typeof parsed.map === 'string' && !map) {
      logger.warn({ candidate: parsed.map }, 'Rejected hallucinated map name');
    }

    return { agent, map };
  }

  // ── Retry helper for Gemini 503/429 ────────────────────────────────────────
  //
  // Two retryable errors have very different meanings:
  //   • 429 RESOURCE_EXHAUSTED — rate-limit hit. Google tells us EXACTLY how
  //     long to wait via the retryDelay field in the error body. Honor it.
  //   • 503 UNAVAILABLE — upstream model overload. Exponential backoff is
  //     the right pattern; the surge usually clears in 5-30s.
  // We parse the Google error body to distinguish them instead of using a
  // fixed-delay schedule for both.

  private parseRetryDelayMs(err: any): number | null {
    const msg = String(err?.message ?? '');
    // Pattern 1: "Please retry in 21.773420952s."
    const m1 = msg.match(/retry in ([\d.]+)s/i);
    if (m1) {
      const secs = Number.parseFloat(m1[1]);
      if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs * 1000);
    }
    // Pattern 2: structured RetryInfo in error body — "retryDelay":"21s"
    const m2 = msg.match(/"retryDelay":"(\d+)s"/);
    if (m2) {
      const secs = Number.parseInt(m2[1], 10);
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }
    return null;
  }

  private async callWithRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.status ?? err?.code;
        const msg = String(err?.message ?? '');
        const is429 = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const is503 =
          status === 503 ||
          msg.includes('503') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('high demand');
        const isRetryable = is429 || is503;
        if (!isRetryable || attempt >= maxRetries) throw err;

        // Honor Google's retryDelay when provided (429), else exponential
        // backoff capped at 30s (503). Add 10% jitter to avoid thundering-herd
        // behavior when multiple workers are waiting on the same quota.
        const googleDelay = is429 ? this.parseRetryDelayMs(err) : null;
        const expDelay = Math.min(2000 * 2 ** attempt, 30000);
        const baseDelay = googleDelay ?? expDelay;
        const jittered = baseDelay + Math.random() * baseDelay * 0.1;

        logger.info(
          {
            attempt: attempt + 1,
            maxRetries,
            delay: Math.round(jittered),
            errorType: is429 ? '429' : '503',
          },
          `Gemini ${is429 ? 'rate-limited' : 'overloaded'} — backing off`,
        );
        await new Promise((r) => setTimeout(r, jittered));
      }
    }
    throw new Error('Unreachable');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
