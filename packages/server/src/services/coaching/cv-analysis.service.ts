/**
 * CV-Powered Game Analysis Service
 *
 * Alternative to the VLM-based DeepAnalysisService. Uses:
 *   1. HSV color detection for death/game state detection (zero AI cost)
 *   2. Structured game timeline from CV detection
 *   3. Text-only LLM coaching from the structured timeline (no video sent to LLM)
 *
 * Falls back to the VLM pipeline if CV detection finds 0 deaths.
 *
 * Same input/output interface as DeepAnalysisService so the rest of
 * the system (routes, DB, client) works unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GameContext } from '@scrima/shared';
import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env.js';
import type { Db } from '../../db/index.js';
import { coachingJobs, coachingReports, matches } from '../../db/schema.js';
import { normalizeLocation } from '../../games/valorant/map-zones.js';
import { VlmError } from '../../shared/errors.js';
import type { UsageService } from '../billing/usage.service.js';
import type { TempStorageService } from '../storage/temp-storage.service.js';
import { type GeminiModelId, GeminiProvider } from '../vlm/gemini.provider.js';
import { type Finding, detectAntiPatterns, formatFindings } from './ability-anti-patterns.js';
import {
  type PositiveFinding,
  detectPositivePatterns,
  formatPositiveFindings,
} from './ability-positive-patterns.js';
import { type AbilityTimeline, buildAbilityTimeline } from './ability-timeline.service.js';
import type { CoachingCreditsService } from './coaching-credits.service.js';
import { type DeathContext, extractDeathContexts } from './death-context-extractor.js';
import type {
  CoachingHistory,
  DeepAnalyzeInput,
  DeepAnalyzeResult,
} from './deep-analysis.service.js';
import type { GameTimeline } from './hsv-detector.js';
import { type VlmGameTimeline, classifyGameTimeline } from './vlm-frame-classifier.js';

// ── Text-only coaching prompt ────────────────────────────────────────────────

function buildTextCoachingPrompt(
  timeline: VlmGameTimeline | GameTimeline,
  context: GameContext,
  coachingHistory?: CoachingHistory | null,
  deathContexts?: DeathContext[],
): string {
  const agent = context.agent ?? 'unknown';
  const map = context.map ?? 'unknown';
  const mode = context.gameMode ?? 'competitive';
  const rank = context.rank ?? 'unknown';

  // Build death list — enriched with visual context when available
  const deathLines = timeline.deaths
    .map((d, i) => {
      const min = Math.floor(d.timestampSec / 60);
      const sec = d.timestampSec % 60;
      const ts = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      const round = timeline.rounds.find((r) => r.round === d.round);
      const roundDuration = round ? round.endSec - round.startSec : 0;
      const dc = deathContexts?.find((c) => c.deathNumber === i + 1);

      let line = `  Death ${i + 1} at ${ts} (Round ${d.round})`;
      if (roundDuration > 0) line += ` — round lasted ${roundDuration}s`;

      if (dc) {
        // Killer info
        if (dc.enemyAgent && dc.enemyAgentConfidence === 'certain') {
          line += `\n    Killed by: ${dc.enemyAgent}`;
          if (dc.killedByWeapon && dc.killedByWeaponConfidence === 'certain') {
            line += ` with ${dc.killedByWeapon}`;
          }
        }

        // Location & game state
        if (dc.mapLocation) line += `\n    Location: ${dc.mapLocation}`;
        if (dc.roundScore) line += ` | Score: ${dc.roundScore}`;
        if (dc.playerEconomy) line += ` | Economy: $${dc.playerEconomy}`;

        // Ability state
        if (dc.abilityComparison) line += `\n    ${dc.abilityComparison}`;

        // Visual observation (the key coaching data)
        if (dc.visualObservation) {
          const v = dc.visualObservation;
          line += `\n    Position: ${v.coverStatus.replace('_', ' ')}, ${v.environment}`;
          line += `\n    Crosshair: ${v.crosshairHeight.replace('_', ' ')}`;
          line += `\n    Action: ${v.playerAction}`;
          if (v.observationNote) line += `\n    Visual: ${v.observationNote}`;
        }
      }

      return line;
    })
    .join('\n\n');

  // Build round summary
  const roundLines = timeline.rounds
    .map((r) => {
      const dur = r.endSec - r.startSec;
      const outcome = r.deathSec !== null ? 'died' : 'survived';
      return `  Round ${r.round}: ${dur}s, ${outcome}`;
    })
    .join('\n');

  // Client-provided death details (if available)
  const clientDeaths = context.deathDetails ?? [];
  let clientDeathBlock = '';
  if (clientDeaths.length > 0) {
    clientDeathBlock = `\n═══ CLIENT-DETECTED DETAILS (from live game monitoring) ═══\n${clientDeaths
      .map(
        (d) =>
          `  Death ${d.index + 1} at ${d.timestampFormatted}: killed by ${d.killer} with ${d.weapon}${d.headshot ? ' (headshot)' : ''} | Team ${d.teamAlive}v${d.enemyAlive} | Economy: $${d.money}${
            d.abilitiesAvailable.length > 0
              ? ` | Abilities available: ${d.abilitiesAvailable.join(', ')}`
              : ''
          }`,
      )
      .join('\n')}\n`;
  }

  // Economy timeline
  const ecoTimeline = context.economyTimeline ?? [];
  let ecoBlock = '';
  if (ecoTimeline.length > 0) {
    ecoBlock = `\n═══ ECONOMY TIMELINE ═══\n${ecoTimeline.map((e) => `  Round ${e.round}: $${e.money} (${e.buyType})`).join('\n')}\n`;
  }

  // Coaching history
  let historyBlock = '';
  if (coachingHistory && coachingHistory.sessionNumber > 1) {
    historyBlock = `\n═══ COACHING HISTORY ═══\nSession #${coachingHistory.sessionNumber}.`;
    if (coachingHistory.lastChallenge) {
      historyBlock += ` Last challenge: "${coachingHistory.lastChallenge.title}" (${coachingHistory.lastChallenge.category}).`;
    }
    if (coachingHistory.patterns.length > 0) {
      historyBlock += `\nRecurring patterns: ${coachingHistory.patterns.map((p) => `${p.category} (${p.trend})`).join(', ')}`;
    }
    historyBlock += '\n';
  }

  return `You are an expert Valorant VOD coach. Analyze this match and provide coaching.

═══ PLAYER CONTEXT ═══
Agent: ${agent}
Map: ${map}
Mode: ${mode}
Rank: ${rank}

═══ MATCH OVERVIEW (from video analysis) ═══
Duration: ${(timeline.videoDurationSec / 60).toFixed(1)} minutes
Deaths detected: ${timeline.deaths.length}
Rounds played: ${timeline.rounds.length}
Rounds survived: ${timeline.rounds.filter((r) => r.deathSec === null).length}
Rounds died: ${timeline.rounds.filter((r) => r.deathSec !== null).length}

═══ DEATHS ═══
${deathLines || '  No deaths detected — coach on positioning, utility usage, and economy.'}

═══ ROUND SUMMARY ═══
${roundLines || '  Round data not available.'}
${clientDeathBlock}${ecoBlock}${historyBlock}
═══ YOUR TASK ═══
Based on the match data above, provide coaching:

1. For each death, explain the likely root cause based on the round context:
   - Early-round deaths (first 30s of a round) suggest aggressive peeks or bad positioning
   - Deaths while pushing suggest utility or peeking mistakes
   - Multiple deaths in the same round situation suggest a recurring habit
   - Deaths on eco rounds are often unavoidable — note this

2. Identify the #1 recurring pattern across all deaths (the most common mistake category):
   Categories: crosshair | positioning | utility | economy | movement | game_sense | peeking | trading

3. Provide a specific practice drill targeting the pattern.

4. Note 1-3 strengths (rounds survived, good stretches, clutch potential).

5. Write a 2-3 sentence match verdict.

RULES:
- Be specific and actionable. "Improve positioning" is useless. "When entering a site, always check the first angle before committing" is coaching.
- Reference the actual death data (timestamps, round numbers).
- If you have client-detected details (killer, weapon, economy), use them for more specific coaching.
- Short honest coaching beats long fabricated coaching.

Output valid JSON matching the schema.`;
}

function buildTextCoachingSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      death_coaching: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            death_number: { type: 'integer' },
            approximate_time: { type: 'string', description: 'MM:SS' },
            situation: {
              type: 'string',
              description: 'What likely happened based on the round context. 2-3 sentences.',
            },
            mistake: { type: 'string', description: 'Root cause. 1-2 sentences.' },
            correction: {
              type: 'string',
              description: 'Concrete rule: when [trigger], do [action]. 1-2 sentences.',
            },
            category: {
              type: 'string',
              enum: [
                'crosshair',
                'positioning',
                'utility',
                'economy',
                'movement',
                'game_sense',
                'peeking',
                'trading',
                'unclear',
              ],
            },
            avoidable: { type: 'boolean' },
          },
          required: [
            'death_number',
            'approximate_time',
            'situation',
            'mistake',
            'correction',
            'category',
            'avoidable',
          ],
        },
      },
      priority_pattern: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'crosshair',
              'positioning',
              'utility',
              'economy',
              'movement',
              'game_sense',
              'peeking',
              'trading',
            ],
          },
          death_count: { type: 'integer' },
          title: { type: 'string', description: 'Specific 5-8 word habit title.' },
          what_happened: { type: 'string' },
          why_it_hurts: { type: 'string' },
          fix: { type: 'string', description: 'Rule: when [trigger], do [action].' },
        },
        required: ['category', 'death_count', 'title', 'what_happened', 'why_it_hurts', 'fix'],
      },
      secondary_patterns: {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            death_count: { type: 'integer' },
            title: { type: 'string' },
            what_happened: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['category', 'death_count', 'title', 'what_happened', 'fix'],
        },
      },
      strengths: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
      session_focus: {
        type: 'object',
        properties: {
          drill_name: { type: 'string' },
          drill_steps: { type: 'string' },
          drill_duration_minutes: { type: 'integer' },
          in_game_cue: { type: 'string', description: 'Max 8 words.' },
        },
        required: ['drill_name', 'drill_steps', 'drill_duration_minutes', 'in_game_cue'],
      },
      match_verdict: { type: 'string', description: '2-3 sentence summary.' },
      coaching_continuity: {
        type: 'object',
        properties: { progress_note: { type: 'string' } },
        required: ['progress_note'],
      },
    },
    required: [
      'death_coaching',
      'priority_pattern',
      'secondary_patterns',
      'strengths',
      'session_focus',
      'match_verdict',
      'coaching_continuity',
    ],
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

export class CvAnalysisService {
  // Use the standard flash model for text coaching (no video = cheap)
  private vlm = new GeminiProvider((env.VLM_MODEL ?? 'gemini-2.5-flash') as GeminiModelId);

  constructor(
    private db: Db,
    private storage: TempStorageService,
    private usage: UsageService,
    private credits: CoachingCreditsService,
  ) {}

  /**
   * Analyze a game using CV detection + text-only LLM coaching.
   * Same interface as DeepAnalysisService.analyzeGame().
   *
   * Returns null if CV detection fails (caller should fall back to VLM pipeline).
   */
  async analyzeGame(input: DeepAnalyzeInput): Promise<DeepAnalyzeResult | null> {
    const start = Date.now();
    const gameMode = input.context.gameMode ?? 'competitive';
    const _gameId = input.context.game ?? 'valorant';

    console.log(
      '[CV-Analysis] START — agent=%s, map=%s, mode=%s, match=%s',
      input.context.agent ?? 'unknown',
      input.context.map ?? 'unknown',
      gameMode,
      input.matchId,
    );

    // ── 1. Credit check FIRST — before any expensive I/O ────────────────────
    const creditResult = await this.credits.checkAndDecrement(input.userId);
    if (!creditResult.allowed) {
      throw new VlmError('No deep coaching credits remaining.', 'NO_CREDITS');
    }

    // ── 2. Download video ───────────────────────────────────────────────────
    let videoBuffer: Buffer;
    try {
      videoBuffer = await this.storage.download(input.videoKey);
    } catch (err) {
      await this.credits.refund(input.userId).catch(() => {});
      throw err;
    }
    if (videoBuffer.length < 20_000) {
      console.log('[CV-Analysis] video too short, falling back');
      await this.credits.refund(input.userId).catch(() => {});
      return null;
    }

    // ── 2b. Write video to disk ONCE — shared across all pipeline stages ──
    const sharedVideoPath = path.join(os.tmpdir(), `scrima-pipeline-${Date.now()}.mp4`);
    await fs.promises.writeFile(sharedVideoPath, videoBuffer);
    console.log(
      '[CV-Analysis] wrote shared video: %sMB → %s',
      (videoBuffer.length / 1024 / 1024).toFixed(1),
      sharedVideoPath,
    );

    // ── 3. Run VLM frame classification (scene-change pre-filter + single-frame VLM) ──
    console.log(
      '[CV-Analysis] running scene-change + VLM classification on %sMB video...',
      (videoBuffer.length / 1024 / 1024).toFixed(1),
    );

    let timeline: VlmGameTimeline;
    try {
      timeline = await classifyGameTimeline(videoBuffer, this.vlm, sharedVideoPath);
    } catch (err) {
      console.error(
        '[CV-Analysis] VLM classification failed:',
        err instanceof Error ? err.message : err,
      );
      fs.rmSync(sharedVideoPath, { force: true });
      await this.credits.refund(input.userId).catch(() => {});
      return null; // fall back to old VLM pipeline
    }

    console.log(
      '[CV-Analysis] detected %d deaths, %d rounds, classification cost=$%s, time=%dms',
      timeline.deaths.length,
      timeline.rounds.length,
      timeline.classificationCostUsd.toFixed(4),
      timeline.processingMs,
    );

    // If 0 deaths found, fall back to old VLM pipeline
    if (timeline.deaths.length === 0) {
      console.log('[CV-Analysis] 0 deaths detected — falling back to VLM pipeline');
      fs.rmSync(sharedVideoPath, { force: true });
      await this.credits.refund(input.userId).catch(() => {});
      return null;
    }

    // ── 4. DB records ───────────────────────────────────────────────────────

    const reportId = uuidv4();
    const jobId = uuidv4();

    await this.db.insert(coachingReports).values({
      id: reportId,
      userId: input.userId,
      type: 'game_analysis',
      trigger: input.trigger,
      status: 'processing',
      matchIds: [input.matchId],
    });
    await this.db.insert(coachingJobs).values({
      id: jobId,
      userId: input.userId,
      reportId,
      matchId: input.matchId,
      bullJobId: input.bullJobId ?? null,
      status: 'processing',
      attempts: 1,
    });

    try {
      // ── 4. Extract frames + death context (two-stage: read then coach) ────────
      const vlmLite = new GeminiProvider('gemini-2.5-flash-lite' as GeminiModelId);

      // Build coaching history in parallel with frame extraction
      const historyPromise = this.buildCoachingHistory(input.userId).catch(() => null);

      // Extract frames (full frames + crops)
      const { buildFrameRequests, extractFrames } = await import('./frame-extractor.js');
      const deathTimestamps = timeline.deaths.slice(0, 8).map((d, i) => ({
        deathNumber: i + 1,
        timestampSec: d.timestampSec,
      }));
      const frameRequests = buildFrameRequests(deathTimestamps, timeline.videoDurationSec);
      const frames = await extractFrames(videoBuffer, frameRequests, sharedVideoPath);

      // Stage 1: READ — Use death-context-extractor to get structured per-death facts
      // flash-lite reads: killer+weapon, visual observation, map location, score, economy, abilities
      const deathContexts = await extractDeathContexts(
        videoBuffer,
        timeline.deaths.slice(0, 8),
        timeline.videoDurationSec,
        input.context.agent ?? 'unknown',
        vlmLite,
        frames, // reuse pre-extracted frames
        sharedVideoPath,
      );

      const coachingHistory = await historyPromise;
      const extractorCost = deathContexts.reduce((s, c) => s + c.vlmCostUsd, 0);
      console.log(
        '[CV-Analysis] death context extracted: %d deaths, cost=$%s',
        deathContexts.length,
        extractorCost.toFixed(4),
      );

      // ── 4b. Build ability timeline (X3a) — pure CPU, no VLM cost ───────────
      // Sample the bar at 1 fps, detect lit→dark transitions per slot,
      // self-verify with cooldown grounding. Used by anti-pattern rules below.
      let abilityTimeline: AbilityTimeline | null = null;
      try {
        // Build round windows for the timeline (uses round.deathSec for first-death).
        const roundWindows = timeline.rounds.map((r) => ({
          round: r.round,
          startSec: r.startSec,
          endSec: r.endSec,
        }));
        abilityTimeline = await buildAbilityTimeline(
          sharedVideoPath,
          roundWindows,
          input.context.agent ?? 'unknown',
        );
      } catch (err) {
        console.warn(
          '[CV-Analysis] ability timeline failed:',
          err instanceof Error ? err.message : err,
        );
      }

      // ── 4c. Run anti-pattern AND positive-pattern rules (X3b + X4) ────────
      // Anti-patterns flag specific BAD rounds; positives flag CONSISTENT
      // good habits across the match. Both feed Gemma so coaching is
      // balanced (keep doing X, fix Y).
      let antiPatternFindings: Finding[] = [];
      let positiveFindings: PositiveFinding[] = [];
      if (abilityTimeline) {
        const ruleRounds = timeline.rounds.map((r) => ({
          round: r.round,
          startSec: r.startSec,
          endSec: r.endSec,
          deathSec: r.deathSec,
        }));
        // Player kill timeline isn't tracked yet — pass empty for v1.
        // Future: parse killfeed events from the VLM frame classifier.
        antiPatternFindings = detectAntiPatterns({
          timeline: abilityTimeline,
          rounds: ruleRounds,
          playerKills: [],
        });
        positiveFindings = detectPositivePatterns({
          timeline: abilityTimeline,
          rounds: ruleRounds,
          playerKills: [],
        });
        console.log(
          '[CV-Analysis] ability rules: %d issue(s), %d positive(s)',
          antiPatternFindings.length,
          positiveFindings.length,
        );
      }

      // ── 5. Stage 2: COACH — Build rich prompt with verified facts + 1 frame per death ──
      const agent = input.context.agent ?? 'unknown';
      const map = input.context.map ?? 'unknown';
      // gameMode is already declared in the outer scope — reuse it
      const rank = input.context.rank ?? 'unknown';
      const clientDeaths = input.context.deathDetails ?? [];
      const ecoTimeline = input.context.economyTimeline ?? [];
      const deathCount = Math.min(timeline.deaths.length, 8);
      const survived = timeline.rounds.filter((r) => r.deathSec === null).length;
      const died = timeline.rounds.filter((r) => r.deathSec !== null).length;

      // Build economy timeline string
      const ecoLine =
        ecoTimeline.length > 0
          ? ecoTimeline.map((e) => `R${e.round}: $${e.money} (${e.buyType})`).join(' | ')
          : 'Not available';

      // Build coaching history block
      let historyBlock = '';
      if (coachingHistory && coachingHistory.sessionNumber > 1) {
        historyBlock = `\n═══ COACHING HISTORY ═══\nSession #${coachingHistory.sessionNumber}.`;
        if (coachingHistory.lastChallenge) {
          historyBlock += ` Last focus: "${coachingHistory.lastChallenge.title}" (${coachingHistory.lastChallenge.category}).`;
        }
        if (coachingHistory.patterns.length > 0) {
          historyBlock += `\nRecurring issues: ${coachingHistory.patterns.map((p) => `${p.category} (${p.trend})`).join(', ')}.`;
        }
        if (coachingHistory.lastDrill) {
          historyBlock += `\nLast drill: ${coachingHistory.lastDrill}.`;
        }
        historyBlock += '\nWatch for improvement or regression in these areas.\n';
      }

      // Build per-death dossiers (merging extractor + client data)
      const dossierBlocks: string[] = [];

      for (let i = 0; i < deathCount; i++) {
        const death = timeline.deaths[i];
        const dc = deathContexts[i];
        const cd = clientDeaths[i]; // client-detected death (may not exist)
        const _round = timeline.rounds.find((r) => r.round === death.round);
        const eco = ecoTimeline.find((e) => e.round === death.round);

        const min = Math.floor(death.timestampSec / 60);
        const sec = death.timestampSec % 60;
        const ts = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

        // Merge killer/weapon: extractor (visual) > client data > unknown
        const killer =
          (dc?.enemyAgent && dc.enemyAgentConfidence === 'certain' ? dc.enemyAgent : null) ??
          cd?.killer ??
          dc?.enemyAgent ??
          'unknown';
        const weapon =
          (dc?.killedByWeapon && dc.killedByWeaponConfidence === 'certain'
            ? dc.killedByWeapon
            : null) ??
          cd?.weapon ??
          dc?.killedByWeapon ??
          'unknown';
        const headshot = cd?.headshot ? ' (headshot)' : '';
        // X2 — normalize HUD location text against map zone dictionary.
        // Returns canonical zone display name when matched (e.g. "A Hookah");
        // falls back to raw HUD text otherwise so coaching never goes blind.
        const normalizedZone = normalizeLocation(map, dc?.mapLocation);
        const location = normalizedZone?.displayName ?? dc?.mapLocation ?? 'unknown';
        const score = dc?.roundScore ?? 'unknown';
        const economy = cd?.money ? `$${cd.money}` : (dc?.playerEconomy ?? 'unknown');
        const buyType = eco?.buyType ?? '';

        // Team situation (client data only)
        const teamLine = cd
          ? `TEAM: ${cd.teamAlive}v${cd.enemyAlive} | Player weapon: ${cd.weapon ?? 'unknown'}`
          : '';

        // Abilities
        let abilityLine = '';
        if (dc?.abilityComparison) {
          abilityLine = `ABILITIES: ${dc.abilityComparison}`;
        } else if (cd?.abilitiesAvailable && cd.abilitiesAvailable.length > 0) {
          abilityLine = `ABILITIES: Available: ${cd.abilitiesAvailable.join(', ')}`;
        }

        // Visual observation from extractor
        let obsLine = '';
        if (dc?.visualObservation) {
          const v = dc.visualObservation;
          obsLine = `OBSERVATION: ${v.coverStatus.replace('_', ' ')}, ${v.environment}, crosshair ${v.crosshairHeight.replace('_', ' ')}, ${v.playerAction}`;
          if (v.observationNote) obsLine += `\n  Visual note: ${v.observationNote}`;
        }

        let block = `═══ DEATH ${i + 1} at ${ts} (Round ${death.round}) ═══\n`;
        block += `FACTS: Killed by ${killer} with ${weapon}${headshot} | Location: ${location} | Score: ${score} | Economy: ${economy} ${buyType}\n`;
        if (teamLine) block += `${teamLine}\n`;
        if (abilityLine) block += `${abilityLine}\n`;
        if (obsLine) block += `${obsLine}\n`;
        block += 'Use the observation details above to coach this death.';

        dossierBlocks.push(block);
      }

      console.log(
        '[CV-Analysis] coaching prompt: %d dossiers (text-only, no images)',
        dossierBlocks.length,
      );

      // X3c — ABILITY USAGE NOTES (only if rules fired). Pre-filtered, text-only.
      const abilityNotesBlock = formatFindings(antiPatternFindings, timeline.rounds.length);
      // X4 — WHAT WORKED (only if cross-match positive thresholds hit).
      const abilityWinsBlock = formatPositiveFindings(positiveFindings);

      const coachingPrompt = `You are an expert Valorant VOD coach analyzing ${deathCount} deaths from a ${gameMode} match.
Your coaching must be specific, actionable, and grounded in the verified facts below.

═══ PLAYER ═══
Agent: ${agent} | Map: ${map} | Rank: ${rank}

═══ MATCH OVERVIEW ═══
${timeline.rounds.length} rounds (${survived} survived, ${died} died) | ${(timeline.videoDurationSec / 60).toFixed(0)} minutes

═══ ECONOMY ═══
${ecoLine}
${historyBlock}
═══ WHAT YOU RECEIVE PER DEATH ═══
For each death below:
  1. FACTS — killer agent, weapon, location, economy. Ground truth from high-res frame analysis. TRUST these.
  2. OBSERVATION — cover status, crosshair height, player action, visual notes. Extracted by analyzing gameplay frames before the death.
  3. ABILITIES — which abilities were available vs used.
All data is verified from frame analysis. Your job is to COACH based on this data, not re-read frames.

═══ DEATHS TO ANALYZE ═══

${dossierBlocks.join('\n\n')}

${
  abilityWinsBlock
    ? `═══ ABILITY USAGE — WHAT WORKED ═══

${abilityWinsBlock}

`
    : ''
}${
  abilityNotesBlock
    ? `═══ ABILITY USAGE — ANTI-PATTERN FLAGS ═══

${abilityNotesBlock}

These notes were pre-filtered: rounds where utility was used acceptably are NOT listed. Use them to inform priority_pattern and secondary_patterns when the issue is utility-related. DO NOT narrate good ability use beyond the WHAT WORKED block — the player only needs to hear what to fix.

`
    : ''
}═══ YOUR TASK PER DEATH ═══
  situation: What was the player doing? Use the verified facts + what you see in the frame. 2-3 sentences. Include weapon, location, team situation.
  mistake: The root cause DECISION error. Not "bad positioning" — explain WHY it was bad. 1-2 sentences.
  correction: Concrete rule: "When [trigger], do [action]." 1-2 sentences.
  category: crosshair | positioning | utility | economy | movement | game_sense | peeking | trading
  avoidable: false if eco/save round with pistol/SMG against rifles, true otherwise.

═══ AFTER ALL DEATHS ═══
  priority_pattern: The #1 recurring mistake category across deaths. Include count, title, explanation, fix.
  secondary_patterns: Up to 2 other patterns.
  strengths: 1-3 things done well (rounds survived, utility usage, clutch potential).
  session_focus: Practice drill for the priority pattern. Name, steps, duration, 8-word in-game cue.
  match_verdict: 2-3 sentence honest assessment.

═══ RULES ═══
  - TRUST the verified facts. They come from high-res frame analysis. Do not contradict.
  - The frame shows WHERE the player was. The facts tell WHAT happened. Combine both.
  - Be specific: "crosshair at chest height on B Main corner" not "bad crosshair placement."
  - Reference round numbers and map locations in coaching.
  - Eco deaths (save/eco buy, $2000 or less) are often unavoidable. Mark avoidable=false.
  - "utility" category requires a specific AVAILABLE ability not used. If on cooldown, do not criticize.
  - BANNED words: "likely", "probably", "appears to", "seems to". State facts or say unknown.
  - PLAIN ENGLISH: never use internal jargon like "LIT" — say "ready" or "available". Don't use bracket notations the player wouldn't recognise.
  - ABILITY NAMES: use ONLY the canonical ability names for THIS agent (${agent}). Never reference abilities from other agents. If unsure of the exact name, refer to the slot ("your Q", "your E ability") instead of guessing.
  - STRENGTHS must be unambiguously POSITIVE statements about what the player did well. Never use a strength entry to describe what they failed to do — that's a habit, not a strength. Wrong: "you were not consistently pushing fights at low HP" (this is a critique). Right: "you maintained head-level crosshair placement on 6 of 8 deaths."
  - Each death coaching must describe a DIFFERENT insight. If same mistake repeats, note count in pattern.

Output valid JSON matching the schema.`;

      const _videoSchema = buildTextCoachingSchema();

      // Architecture: Flash text-only, NO JSON schema mode.
      // JSON schema mode (responseMimeType: application/json) triggers 503 on Flash
      // during high demand. Plain text mode is 100% reliable.
      // We ask Flash to return JSON in the prompt and parse it ourselves.
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
      const coachingModel = 'gemini-2.5-flash';

      let response: any;
      let lastError: Error | null = null;

      // Gemini Flash has ~65% success rate due to capacity issues.
      // 10 retries with 2-3s gaps gives ~97% chance of success.
      for (const waitMs of [0, 2000, 2000, 3000, 3000, 3000, 5000, 5000, 8000, 10000]) {
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        try {
          const genResponse = await ai.models.generateContent({
            model: coachingModel,
            contents: [{ parts: [{ text: coachingPrompt }] }],
            config: {
              temperature: 0.1,
              maxOutputTokens: 4096,
            },
          });

          const text =
            genResponse.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
            genResponse.text ||
            '';
          const usage = genResponse.usageMetadata;

          // Parse JSON from the response text
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('No JSON found in coaching response');
          const parsed = JSON.parse(jsonMatch[0]);

          const inputTokens = usage?.promptTokenCount ?? 0;
          const outputTokens = usage?.candidatesTokenCount ?? 0;
          const thinkingTokens = (usage as any)?.thoughtsTokenCount ?? 0;
          // flash pricing
          const costUsd =
            (inputTokens / 1_000_000) * 0.15 +
            (outputTokens / 1_000_000) * 0.6 +
            (thinkingTokens / 1_000_000) * 0.6;

          response = {
            result: parsed,
            costUsd,
            tokensUsed: { input: inputTokens, output: outputTokens },
          };
          lastError = null;
          break;
        } catch (err) {
          lastError = err as Error;
          console.warn(
            '[CV-Analysis] coaching retry (wait %ds): %s',
            waitMs / 1000,
            (err as Error).message?.slice(0, 80),
          );
        }
      }

      if (lastError) throw lastError;
      console.log('[CV-Analysis] coaching succeeded (flash text-only, no JSON mode)');

      const r = response.result as any;
      const coachingCost = response.costUsd;
      const classificationCost = timeline.classificationCostUsd ?? 0;
      const totalCostUsd = coachingCost + classificationCost + extractorCost;
      console.log(
        '[CV-Analysis] coaching done: cost=$%s (classification=$%s + extractor=$%s + coaching=$%s), deaths=%d',
        totalCostUsd.toFixed(4),
        classificationCost.toFixed(4),
        extractorCost.toFixed(4),
        coachingCost.toFixed(4),
        (r.deaths ?? r.death_coaching ?? []).length,
      );

      // ── 6. Build report in same format as DeepAnalysisService ───────────────
      // Map coaching response to report format using verified data from death contexts
      const rawDeaths = r.deaths ?? r.death_coaching ?? [];
      const deathCoaching = rawDeaths.map((d: any, i: number) => {
        const dc = deathContexts[i];
        const verifiedAgent = dc?.enemyAgent ?? 'unknown';
        const verifiedWeapon = dc?.killedByWeapon ?? 'unknown';

        const situation = d.observation ?? d.situation ?? '';
        const mistake = d.mistake ?? '';
        const correction = d.correction ?? d.fix ?? '';

        return {
          death_number: d.death_number ?? i + 1,
          approximate_time: (() => {
            const t = timeline.deaths[i]?.timestampSec ?? 0;
            return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
          })(),
          situation,
          mistake,
          correction,
          category: d.category ?? 'positioning',
          avoidable: d.avoidable ?? true,
          weapon_used: verifiedWeapon,
          weapon_confidence: dc?.killedByWeaponConfidence ?? ('uncertain' as const),
          killed_by: verifiedAgent,
          killed_by_confidence: dc?.enemyAgentConfidence ?? ('uncertain' as const),
          visual_evidence: dc?.visualObservation?.observationNote ?? '',
          coaching_priority: 3,
          round_utility_events: [],
        };
      });

      await this.db
        .update(coachingReports)
        .set({
          status: 'completed',
          report: {
            deathCoaching,
            matchVerdict: r.verdict ?? r.match_verdict ?? '',
            priorityIssue: r.pattern ?? r.priority_pattern ?? null,
            secondaryIssues: r.secondary_patterns ?? [],
            strengths: r.strengths ?? [],
            sessionFocus: r.session_focus ?? null,
            gameMode,
            detectedAgent: agent,
            detectedMap: map,
            coachingHistory: coachingHistory ?? null,
            coachingContinuity: r.coaching_continuity ?? null,
            enrichmentStatus: 'cv_frame_coaching',
            cvDetection: {
              deaths: timeline.deaths.length,
              rounds: timeline.rounds.length,
              processingMs: timeline.processingMs,
            },
            // X3 — ability anti-pattern findings (consumed by observation extraction
            // to seed brain habits, and surfaced in the UI 'Your Coach' tab).
            abilityFindings: antiPatternFindings.map((f) => ({
              kind: f.kind,
              round: f.round,
              text: f.text,
              habitKey: f.habitKey,
            })),
            // X4 — ability positive-pattern findings. Consumed by observation
            // extraction to seed brain STRENGTH observations, and surfaced as
            // "what worked" in the report UI.
            abilityWins: positiveFindings.map((f) => ({
              kind: f.kind,
              text: f.text,
              habitKey: f.habitKey,
              ratio: f.ratio,
            })),
            moments: [],
            positiveHighlights: [],
            drills: [],
          },
          topIssues: [],
          overallAssessment: r.verdict ?? r.match_verdict ?? '',
          // Denormalize agent/map onto dedicated columns — see deep-analysis
          // for the rationale. Brain context, compass, weekly report all read
          // these directly.
          vlmDetectedAgent: agent ?? null,
          vlmDetectedMap: map ?? null,
          resolvedAgent: agent ?? null,
          resolvedMap: map ?? null,
          vlmModel: `cv+${coachingModel}`,
          vlmCostUsd: totalCostUsd,
          tokensInput: response.tokensUsed.input,
          tokensOutput: response.tokensUsed.output,
          processingTimeMs: Date.now() - start,
          completedAt: new Date(),
        })
        .where(eq(coachingReports.id, reportId));

      await this.db
        .update(coachingJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(coachingJobs.id, jobId));

      await this.db
        .update(matches)
        .set({ analysisStatus: 'analyzed' })
        .where(eq(matches.id, input.matchId));

      await this.usage.recordUsage(input.userId, 'game_analysis', totalCostUsd);
      fs.rmSync(sharedVideoPath, { force: true }); // cleanup shared pipeline video
      await this.storage.delete(input.videoKey).catch(() => {}); // cleanup temp video

      console.log(
        '[CV-Analysis] DONE: %d deaths, cost=$%s, time=%dms (CV=%dms)',
        deathCoaching.length,
        totalCostUsd.toFixed(4),
        Date.now() - start,
        timeline.processingMs,
      );

      return {
        reportId,
        overallAssessment: r.verdict ?? r.match_verdict ?? '',
        moments: [],
        topIssues: [],
        positiveHighlights: [],
        drills: [],
        vlmCostUsd: totalCostUsd,
        processingTimeMs: Date.now() - start,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[CV-Analysis] FAILED: %s', errorMsg);

      await this.db
        .update(coachingReports)
        .set({ status: 'failed' })
        .where(eq(coachingReports.id, reportId));
      await this.db
        .update(coachingJobs)
        .set({
          status: 'failed',
          errorMsg,
          updatedAt: new Date(),
        })
        .where(eq(coachingJobs.id, jobId));

      await this.credits.refund(input.userId).catch(() => {});
      fs.rmSync(sharedVideoPath, { force: true }); // cleanup shared pipeline video
      throw err;
    }
  }

  // ── Coaching History (same logic as DeepAnalysisService) ──────────────────

  private async buildCoachingHistory(userId: string): Promise<CoachingHistory | null> {
    const pastReports = await this.db
      .select({ report: coachingReports.report, createdAt: coachingReports.createdAt })
      .from(coachingReports)
      .where(
        and(
          eq(coachingReports.userId, userId),
          eq(coachingReports.status, 'completed'),
          eq(coachingReports.type, 'game_analysis'),
        ),
      )
      .orderBy(desc(coachingReports.createdAt))
      .limit(10);

    if (pastReports.length === 0) return null;

    const categoryCount: Record<string, number> = {};
    const recentCategoryCount: Record<string, number> = {};

    for (let i = 0; i < pastReports.length; i++) {
      const r = pastReports[i].report as any;
      if (!r || r.rejected) continue;
      const categories = new Set<string>();
      const pri = r.priorityIssue ?? r.priority_pattern;
      if (pri?.category) categories.add(pri.category);
      for (const s of r.secondaryIssues ?? r.secondary_patterns ?? []) {
        if (s?.category) categories.add(s.category);
      }
      for (const cat of categories) {
        categoryCount[cat] = (categoryCount[cat] ?? 0) + 1;
        if (i < 3) recentCategoryCount[cat] = (recentCategoryCount[cat] ?? 0) + 1;
      }
    }

    const patterns = Object.entries(categoryCount)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => {
        const recent = recentCategoryCount[category] ?? 0;
        const trend =
          count === 2 && recent <= 1
            ? ('new' as const)
            : recent <= 0
              ? ('improving' as const)
              : ('recurring' as const);
        return { category, count, recentCount: recent, trend };
      });

    const lastReport = pastReports[0].report as any;
    const lastFocus = lastReport?.sessionFocus ?? lastReport?.session_focus ?? null;
    const lastPriority = lastReport?.priorityIssue ?? lastReport?.priority_pattern ?? null;

    return {
      sessionNumber: pastReports.length + 1,
      patterns,
      lastDrill: lastFocus?.drill_name ?? lastFocus?.drillName ?? null,
      lastCue: lastFocus?.in_game_cue ?? lastFocus?.inGameCue ?? null,
      lastChallenge: lastPriority?.title
        ? { title: lastPriority.title, category: lastPriority.category ?? 'unknown' }
        : null,
    };
  }
}
