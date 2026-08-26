// GAMING REDESIGN
import type { MatchRow, MatchSummary } from '../../stores/matchStore';
import { PerformanceSummary } from './PerformanceSummary';
import { RoundTimeline } from './RoundTimeline';

interface Props {
  summary: MatchSummary;
  matchRow?: MatchRow;
}

/**
 * Full post-game dashboard — shown after a Valorant session ends.
 * Displays performance metrics, event timeline, and death analysis.
 */
export function PostGameDashboard({ summary, matchRow }: Props) {
  const durationStr = formatDuration(summary.durationMs);
  const won = matchRow?.won;
  const resultColor = won ? '#00FF85' : won === false ? '#FF2D55' : '#7A8BAD';

  return (
    <div className="space-y-5">
      {/* Hero match header */}
      <div
        className="hud-corners relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #0D1221 0%, #121929 100%)',
          border: '1px solid #1A2440',
        }}
      >
        {/* Animated top edge with result color */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 12,
            right: 12,
            height: '1px',
            background: `linear-gradient(90deg, transparent, ${resultColor}60, transparent)`,
          }}
        />

        {/* Background glow based on win/loss */}
        {won !== null && won !== undefined && (
          <>
            <div
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                width: '40%',
                height: '100%',
                background: won
                  ? 'radial-gradient(ellipse at right, #00FF8510 0%, transparent 70%)'
                  : 'radial-gradient(ellipse at right, #FF2D5510 0%, transparent 70%)',
                pointerEvents: 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 3,
                height: '100%',
                background: won
                  ? 'linear-gradient(180deg, #00FF85, #00FF8540)'
                  : 'linear-gradient(180deg, #FF2D55, #FF2D5540)',
                boxShadow: `0 0 8px ${resultColor}40`,
              }}
            />
          </>
        )}

        <div className="p-6">
          <div className="flex items-start justify-between relative">
            <div>
              <div className="flex items-center gap-3 mb-1">
                {/* Win/Loss */}
                {won !== null && won !== undefined && (
                  <span
                    className="text-3xl font-black tracking-[0.15em] uppercase"
                    style={{
                      color: resultColor,
                      textShadow: `0 0 20px ${resultColor}, 0 0 40px ${resultColor}44`,
                    }}
                  >
                    {won ? 'VICTORY' : 'DEFEAT'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3 mt-2">
                {matchRow?.map && (
                  <span
                    className="text-sm font-bold tracking-widest uppercase"
                    style={{ color: '#E8EFFF' }}
                  >
                    {matchRow.map}
                  </span>
                )}
                {matchRow?.agent && (
                  <>
                    <span style={{ color: '#1A244080' }}>|</span>
                    <span
                      className="text-sm font-semibold tracking-wider"
                      style={{ color: '#00D4FF' }}
                    >
                      {matchRow.agent}
                    </span>
                  </>
                )}
                <span style={{ color: '#1A244080' }}>|</span>
                <span className="text-sm font-mono" style={{ color: '#7A8BAD' }}>
                  {durationStr}
                </span>
              </div>
            </div>

            {/* Analysis status pill */}
            <StatusPill status={matchRow?.analysisStatus ?? 'pending'} label="ANALYSIS" />
          </div>
        </div>
      </div>

      {/* K / D / A + metrics */}
      <PerformanceSummary metrics={summary.metrics ?? []} match={matchRow} />

      {/* Event timeline */}
      <div>
        <h3
          className="text-xs font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
          style={{ color: '#7A8BAD' }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 16,
              height: 1,
              background: 'linear-gradient(90deg, #7C3AED, #7C3AED40)',
              verticalAlign: 'middle',
            }}
          />
          EVENTS ({summary.events?.length ?? 0})
        </h3>
        <RoundTimeline events={summary.events ?? []} />
      </div>

      {/* Coachable moments */}
      {(summary.coachableMoments?.length ?? 0) > 0 && (
        <div
          className="flex items-center gap-4 p-4 hud-corners"
          style={{
            background: 'linear-gradient(135deg, #F59E0B08, #0D1221)',
            border: '1px solid #F59E0B30',
          }}
        >
          <div
            className="text-3xl font-black font-mono flex-shrink-0"
            style={{ color: '#F59E0B', textShadow: '0 0 16px #F59E0B30' }}
          >
            {summary.coachableMoments?.length ?? 0}
          </div>
          <div>
            <div
              className="text-sm font-bold tracking-widest uppercase"
              style={{ color: '#F59E0B' }}
            >
              COACHABLE MOMENTS
            </div>
            <div
              className="text-[10px] mt-0.5 font-mono tracking-wider"
              style={{ color: '#7A8BAD' }}
            >
              ANALYSIS PENDING — CHECK COACHING TAB
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusPill({ status, label }: { status: string; label: string }) {
  const color =
    status === 'done'
      ? { text: '#00FF85', border: '#00FF8544', bg: '#00FF850D' }
      : status === 'pending'
        ? { text: '#F59E0B', border: '#F59E0B44', bg: '#F59E0B0D' }
        : { text: '#7A8BAD', border: '#1A2440', bg: '#0D1221' };

  return (
    <span
      className="text-[10px] font-mono font-bold tracking-widest uppercase px-2.5 py-1"
      style={{ color: color.text, border: `1px solid ${color.border}`, background: color.bg }}
    >
      {label}: {status.toUpperCase()}
    </span>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s}s`;
}
