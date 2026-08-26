// GAMING REDESIGN
import type { GameEvent } from '../../stores/matchStore';

interface Props {
  event: GameEvent;
  index: number;
}

/**
 * Compact death card with left red neon border.
 * Shows: death number, monospace timestamp, HP bar, confidence pill, detection source badges.
 */
export function DeathCard({ event, index }: Props) {
  const time = formatTimestamp(event.timestampMs);
  const prevHp =
    typeof event.data.from === 'number' ? Math.round((event.data.from as number) * 100) : null;
  const killer = typeof event.data.killer === 'string' ? event.data.killer : null;
  const weapon = typeof event.data.weapon === 'string' ? event.data.weapon : null;

  const hpColor =
    prevHp === null ? '#7A8BAD' : prevHp > 50 ? '#00FF85' : prevHp > 25 ? '#F59E0B' : '#FF2D55';

  const confPct = Math.round(event.confidence * 100);

  return (
    <div
      className="flex items-start gap-3 p-3 transition-all duration-150"
      style={{
        background: '#0A0E1A',
        borderLeft: '3px solid #FF2D55',
        borderTop: '1px solid #1A2440',
        borderRight: '1px solid #1A2440',
        borderBottom: '1px solid #1A2440',
        boxShadow: 'inset 2px 0 8px #FF2D5514',
      }}
    >
      {/* Death index */}
      <div
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-xs font-black font-mono"
        style={{
          background: '#FF2D550D',
          border: '1px solid #FF2D5544',
          color: '#FF2D55',
        }}
      >
        {index + 1}
      </div>

      <div className="flex-1 min-w-0">
        {/* Top row: label + timestamp */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-bold tracking-widest uppercase"
              style={{ color: '#FF2D55' }}
            >
              DEATH
            </span>
            {killer && killer !== 'unknown' && (
              <span className="text-xs font-mono" style={{ color: '#E8EFFF' }}>
                by <span style={{ color: '#FF2D55', fontWeight: 700 }}>{killer}</span>
                {weapon && weapon !== 'unknown' && (
                  <span style={{ color: '#7A8BAD' }}> ({weapon})</span>
                )}
              </span>
            )}
          </div>
          <span className="text-xs font-mono" style={{ color: '#3D4F6E' }}>
            {time}
          </span>
        </div>

        {/* HP bar */}
        {prevHp !== null && (
          <div className="mb-1.5">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] font-mono" style={{ color: '#7A8BAD' }}>
                HP BEFORE
              </span>
              <span className="text-[10px] font-mono font-bold" style={{ color: hpColor }}>
                {prevHp}%
              </span>
            </div>
            <div className="h-1" style={{ background: '#1A2440' }}>
              <div
                className="h-full transition-all"
                style={{
                  width: `${prevHp}%`,
                  background: hpColor,
                  boxShadow: `0 0 4px ${hpColor}88`,
                }}
              />
            </div>
          </div>
        )}

        {/* Confidence + sources row */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Confidence pill */}
          <span
            className="text-[10px] font-mono font-semibold px-1.5 py-0.5"
            style={{
              background: '#7C3AED14',
              border: '1px solid #7C3AED44',
              color: '#A78BFA',
            }}
          >
            {confPct}% CONF
          </span>

          {/* Detection source badges */}
          {event.detectionSources.map((src) => (
            <span
              key={src}
              className="text-[10px] font-mono px-1.5 py-0.5"
              style={{
                background: '#1A2440',
                border: '1px solid #2D4A6B',
                color: '#7A8BAD',
              }}
            >
              {src.toUpperCase()}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
