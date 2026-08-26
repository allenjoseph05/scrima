// GAMING REDESIGN
import type { GameEvent } from '../../stores/matchStore';
import { DeathCard } from './DeathCard';

interface Props {
  events: GameEvent[];
}

/**
 * Chronological timeline of significant events (kills, deaths, round transitions).
 * Deaths are shown as cards; other events as timeline dots.
 */
export function RoundTimeline({ events }: Props) {
  if (events.length === 0) {
    return (
      <div
        className="p-5 text-center"
        style={{
          background: '#0D1221',
          border: '1px solid #1A2440',
        }}
      >
        <p className="text-sm font-mono" style={{ color: '#3D4F6E' }}>
          NO EVENTS RECORDED THIS MATCH
        </p>
      </div>
    );
  }

  const deaths = events.filter((e) => e.eventTypeId === 'death');
  const kills = events.filter((e) => e.eventTypeId === 'kill');
  const rounds = events.filter((e) => e.eventTypeId === 'round_start');
  const buys = events.filter((e) => e.eventTypeId === 'buy_phase_start');
  const scores = events.filter((e) => e.eventTypeId === 'score_update');
  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const startMs = sorted[0]?.timestampMs ?? 0;
  const endMs = sorted[sorted.length - 1]?.timestampMs ?? 1;
  const durationMs = endMs - startMs || 1;
  const lastScore = scores.length > 0 ? scores[scores.length - 1] : null;

  return (
    <div className="space-y-4">
      {/* Summary badges */}
      <div className="flex gap-2 flex-wrap">
        <EventBadge
          count={kills.length}
          label="KILLS"
          dotColor="#00FF85"
          borderColor="#00FF8544"
          textColor="#00FF85"
        />
        <EventBadge
          count={deaths.length}
          label="DEATHS"
          dotColor="#FF2D55"
          borderColor="#FF2D5544"
          textColor="#FF2D55"
        />
        {rounds.length > 0 && (
          <EventBadge
            count={rounds.length}
            label="ROUNDS"
            dotColor="#00D4FF"
            borderColor="#00D4FF44"
            textColor="#00D4FF"
          />
        )}
        {lastScore && (
          <ScoreBadge
            teamScore={Number(lastScore.data.team_score ?? 0)}
            enemyScore={Number(lastScore.data.enemy_score ?? 0)}
          />
        )}
        <EventBadge
          count={events.length}
          label="TOTAL EVENTS"
          dotColor="#7A8BAD"
          borderColor="#1A2440"
          textColor="#7A8BAD"
        />
      </div>

      {/* Visual timeline scrubber */}
      <div
        className="p-4"
        style={{
          background: '#0D1221',
          border: '1px solid #1A2440',
        }}
      >
        <h3
          className="text-[10px] font-black tracking-[0.2em] uppercase mb-3"
          style={{ color: '#3D4F6E' }}
        >
          EVENT TIMELINE
        </h3>

        {/* Scrubber track */}
        <div
          className="relative h-5"
          style={{ background: '#0A0E1A', border: '1px solid #1A2440' }}
        >
          {/* Round divider lines */}
          {rounds.map((r, i) => {
            const pct = ((r.timestampMs - startMs) / durationMs) * 100;
            return (
              <div
                key={`round-${r.id}`}
                className="absolute top-0 h-full"
                style={{
                  left: `${pct}%`,
                  width: 1,
                  background: '#1A244088',
                }}
                title={`Round ${i + 1}`}
              />
            );
          })}
          {/* Event dots */}
          {sorted
            .filter((e) => e.eventTypeId !== 'round_start')
            .map((e) => {
              const pct = ((e.timestampMs - startMs) / durationMs) * 100;
              return (
                <div
                  key={e.id}
                  className="absolute top-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${pct}%`,
                    width: 6,
                    height: 6,
                    background: dotColor(e.eventTypeId),
                    boxShadow: `0 0 4px ${dotColor(e.eventTypeId)}`,
                    transform: 'translate(-50%, -50%)',
                  }}
                  title={`${e.eventTypeId} @ ${formatTs(e.timestampMs)}`}
                />
              );
            })}
        </div>

        <div className="flex justify-between mt-1.5">
          <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
            {formatTs(startMs)}
          </span>
          <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
            {formatTs(endMs)}
          </span>
        </div>
      </div>

      {/* Death cards */}
      {deaths.length > 0 && (
        <div
          className="p-4"
          style={{
            background: '#0D1221',
            border: '1px solid #1A2440',
          }}
        >
          <h3
            className="text-[10px] font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
            style={{ color: '#3D4F6E' }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 1,
                background: '#FF2D55',
                verticalAlign: 'middle',
              }}
            />
            DEATHS ({deaths.length})
          </h3>
          <div className="space-y-2">
            {deaths.map((d, i) => (
              <DeathCard key={d.id} event={d} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* Economy per round */}
      {buys.length > 0 && (
        <div
          className="p-4"
          style={{
            background: '#0D1221',
            border: '1px solid #1A2440',
          }}
        >
          <h3
            className="text-[10px] font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
            style={{ color: '#3D4F6E' }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 1,
                background: '#F59E0B',
                verticalAlign: 'middle',
              }}
            />
            ECONOMY ({buys.length} ROUNDS)
          </h3>
          <div className="flex gap-2 flex-wrap">
            {buys.map((b, i) => {
              const money = Number(b.data.money ?? 0);
              const buyType = String(b.data.buy_type ?? 'unknown');
              return <EconomyPill key={b.id} round={i + 1} money={money} buyType={buyType} />;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EventBadge({
  count,
  label,
  dotColor: dot,
  borderColor,
  textColor,
}: {
  count: number;
  label: string;
  dotColor: string;
  borderColor: string;
  textColor: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5"
      style={{ border: `1px solid ${borderColor}`, background: '#0D1221' }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: dot, boxShadow: `0 0 4px ${dot}` }}
      />
      <span className="text-xs font-mono font-bold" style={{ color: textColor }}>
        {count}
      </span>
      <span
        className="text-[10px] font-mono tracking-widest uppercase"
        style={{ color: '#7A8BAD' }}
      >
        {label}
      </span>
    </div>
  );
}

function dotColor(eventTypeId: string): string {
  switch (eventTypeId) {
    case 'kill':
      return '#00FF85';
    case 'death':
      return '#FF2D55';
    case 'round_start':
      return '#00D4FF';
    case 'score_update':
      return '#00D4FF';
    case 'buy_phase_start':
      return '#F59E0B';
    default:
      return '#7A8BAD';
  }
}

function ScoreBadge({ teamScore, enemyScore }: { teamScore: number; enemyScore: number }) {
  const won = teamScore > enemyScore;
  const color = won ? '#00FF85' : teamScore === enemyScore ? '#F59E0B' : '#FF2D55';
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5"
      style={{ border: `1px solid ${color}44`, background: '#0D1221' }}
    >
      <span className="text-xs font-mono font-bold" style={{ color }}>
        {teamScore} – {enemyScore}
      </span>
      <span
        className="text-[10px] font-mono tracking-widest uppercase"
        style={{ color: '#7A8BAD' }}
      >
        SCORE
      </span>
    </div>
  );
}

function EconomyPill({ round, money, buyType }: { round: number; money: number; buyType: string }) {
  const buyColor: Record<string, string> = {
    full_buy: '#00FF85',
    force_buy: '#F59E0B',
    half_buy: '#F59E0B',
    eco: '#FF2D55',
    pistol: '#00D4FF',
  };
  const color = buyColor[buyType] ?? '#7A8BAD';
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{ background: '#0A0E1A', border: '1px solid #1A2440' }}
    >
      <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
        R{round}
      </span>
      <span className="text-xs font-mono font-bold" style={{ color: '#E8EFFF' }}>
        ${money.toLocaleString()}
      </span>
      <span
        className="text-[10px] font-mono font-semibold uppercase px-1 py-0.5"
        style={{ background: `${color}14`, border: `1px solid ${color}44`, color }}
      >
        {buyType.replace('_', ' ')}
      </span>
    </div>
  );
}

function formatTs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
