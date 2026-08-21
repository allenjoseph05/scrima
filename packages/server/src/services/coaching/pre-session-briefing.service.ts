/**
 * Pre-Session Briefing Service (Phase 4)
 *
 * Assembles the "Before you play" Dashboard card from existing brain data.
 * Does NOT write any new data on read — this is purely a read-side compose
 * over coachingReports, playerObservations, coachingGraphNodes, and the
 * Phase 3 bottleneck compass.
 *
 * See: docs/YOUR_COACH_PHASE4_PLAN.md
 */

import { GoogleGenAI } from '@google/genai';
import { and, desc, eq, sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { Db } from '../../db/index.js';
import {
  coachingGraphNodes,
  coachingReports,
  matches,
  playerObservations,
} from '../../db/schema.js';
import { sanitizeAgentMapNames } from '../../games/valorant/prompts.js';
import { BottleneckCompassService } from './bottleneck-compass.service.js';

// ── Return shape ────────────────────────────────────────────────────────────

export interface Briefing {
  sessionNumber: number;

  detected?: {
    primarySkillId?: string;
    primarySkillName?: string;
    domain?: string;
  };

  practice: {
    drillName: string;
    drillSteps: string;
    durationMinutes: number;
  } | null;

  // LOOK FOR — mental rule to apply in-game. Short cue + rich deployment.
  lookFor: {
    cue: string; // short mantra
    context: string; // recent stat / observation
    when?: string; // trigger moment
    check?: string; // physical/mental check
    ifYes?: string; // action if check passes
    ifNo?: string; // action if check fails
  } | null;

  // AVOID — signature miss pattern with specific trigger + alternative.
  avoid: {
    pattern: string; // short label
    occurrenceLine: string;
    signature?: string; // one-line description of playstyle miss
    trigger?: string; // game situation to recognize
    instinct?: string; // what the player usually does wrong
    rule?: string; // what to do instead
  } | null;

  // Single auto-generated rule for today. Player can commit to it.
  todayRule: string | null;

  currentCommitment: {
    focus: string;
    committedAt: string;
  } | null;
}

// ── Enrichment LLM response shape ───────────────────────────────────────────

interface EnrichedSections {
  lookFor: { when: string; check: string; ifYes: string; ifNo: string } | null;
  avoid: { signature: string; trigger: string; instinct: string; rule: string } | null;
  todayRule: string | null;
}

// ── Cache ───────────────────────────────────────────────────────────────────

const BRIEFING_CACHE_TTL_MS = 10 * 60 * 1000;
const enrichmentCache = new Map<string, { payload: EnrichedSections; expiresAt: number }>();

// ── Defaults when data is sparse ────────────────────────────────────────────

const DEFAULT_RULE_FALLBACK =
  "Stay deliberate. One conscious, focused peek every round is today's win.";

// ── Service ─────────────────────────────────────────────────────────────────

export class PreSessionBriefingService {
  constructor(private db: Db) {}

  async assemble(userId: string): Promise<Briefing> {
    // ── 1. Session number (count of completed reports + 1 for the *next* one) ─
    const reportCountRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(coachingReports)
      .where(and(eq(coachingReports.userId, userId), eq(coachingReports.status, 'completed')));
    const completedCount = Number(reportCountRows[0]?.count ?? 0);
    const sessionNumber = completedCount + 1;

    // ── 2. Latest completed report — source of session focus / drill ──────
    const latestReportRows = await this.db
      .select({ report: coachingReports.report })
      .from(coachingReports)
      .where(and(eq(coachingReports.userId, userId), eq(coachingReports.status, 'completed')))
      .orderBy(desc(coachingReports.createdAt))
      .limit(1);
    const latestReport = latestReportRows[0]?.report as any | undefined;
    const sessionFocus = latestReport?.sessionFocus ?? latestReport?.session_focus ?? null;

    // ── 3. Compass — reuses Phase 3 service ────────────────────────────────
    const compassService = new BottleneckCompassService(this.db);
    const compass = await compassService.compute(userId);

    // ── 4. Observations — top unconfirmed habit/insight for LOOK FOR context ─
    const obsRows = await this.db
      .select()
      .from(playerObservations)
      .where(and(eq(playerObservations.userId, userId), eq(playerObservations.archived, false)))
      .orderBy(desc(playerObservations.occurrences), desc(playerObservations.lastSeenAt))
      .limit(20);

    // Prefer unconfirmed observations (player hasn't agreed/disagreed yet)
    const topUnconfirmed = obsRows.find((o) => !o.confirmedAt && !o.disagreedAt);
    const topHabit = obsRows.find((o) => o.category === 'habit' && (o.confidence ?? 0.5) > 0);

    // ── 5. Pattern aggregation from last ~30 graph nodes ───────────────────
    const patternNodes = await this.db
      .select({
        label: coachingGraphNodes.label,
        data: coachingGraphNodes.data,
      })
      .from(coachingGraphNodes)
      .where(and(eq(coachingGraphNodes.userId, userId), eq(coachingGraphNodes.nodeType, 'pattern')))
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(30);

    const categoryCounts = new Map<string, { count: number; lastExample: string }>();
    for (const node of patternNodes) {
      const cat = (node.data as any)?.category ?? 'unknown';
      const existing = categoryCounts.get(cat);
      if (existing) existing.count += 1;
      else categoryCounts.set(cat, { count: 1, lastExample: node.label });
    }

    const topPatternEntry = Array.from(categoryCounts.entries()).sort(
      (a, b) => b[1].count - a[1].count,
    )[0];
    const topPattern =
      topPatternEntry && topPatternEntry[1].count >= 2
        ? {
            category: topPatternEntry[0],
            count: topPatternEntry[1].count,
            example: topPatternEntry[1].lastExample,
          }
        : null;

    // ── 6. Latest focus_commitment — show committed state if any ──────────
    const commitmentRows = await this.db
      .select({
        label: coachingGraphNodes.label,
        createdAt: coachingGraphNodes.createdAt,
      })
      .from(coachingGraphNodes)
      .where(
        and(
          eq(coachingGraphNodes.userId, userId),
          eq(coachingGraphNodes.nodeType, 'focus_commitment'),
        ),
      )
      .orderBy(desc(coachingGraphNodes.createdAt))
      .limit(1);

    const currentCommitment = commitmentRows[0]
      ? {
          focus: commitmentRows[0].label,
          committedAt: commitmentRows[0].createdAt.toISOString(),
        }
      : null;

    // ── 7. Pull rank from latest match for enrichment context.
    // Note: we deliberately do NOT pass the last-played agent — the player may
    // switch agents between games, so the briefing must be agent-agnostic.
    const lastMatchRow = await this.db
      .select({ rank: matches.rank })
      .from(matches)
      .where(eq(matches.userId, userId))
      .orderBy(desc(matches.playedAt))
      .limit(1);
    const rank = lastMatchRow[0]?.rank ?? undefined;

    // ── 8. Compose raw briefing (pre-enrichment) ──────────────────────────
    const practice =
      sessionFocus &&
      typeof sessionFocus === 'object' &&
      typeof sessionFocus.drill_name === 'string'
        ? {
            drillName: sessionFocus.drill_name,
            drillSteps:
              typeof sessionFocus.drill_steps === 'string' ? sessionFocus.drill_steps : '',
            durationMinutes:
              typeof sessionFocus.drill_duration_minutes === 'number'
                ? sessionFocus.drill_duration_minutes
                : 15,
          }
        : null;

    const baseLookFor =
      sessionFocus &&
      typeof sessionFocus === 'object' &&
      typeof sessionFocus.in_game_cue === 'string' &&
      sessionFocus.in_game_cue.length > 0
        ? {
            cue: sessionFocus.in_game_cue,
            context: topUnconfirmed?.text ?? topHabit?.text ?? '',
          }
        : null;

    const baseAvoid = topPattern
      ? {
          pattern: topPattern.example,
          occurrenceLine: `Flagged in ${topPattern.count} of your recent games`,
        }
      : null;

    // ── 9. Enrich with LLM (cache-backed; skip if no signal) ──────────────
    const hasEnrichableSignal = compass.state === 'ready' || !!baseLookFor || !!baseAvoid;
    const enriched = hasEnrichableSignal
      ? await this.enrichWithLLM(userId, {
          sessionNumber,
          bottleneckName: compass.state === 'ready' ? compass.primary.name : undefined,
          bottleneckDomain: compass.state === 'ready' ? compass.primary.domain : undefined,
          bottleneckBlockedCount:
            compass.state === 'ready' ? compass.primary.blockedCount : undefined,
          drillName: practice?.drillName ? sanitizeAgentMapNames(practice.drillName) : undefined,
          drillSteps: practice?.drillSteps ? sanitizeAgentMapNames(practice.drillSteps) : undefined,
          cue: baseLookFor?.cue,
          observationHint: baseLookFor?.context
            ? sanitizeAgentMapNames(baseLookFor.context)
            : undefined,
          topPatternCategory: topPattern?.category,
          topPatternExample: topPattern?.example
            ? sanitizeAgentMapNames(topPattern.example)
            : undefined,
          topPatternCount: topPattern?.count,
          rank,
        })
      : { lookFor: null, avoid: null, todayRule: null };

    // Merge enriched content onto base, preserving fallbacks
    const lookFor = baseLookFor
      ? {
          ...baseLookFor,
          when: enriched.lookFor?.when,
          check: enriched.lookFor?.check,
          ifYes: enriched.lookFor?.ifYes,
          ifNo: enriched.lookFor?.ifNo,
        }
      : null;

    const avoid = baseAvoid
      ? {
          ...baseAvoid,
          signature: enriched.avoid?.signature,
          trigger: enriched.avoid?.trigger,
          instinct: enriched.avoid?.instinct,
          rule: enriched.avoid?.rule,
        }
      : null;

    // Derive today's rule: prefer LLM-generated, then compass-based fallback, then generic.
    const todayRule =
      enriched.todayRule ??
      (compass.state === 'ready'
        ? `Focus on ${compass.primary.name.toLowerCase()} every round. One conscious rep = today's win.`
        : DEFAULT_RULE_FALLBACK);

    return {
      sessionNumber,
      detected:
        compass.state === 'ready'
          ? {
              primarySkillId: compass.primary.skillId,
              primarySkillName: compass.primary.name,
              domain: compass.primary.domain,
            }
          : undefined,
      practice,
      lookFor,
      avoid,
      todayRule,
      currentCommitment,
    };
  }

  // ── LLM enrichment ─────────────────────────────────────────────────────

  private async enrichWithLLM(
    userId: string,
    ctx: {
      sessionNumber: number;
      bottleneckName?: string;
      bottleneckDomain?: string;
      bottleneckBlockedCount?: number;
      drillName?: string;
      drillSteps?: string;
      cue?: string;
      observationHint?: string;
      topPatternCategory?: string;
      topPatternExample?: string;
      topPatternCount?: number;
      rank?: string;
    },
  ): Promise<EnrichedSections> {
    // Cache check
    const cacheKey = `${userId}:${ctx.bottleneckName ?? ''}:${ctx.topPatternExample ?? ''}:${ctx.cue ?? ''}`;
    const cached = enrichmentCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.payload;
    }

    const empty: EnrichedSections = { lookFor: null, avoid: null, todayRule: null };
    if (!env.GEMINI_API_KEY) return empty;

    const system = `You are the Scrima Valorant coach writing a tight, actionable pre-session briefing.

Your output MUST be valid JSON in the exact schema below. Do not add commentary.

CRITICAL — AGENT-AGNOSTIC LANGUAGE:
The player may play any agent today. NEVER reference specific ability names or agents.

• BAD:  "Deploy Clove's Ruse (E) before peeking"
• BAD:  "Throw Reyna's Leer first"
• BAD:  "Use Jett's Updraft to reposition"
• GOOD: "Use your controller's vision denial first"
• GOOD: "Throw your flash or smoke before peeking"
• GOOD: "Commit utility before you peek — every time, regardless of agent"

Speak in terms of SKILLS and PRINCIPLES (utility-first peeking, crosshair placement,
trading, post-plant discipline), never agent-specific ability names.

Never use hollow phrases like "be aware", "resist the urge", "play better",
"improve your X", "focus more". Every field should:
• Use IMPERATIVE MOOD (commands) — "Throw X", "Hold Y", "Wait Z"
• Name a specific in-game moment, not an abstract concept
• Give a concrete alternative action when naming a mistake
• Apply REGARDLESS of which agent the player picks today`;

    const user = `CONTEXT:
- Rank: ${ctx.rank ?? 'unknown'}
- Bottleneck skill: ${ctx.bottleneckName ?? '(none yet)'} (${ctx.bottleneckDomain ?? 'n/a'}) — blocks ${ctx.bottleneckBlockedCount ?? 0} downstream skills
- Active drill theme: ${ctx.drillName ?? '(none)'}
- Drill steps theme: ${ctx.drillSteps ?? '(none)'}
- In-game cue mantra: ${ctx.cue ?? '(none)'}
- Top recurring pattern (category-level): ${ctx.topPatternCategory ?? '(none)'} — flagged in ${ctx.topPatternCount ?? 0} recent games
- Top observation (generic summary): ${ctx.observationHint ?? '(none)'}

(Agent names have been stripped from context — the player may switch agents today.)

Produce this exact JSON:
{
  "lookFor": {
    "when": "Specific trigger moment in gameplay. 10-20 words. Agent-agnostic.",
    "check": "Physical or mental action. 8-15 words. Agent-agnostic.",
    "ifYes": "What to do when the check passes. 10-20 words. Agent-agnostic.",
    "ifNo": "What to do when the check fails. 10-20 words. Agent-agnostic."
  },
  "avoid": {
    "signature": "One specific playstyle miss. 10-20 words. Describe the behavior, not the agent.",
    "trigger": "Game situation that triggers the miss. 15-25 words. Agent-agnostic.",
    "instinct": "The wrong thing the player usually does. 10-20 words. Agent-agnostic.",
    "rule": "The specific correction with a concrete action. 15-25 words. Agent-agnostic."
  },
  "todayRule": "ONE sentence rule to honor every round today. Max 90 chars. Imperative. Agent-agnostic."
}

If a section has no meaningful signal, set its object to null. NEVER invent placeholder content.`;

    try {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: user }] }],
        config: {
          systemInstruction: system,
          temperature: 0.5,
          maxOutputTokens: 800,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const text =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';

      // Extract JSON from the response (Gemma/Gemini sometimes wraps in ```json blocks)
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd <= jsonStart) return empty;
      const jsonText = text.slice(jsonStart, jsonEnd + 1);

      const parsed = JSON.parse(jsonText) as Partial<EnrichedSections>;
      // Defense-in-depth: even though we instructed the LLM to stay
      // agent-agnostic, run the sanitizer over every enriched field as a
      // safety net. Agent names get replaced with "your agent", map names with
      // "the map". Keeps the briefing portable across whatever agent the
      // player picks today.
      const clean = (s: string | undefined | null): string =>
        sanitizeAgentMapNames(String(s ?? ''));

      const sanitized: EnrichedSections = {
        lookFor:
          parsed.lookFor?.when && parsed.lookFor?.check
            ? {
                when: clean(parsed.lookFor.when),
                check: clean(parsed.lookFor.check),
                ifYes: clean(parsed.lookFor.ifYes),
                ifNo: clean(parsed.lookFor.ifNo),
              }
            : null,
        avoid:
          parsed.avoid?.signature && parsed.avoid?.rule
            ? {
                signature: clean(parsed.avoid.signature),
                trigger: clean(parsed.avoid.trigger),
                instinct: clean(parsed.avoid.instinct),
                rule: clean(parsed.avoid.rule),
              }
            : null,
        todayRule:
          typeof parsed.todayRule === 'string' && parsed.todayRule.trim().length > 0
            ? clean(parsed.todayRule).trim().slice(0, 140)
            : null,
      };

      enrichmentCache.set(cacheKey, {
        payload: sanitized,
        expiresAt: Date.now() + BRIEFING_CACHE_TTL_MS,
      });
      // Keep cache bounded
      if (enrichmentCache.size > 500) {
        const firstKey = enrichmentCache.keys().next().value;
        if (firstKey) enrichmentCache.delete(firstKey);
      }

      return sanitized;
    } catch (err) {
      console.warn('[Briefing] LLM enrichment failed:', err instanceof Error ? err.message : err);
      return empty;
    }
  }
}
