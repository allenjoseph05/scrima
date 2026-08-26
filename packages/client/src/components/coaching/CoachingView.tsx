import { invoke } from '@tauri-apps/api/core';
// GAMING REDESIGN — Card-based coaching view
import { useEffect, useState } from 'react';
import { type DeepCoachingReport, useAnalysisStore } from '../../stores/analysisStore';
import { useAppStore } from '../../stores/appStore';
import { useMatchStore } from '../../stores/matchStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { CoachingReportView } from './CoachingReportView';
import { MatchQnA } from './MatchQnA';

// ── Progress bar ──────────────────────────────────────────────────────────────

function AnalysisProgressBar({
  onRetry,
  onCancel,
}: { onRetry?: () => void; onCancel?: () => void }) {
  const progress = useAnalysisStore((s) => s.progress);
  if (!progress || progress.stage === 'done' || progress.stage === 'idle') return null;
  const canCancel = onCancel && progress.stage !== 'coaching_report' && progress.stage !== 'error';

  const isError = progress.stage === 'error';

  // Use server-provided percent if available, otherwise fall back to stage estimates
  const pct = isError
    ? 100
    : progress.percent != null
      ? progress.percent
      : progress.stage === 'extracting'
        ? 10
        : progress.stage === 'classifying'
          ? 20
          : progress.stage === 'compressing'
            ? 15
            : progress.stage === 'uploading'
              ? 42
              : progress.stage === 'analyzing'
                ? 65
                : progress.stage === 'analyzing_background'
                  ? 70
                  : progress.stage === 'coaching_report'
                    ? 88
                    : progress.stage === 'enriching'
                      ? 95
                      : 50;

  const stageLabel: Record<string, string> = {
    extracting: 'EXTRACTING FRAMES',
    classifying: 'CLASSIFYING FRAMES',
    compressing: 'PREPARING VIDEO FOR ANALYSIS',
    uploading: 'UPLOADING TO SERVER',
    analyzing: 'AI ANALYZING YOUR GAMEPLAY',
    analyzing_background: 'ANALYSIS IN PROGRESS (BACKGROUND)',
    coaching_report: 'GENERATING COACHING REPORT',
    enriching: 'ENHANCING COACHING — ANALYZING DEATH FRAMES',
    error: 'ANALYSIS FAILED',
  };

  // Use server-provided detail text when available
  const labelText = progress.detail
    ? progress.detail.toUpperCase()
    : (stageLabel[progress.stage] ?? progress.stage.toUpperCase());

  return (
    <div
      className="mb-6 p-4"
      style={{
        background: isError ? '#FF2D550D' : '#0D1221',
        border: `1px solid ${isError ? '#FF2D5544' : '#1A2440'}`,
      }}
    >
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2">
          {!isError && (
            <div
              className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin flex-shrink-0"
              style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
            />
          )}
          <span
            className="text-xs font-mono font-bold tracking-widest"
            style={{ color: isError ? '#FF2D55' : '#00D4FF' }}
          >
            {labelText}
          </span>
          {isError && (
            <span className="text-[10px] font-mono ml-2" style={{ color: '#7A8BAD' }}>
              — Analysis failed. Try again.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isError && (
            <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
              {pct}%
            </span>
          )}
          {isError && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="btn-ghost"
              style={{ padding: '0.2rem 0.75rem', fontSize: '0.65rem' }}
            >
              RETRY
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-[10px] font-mono font-bold tracking-widest px-2.5 py-0.5 transition-colors"
              style={{
                color: '#FF2D55',
                border: '1px solid #FF2D5533',
                background: '#FF2D550D',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#FF2D5520';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#FF2D550D';
              }}
            >
              CANCEL
            </button>
          )}
        </div>
      </div>

      {/* Progress bar track */}
      <div className="h-1" style={{ background: '#0A0E1A' }}>
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${isError ? 100 : pct}%`,
            background: isError ? '#FF2D55' : 'linear-gradient(90deg, #7C3AED, #00D4FF)',
            boxShadow: isError ? '0 0 6px #FF2D55' : '0 0 8px #7C3AED',
          }}
        />
      </div>
    </div>
  );
}

// ── Analysis card ─────────────────────────────────────────────────────────────

interface AnalysisCardData {
  matchId: string;
  matchNum: number;
  date: string;
  report: DeepCoachingReport;
}

function AnalysisCard({
  data,
  isExpanded,
  onToggle,
  onOpenQnA,
}: {
  data: AnalysisCardData;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenQnA: () => void;
}) {
  const { report } = data;
  const momentCount = report.moments.length;
  const criticalCount = report.moments.filter((m) => m.severity === 'critical').length;
  const highlightCount = report.positiveHighlights.length;

  // Truncate assessment for preview
  const previewText = report.overallAssessment
    ? report.overallAssessment.length > 150
      ? `${report.overallAssessment.slice(0, 150)}…`
      : report.overallAssessment
    : 'Analysis complete';

  return (
    <div
      style={{
        background: '#0A0E1A',
        border: `1px solid ${isExpanded ? '#7C3AED44' : '#1A2440'}`,
        transition: 'border-color 0.2s',
      }}
    >
      {/* Card header — always visible */}
      <div
        className="p-4 cursor-pointer"
        onClick={onToggle}
        onMouseEnter={(e) => {
          if (!isExpanded)
            (e.currentTarget.parentElement as HTMLDivElement).style.borderColor = '#2A3450';
        }}
        onMouseLeave={(e) => {
          if (!isExpanded)
            (e.currentTarget.parentElement as HTMLDivElement).style.borderColor = '#1A2440';
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {/* Title row */}
            <div className="flex items-center gap-3 mb-2">
              <span
                className="text-xs font-black tracking-[0.15em] uppercase"
                style={{ color: '#E8EFFF' }}
              >
                Game #{data.matchNum}
              </span>
              <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
                {data.date}
              </span>
            </div>

            {/* Preview text */}
            {!isExpanded && (
              <p className="text-xs leading-relaxed" style={{ color: '#7A8BAD' }}>
                {previewText}
              </p>
            )}
          </div>

          {/* Stats + expand indicator */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Stat badges */}
            <div className="flex gap-2">
              {momentCount > 0 && (
                <span
                  className="text-[9px] font-mono px-2 py-0.5"
                  style={{
                    color: criticalCount > 0 ? '#FF2D55' : '#F59E0B',
                    background: criticalCount > 0 ? '#FF2D550D' : '#F59E0B0D',
                    border: `1px solid ${criticalCount > 0 ? '#FF2D5533' : '#F59E0B33'}`,
                  }}
                >
                  {momentCount} MOMENT{momentCount !== 1 ? 'S' : ''}
                </span>
              )}
              {highlightCount > 0 && (
                <span
                  className="text-[9px] font-mono px-2 py-0.5"
                  style={{
                    color: '#00FF88',
                    background: '#00FF880D',
                    border: '1px solid #00FF8833',
                  }}
                >
                  {highlightCount} GOOD
                </span>
              )}
            </div>

            {/* Chevron */}
            <span
              className="text-xs transition-transform duration-200"
              style={{
                color: '#3D4F6E',
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            >
              ▼
            </span>
          </div>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-4 pb-4">
          <div
            className="h-px mb-4"
            style={{ background: 'linear-gradient(90deg, #7C3AED44, transparent)' }}
          />
          <CoachingReportView report={report} />

          {/* Q&A button */}
          <div className="mt-4 pt-4" style={{ borderTop: '1px solid #1A2440' }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenQnA();
              }}
              className="text-[10px] font-bold tracking-[0.15em] uppercase px-4 py-2 transition-all duration-200"
              style={{
                color: '#A78BFA',
                background: '#7C3AED0D',
                border: '1px solid #7C3AED33',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#7C3AED1A';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#7C3AED0D';
              }}
            >
              ASK YOUR COACH
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Placeholder row for matches whose report is loading / analyzing / missing.
//    Matches the AnalysisCard header layout so the list visually reads as
//    N rows = N analyzed matches regardless of per-row load state.
function StatusRow({
  matchId,
  matchNum,
  date,
  state,
  onRetry,
}: {
  matchId: string;
  matchNum: number;
  date: string;
  state: 'loading' | 'unavailable' | 'analyzing';
  onRetry?: () => Promise<void> | void;
}) {
  // Track in-flight retry locally so the click is always visible even if
  // loadDeepCoachingReport resolves to the same state (null → null).
  const [retrying, setRetrying] = useState(false);

  const effectiveState = retrying ? 'loading' : state;
  const label = retrying
    ? 'RETRYING…'
    : effectiveState === 'loading'
      ? 'LOADING REPORT…'
      : effectiveState === 'analyzing'
        ? 'ANALYSIS IN PROGRESS'
        : 'REPORT UNAVAILABLE';
  const labelColor = effectiveState === 'unavailable' ? '#FF2D55' : '#7A8BAD';
  const showSpinner = effectiveState !== 'unavailable';

  const handleRetry = async () => {
    if (!onRetry || retrying) return;
    console.info('[StatusRow] RETRY clicked for match', matchId);
    setRetrying(true);
    try {
      await onRetry();
      console.info('[StatusRow] RETRY resolved for match', matchId);
    } catch (err) {
      console.error('[StatusRow] RETRY threw for match', matchId, err);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      style={{
        background: '#0A0E1A',
        border: '1px solid #1A2440',
        padding: '1rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="text-xs font-black tracking-[0.15em] uppercase"
          style={{ color: '#E8EFFF' }}
        >
          Game #{matchNum}
        </span>
        <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
          {date}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {showSpinner && (
          <div
            className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: labelColor, borderTopColor: 'transparent' }}
          />
        )}
        <span
          className="text-[10px] font-mono font-bold tracking-[0.15em]"
          style={{ color: labelColor }}
        >
          {label}
        </span>
        {onRetry && !retrying && effectiveState === 'unavailable' && (
          <button
            type="button"
            onClick={handleRetry}
            style={{
              background: '#FF2D550D',
              border: '1px solid #FF2D5544',
              color: '#FF2D55',
              padding: '0.25rem 0.75rem',
              fontSize: '0.6rem',
              fontFamily: 'monospace',
              letterSpacing: '0.15em',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#FF2D5522';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#FF2D550D';
            }}
          >
            RETRY
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────────

interface MatchInfo {
  id: string;
  startedAt: number;
  map: string | null;
  analysisStatus: string;
  /** Server-computed 1-indexed rank across ALL matches (oldest=1, newest=total).
   *  Consistent with the same field in history view so "Game #N" is identical
   *  for the same physical match in both places. */
  matchNumber: number;
}

const PAGE_SIZE = 10;

export function CoachingView() {
  const [pageMatches, setPageMatches] = useState<MatchInfo[]>([]);
  const [totalAnalyzed, setTotalAnalyzed] = useState(0);
  const [page, setPage] = useState(1); // 1-indexed
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [qnaMatchId, setQnaMatchId] = useState<string | null>(null);

  const progress = useAnalysisStore((s) => s.progress);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);
  const cancelAnalysis = useAnalysisStore((s) => s.cancelAnalysis);
  const activeMatchId = useAnalysisStore((s) => s.activeMatchId);
  const deepReports = useAnalysisStore((s) => s.deepReports);
  const loadDeepCoachingReport = useAnalysisStore((s) => s.loadDeepCoachingReport);

  // matchStore + appStore used per spec
  const _matchHistory = useMatchStore((s) => s.matchHistory); // eslint-disable-line @typescript-eslint/no-unused-vars
  const _activeView = useAppStore((s) => s.activeView); // eslint-disable-line @typescript-eslint/no-unused-vars

  // Dismiss notifications when this view is opened
  const dismissForView = useNotificationStore((s) => s.dismissForView);
  useEffect(() => {
    dismissForView('coaching');
  }, [dismissForView]);

  const totalPages = Math.max(1, Math.ceil(totalAnalyzed / PAGE_SIZE));
  const progressStage = progress?.stage;
  // The match currently being analyzed (if any). We MUST NOT load its deep
  // report while analysis is running — the DB row may be in a partially-
  // written state. For every other match on the page we load freely, which
  // fixes the bug where history→analyze→coaching showed NO past reports
  // until the current analysis finished.
  const activelyAnalyzingId =
    activeMatchId && progressStage !== undefined && progressStage !== 'done' ? activeMatchId : null;

  // Load the current page of analyzed matches and their reports.
  // Triggers: page change, progress-stage transitions (so completed analyses
  // on any page refresh), and mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
        const [rows, total] = await Promise.all([
          invoke<MatchInfo[]>('list_recent_matches', {
            limit: PAGE_SIZE,
            offset,
            analysedOnly: true,
          }),
          invoke<number>('count_recent_matches', { analysedOnly: true }),
        ]);
        if (cancelled) return;
        setPageMatches(rows);
        setTotalAnalyzed(total);

        // Load deep reports in parallel for every match on this page EXCEPT
        // the one currently analyzing. Previously this skipped ALL reports
        // when any analysis was running — the exact bug being fixed here.
        await Promise.all(
          rows.map((row) => {
            if (row.id === activelyAnalyzingId) return Promise.resolve();
            if (deepReports[row.id] != null) return Promise.resolve();
            return loadDeepCoachingReport(row.id).catch((err) => {
              console.warn('loadDeepCoachingReport failed for', row.id, err);
            });
          }),
        );
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, progressStage, activelyAnalyzingId]);

  // Auto-expand newly completed analysis AND jump to page 1 so the user
  // actually sees it (new analyses surface as the newest analyzed match).
  useEffect(() => {
    if (progress?.stage === 'done' && progress.matchId) {
      setExpandedId(progress.matchId);
      setPage(1);
    }
  }, [progress]);

  // Build one entry per matches row, carrying whichever report state exists.
  // We DO NOT filter out unloaded/null entries — the user should see every
  // analyzed match as a row (skeleton if still loading, placeholder if the
  // report couldn't be loaded). Previously we filtered these out, which made
  // legitimate analyzed matches disappear from the list.
  type CoachingRow = {
    matchId: string;
    matchNum: number;
    date: string;
    state: 'loaded' | 'loading' | 'unavailable' | 'analyzing';
    report: DeepCoachingReport | null;
  };
  const rows: CoachingRow[] = pageMatches.map((m) => {
    // Server-computed absolute rank — matches the number shown in history
    // view for the same physical match (same m.id across views).
    const matchNum = m.matchNumber;
    const date = new Date(m.startedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const report = deepReports[m.id];
    let state: CoachingRow['state'];
    if (m.id === activelyAnalyzingId) state = 'analyzing';
    else if (report === undefined) state = 'loading';
    else if (report === null) state = 'unavailable';
    else state = 'loaded';
    return { matchId: m.id, matchNum, date, state, report: report ?? null };
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-3">
        <div
          className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
          style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
        />
        <span className="text-sm font-mono" style={{ color: '#7A8BAD' }}>
          LOADING…
        </span>
      </div>
    );
  }

  // Empty state only when there are genuinely no analyzed matches across ALL
  // pages AND no analysis is currently running. An analysis-in-flight keeps
  // the progress bar visible even with an empty page, which is correct UX.
  if (totalAnalyzed === 0 && !progress) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p
            className="text-lg font-black tracking-[0.15em] uppercase mb-2"
            style={{ color: '#E8EFFF' }}
          >
            NO ANALYSED MATCHES
          </p>
          <p className="text-sm font-mono" style={{ color: '#3D4F6E' }}>
            Go to History and click ANALYSE on a completed match.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto" style={{ color: '#E8EFFF' }}>
      {/* Header */}
      <div className="mb-6">
        <h1
          className="text-2xl font-black tracking-[0.15em] uppercase"
          style={{ color: '#E8EFFF' }}
        >
          COACHING ANALYSIS
        </h1>
        <p className="text-xs font-mono tracking-widest mt-1" style={{ color: '#7A8BAD' }}>
          AI-POWERED GAME COACHING — {totalAnalyzed} REPORT{totalAnalyzed !== 1 ? 'S' : ''}
        </p>
      </div>

      {/* Progress bar for active analysis */}
      <AnalysisProgressBar
        onRetry={activeMatchId ? () => runAnalysis(activeMatchId) : undefined}
        onCancel={cancelAnalysis}
      />

      {/* Q&A modal */}
      {qnaMatchId && <MatchQnA matchId={qnaMatchId} onClose={() => setQnaMatchId(null)} />}

      {/* Analysis cards — render one row per analyzed match on this page.
          Loaded rows show the full card; loading / unavailable / analyzing
          rows show a status placeholder so the user can always see the
          expected count of analyzed matches. */}
      <div className="space-y-3">
        {rows.map((row) => {
          if (row.state === 'loaded' && row.report) {
            return (
              <AnalysisCard
                key={row.matchId}
                data={{
                  matchId: row.matchId,
                  matchNum: row.matchNum,
                  date: row.date,
                  report: row.report,
                }}
                isExpanded={expandedId === row.matchId}
                onToggle={() =>
                  setExpandedId((prev) => (prev === row.matchId ? null : row.matchId))
                }
                onOpenQnA={() => setQnaMatchId(row.matchId)}
              />
            );
          }
          // Fallback path: row.state is 'loading' | 'analyzing' | 'unavailable'
          // (the 'loaded' branch returned above). Also covers the rare case
          // where state='loaded' but report is null — render as unavailable.
          const placeholderState = row.state === 'loaded' ? 'unavailable' : row.state;
          return (
            <StatusRow
              key={row.matchId}
              matchId={row.matchId}
              matchNum={row.matchNum}
              date={row.date}
              state={placeholderState}
              onRetry={
                placeholderState === 'unavailable'
                  ? () => loadDeepCoachingReport(row.matchId)
                  : undefined
              }
            />
          );
        })}
      </div>

      {/* Pagination controls — always render when there are analyzed matches.
          Single-page state shows "Page 1 of 1" with disabled controls so the
          UI is visually consistent with the history view (which also shows
          pagination). */}
      {totalAnalyzed > 0 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{
              background: '#0A0E1A',
              border: '1px solid #1A2440',
              color: page === 1 ? '#2A3450' : '#7A8BAD',
              padding: '0.4rem 0.9rem',
              fontSize: '0.65rem',
              fontFamily: 'monospace',
              letterSpacing: '0.15em',
              fontWeight: 700,
              cursor: page === 1 ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              if (page !== 1) {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#7C3AED44';
                (e.currentTarget as HTMLButtonElement).style.color = '#A78BFA';
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = '#1A2440';
              (e.currentTarget as HTMLButtonElement).style.color =
                page === 1 ? '#2A3450' : '#7A8BAD';
            }}
          >
            ← PREV
          </button>
          <span className="text-[10px] font-mono tracking-[0.15em]" style={{ color: '#3D4F6E' }}>
            PAGE <span style={{ color: '#E8EFFF', fontWeight: 700 }}>{page}</span> OF{' '}
            <span style={{ color: '#E8EFFF', fontWeight: 700 }}>{totalPages}</span>
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            style={{
              background: '#0A0E1A',
              border: '1px solid #1A2440',
              color: page >= totalPages ? '#2A3450' : '#7A8BAD',
              padding: '0.4rem 0.9rem',
              fontSize: '0.65rem',
              fontFamily: 'monospace',
              letterSpacing: '0.15em',
              fontWeight: 700,
              cursor: page >= totalPages ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              if (page < totalPages) {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#7C3AED44';
                (e.currentTarget as HTMLButtonElement).style.color = '#A78BFA';
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = '#1A2440';
              (e.currentTarget as HTMLButtonElement).style.color =
                page >= totalPages ? '#2A3450' : '#7A8BAD';
            }}
          >
            NEXT →
          </button>
        </div>
      )}

      {/* Placeholder only when the user has zero analyzed matches yet and an
          analysis is running. Once there's at least one row, rows + progress
          bar above make the state self-explanatory. */}
      {totalAnalyzed === 0 && progress && (
        <div className="text-center py-12">
          <p className="text-sm font-mono tracking-widest" style={{ color: '#3D4F6E' }}>
            YOUR ANALYSIS WILL APPEAR HERE ONCE COMPLETE
          </p>
        </div>
      )}
    </div>
  );
}
