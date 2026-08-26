import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
// GAMING REDESIGN
import { useEffect, useState } from 'react';
import { formatUserError, reportError } from '../../lib/errors';
import { useAnalysisStore } from '../../stores/analysisStore';
import { useAppStore } from '../../stores/appStore';
import { useMatchStore } from '../../stores/matchStore';
import { ConfirmDialog, TrashIcon } from '../shared/ConfirmDialog';
import { VideoPlayer } from '../shared/VideoPlayer';

interface MatchRow {
  id: string;
  gameId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  map: string | null;
  agent: string | null;
  won: boolean | null;
  kills: number;
  deaths: number;
  assists: number;
  recordingPath: string | null;
  recordingSizeBytes: number | null;
  analysisStatus: string;
  createdAt: number;
  /** 1-indexed rank across ALL matches, oldest=1 newest=total. Computed
   *  server-side by the list_matches CTE so the same physical match shows
   *  the same "Game #N" label in history, coaching, and any future view. */
  matchNumber: number;
}

// ── Game data ────────────────────────────────────────────────────────────────

const VALORANT_AGENTS = [
  'Jett',
  'Reyna',
  'Phoenix',
  'Raze',
  'Yoru',
  'Neon',
  'Iso',
  'Waylay',
  'Brimstone',
  'Viper',
  'Omen',
  'Astra',
  'Harbor',
  'Clove',
  'Miks',
  'Sage',
  'Cypher',
  'Killjoy',
  'Chamber',
  'Deadlock',
  'Vyse',
  'Veto',
  'Sova',
  'Breach',
  'Skye',
  'KAY/O',
  'Fade',
  'Gekko',
  'Tejo',
];

const VALORANT_MAPS = [
  'Bind',
  'Haven',
  'Split',
  'Ascent',
  'Icebox',
  'Breeze',
  'Fracture',
  'Pearl',
  'Lotus',
  'Sunset',
  'Abyss',
  'Corrode',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const TIER_CONFIG: Record<string, { label: string; text: string; border: string; bg: string }> = {
  pending: { label: 'PENDING', text: '#7A8BAD', border: '#1A2440', bg: '#0D1221' },
  processing: { label: 'ANALYSING', text: '#F59E0B', border: '#F59E0B44', bg: '#F59E0B0D' },
  done: { label: 'DONE', text: '#00FF85', border: '#00FF8544', bg: '#00FF850D' },
  error: { label: 'ERROR', text: '#FF2D55', border: '#FF2D5544', bg: '#FF2D550D' },
  none: { label: 'N/A', text: '#3D4F6E', border: '#1A2440', bg: '#0A0E1A' },
};

function TierBadge({ status, label }: { status: string; label: string }) {
  const cfg = TIER_CONFIG[status] ?? TIER_CONFIG.none;
  return (
    <span
      className="text-[10px] font-mono font-bold tracking-widest px-2 py-0.5"
      style={{ color: cfg.text, border: `1px solid ${cfg.border}`, background: cfg.bg }}
    >
      {label}:{cfg.label}
    </span>
  );
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number | null) {
  if (!ms) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 KB';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Convert a Windows or Unix file path to a safe asset:// URL.
// convertFileSrc encodes backslashes as %5C which Tauri's scope matching rejects.
function toAssetSrc(filePath: string): string {
  return convertFileSrc(filePath.replace(/\\/g, '/'));
}

// ── Video player modal ─────────────────────────────────────────────────────────

function VideoModal({ match, onClose }: { match: MatchRow; onClose: () => void }) {
  const [videoError, setVideoError] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: '90vw',
          maxWidth: 1100,
          maxHeight: '90vh',
          background: '#0A0E1A',
          border: '1px solid #1A2440',
          boxShadow: '0 0 40px #7C3AED22',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid #1A2440' }}
        >
          <div>
            <span
              className="text-sm font-black tracking-widest uppercase"
              style={{ color: '#E8EFFF' }}
            >
              {formatDate(match.startedAt)}
            </span>
            <span className="text-xs font-mono ml-3" style={{ color: '#7A8BAD' }}>
              {formatDuration(match.durationMs)} · {formatBytes(match.recordingSizeBytes)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid #1A2440',
              color: '#7A8BAD',
              padding: '0.2rem 0.6rem',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: '0.7rem',
              letterSpacing: '0.1em',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#E8EFFF';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#7A8BAD';
            }}
          >
            ✕ CLOSE
          </button>
        </div>

        {/* Video area — flex-1 fills remaining space, overflow hidden keeps it in bounds */}
        <div
          className="flex-1 min-h-0"
          style={{
            background: '#000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {videoError ? (
            <div className="text-center p-8">
              <p
                className="text-sm font-mono font-bold tracking-widest"
                style={{ color: '#FF2D55' }}
              >
                RECORDING UNAVAILABLE
              </p>
              <p className="text-xs font-mono mt-2" style={{ color: '#3D4F6E' }}>
                File may be corrupted or missing. Try re-recording.
              </p>
            </div>
          ) : match.recordingPath ? (
            <VideoPlayer
              key={match.recordingPath}
              src={toAssetSrc(match.recordingPath)}
              maxHeight="calc(90vh - 60px)"
              maxWidth="100%"
              onError={() => setVideoError(true)}
            />
          ) : (
            <span className="text-sm font-mono" style={{ color: '#3D4F6E' }}>
              NO RECORDING AVAILABLE
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

export function HistoryView() {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1); // 1-indexed
  const [loading, setLoading] = useState(true);
  const [watchMatch, setWatchMatch] = useState<MatchRow | null>(null);
  const [selections, setSelections] = useState<Record<string, { agent: string; map: string }>>({});
  const setActiveView = useAppStore((s) => s.setActiveView);
  const runAnalysis = useAnalysisStore((s) => s.runAnalysis);
  const activeMatchId = useAnalysisStore((s) => s.activeMatchId);
  const _matchHistory = useMatchStore((s) => s.matchHistory); // eslint-disable-line @typescript-eslint/no-unused-vars

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const getSelection = (matchId: string) => selections[matchId] ?? { agent: '', map: '' };
  const updateSelection = (matchId: string, field: 'agent' | 'map', value: string) => {
    const prev = selections[matchId] ?? { agent: '', map: '' };
    const next = { ...prev, [field]: value };
    setSelections((s) => ({ ...s, [matchId]: next }));
    // Persist to localStorage so selections survive navigation
    try {
      const stored = JSON.parse(localStorage.getItem('scrima:agent-selections') ?? '{}');
      stored[matchId] = next;
      localStorage.setItem('scrima:agent-selections', JSON.stringify(stored));
    } catch {
      /* ignore */
    }
    // Persist to DB immediately so ground truth survives failed analyses,
    // app restarts, and any per-match state churn. Fire-and-forget.
    invoke('update_match_metadata', {
      matchId,
      agent: next.agent || null,
      map: next.map || null,
    }).catch((err) => console.warn('update_match_metadata failed:', err));
  };

  // Single source of truth for fetching the current page + total. Any action
  // that mutates the table (analyse / delete / import) should call this.
  const loadPage = async (targetPage: number) => {
    const offset = (Math.max(1, targetPage) - 1) * PAGE_SIZE;
    const [rows, total] = await Promise.all([
      invoke<MatchRow[]>('list_recent_matches', { limit: PAGE_SIZE, offset, analysedOnly: false }),
      invoke<number>('count_recent_matches', { analysedOnly: false }),
    ]);
    setMatches(rows);
    setTotalCount(total);
    // Merge in selections for the rows we just loaded, preserving any
    // pre-existing selections for other pages (so going back/forward keeps UI state).
    setSelections((prev) => {
      const stored = JSON.parse(localStorage.getItem('scrima:agent-selections') ?? '{}');
      const merged = { ...prev };
      for (const row of rows) {
        if (!merged[row.id]) {
          merged[row.id] = {
            agent: stored[row.id]?.agent || row.agent || '',
            map: stored[row.id]?.map || row.map || '',
          };
        }
      }
      return merged;
    });
    return { rows, total };
  };

  useEffect(() => {
    (async () => {
      try {
        await loadPage(page);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const handleAnalyse = async (matchId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const sel = getSelection(matchId);
    await runAnalysis(matchId, sel.agent || undefined, sel.map || undefined);
    // Refresh current page so the match's analysis_status reflects the running state
    await loadPage(page).catch((err) => console.warn('refresh after analyse:', err));
    setActiveView('coaching');
  };

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestDelete = (matchId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDelete(matchId);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const matchId = pendingDelete;
    try {
      await invoke('delete_match', { matchId });
      const { rows } = await loadPage(page);
      if (rows.length === 0 && page > 1) setPage((p) => p - 1);
      setPendingDelete(null);
    } catch (err) {
      reportError(err, 'HistoryView.deleteMatch');
      setDeleteError(formatUserError(err, 'Could not delete this match. Try again.'));
    }
  };

  const [importing, setImporting] = useState(false);

  const handleImport = async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] }],
      });
      if (!file) return;

      setImporting(true);
      const matchId = await invoke<string>('import_video', {
        videoPath: file,
        deaths: 5,
      });
      console.log('Imported as match:', matchId);
      // Jump back to page 1 so the new match is visible (newest first).
      if (page !== 1) setPage(1);
      else await loadPage(1);
    } catch (err) {
      console.error('Import failed:', err);
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3">
          <div
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
          />
          <span className="text-sm font-mono tracking-widest" style={{ color: '#7A8BAD' }}>
            LOADING…
          </span>
        </div>
      </div>
    );
  }

  // Empty state only when there are genuinely no matches across ALL pages.
  // (A post-delete empty current page scrolls back a page instead — handled
  // in handleDelete.)
  if (totalCount === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p
            className="text-lg font-black tracking-[0.2em] uppercase mb-2"
            style={{ color: '#E8EFFF' }}
          >
            NO MATCHES RECORDED
          </p>
          <p className="text-xs font-mono tracking-wider" style={{ color: '#3D4F6E' }}>
            START YOUR GAME AND SCRIMA WILL RECORD AUTOMATICALLY
          </p>
        </div>
      </div>
    );
  }

  // Storage tallied from the current page only (cheap + responsive);
  // accurate total-storage would require a separate Rust aggregate query.
  const totalBytes = matches.reduce((sum, m) => sum + (m.recordingSizeBytes ?? 0), 0);

  return (
    <div className="p-6" style={{ color: '#E8EFFF' }}>
      {/* Video modal */}
      {watchMatch && <VideoModal match={watchMatch} onClose={() => setWatchMatch(null)} />}

      {/* Sub-header with stats + import */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-4">
          <div
            className="flex items-center gap-2 px-3 py-1.5"
            style={{
              background: '#0A0E1A',
              border: '1px solid #1A244060',
            }}
          >
            <span className="text-[10px] font-mono tracking-widest" style={{ color: '#3D4F6E' }}>
              MATCHES
            </span>
            <span className="text-sm font-mono font-bold" style={{ color: '#00D4FF' }}>
              {totalCount}
            </span>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-1.5"
            style={{
              background: '#0A0E1A',
              border: '1px solid #1A244060',
            }}
          >
            <span className="text-[10px] font-mono tracking-widest" style={{ color: '#3D4F6E' }}>
              STORAGE
            </span>
            <span className="text-sm font-mono font-bold" style={{ color: '#7A8BAD' }}>
              {formatBytes(totalBytes)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleImport}
          disabled={importing}
          className="btn-primary"
          style={{ padding: '0.4rem 1rem', fontSize: '0.65rem' }}
        >
          {importing ? 'IMPORTING…' : '+ IMPORT VIDEO'}
        </button>
      </div>

      {/* Table header */}
      <div
        className="grid px-4 py-2 mb-1"
        style={{
          gridTemplateColumns: '3px 1fr 6rem 6rem 12rem 5.5rem 2rem',
          gap: '0.75rem',
          background: 'linear-gradient(90deg, #0A0E1A, #0D1221)',
          borderBottom: '1px solid #1A244060',
          alignItems: 'center',
        }}
      >
        {['', 'MATCH', 'STATUS', 'SIZE', 'AGENT / MAP', '', ''].map((h, i) => (
          <span
            key={i}
            className="text-[9px] font-bold tracking-[0.2em] uppercase"
            style={{ color: '#3D4F6E' }}
          >
            {h}
          </span>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-1">
        {matches.map((m) => {
          const isAnalyzed = m.analysisStatus === 'done';
          const hasRecording = !!m.recordingPath;
          // Use the server-computed rank so the same physical match shows the
          // same number in history, coaching, and any future view.
          const matchNum = m.matchNumber;
          return (
            <div
              key={m.id}
              className="grid px-4 py-3 transition-all duration-150 group"
              style={{
                gridTemplateColumns: '3px 1fr 6rem 6rem 12rem 5.5rem 2rem',
                gap: '0.75rem',
                background: '#0D1221',
                border: '1px solid #1A2440',
                alignItems: 'center',
                cursor: 'default',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = '#2A3A60';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = '#1A2440';
              }}
            >
              {/* Accent bar */}
              <div
                style={{
                  width: 3,
                  height: 36,
                  background: isAnalyzed ? '#7C3AED' : '#1A2440',
                  boxShadow: isAnalyzed ? '0 0 6px #7C3AED88' : 'none',
                  borderRadius: 1,
                }}
              />

              {/* Match info: # + date + duration + badges + watch */}
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="text-sm font-bold" style={{ color: '#E8EFFF' }}>
                    Game #{matchNum}
                  </span>
                  {isAnalyzed && (
                    <span
                      className="text-[9px] font-mono font-bold tracking-widest px-1.5 py-0.5"
                      style={{
                        color: '#00FF85',
                        background: '#00FF850D',
                        border: '1px solid #00FF8533',
                      }}
                    >
                      ANALYSED
                    </span>
                  )}
                  {hasRecording && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWatchMatch(m);
                      }}
                      style={{
                        background: 'transparent',
                        border: '1px solid #1A2440',
                        color: '#3D4F6E',
                        padding: '0 0.4rem',
                        fontSize: '0.6rem',
                        fontFamily: 'monospace',
                        letterSpacing: '0.08em',
                        cursor: 'pointer',
                        lineHeight: '1.6',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = '#00D4FF44';
                        (e.currentTarget as HTMLButtonElement).style.color = '#00D4FF';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = '#1A2440';
                        (e.currentTarget as HTMLButtonElement).style.color = '#3D4F6E';
                      }}
                    >
                      ▶ WATCH
                    </button>
                  )}
                </div>
                <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
                  {formatDate(m.startedAt)} · {formatDuration(m.durationMs)}
                </span>
              </div>

              {/* Analysis status */}
              <div className="flex flex-col gap-1">
                <TierBadge status={m.analysisStatus} label="AI" />
              </div>

              {/* File size */}
              <span
                className="text-xs font-mono"
                style={{ color: m.recordingSizeBytes ? '#7A8BAD' : '#3D4F6E' }}
              >
                {formatBytes(m.recordingSizeBytes)}
              </span>

              {/* Agent / Map selection */}
              <div className="flex flex-col gap-1">
                <select
                  value={getSelection(m.id).agent}
                  onChange={(e) => {
                    e.stopPropagation();
                    updateSelection(m.id, 'agent', e.target.value);
                  }}
                  style={{
                    background: '#0A0E1A',
                    color: '#E8EFFF',
                    border: '1px solid #1A2440',
                    fontSize: '0.6rem',
                    fontFamily: 'monospace',
                    padding: '0.2rem 0.3rem',
                    letterSpacing: '0.05em',
                    width: '100%',
                    cursor: 'pointer',
                  }}
                >
                  <option value="">SELECT AGENT</option>
                  {VALORANT_AGENTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <select
                  value={getSelection(m.id).map}
                  onChange={(e) => {
                    e.stopPropagation();
                    updateSelection(m.id, 'map', e.target.value);
                  }}
                  style={{
                    background: '#0A0E1A',
                    color: '#7A8BAD',
                    border: '1px solid #1A2440',
                    fontSize: '0.6rem',
                    fontFamily: 'monospace',
                    padding: '0.2rem 0.3rem',
                    letterSpacing: '0.05em',
                    width: '100%',
                    cursor: 'pointer',
                  }}
                >
                  <option value="">MAP (OPTIONAL)</option>
                  {VALORANT_MAPS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {/* Analyse button */}
              <div>
                <button
                  type="button"
                  onClick={(e) => handleAnalyse(m.id, e)}
                  className="btn-primary"
                  disabled={activeMatchId === m.id || !getSelection(m.id).agent}
                  style={{ padding: '0.25rem 0.6rem', fontSize: '0.65rem', width: '100%' }}
                  title={!getSelection(m.id).agent ? 'Select an agent first' : ''}
                >
                  {activeMatchId === m.id ? 'ANALYSING…' : 'ANALYSE'}
                </button>
              </div>

              {/* Delete — icon column */}
              <button
                type="button"
                onClick={(e) => requestDelete(m.id, e)}
                title="Delete match and recordings"
                aria-label="Delete match and recordings"
                className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#3D4F6E',
                  cursor: 'pointer',
                  padding: '0.25rem',
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = '#FF2D55';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = '#3D4F6E';
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Pagination controls — only render when there's more than one page */}
      {totalPages > 1 && (
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
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#00D4FF44';
                (e.currentTarget as HTMLButtonElement).style.color = '#00D4FF';
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
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#00D4FF44';
                (e.currentTarget as HTMLButtonElement).style.color = '#00D4FF';
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
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this match?"
        body={
          <span>
            This removes the recording, clips, and any analysis for this match permanently.
            {deleteError && (
              <span className="block mt-2 text-xs font-mono" style={{ color: '#FF2D55' }}>
                {deleteError}
              </span>
            )}
          </span>
        }
        confirmLabel="Delete match"
        danger
        onConfirm={confirmDelete}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(null);
        }}
      />
    </div>
  );
}
