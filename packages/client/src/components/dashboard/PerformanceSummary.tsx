// GAMING REDESIGN
import type { MatchRow, MetricValue } from '../../stores/matchStore';

interface Props {
  metrics: MetricValue[];
  match?: MatchRow;
}

/**
 * Grid of K/D/A and other post-game metrics with neon card styling.
 */
export function PerformanceSummary({ metrics, match }: Props) {
  const kd =
    match && match.deaths > 0
      ? (match.kills / match.deaths).toFixed(2)
      : match
        ? match.kills.toString()
        : null;

  return (
    <div
      className="p-5"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
      }}
    >
      <h3
        className="text-[10px] font-black tracking-[0.2em] uppercase mb-4 flex items-center gap-2"
        style={{ color: '#3D4F6E' }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 1,
            background: '#7C3AED',
            verticalAlign: 'middle',
          }}
        />
        PERFORMANCE
      </h3>

      {/* K / D / A from match row */}
      {match && (
        <div className="grid grid-cols-4 gap-3 mb-4">
          <StatCard label="KILLS" value={match.kills.toString()} color="#00FF85" />
          <StatCard label="DEATHS" value={match.deaths.toString()} color="#FF2D55" />
          <StatCard label="ASSISTS" value={match.assists.toString()} color="#00D4FF" />
          {kd && <StatCard label="K/D" value={kd} color="#F59E0B" />}
        </div>
      )}

      {/* Extra metrics */}
      {metrics.length > 0 && (
        <div className="grid grid-cols-4 gap-3 pt-4" style={{ borderTop: '1px solid #1A2440' }}>
          {metrics.map((m) => (
            <StatCard key={m.metricId} label={labelFor(m.metricId)} value={m.formatted} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color = '#E8EFFF',
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      className="text-center p-3"
      style={{
        background: '#0A0E1A',
        border: '1px solid #1A2440',
        clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%)',
      }}
    >
      <div
        className="font-black font-mono leading-none"
        style={{
          fontSize: '1.75rem',
          color,
          textShadow: `0 0 12px ${color}66`,
        }}
      >
        {value}
      </div>
      <div
        className="text-[10px] font-semibold tracking-widest uppercase mt-1.5"
        style={{ color: '#3D4F6E' }}
      >
        {label}
      </div>
    </div>
  );
}

function labelFor(metricId: string): string {
  const labels: Record<string, string> = {
    kills: 'KILLS',
    deaths: 'DEATHS',
    assists: 'ASSISTS',
    kd_ratio: 'K/D',
    rounds_won: 'RND WON',
  };
  return labels[metricId] ?? metricId.toUpperCase();
}
