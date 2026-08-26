/**
 * CoachEras (Phase 5 — Living Mind)
 *
 * Chapter-based view of the player's growth. Each era = a skill the coach
 * worked on with the player, start → graduation. Scales infinitely: 200
 * games = ~6-10 eras; 2000 games = ~30-50 eras.
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md §5
 */

import { useEffect, useState } from 'react';
import { type Era, type EraLiveStatus, useEraStore } from '../../stores/eraStore';

const PAST_ERAS_PREVIEW_COUNT = 3;

const DOMAIN_COLOR: Record<string, string> = {
  mechanical: '#FF2D55',
  game_sense: '#00D4FF',
  utility: '#F59E0B',
  mental: '#A78BFA',
};

const DOMAIN_LABEL: Record<string, string> = {
  mechanical: 'MECHANICAL',
  game_sense: 'GAME SENSE',
  utility: 'UTILITY',
  mental: 'MENTAL',
};

const STATUS_LABEL: Record<Era['data']['status'], string> = {
  active: 'ACTIVE',
  graduated: 'GRADUATED',
  abandoned: 'ABANDONED',
  paused: 'PAUSED',
};

const STATUS_COLOR: Record<Era['data']['status'], string> = {
  active: '#00D4FF',
  graduated: '#00FF88',
  abandoned: '#6B7280',
  paused: '#F59E0B',
};

/**
 * Closed-era live-status badge config. We re-check the skill's current
 * mastery on every list call — if the player has slipped since the era
 * "graduated" we surface that here instead of letting the dashboard claim
 * forever that they mastered it.
 */
const LIVE_STATUS_CONFIG: Partial<Record<EraLiveStatus, { label: string; color: string }>> = {
  maintained: { label: 'STILL SOLID', color: '#00FF88' },
  declining: { label: 'SLIPPING', color: '#F59E0B' },
  regressed: { label: 'REGRESSED', color: '#FF2D55' },
};

// ── Era card ────────────────────────────────────────────────────────────────

function formatDateRange(data: Era['data']): string {
  const start = new Date(data.startDate);
  const end = data.endDate ? new Date(data.endDate) : null;
  const startLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endLabel = end
    ? end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : 'now';
  return `${startLabel} — ${endLabel}`;
}

function EraCard({ era }: { era: Era }) {
  const color = DOMAIN_COLOR[era.data.domain] ?? '#7C3AED';
  const statusColor = STATUS_COLOR[era.data.status];
  const startPct = Math.round(era.data.startMastery * 100);
  const endPct = era.data.endMastery != null ? Math.round(era.data.endMastery * 100) : null;

  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `4px solid ${color}`,
        boxShadow: era.data.status === 'active' ? `0 0 20px ${color}0D` : 'none',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span
          className="text-[9px] font-mono tracking-wider uppercase px-1.5 py-0.5"
          style={{
            color: statusColor,
            background: `${statusColor}0D`,
            border: `1px solid ${statusColor}44`,
          }}
        >
          ◆ {STATUS_LABEL[era.data.status]}
        </span>
        <span
          className="text-[9px] font-mono tracking-wider uppercase px-1.5 py-0.5"
          style={{
            color,
            background: `${color}0D`,
            border: `1px solid ${color}44`,
          }}
        >
          {DOMAIN_LABEL[era.data.domain] ?? era.data.domain}
        </span>
        {era.liveStatus &&
          era.liveStatus !== 'active' &&
          era.liveStatus !== 'unknown' &&
          LIVE_STATUS_CONFIG[era.liveStatus] && (
            <span
              className="text-[9px] font-mono tracking-wider uppercase px-1.5 py-0.5"
              style={{
                color: LIVE_STATUS_CONFIG[era.liveStatus]!.color,
                background: `${LIVE_STATUS_CONFIG[era.liveStatus]!.color}0D`,
                border: `1px solid ${LIVE_STATUS_CONFIG[era.liveStatus]!.color}44`,
              }}
              title={
                era.currentMastery != null
                  ? `Currently ${Math.round(era.currentMastery * 100)}% mastery`
                  : undefined
              }
            >
              {LIVE_STATUS_CONFIG[era.liveStatus]!.label}
            </span>
          )}
        <span className="ml-auto text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
          {formatDateRange(era.data)} · {era.data.gamesCount} games
        </span>
      </div>

      {/* Title */}
      <p className="text-base font-black leading-snug mb-2" style={{ color: '#E8EFFF' }}>
        {era.label}
      </p>

      {/* Mastery delta */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 relative h-1.5" style={{ background: '#1A2440' }}>
          <div
            className="absolute top-0 left-0 h-full"
            style={{
              width: `${endPct ?? startPct}%`,
              background: color,
            }}
          />
          {endPct != null && startPct !== endPct && (
            <div
              className="absolute top-0 h-full"
              style={{
                left: `${Math.min(startPct, endPct)}%`,
                width: `${Math.abs(endPct - startPct)}%`,
                background: `${color}66`,
                border: `1px solid ${color}88`,
              }}
            />
          )}
        </div>
        <span className="text-[11px] font-mono flex-shrink-0" style={{ color: '#B0BCDB' }}>
          {startPct}%{endPct != null ? ` → ${endPct}%` : ' → climbing'}
        </span>
      </div>

      {/* Summary */}
      {era.data.summary ? (
        <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
          {era.data.summary}
        </p>
      ) : (
        <p className="text-xs italic leading-relaxed" style={{ color: '#7A8BAD' }}>
          Working on {era.data.primarySkillName.toLowerCase()} — mastery climbing from {startPct}%.
          Summary will be written when this era graduates.
        </p>
      )}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyEras() {
  return (
    <div className="px-6 py-16 text-center">
      <div
        className="w-12 h-12 mx-auto mb-4 flex items-center justify-center"
        style={{
          border: '1px solid #7C3AED44',
          background: '#7C3AED0D',
        }}
      >
        <span className="text-xl" style={{ color: '#A78BFA' }}>
          ◆
        </span>
      </div>
      <p className="text-sm font-bold mb-2" style={{ color: '#E8EFFF' }}>
        Your first chapter will start soon.
      </p>
      <p className="text-xs leading-relaxed max-w-sm mx-auto" style={{ color: '#7A8BAD' }}>
        Each era is a chapter of your growth — one skill at a time. Play a few games and I'll start
        the first one.
      </p>
    </div>
  );
}

// ── Stackable content (Phase 7A — used by CoachLivingMind) ─────────────────

/**
 * ErasSections renders the eras (current chapter + past chapters) without the
 * outer scroll shell. Use this when composing inside CoachLivingMind. Use
 * <CoachEras /> for legacy standalone tab rendering.
 */
export function ErasSections() {
  const eras = useEraStore((s) => s.eras);
  const fetched = useEraStore((s) => s.fetched);
  const fetchEras = useEraStore((s) => s.fetchEras);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetchEras();
  }, [fetchEras]);

  if (fetched && eras.length === 0) {
    return <EmptyEras />;
  }

  const activeEra = eras.find((e) => e.data.status === 'active');
  const pastEras = eras.filter((e) => e.data.status !== 'active');
  const hasMore = pastEras.length > PAST_ERAS_PREVIEW_COUNT;
  const visiblePastEras = expanded ? pastEras : pastEras.slice(0, PAST_ERAS_PREVIEW_COUNT);

  return (
    <div className="space-y-6">
      {activeEra && (
        <div className="space-y-3">
          <p className="text-[10px] font-mono tracking-widest" style={{ color: '#00D4FF' }}>
            CURRENT CHAPTER
          </p>
          <EraCard era={activeEra} />
        </div>
      )}

      {pastEras.length > 0 && (
        <div className="space-y-3">
          <p className="text-[10px] font-mono tracking-widest" style={{ color: '#A78BFA' }}>
            PAST CHAPTERS ({pastEras.length})
          </p>
          <div className="space-y-3">
            {visiblePastEras.map((era) => (
              <EraCard key={era.id} era={era} />
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="text-[10px] font-mono tracking-widest uppercase px-3 py-1.5"
              style={{
                color: '#A78BFA',
                background: 'transparent',
                border: '1px solid #A78BFA33',
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Show recent only' : `Show all ${pastEras.length} chapters`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component (legacy full-view; kept for rollback safety) ────────────

export function CoachEras() {
  const loading = useEraStore((s) => s.loading);
  const fetched = useEraStore((s) => s.fetched);

  if (loading && !fetched) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div
            className="w-4 h-4 border-2 rounded-full animate-spin"
            style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
          />
          <span className="text-xs font-mono" style={{ color: '#3D4F6E' }}>
            Loading your chapters...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-auto px-6 py-5"
      style={{
        maskImage:
          'linear-gradient(to bottom, transparent 0%, black 2%, black 98%, transparent 100%)',
        WebkitMaskImage:
          'linear-gradient(to bottom, transparent 0%, black 2%, black 98%, transparent 100%)',
      }}
    >
      <div className="max-w-3xl mx-auto pb-12">
        <ErasSections />
      </div>
    </div>
  );
}
