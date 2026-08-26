import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn, listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { formatUserError } from '../lib/errors';

// ── Types ────────────────────────────────────────────────────────────────────

export type AnalysisStage =
  | 'idle'
  | 'extracting'
  | 'classifying'
  | 'compressing'
  | 'uploading'
  | 'analyzing'
  | 'analyzing_background'
  | 'coaching_report'
  | 'enriching'
  | 'done'
  | 'error';

export interface AnalysisProgress {
  matchId: string;
  stage: AnalysisStage;
  total?: number;
  done?: number;
  error?: string;
  percent?: number;
  detail?: string;
}

export interface TrendReport {
  id: string;
  generatedAt: number;
  matchesAnalyzed: number;
  reportJson: string;
  topPatterns: string;
}

export interface TrendProgress {
  stage: 'idle' | 'analysing' | 'done' | 'error';
  deaths?: number;
}

// ── Coaching report types ────────────────────────────────────────────────────

/** Legacy type — kept for backward compat with old reports */
export interface CoachingMoment {
  timestamp: string;
  timestampMs: number;
  cause: string;
  severity: 'critical' | 'important' | 'moderate' | 'minor';
  description: string;
  whatHappened?: string;
  whatToDoInstead?: string;
  localClipPath?: string;
}

/** Legacy type — kept for backward compat with old reports */
export interface CoachingDrill {
  name: string;
  description: string;
  durationMinutes: number;
  frequency: string;
  targetsCategory: string;
}

// ── v2 schema ─────────────────────────────────────────────────────────────

export interface CoachingIssue {
  category: string;
  severity?: 'critical' | 'moderate' | 'minor';
  rounds_affected: number;
  title: string;
  what_happened: string;
  root_cause: string;
  what_to_do: string;
}

export interface AgentMastery {
  score: number;
  correct_usage: string;
  missed_power: string;
}

export interface EconomyAudit {
  rounds_desynced: number;
  key_example: string;
  verdict: string;
}

export interface SessionFocus {
  drill_name: string;
  drill_steps: string;
  drill_duration_minutes: number;
  in_game_cue: string;
}

export interface DeathEvidenceItem {
  label: string;
  value: string;
  confidence?: 'high' | 'medium' | 'low' | string;
  source?: string;
}

export interface DeathTimelineItem {
  label: string;
  time: string;
  detail: string;
}

export interface FightPhaseObservation {
  phase: string;
  finding: string;
  confidence?: 'high' | 'medium' | 'low' | string;
  evidenceFrame?: string;
}

export interface SupportedFightProblem {
  problem: string;
  evidence: string;
  confidence?: 'high' | 'medium' | 'low' | string;
}

export interface DeathCoachingEntry {
  death_number: number;
  approximate_time: string;
  situation: string;
  mistake: string;
  correction: string;
  category: string;
  avoidable: boolean;
  confidence?: 'high' | 'medium' | 'low' | string;
  evidence?: DeathEvidenceItem[];
  unknowns?: string[];
  timeline?: DeathTimelineItem[];
  sourceFrameRefs?: string[];
  fightPhases?: FightPhaseObservation[];
  coachPausePoint?: string | null;
  supportedProblems?: SupportedFightProblem[];
  notProven?: string[];
  observerVersion?: string;
  grade?: string;
  killedBy?: string | null;
  killfeedMatchConfidence?: string;
  weapon?: string | null;
  killerWeapon?: string | null;
  playerWeapon?: string | null;
  weaponAction?: string | null;
  fireDiscipline?: string | null;
  firstBulletThreat?: string | null;
  utilityUsed?: string[];
  utilityEffect?: string | null;
  utilityEffectConfidence?: string;
  decisionHP?: number | null;
  impactHP?: number | null;
  abilitiesUnused?: string[];
  tactical?: unknown;
  visual_evidence?: string;
  coaching_priority?: number;
}

export interface CoachingContinuity {
  progress_note: string;
}

export interface CoachingPatternEntry {
  category: string;
  count: number;
  recentCount: number;
  trend: 'improving' | 'recurring' | 'new';
}

export interface CoachingHistoryMeta {
  sessionNumber: number;
  patterns: CoachingPatternEntry[];
  lastDrill: string | null;
  lastCue: string | null;
  lastChallenge: { title: string; category: string } | null;
}

export interface DeepCoachingReport {
  id: string;
  matchId: string;
  serverReportId: string;
  createdAt: number;
  reportSchemaVersion?: number;
  analysisMetadata?: {
    totalDeaths?: number;
    analyzedDeaths?: number;
    failedDeaths?: number;
    evidenceVersion?: number;
    evidencePipeline?: string;
  };
  // Game mode
  gameMode?: string;
  rejected?: boolean;
  rejectionReason?: string;
  // v2 schema
  deathCoaching: DeathCoachingEntry[];
  matchVerdict: string;
  priorityIssue: CoachingIssue | null;
  secondaryIssues: CoachingIssue[];
  agentMastery: AgentMastery | null; // deprecated — no longer requested from model
  economyAudit: EconomyAudit | null; // deprecated — no longer requested from model
  strengths: string[];
  sessionFocus: SessionFocus | null;
  // Coaching Memory
  coachingContinuity: CoachingContinuity | null;
  coachingHistory: CoachingHistoryMeta | null;
  // Legacy fallback (old reports without v2 fields)
  moments: CoachingMoment[];
  positiveHighlights: (string | Record<string, unknown>)[];
  overallAssessment: string;
  drills: CoachingDrill[];
}

export interface DeepAnalysisJob {
  id: string;
  matchId: string;
  serverJobId: string | null;
  serverReportId: string | null;
  status: 'uploading' | 'polling' | 'completed' | 'failed';
  errorMsg: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CoachingCredits {
  total: number;
  used: number;
  remaining: number;
  resetsAt: string;
  month: string;
}

// ── Q&A types ────────────────────────────────────────────────────────────────

export interface QnAMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MatchQnAState {
  messages: QnAMessage[];
  questionsUsed: number;
  loading: boolean;
}

const MAX_QUESTIONS_PER_MATCH = 15;

// ── Store ─────────────────────────────────────────────────────────────────────

interface AnalysisState {
  // Current match being analysed
  activeMatchId: string | null;
  progress: AnalysisProgress | null;

  // Trend analysis
  trendProgress: TrendProgress;
  trendReport: TrendReport | null;

  // Deep coaching reports
  deepReports: Record<string, DeepCoachingReport | null>;
  credits: CoachingCredits | null;

  // Q&A chat per match
  qnaChats: Record<string, MatchQnAState>;
  activeQnAMatchId: string | null;

  // Actions
  runAnalysis: (matchId: string, agent?: string, map?: string) => Promise<void>;
  cancelAnalysis: () => Promise<void>;
  clearAnalysis: () => void;
  runTrendAnalysis: (nMatches?: number) => Promise<void>;
  loadTrendReport: () => Promise<void>;
  loadDeepCoachingReport: (matchId: string) => Promise<void>;
  loadCredits: () => Promise<void>;

  // Q&A actions
  openQnA: (matchId: string) => void;
  closeQnA: () => void;
  askQuestion: (matchId: string, question: string) => Promise<void>;
  getQnAState: (matchId: string) => MatchQnAState;
}

const EMPTY_QNA: MatchQnAState = { messages: [], questionsUsed: 0, loading: false };

export const useAnalysisStore = create<AnalysisState>()(
  persist(
    (set, get) => ({
      activeMatchId: null,
      progress: null,
      trendProgress: { stage: 'idle' },
      trendReport: null,
      deepReports: {},
      credits: null,
      qnaChats: {},
      activeQnAMatchId: null,

      runAnalysis: async (matchId: string, agent?: string, map?: string) => {
        set({ activeMatchId: matchId, progress: { matchId, stage: 'compressing' } });
        try {
          await invoke('run_analysis', { matchId, agent: agent || null, map: map || null });
        } catch (e) {
          console.error('run_analysis failed:', e);
          set({ progress: { matchId, stage: 'error' } });
        }
      },

      cancelAnalysis: async () => {
        try {
          await invoke('cancel_analysis');
          set({ activeMatchId: null, progress: null });
        } catch (e) {
          console.error('cancel_analysis failed:', e);
        }
      },

      clearAnalysis: () => set({ activeMatchId: null, progress: null }),

      runTrendAnalysis: async (nMatches = 10) => {
        set({ trendProgress: { stage: 'analysing' } });
        try {
          await invoke('run_trend_analysis', { nMatches });
        } catch (e) {
          console.error('run_trend_analysis failed:', e);
          set({ trendProgress: { stage: 'error' } });
        }
      },

      loadTrendReport: async () => {
        try {
          const data = await invoke<TrendReport | null>('get_trend_report');
          set({ trendReport: data });
        } catch (e) {
          console.error('get_trend_report failed:', e);
        }
      },

      loadDeepCoachingReport: async (matchId: string) => {
        // VERSION MARKER — unique string. If this log appears in DevTools, the
        // latest loadDeepCoachingReport code IS running. If it doesn't appear,
        // Vite HMR has a stale Zustand store — user should hard-reload the
        // Tauri webview (Ctrl+R) to force a fresh store init.
        console.info('[loadDeepCoachingReport v2/2026-04-20] start for', matchId);

        // Wrap the core load in a timeout so a hung Tauri command or slow
        // server refresh doesn't leave the row in a permanent "loading" state
        // (previously the catch at the bottom only fired on throw — a hang
        // produced neither throw nor set, so `deepReports[id]` stayed undefined
        // and the UI spun forever).
        const LOAD_TIMEOUT_MS = 15_000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`loadDeepCoachingReport timeout for ${matchId}`)),
            LOAD_TIMEOUT_MS,
          );
        });

        try {
          let raw = await Promise.race([
            invoke<{
              id: string;
              matchId: string;
              serverReportId: string;
              reportJson: string;
              createdAt: number;
            } | null>('get_deep_coaching_report', { matchId }),
            timeoutPromise,
          ]);
          if (!raw) {
            console.warn(
              '[loadDeepCoachingReport]',
              matchId,
              'Rust returned NO ROW — no local coaching report in SQLite',
            );
            set((s) => ({ deepReports: { ...s.deepReports, [matchId]: null } }));
            return;
          }
          console.info(
            '[loadDeepCoachingReport]',
            matchId,
            'Rust returned row, bytes=',
            raw.reportJson.length,
          );
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(raw.reportJson);
          } catch (parseErr) {
            console.error('Failed to parse coaching report JSON:', parseErr);
            parsed = { _parseError: true };
          }

          // Re-fetch from server if the cached report is either:
          // 1. Old format (missing v2 fields entirely)
          // 2. Pass 1 placeholder data (no real coaching text — empty situation/mistake/correction)
          const isOldFormat =
            !parsed.match_verdict &&
            !parsed.matchVerdict &&
            !parsed.priority_issue &&
            !parsed.priorityIssue;
          const deathCoachingArr = (parsed.deathCoaching ?? parsed.death_coaching) as
            | any[]
            | undefined;
          // A true placeholder has no real coaching text, not just 'unclear' categories.
          // The VLM sometimes outputs 'unclear' for categories even when coaching is real.
          const allDeathsEmpty =
            deathCoachingArr &&
            deathCoachingArr.length > 0 &&
            deathCoachingArr.every((d: any) => !d.situation && !d.mistake && !d.correction);
          const isPass1Placeholder = allDeathsEmpty;
          const enrichStatus = parsed.enrichmentStatus as string | undefined;
          const needsRefresh = isOldFormat || isPass1Placeholder || enrichStatus === 'pending';

          if (needsRefresh) {
            // Cap the refresh at 5s. The Rust command's reqwest client has its own
            // 120s timeout; if we waited for that the row would be stuck on
            // LOADING for two minutes whenever the server is slow. Cached local
            // data is better than nothing.
            const refreshTimeout = new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 5_000),
            );
            try {
              const refreshed = await Promise.race([
                invoke<{
                  id: string;
                  matchId: string;
                  serverReportId: string;
                  reportJson: string;
                  createdAt: number;
                } | null>('refresh_deep_coaching_report', { matchId }),
                refreshTimeout,
              ]);
              if (refreshed) {
                raw = refreshed;
                try {
                  parsed = JSON.parse(raw.reportJson);
                } catch {
                  /* keep old parsed */
                }
              }
            } catch {
              /* server offline — use cached data */
            }

            // Re-check after refresh: if still a true placeholder (no coaching text), store null
            // so the UI doesn't render garbage data. The enrichment-done handler
            // will reload the report once enrichment completes with real data.
            const refreshedDeaths = (parsed.deathCoaching ?? parsed.death_coaching) as
              | any[]
              | undefined;
            const stillAllEmpty =
              refreshedDeaths &&
              refreshedDeaths.length > 0 &&
              refreshedDeaths.every((d: any) => !d.situation && !d.mistake && !d.correction);
            if (stillAllEmpty) {
              console.warn(
                '[loadDeepCoachingReport]',
                matchId,
                'report marked STILL_ALL_EMPTY after refresh — hiding. deathCoaching length:',
                refreshedDeaths?.length,
              );
              set((s) => ({ deepReports: { ...s.deepReports, [matchId]: null } }));
              return;
            }
          }

          // ── Unwrap assessment if it contains embedded JSON (old parser failure path) ──
          let assessment =
            (parsed.overallAssessment as string) ?? (parsed.overall_assessment as string) ?? '';
          let embeddedMoments: Record<string, unknown>[] | null = null;
          let embeddedHighlights: unknown[] | null = null;
          let embeddedDrills: unknown[] | null = null;

          if (assessment.startsWith('{')) {
            try {
              const inner = JSON.parse(assessment);
              assessment =
                (inner.overall_assessment as string) ??
                (inner.overallAssessment as string) ??
                (inner.match_verdict as string) ??
                assessment;
              embeddedMoments = (inner.moments as Record<string, unknown>[]) ?? null;
              embeddedHighlights =
                (inner.positive_highlights as unknown[]) ??
                (inner.positiveHighlights as unknown[]) ??
                null;
              embeddedDrills = (inner.drills as unknown[]) ?? null;
            } catch {
              /* keep as-is */
            }
          }

          // ── v2 schema fields ──────────────────────────────────────────────────
          const matchVerdict =
            (parsed.matchVerdict as string) ?? (parsed.match_verdict as string) ?? assessment ?? '';

          const parsedPriority =
            ((parsed.priorityIssue ?? parsed.priority_issue) as CoachingIssue | null) ?? null;
          const parsedSecondary =
            ((parsed.secondaryIssues ?? parsed.secondary_issues) as CoachingIssue[]) ?? [];
          const parsedAgentMastery =
            ((parsed.agentMastery ?? parsed.agent_mastery) as AgentMastery | null) ?? null;
          const parsedEconomyAudit =
            ((parsed.economyAudit ?? parsed.economy_audit) as EconomyAudit | null) ?? null;
          const parsedStrengths = (parsed.strengths as string[]) ?? [];
          const parsedSessionFocus =
            ((parsed.sessionFocus ?? parsed.session_focus) as SessionFocus | null) ?? null;
          const parsedDeathCoaching =
            ((parsed.deathCoaching ?? parsed.death_coaching) as DeathCoachingEntry[]) ?? [];
          const parsedCoachingContinuity =
            ((parsed.coachingContinuity ??
              parsed.coaching_continuity) as CoachingContinuity | null) ?? null;
          const parsedCoachingHistory =
            ((parsed.coachingHistory ?? parsed.coaching_history) as CoachingHistoryMeta | null) ??
            null;

          // ── Legacy moments (kept for backward compat) ─────────────────────────
          const rawMoments = (parsed.moments as Record<string, unknown>[])?.length
            ? (parsed.moments as Record<string, unknown>[])
            : (embeddedMoments ?? []);

          const moments: CoachingMoment[] = rawMoments.map((m) => ({
            timestamp: (m.timestamp as string) ?? '',
            timestampMs: (m.timestampMs as number) ?? 0,
            cause: (m.cause as string) ?? (m.category as string) ?? 'unknown',
            severity: ((m.severity as string) ?? 'minor') as CoachingMoment['severity'],
            description:
              (m.description as string) ??
              (m.what_was_wrong as string) ??
              (m.what_happened as string) ??
              '',
            whatHappened: (m.whatHappened as string) ?? (m.what_happened as string),
            whatToDoInstead: (m.whatToDoInstead as string) ?? (m.what_to_do as string),
            localClipPath: m.localClipPath as string | undefined,
          }));

          const rawHighlights = (parsed.positiveHighlights as unknown[])?.length
            ? (parsed.positiveHighlights as unknown[])
            : (parsed.positive_highlights as unknown[])?.length
              ? (parsed.positive_highlights as unknown[])
              : (embeddedHighlights ?? []);
          const positiveHighlights = rawHighlights.map((h) => {
            if (typeof h === 'string') return h;
            return h as Record<string, unknown>;
          });

          const report: DeepCoachingReport = {
            id: raw.id,
            matchId: raw.matchId,
            serverReportId: raw.serverReportId,
            createdAt: raw.createdAt,
            reportSchemaVersion: parsed.reportSchemaVersion as number | undefined,
            analysisMetadata: parsed.analysisMetadata as DeepCoachingReport['analysisMetadata'],
            // game mode
            gameMode: (parsed.gameMode ?? parsed.game_mode) as string | undefined,
            rejected: parsed.rejected as boolean | undefined,
            rejectionReason: (parsed.rejectionReason ?? parsed.rejection_reason) as
              | string
              | undefined,
            // v2
            deathCoaching: parsedDeathCoaching,
            matchVerdict,
            priorityIssue: parsedPriority,
            secondaryIssues: parsedSecondary,
            agentMastery: parsedAgentMastery,
            economyAudit: parsedEconomyAudit,
            strengths: parsedStrengths,
            sessionFocus: parsedSessionFocus,
            // Coaching Memory
            coachingContinuity: parsedCoachingContinuity,
            coachingHistory: parsedCoachingHistory,
            // legacy
            moments,
            positiveHighlights,
            overallAssessment: assessment,
            drills: (parsed.drills as CoachingDrill[])?.length
              ? (parsed.drills as CoachingDrill[])
              : ((embeddedDrills as CoachingDrill[]) ?? []),
          };
          console.info('[loadDeepCoachingReport]', matchId, 'SUCCESS — setting report');
          set((s) => ({ deepReports: { ...s.deepReports, [matchId]: report } }));
        } catch (e) {
          // CRITICAL: MUST set deepReports[matchId] to null (not leave undefined)
          // so the UI flips the row to 'unavailable' (with RETRY) instead of
          // showing an infinite spinner. Previously we only console.error'd and
          // the row was stuck loading forever — fixed 2026-04-20.
          console.error('[loadDeepCoachingReport] THREW for', matchId, e);
          set((s) => ({ deepReports: { ...s.deepReports, [matchId]: null } }));
        }
      },

      loadCredits: async () => {
        try {
          const data = await invoke<CoachingCredits>('get_coaching_credits');
          set({ credits: data });
        } catch (e) {
          console.error('get_coaching_credits failed:', e);
        }
      },

      // ── Q&A actions ──────────────────────────────────────────────────────────

      openQnA: (matchId: string) => set({ activeQnAMatchId: matchId }),

      closeQnA: () => set({ activeQnAMatchId: null }),

      getQnAState: (matchId: string) => get().qnaChats[matchId] ?? EMPTY_QNA,

      askQuestion: async (matchId: string, question: string) => {
        const state = get();
        const chat = state.qnaChats[matchId] ?? { ...EMPTY_QNA };

        if (chat.questionsUsed >= MAX_QUESTIONS_PER_MATCH) return;

        const report = state.deepReports[matchId];
        if (!report) return;

        // Add user message + set loading
        const updatedMessages: QnAMessage[] = [
          ...chat.messages,
          { role: 'user', content: question },
        ];
        set((s) => ({
          qnaChats: {
            ...s.qnaChats,
            [matchId]: { ...chat, messages: updatedMessages, loading: true },
          },
        }));

        try {
          // Build history for server context
          const history = updatedMessages.map((m) => ({ role: m.role, content: m.content }));

          const result = await invoke<{
            answer: string;
            tokensUsed: number;
            softBlock?: boolean;
            quota?: { limit: number; remaining: number };
          }>('ask_match_question', {
            reportId: report.serverReportId,
            question,
            history: history.slice(0, -1), // exclude current question (sent separately)
          });

          set((s) => {
            const prev = s.qnaChats[matchId] ?? { ...EMPTY_QNA };
            // If the server returns an authoritative quota snapshot, trust it.
            // Otherwise (older server, soft-block) keep the local counter, and
            // do NOT charge the user for a safety-blocked deflection.
            let questionsUsed = prev.questionsUsed;
            if (result.quota) {
              questionsUsed = Math.max(0, result.quota.limit - result.quota.remaining);
            } else if (!result.softBlock) {
              questionsUsed = prev.questionsUsed + 1;
            }
            return {
              qnaChats: {
                ...s.qnaChats,
                [matchId]: {
                  messages: [
                    ...prev.messages,
                    { role: 'assistant' as const, content: result.answer },
                  ],
                  questionsUsed,
                  loading: false,
                },
              },
            };
          });
        } catch (e) {
          console.error('ask_match_question failed:', e);
          set((s) => {
            const prev = s.qnaChats[matchId] ?? { ...EMPTY_QNA };
            return {
              qnaChats: {
                ...s.qnaChats,
                [matchId]: {
                  ...prev,
                  messages: [
                    ...prev.messages,
                    {
                      role: 'assistant' as const,
                      content: formatUserError(
                        e,
                        "Sorry, I couldn't answer that right now. Try again in a moment.",
                      ),
                    },
                  ],
                  loading: false,
                },
              },
            };
          });
        }
      },
    }),
    {
      name: 'scrima-analysis-store',
      storage: createJSONStorage(() => localStorage),
      // Only persist the bits that must survive reloads:
      //   - qna quota counters (per-match questionsUsed)
      // Messages/loading stay in-memory — we don't want to restore stale chat history
      // and we don't want loading flags sticking around after a crash.
      partialize: (s) => ({
        qnaChats: Object.fromEntries(
          Object.entries(s.qnaChats).map(([matchId, chat]) => [
            matchId,
            { questionsUsed: chat.questionsUsed, messages: [], loading: false } as MatchQnAState,
          ]),
        ),
      }),
    },
  ),
);

// ── Event listeners ───────────────────────────────────────────────────────────

let _unlisten: UnlistenFn[] = [];
let _enrichTimeout: ReturnType<typeof setTimeout> | null = null;

export async function initAnalysisListeners() {
  // Clean up any existing listeners first
  teardownAnalysisListeners();

  const store = useAnalysisStore.getState;

  _unlisten.push(
    await listen<AnalysisProgress>('scrima:analysis-progress', ({ payload }) => {
      useAnalysisStore.setState({ progress: payload });
    }),

    await listen<{ matchId: string; error?: string; reportId?: string }>(
      'scrima:analysis-complete',
      ({ payload }) => {
        // User cancellations are not failures — clear the progress UI silently
        // instead of routing to the red "Analysis failed" box. The Rust side
        // surfaces this as `AnalysisError::Cancelled` whose message contains
        // "cancel"; match leniently so future renames don't reintroduce the bug.
        const looksCancelled = !!payload.error && /cancel/i.test(payload.error);
        if (looksCancelled) {
          useAnalysisStore.setState({ activeMatchId: null, progress: null });
          if (_enrichTimeout) {
            clearTimeout(_enrichTimeout);
            _enrichTimeout = null;
          }
        } else if (payload.error) {
          const errorMsg = formatUserError(payload.error, 'Analysis failed. Try again.');
          useAnalysisStore.setState({
            progress: { matchId: payload.matchId, stage: 'error', error: errorMsg },
          });
        } else {
          // Don't load the report yet — wait for enrichment to finish
          // so the user never sees un-enriched placeholder data
          useAnalysisStore.setState({
            progress: { matchId: payload.matchId, stage: 'enriching' },
            activeMatchId: null,
          });

          // Safety timeout: if enrichment-done never arrives (e.g. no deaths,
          // Rust event lost, or binary too old), fall through after 3 minutes.
          // Enrichment involves ffmpeg frame extraction + base64 upload + VLM inference,
          // which can easily take 1-2 minutes for games with many deaths.
          if (_enrichTimeout) clearTimeout(_enrichTimeout);
          _enrichTimeout = setTimeout(() => {
            const current = useAnalysisStore.getState().progress;
            if (current?.matchId === payload.matchId && current.stage === 'enriching') {
              console.warn('[analysisStore] Enrichment timeout — loading report anyway');
              store().loadDeepCoachingReport(payload.matchId);
              useAnalysisStore.setState({
                progress: { matchId: payload.matchId, stage: 'done' },
              });
            }
            _enrichTimeout = null;
          }, 180_000);
        }
      },
    ),

    await listen<{ matchId: string; enriched: boolean; deathsUpdated?: number }>(
      'scrima:enrichment-done',
      ({ payload }) => {
        if (_enrichTimeout) {
          clearTimeout(_enrichTimeout);
          _enrichTimeout = null;
        }
        // Enrichment finished (success or failure) — NOW load the report
        store().loadDeepCoachingReport(payload.matchId);
        useAnalysisStore.setState({
          progress: { matchId: payload.matchId, stage: 'done' },
        });
      },
    ),

    // Backwards compat: old client binary emits this instead of enrichment-done
    await listen<{ matchId: string; enriched?: boolean; deathsUpdated?: number }>(
      'scrima:enrichment-complete',
      ({ payload }) => {
        store().loadDeepCoachingReport(payload.matchId);
        useAnalysisStore.setState({
          progress: { matchId: payload.matchId, stage: 'done' },
        });
      },
    ),

    await listen<{ deaths: number }>('scrima:trend-progress', ({ payload }) => {
      useAnalysisStore.setState({
        trendProgress: { stage: 'analysing', deaths: payload.deaths },
      });
    }),

    await listen('scrima:trend-complete', () => {
      useAnalysisStore.setState({ trendProgress: { stage: 'done' } });
      useAnalysisStore.getState().loadTrendReport();
    }),

    await listen<{ error: string }>('scrima:trend-error', () => {
      useAnalysisStore.setState({ trendProgress: { stage: 'error' } });
    }),
  );
}

export function teardownAnalysisListeners() {
  _unlisten.forEach((fn) => fn());
  _unlisten = [];
  if (_enrichTimeout) {
    clearTimeout(_enrichTimeout);
    _enrichTimeout = null;
  }
}
