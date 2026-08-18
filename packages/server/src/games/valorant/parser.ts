import type { CoachingReport } from '@scrima/shared';
import type {
  VerifiedDeath,
  VerifiedPlayerAgent,
} from '../../services/coaching/fact-verification.service.js';
import { VALID_AGENTS, VALID_WEAPONS } from './knowledge.js';

// Weapon names the VLM might confuse — normalize common misidentifications
const WEAPON_SET = new Set(VALID_WEAPONS.map((w) => w.toLowerCase()));

// ── Category enum validation ────────────────────────────────────────────────
// The VLM sometimes emits off-enum categories (e.g. "decision") despite the
// structured-output schema. Normalize them here so downstream skill mapping,
// graph ingestion, and BKT updates always see a valid category.
const VALID_CATEGORIES = new Set([
  'crosshair',
  'positioning',
  'utility',
  'economy',
  'movement',
  'game_sense',
  'peeking',
  'trading',
  'unclear',
]);

// Known off-enum emissions remapped to the closest valid category.
// Keep this tight — unknown categories fall through to 'unclear' rather than
// being force-fit into a category we'd later have to defend.
const CATEGORY_REMAP: Record<string, string> = {
  decision: 'game_sense',
  rotation: 'game_sense',
  spray_control: 'crosshair',
  outplayed: 'unclear',
  unknown: 'unclear',
};

function validateCategory(raw: unknown): string {
  if (typeof raw !== 'string') return 'unclear';
  const cat = raw.toLowerCase().trim();
  if (VALID_CATEGORIES.has(cat)) return cat;
  const remapped = CATEGORY_REMAP[cat];
  if (remapped) return remapped;
  return 'unclear';
}

/** Map weapon enum category codes to readable descriptions */
const WEAPON_CATEGORY_LABELS: Record<string, string> = {
  unknown_rifle: 'a rifle',
  unknown_sidearm: 'a sidearm',
  unknown_smg: 'an SMG',
  unknown_sniper: 'a sniper',
  unknown_shotgun: 'a shotgun',
  unknown_heavy: 'a heavy weapon',
  unknown_melee: 'melee',
  unknown: 'a weapon',
};

/**
 * Post-process a death coaching entry to strip uncertain claims.
 * When the VLM marks weapon or enemy identification as "uncertain",
 * replace the specific name with a generic description to prevent hallucinations.
 */
function stripUncertainClaims(death: any): any {
  const result = { ...death };

  // If weapon confidence is uncertain, replace with generic category label
  if (result.weapon_confidence === 'uncertain' && result.weapon_used) {
    const label = WEAPON_CATEGORY_LABELS[result.weapon_used];
    if (!label) {
      // It's a specific weapon name but marked uncertain — downgrade to category
      const weaponLower = result.weapon_used.toLowerCase();
      if (['classic', 'shorty', 'frenzy', 'ghost', 'sheriff'].some((w) => w === weaponLower)) {
        result.weapon_used = 'unknown_sidearm';
      } else if (['stinger', 'spectre'].some((w) => w === weaponLower)) {
        result.weapon_used = 'unknown_smg';
      } else if (['bulldog', 'guardian', 'phantom', 'vandal'].some((w) => w === weaponLower)) {
        result.weapon_used = 'unknown_rifle';
      } else if (['marshal', 'operator', 'outlaw'].some((w) => w === weaponLower)) {
        result.weapon_used = 'unknown_sniper';
      } else if (['bucky', 'judge'].some((w) => w === weaponLower)) {
        result.weapon_used = 'unknown_shotgun';
      } else if (['ares', 'odin'].some((w) => w === weaponLower)) {
        result.weapon_used = 'unknown_heavy';
      } else {
        result.weapon_used = 'unknown';
      }
    }
  }

  // If enemy agent confidence is uncertain, replace with generic
  if (
    result.killed_by_confidence === 'uncertain' &&
    result.killed_by &&
    result.killed_by !== 'an enemy'
  ) {
    result.killed_by = 'an enemy';
  }

  // Scrub uncertain weapon/enemy names from situation and mistake text
  if (result.weapon_confidence === 'uncertain') {
    const weaponLabel = WEAPON_CATEGORY_LABELS[result.weapon_used] || 'a weapon';
    result.situation = scrubSpecificWeaponNames(result.situation, weaponLabel);
    result.mistake = scrubSpecificWeaponNames(result.mistake, weaponLabel);
  }
  if (result.killed_by_confidence === 'uncertain') {
    result.situation = scrubSpecificAgentNames(result.situation);
    result.mistake = scrubSpecificAgentNames(result.mistake);
  }

  return result;
}

/** Replace specific weapon names in text with a generic label when uncertain */
function scrubSpecificWeaponNames(text: string, replacement: string): string {
  if (!text) return text;
  return text.replace(
    /\b(with|holding|using|equipped|had)\s+(an?\s+)?(\w+)/gi,
    (match, verb, _article, weapon) => {
      const lower = weapon.toLowerCase();
      if (WEAPON_SET.has(lower)) {
        return `${verb} ${replacement}`;
      }
      return match;
    },
  );
}

/** Replace specific agent names in text with "an enemy" when uncertain */
function scrubSpecificAgentNames(text: string): string {
  if (!text) return text;
  // Build regex dynamically from VALID_AGENTS (already imported at top of file)
  const escaped = VALID_AGENTS.map((a: string) => a.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'));
  const agentPattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
  return text.replace(agentPattern, 'an enemy');
}

/**
 * Parse Gemini's structured JSON output into the canonical CoachingReport shape.
 * Handles both camelCase and snake_case field names from the VLM.
 *
 * The returned object extends CoachingReport with additional game-specific
 * fields (deathCoaching, priorityIssue, etc.) stored in the JSONB blob.
 */
export function parseValorantReport(
  json: Record<string, unknown>,
): CoachingReport & Record<string, unknown> {
  // Check video_validation — if the model rejected the video, return a rejection report
  const validation = json.video_validation as any;
  if (validation && validation.is_valorant === false) {
    const reason = validation.rejection_reason || 'This does not appear to be Valorant gameplay.';
    return {
      ...json,
      rejected: true,
      rejectionReason: reason,
      deathCoaching: [],
      gameMode: 'unknown',
      overallAssessment: reason,
      matchVerdict: reason,
      priorityIssue: null,
      secondaryIssues: [],
      strengths: [],
      sessionFocus: null,
      coachingContinuity: null,
      moments: [],
      topIssues: [],
      positiveHighlights: [],
      drills: [],
    };
  }

  // Per-death coaching entries — apply post-processing to strip uncertain claims
  const deathCoaching = ((json.death_coaching ?? []) as any[]).map((d: any) => {
    const raw = {
      death_number: d.death_number ?? 0,
      approximate_time: d.approximate_time ?? '',
      situation: d.situation ?? '',
      mistake: d.mistake ?? '',
      correction: d.correction ?? '',
      category: validateCategory(d.category),
      avoidable: d.avoidable ?? true,
      weapon_used: d.weapon_used ?? 'unknown',
      weapon_confidence: d.weapon_confidence ?? 'uncertain',
      killed_by: d.killed_by ?? 'an enemy',
      killed_by_confidence: d.killed_by_confidence ?? 'uncertain',
      visual_evidence: d.visual_evidence ?? '',
      coaching_priority: d.coaching_priority ?? 3,
    };
    return stripUncertainClaims(raw);
  });

  // Map priority_pattern → priorityIssue (frontend type)
  const pp = json.priority_pattern as any;
  const priorityIssue = pp
    ? {
        category: validateCategory(pp.category),
        severity: 'critical' as const,
        rounds_affected: pp.death_count ?? 0,
        title: pp.title ?? '',
        what_happened: pp.what_happened ?? pp.why_it_hurts ?? '',
        root_cause: pp.why_it_hurts ?? '',
        what_to_do: pp.fix ?? '',
      }
    : null;

  // Map secondary_patterns → secondaryIssues
  const secondaryIssues = ((json.secondary_patterns ?? []) as any[]).map((sp: any) => ({
    category: validateCategory(sp.category),
    severity: 'moderate' as const,
    rounds_affected: sp.death_count ?? 0,
    title: sp.title ?? '',
    what_happened: sp.what_happened ?? sp.title ?? '',
    root_cause: sp.what_happened ?? '',
    what_to_do: sp.fix ?? '',
  }));

  // Map to shared CoachingIssue shape for topIssues
  const topIssues = secondaryIssues.map((s) => ({
    category: s.category,
    frequency: `${s.rounds_affected} deaths`,
    description: s.what_happened,
    drill: s.what_to_do,
  }));

  // Map strengths to positiveHighlights shape
  const strengths = (json.strengths as string[]) ?? [];
  const positiveHighlights = strengths.map((s) => ({
    timestamp: '',
    description: s,
  }));

  // Coaching continuity (VLM-generated progress note)
  const cc = json.coaching_continuity as any;
  const coachingContinuity = cc ? { progress_note: cc.progress_note ?? '' } : null;

  return {
    ...json,
    deathCoaching,
    gameMode: (json.game_mode as string) ?? (json.gameMode as string) ?? 'competitive',
    overallAssessment: (json.match_verdict as string) ?? '',
    matchVerdict: (json.match_verdict as string) ?? '',
    priorityIssue,
    secondaryIssues,
    strengths,
    sessionFocus: (json.session_focus as any) ?? null,
    coachingContinuity,
    moments: [],
    topIssues,
    positiveHighlights,
    drills: [],
  };
}

/**
 * Return the player agent from the report.
 * Pass 1 (full video analysis) is the authoritative source for agent identification.
 * Enrichment (Pass 2) does NOT re-identify the agent — it only refines coaching facts.
 *
 * Returns the agent name from Pass 1.
 */
export function applyVerifiedAgent(
  report: Record<string, unknown>,
  _verifiedAgent: VerifiedPlayerAgent | null,
): string {
  const validation = report.video_validation as any;
  if (!validation) return (report as any).detectedAgent ?? 'unknown';

  return validation.detected_agent ?? 'unknown';
}

// ── Fact Verification Merge ──────────────────────────────────────────────────

const VALID_WEAPON_SET = new Set(VALID_WEAPONS.map((w) => w.toLowerCase()));
const VALID_AGENT_SET = new Set(VALID_AGENTS.map((a) => a.toLowerCase()));

/**
 * Merge enriched facts from the high-res enrichment pass into the
 * death coaching entries from the main analysis.
 *
 * The enrichment pass REWRITES situation/mistake/correction with verified facts
 * from high-res frames while preserving the coaching insight from the low-res
 * video analysis. Enriched text replaces original text entirely.
 *
 * For entries WITHOUT enrichment data, downgrade video claims to uncertain
 * and strip specific names (the video was guessing).
 */
export function mergeEnrichedFacts(deathCoaching: any[], verified: VerifiedDeath[]): any[] {
  if (!verified || verified.length === 0) {
    // No enrichment data at all — downgrade ALL video claims to uncertain
    return deathCoaching.map((death) =>
      stripUncertainClaims({
        ...death,
        weapon_confidence: 'uncertain',
        killed_by_confidence: 'uncertain',
      }),
    );
  }

  // Index enriched entries by death_number for fast lookup
  const enrichedMap = new Map<number, VerifiedDeath>();
  for (const v of verified) {
    enrichedMap.set(v.death_number, v);
  }

  return deathCoaching.map((death) => {
    const v = enrichedMap.get(death.death_number);

    if (!v) {
      // No enrichment for this death — downgrade video claims
      return stripUncertainClaims({
        ...death,
        weapon_confidence: 'uncertain',
        killed_by_confidence: 'uncertain',
      });
    }

    const merged = { ...death };

    // Enriched coaching text — replaces original entirely when available
    if (v.situation) merged.situation = v.situation;
    if (v.mistake) merged.mistake = v.mistake;
    if (v.correction) merged.correction = v.correction;

    // Weapon: enrichment ALWAYS overrides video analysis
    if (v.weapon_used && v.weapon_confidence === 'certain') {
      const validWeapon =
        VALID_WEAPON_SET.has(v.weapon_used.toLowerCase()) || v.weapon_used.startsWith('unknown_');
      if (validWeapon) {
        merged.weapon_used = v.weapon_used;
        merged.weapon_confidence = 'certain';
      }
    } else {
      merged.weapon_confidence = 'uncertain';
    }

    // Killed by: enrichment ALWAYS overrides video analysis
    if (v.killed_by && v.killed_by_confidence === 'certain') {
      const validAgent =
        VALID_AGENT_SET.has(v.killed_by.toLowerCase()) || v.killed_by === 'an enemy';
      if (validAgent) {
        merged.killed_by = v.killed_by;
        merged.killed_by_confidence = 'certain';
      }
    } else {
      merged.killed_by_confidence = 'uncertain';
    }

    // Map location from enrichment
    if (v.map_location && v.map_location !== 'unknown') {
      merged.map_location = v.map_location;
    }

    // Abilities available
    if (v.abilities_available && v.abilities_available.length > 0) {
      merged.abilities_available = v.abilities_available;
    }

    // Strip uncertain claims from structured fields (text is already correct from enrichment)
    if (merged.weapon_confidence === 'uncertain' || merged.killed_by_confidence === 'uncertain') {
      return stripUncertainClaims(merged);
    }

    return merged;
  });
}
