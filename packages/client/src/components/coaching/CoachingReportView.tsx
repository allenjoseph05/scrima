/// Coaching Report View — Tier 3 deep coaching report display (v2)
///
/// Layout:
///   Match Verdict → Priority Issue (big) → Round Timeline → Agent Mastery
///   → Secondary Issues (collapsible) → Economy Audit → Strengths → Session Focus

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import type {
  AgentMastery,
  CoachingContinuity,
  CoachingDrill,
  CoachingHistoryMeta,
  CoachingIssue,
  CoachingMoment,
  DeathCoachingEntry,
  DeepCoachingReport,
  EconomyAudit,
  SessionFocus,
} from '../../stores/analysisStore';
import { type CompassState, useCompassStore } from '../../stores/compassStore';

// ── Phase 2 — timestamp parsing for Counterfactual Clip frame extraction ────

function parseApproxTimeToSec(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ── Colors ────────────────────────────────────────────────────────────────────

const CATEGORY_COLOR: Record<string, string> = {
  crosshair: '#00D4FF',
  positioning: '#7C3AED',
  economy: '#10B981',
  utility: '#F59E0B',
  decision: '#FF6B35',
  movement: '#E879F9',
  rotation: '#06B6D4',
  peeking: '#F59E0B',
  spray_control: '#8B5CF6',
  game_sense: '#FF6B35',
  trading: '#06B6D4',
  unclear: '#6B7280',
  outplayed: '#6B7280',
  unknown: '#4B5563',
};

const MODE_LABEL: Record<string, string> = {
  competitive: 'COMPETITIVE',
  unrated: 'UNRATED',
  swiftplay: 'SWIFTPLAY',
  premier: 'PREMIER',
  custom: 'CUSTOM',
  deathmatch: 'DEATHMATCH',
  team_deathmatch: 'TEAM DM',
  spike_rush: 'SPIKE RUSH',
};

function categoryColor(cat: string) {
  return CATEGORY_COLOR[cat?.toLowerCase()] ?? CATEGORY_COLOR.unknown;
}

// ── Category tag ──────────────────────────────────────────────────────────────

function CategoryTag({ category }: { category: string }) {
  const color = categoryColor(category);
  return (
    <span
      className="text-[9px] font-mono tracking-wider uppercase px-2 py-0.5"
      style={{ color, background: `${color}18`, border: `1px solid ${color}44` }}
    >
      {category}
    </span>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <h3
      className="text-[10px] font-black tracking-[0.2em] uppercase mb-3"
      style={{ color: '#3D4F6E' }}
    >
      {title}
    </h3>
  );
}

// ── Mode badge ───────────────────────────────────────────────────────────────

function ModeBadge({ mode }: { mode?: string }) {
  if (!mode) return null;
  const label = MODE_LABEL[mode] ?? mode.toUpperCase();
  const isDM = mode === 'deathmatch' || mode === 'team_deathmatch';
  const color = isDM ? '#F59E0B' : '#00D4FF';
  return (
    <span
      className="text-[9px] font-black tracking-[0.15em] uppercase px-2.5 py-1"
      style={{ color, background: `${color}12`, border: `1px solid ${color}33` }}
    >
      {label}
    </span>
  );
}

// ── Coaching progress ────────────────────────────────────────────────────────

const TREND_CONFIG: Record<string, { label: string; color: string }> = {
  improving: { label: 'IMPROVING', color: '#00FF88' },
  recurring: { label: 'RECURRING', color: '#FF2D55' },
  new: { label: 'NEW', color: '#F59E0B' },
};

function ChallengeCard({
  history,
  continuity,
}: {
  history: CoachingHistoryMeta;
  continuity: CoachingContinuity | null;
}) {
  if (history.sessionNumber <= 1) return null;

  const accentColor = '#00D4FF';

  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: `1px solid ${accentColor}33`,
        borderLeft: `4px solid ${accentColor}`,
        boxShadow: `0 0 20px ${accentColor}08`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-mono tracking-widest" style={{ color: accentColor }}>
          COACHING PROGRESS
        </p>
        <span
          className="text-[10px] font-black tracking-[0.15em] uppercase px-2.5 py-1"
          style={{ color: '#00D4FF', background: '#00D4FF12', border: '1px solid #00D4FF33' }}
        >
          SESSION #{history.sessionNumber}
        </span>
      </div>

      {/* Last focus area (informational, no status tracking) */}
      {history.lastChallenge && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <CategoryTag category={history.lastChallenge.category} />
          </div>
          <p className="text-base font-black" style={{ color: '#E8EFFF' }}>
            {history.lastChallenge.title}
          </p>
        </div>
      )}

      {/* VLM progress note */}
      {continuity?.progress_note && (
        <div
          className="p-3 mb-3"
          style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}18` }}
        >
          <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
            {continuity.progress_note}
          </p>
        </div>
      )}

      {/* No challenge: show pattern trends (fallback) */}
      {!history.lastChallenge && history.patterns.length > 0 && (
        <div className="space-y-2 mb-3">
          {history.patterns.map((p) => {
            const trendCfg = TREND_CONFIG[p.trend] ?? TREND_CONFIG.new;
            return (
              <div key={p.category} className="flex items-center gap-2 flex-wrap">
                <CategoryTag category={p.category} />
                <span className="text-[10px] font-mono" style={{ color: '#B0BCDB' }}>
                  {p.count}/10 games
                </span>
                <span
                  className="text-[9px] font-black tracking-wider uppercase px-2 py-0.5"
                  style={{
                    color: trendCfg.color,
                    background: `${trendCfg.color}0D`,
                    border: `1px solid ${trendCfg.color}44`,
                  }}
                >
                  {trendCfg.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Previous drill reference */}
      {history.lastDrill && (
        <p className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
          DRILL WAS: {history.lastDrill}
        </p>
      )}
    </div>
  );
}

// ── Rejection view ───────────────────────────────────────────────────────────

function RejectedReportView({ reason }: { reason: string }) {
  return (
    <div
      className="p-6 text-center"
      style={{
        background: '#0D1221',
        border: '1px solid #FF2D5533',
        borderLeft: '4px solid #FF2D55',
      }}
    >
      <p className="text-[10px] font-mono tracking-widest mb-3" style={{ color: '#FF2D55' }}>
        NOT ANALYZED
      </p>
      <p className="text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
        {reason}
      </p>
    </div>
  );
}

// ── Match verdict ─────────────────────────────────────────────────────────────

function MatchVerdictCard({ verdict }: { verdict: string }) {
  if (!verdict) return null;
  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: '3px solid #00D4FF',
      }}
    >
      <p className="text-[10px] font-mono tracking-widest mb-2" style={{ color: '#3D4F6E' }}>
        MATCH SUMMARY
      </p>
      <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
        {verdict}
      </p>
    </div>
  );
}

// ── Priority issue ────────────────────────────────────────────────────────────

function PriorityIssueCard({ issue, isDM }: { issue: CoachingIssue; isDM?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const color = categoryColor(issue.category);

  return (
    <div
      style={{
        background: '#0D1221',
        border: '1px solid #FF2D5533',
        borderLeft: '4px solid #FF2D55',
        boxShadow: '0 0 20px #FF2D5510',
      }}
    >
      {/* Header */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span
              className="text-[9px] font-black tracking-widest uppercase px-2 py-0.5"
              style={{ color: '#FF2D55', background: '#FF2D550D', border: '1px solid #FF2D5544' }}
            >
              PRIORITY ISSUE
            </span>
            <CategoryTag category={issue.category} />
            <span
              className="text-[10px] font-mono ml-auto flex-shrink-0"
              style={{ color: '#FF2D55' }}
            >
              {issue.rounds_affected} {isDM ? 'times observed' : 'rounds affected'}
            </span>
          </div>
          <p className="text-base font-black tracking-wide" style={{ color: '#E8EFFF' }}>
            {issue.title}
          </p>
        </div>
        <span className="text-xs font-mono flex-shrink-0 mt-1" style={{ color: '#3D4F6E' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4" style={{ borderTop: '1px solid #1A2440' }}>
          <div className="pt-4">
            <p
              className="text-[10px] font-mono tracking-widest mb-1.5"
              style={{ color: '#3D4F6E' }}
            >
              WHAT HAPPENED
            </p>
            <p className="text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
              {issue.what_happened}
            </p>
          </div>
          <div>
            <p
              className="text-[10px] font-mono tracking-widest mb-1.5"
              style={{ color: '#3D4F6E' }}
            >
              {isDM ? 'WHY IT MATTERS' : 'WHY IT COSTS ROUNDS'}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
              {issue.root_cause}
            </p>
          </div>
          <div className="p-3" style={{ background: `${color}0D`, border: `1px solid ${color}33` }}>
            <p className="text-[10px] font-mono tracking-widest mb-1.5" style={{ color }}>
              DO THIS INSTEAD
            </p>
            <p className="text-sm leading-relaxed font-medium" style={{ color: '#E8EFFF' }}>
              {issue.what_to_do}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Agent mastery ─────────────────────────────────────────────────────────────

function AgentMasteryCard({ mastery }: { mastery: AgentMastery }) {
  const score = Math.max(0, Math.min(100, mastery.score));
  const color = score >= 70 ? '#00FF88' : score >= 45 ? '#F59E0B' : '#FF2D55';

  return (
    <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-mono tracking-widest" style={{ color: '#3D4F6E' }}>
          AGENT MASTERY
        </p>
        <span className="text-2xl font-black font-mono" style={{ color }}>
          {score}
          <span className="text-sm font-mono" style={{ color: '#3D4F6E' }}>
            /100
          </span>
        </span>
      </div>
      {/* Score bar */}
      <div className="h-1.5 mb-4" style={{ background: '#0A0E1A' }}>
        <div
          className="h-full transition-all duration-700"
          style={{
            width: `${score}%`,
            background: `linear-gradient(90deg, #FF2D55, ${color})`,
            boxShadow: `0 0 6px ${color}`,
          }}
        />
      </div>
      <div className="space-y-2">
        <div className="flex gap-2">
          <span className="text-sm flex-shrink-0" style={{ color: '#00FF88' }}>
            ✓
          </span>
          <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
            {mastery.correct_usage}
          </p>
        </div>
        <div className="flex gap-2">
          <span className="text-sm flex-shrink-0" style={{ color: '#FF2D55' }}>
            ✗
          </span>
          <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
            {mastery.missed_power}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Secondary issues ──────────────────────────────────────────────────────────

function SecondaryIssueRow({ issue }: { issue: CoachingIssue }) {
  const [expanded, setExpanded] = useState(false);
  const color = categoryColor(issue.category);
  const severityColor = issue.severity === 'moderate' ? '#F59E0B' : '#6B7280';

  return (
    <div
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${color}`,
      }}
    >
      <button
        type="button"
        className="w-full text-left p-3 flex items-start gap-3"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <CategoryTag category={issue.category} />
            <span className="text-[9px] font-mono uppercase" style={{ color: severityColor }}>
              {issue.severity ?? 'minor'}
            </span>
            <span className="text-[9px] font-mono ml-auto" style={{ color: '#3D4F6E' }}>
              {issue.rounds_affected}× observed
            </span>
          </div>
          <p className="text-sm" style={{ color: '#E8EFFF' }}>
            {issue.title}
          </p>
        </div>
        <span className="text-xs font-mono flex-shrink-0 mt-0.5" style={{ color: '#3D4F6E' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-3" style={{ borderTop: '1px solid #0A0E1A' }}>
          <div className="pt-3">
            <p className="text-[10px] font-mono tracking-widest mb-1" style={{ color: '#3D4F6E' }}>
              WHAT HAPPENED
            </p>
            <p className="text-xs leading-relaxed" style={{ color: '#7A8BAD' }}>
              {issue.what_happened}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-mono tracking-widest mb-1" style={{ color: '#3D4F6E' }}>
              WHY IT MATTERS
            </p>
            <p className="text-xs leading-relaxed" style={{ color: '#7A8BAD' }}>
              {issue.root_cause}
            </p>
          </div>
          <div
            className="p-2.5"
            style={{ background: `${color}0D`, border: `1px solid ${color}22` }}
          >
            <p className="text-[10px] font-mono tracking-widest mb-1" style={{ color }}>
              DO THIS INSTEAD
            </p>
            <p className="text-xs leading-relaxed" style={{ color: '#E8EFFF' }}>
              {issue.what_to_do}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Economy audit ─────────────────────────────────────────────────────────────

function EconomyAuditCard({ audit }: { audit: EconomyAudit }) {
  if (!audit || audit.rounds_desynced === 0) return null;
  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: '1px solid #10B98133',
        borderLeft: '3px solid #10B981',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-mono tracking-widest" style={{ color: '#3D4F6E' }}>
          ECONOMY AUDIT
        </p>
        <span className="text-lg font-black font-mono" style={{ color: '#F59E0B' }}>
          {audit.rounds_desynced}
          <span className="text-xs font-mono ml-1" style={{ color: '#3D4F6E' }}>
            rounds desynced
          </span>
        </span>
      </div>
      {audit.key_example && (
        <p
          className="text-xs font-mono mb-2 px-2 py-1.5"
          style={{ color: '#F59E0B', background: '#F59E0B0D', border: '1px solid #F59E0B22' }}
        >
          {audit.key_example}
        </p>
      )}
      <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
        {audit.verdict}
      </p>
    </div>
  );
}

// ── Strengths ─────────────────────────────────────────────────────────────────

function StrengthsCard({ strengths }: { strengths: string[] }) {
  if (strengths.length === 0) return null;
  return (
    <div className="p-4" style={{ background: '#00FF880A', border: '1px solid #00FF8822' }}>
      <p className="text-[10px] font-mono tracking-widest mb-3" style={{ color: '#3D4F6E' }}>
        WHAT YOU DID WELL
      </p>
      <div className="space-y-2">
        {strengths.map((s, i) => (
          <div key={i} className="flex gap-2 text-sm">
            <span style={{ color: '#00FF88', flexShrink: 0 }}>+</span>
            <p style={{ color: '#E8EFFF' }}>{s}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Session focus ─────────────────────────────────────────────────────────────

function SessionFocusCard({ focus }: { focus: SessionFocus }) {
  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: '1px solid #F59E0B44',
        borderLeft: '4px solid #F59E0B',
        boxShadow: '0 0 20px #F59E0B0A',
      }}
    >
      <p className="text-[10px] font-mono tracking-widest mb-3" style={{ color: '#F59E0B' }}>
        RECOMMENDED DRILL
      </p>
      <p className="text-base font-black mb-4" style={{ color: '#E8EFFF' }}>
        {focus.drill_name}
      </p>
      <p className="text-xs leading-relaxed mb-4" style={{ color: '#B0BCDB' }}>
        {focus.drill_steps}
      </p>
      <div className="flex items-center gap-4 mb-4">
        <span className="text-xs font-mono" style={{ color: '#3D4F6E' }}>
          {focus.drill_duration_minutes} MIN
        </span>
      </div>
      {focus.in_game_cue && (
        <div className="p-3" style={{ background: '#F59E0B15', border: '1px solid #F59E0B33' }}>
          <p className="text-[10px] font-mono tracking-widest mb-1.5" style={{ color: '#F59E0B' }}>
            SAY THIS BEFORE EACH ROUND
          </p>
          <p className="text-sm italic" style={{ color: '#E8EFFF' }}>
            "{focus.in_game_cue}"
          </p>
        </div>
      )}
    </div>
  );
}

// ── Death coaching timeline ──────────────────────────────────────────────────

function DeathCoachingTimeline({ deaths }: { deaths: DeathCoachingEntry[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (deaths.length === 0) return null;

  const avoidableCount = deaths.filter((d) => d.avoidable).length;

  return (
    <div>
      <SectionHeader
        title={`DEATH-BY-DEATH COACHING (${deaths.length} DEATHS — ${avoidableCount} AVOIDABLE)`}
      />
      <div className="space-y-2">
        {deaths.map((d, i) => {
          const color = categoryColor(d.category);
          const isExpanded = expandedIdx === i;

          return (
            <div
              key={d.death_number}
              style={{
                background: '#0D1221',
                border: '1px solid #1A2440',
                borderLeft: `3px solid ${d.avoidable ? '#FF2D55' : '#6B7280'}`,
              }}
            >
              <button
                type="button"
                className="w-full text-left p-3 flex items-start gap-3"
                onClick={() => setExpandedIdx(isExpanded ? null : i)}
              >
                {/* Death number badge */}
                <span
                  className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-[11px] font-black"
                  style={{
                    color: d.avoidable ? '#FF2D55' : '#6B7280',
                    background: d.avoidable ? '#FF2D550D' : '#6B72800D',
                    border: `1px solid ${d.avoidable ? '#FF2D5544' : '#6B728044'}`,
                    borderRadius: '50%',
                  }}
                >
                  {d.death_number}
                </span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <CategoryTag category={d.category} />
                    {d.confidence && (
                      <span
                        className="text-[9px] font-mono tracking-wider uppercase px-2 py-0.5"
                        style={{
                          color: '#00D4FF',
                          background: '#00D4FF0D',
                          border: '1px solid #00D4FF44',
                        }}
                      >
                        {d.confidence} confidence
                      </span>
                    )}
                    {!d.avoidable && (
                      <span
                        className="text-[9px] font-mono tracking-wider uppercase px-2 py-0.5"
                        style={{
                          color: '#6B7280',
                          background: '#6B72800D',
                          border: '1px solid #6B728044',
                        }}
                      >
                        FAIR DUEL
                      </span>
                    )}
                    <span
                      className="text-[10px] font-mono ml-auto flex-shrink-0"
                      style={{ color: '#3D4F6E' }}
                    >
                      {d.approximate_time}
                    </span>
                  </div>
                  <p className="text-sm leading-snug" style={{ color: '#B0BCDB' }}>
                    {d.situation}
                  </p>
                </div>

                <span
                  className="text-xs font-mono flex-shrink-0 mt-0.5"
                  style={{ color: '#3D4F6E' }}
                >
                  {isExpanded ? '\u25B2' : '\u25BC'}
                </span>
              </button>

              {isExpanded && (
                <div
                  className="px-3 pb-3 ml-9 space-y-3"
                  style={{ borderTop: '1px solid #0A0E1A' }}
                >
                  {d.coachPausePoint && (
                    <div className="pt-3">
                      <p
                        className="text-[10px] font-mono tracking-widest mb-1"
                        style={{ color: '#7A8BAD' }}
                      >
                        COACH PAUSE POINT
                      </p>
                      <p className="text-xs leading-relaxed" style={{ color: '#E8EFFF' }}>
                        {d.coachPausePoint}
                      </p>
                    </div>
                  )}
                  <div className="pt-3 flex gap-2">
                    <span className="text-sm flex-shrink-0" style={{ color: '#FF2D55' }}>
                      {'\u2717'}
                    </span>
                    <div>
                      <p
                        className="text-[10px] font-mono tracking-widest mb-1"
                        style={{ color: '#FF2D55' }}
                      >
                        MISTAKE
                      </p>
                      <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                        {d.mistake}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-sm flex-shrink-0" style={{ color: '#00FF88' }}>
                      {'\u2192'}
                    </span>
                    <div
                      className="flex-1 p-2.5"
                      style={{ background: `${color}0D`, border: `1px solid ${color}22` }}
                    >
                      <p
                        className="text-[10px] font-mono tracking-widest mb-1"
                        style={{ color: '#00FF88' }}
                      >
                        CORRECTION
                      </p>
                      <p className="text-xs leading-relaxed" style={{ color: '#E8EFFF' }}>
                        {d.correction}
                      </p>
                    </div>
                  </div>
                  {Array.isArray(d.timeline) && d.timeline.length > 0 && (
                    <div className="space-y-1">
                      <p
                        className="text-[10px] font-mono tracking-widest"
                        style={{ color: '#7A8BAD' }}
                      >
                        TIMELINE
                      </p>
                      {d.timeline.map((item, idx) => (
                        <p
                          key={`${d.death_number}-timeline-${idx}`}
                          className="text-[11px] leading-relaxed"
                          style={{ color: '#B0BCDB' }}
                        >
                          <span className="font-mono" style={{ color: '#3D4F6E' }}>
                            {item.time}
                          </span>{' '}
                          <span style={{ color: '#E8EFFF' }}>{item.label}:</span> {item.detail}
                        </p>
                      ))}
                    </div>
                  )}
                  {Array.isArray(d.evidence) && d.evidence.length > 0 && (
                    <div className="space-y-1">
                      <p
                        className="text-[10px] font-mono tracking-widest"
                        style={{ color: '#7A8BAD' }}
                      >
                        EVIDENCE
                      </p>
                      {d.evidence.slice(0, 6).map((item, idx) => (
                        <p
                          key={`${d.death_number}-evidence-${idx}`}
                          className="text-[11px] leading-relaxed"
                          style={{ color: '#B0BCDB' }}
                        >
                          <span style={{ color: '#E8EFFF' }}>{item.label}:</span> {item.value}
                          {item.source && (
                            <span className="font-mono" style={{ color: '#3D4F6E' }}>
                              {' '}
                              ({item.source})
                            </span>
                          )}
                        </p>
                      ))}
                    </div>
                  )}
                  {Array.isArray(d.unknowns) && d.unknowns.length > 0 && (
                    <div>
                      <p
                        className="text-[10px] font-mono tracking-widest mb-1"
                        style={{ color: '#7A8BAD' }}
                      >
                        NOT PROVEN
                      </p>
                      <p className="text-[11px] leading-relaxed" style={{ color: '#7A8BAD' }}>
                        {d.unknowns.slice(0, 4).join('; ')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Legacy fallback (old report format) ──────────────────────────────────────

function LegacyMomentCard({ moment, index }: { moment: CoachingMoment; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = categoryColor(moment.cause);

  return (
    <div
      className="p-4 cursor-pointer transition-all duration-150"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${color}`,
      }}
      onClick={() => setExpanded((p) => !p)}
    >
      <div className="flex items-start gap-3">
        <span className="text-[10px] font-mono w-5 flex-shrink-0" style={{ color: '#3D4F6E' }}>
          {index + 1}.
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <CategoryTag category={moment.cause} />
            <span className="text-[9px] font-mono uppercase" style={{ color: '#F59E0B' }}>
              {moment.severity}
            </span>
          </div>
          <p className="text-sm leading-snug" style={{ color: '#E8EFFF' }}>
            {moment.description}
          </p>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 ml-8 space-y-3">
          {moment.whatHappened && (
            <div>
              <p
                className="text-[10px] font-mono tracking-widest mb-1"
                style={{ color: '#3D4F6E' }}
              >
                WHAT HAPPENED
              </p>
              <p className="text-xs leading-relaxed" style={{ color: '#7A8BAD' }}>
                {moment.whatHappened}
              </p>
            </div>
          )}
          {moment.whatToDoInstead && (
            <div>
              <p
                className="text-[10px] font-mono tracking-widest mb-1"
                style={{ color: '#3D4F6E' }}
              >
                DO THIS INSTEAD
              </p>
              <p className="text-xs leading-relaxed" style={{ color: '#E8EFFF' }}>
                {moment.whatToDoInstead}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegacyDrillCard({ drill }: { drill: CoachingDrill }) {
  const color = categoryColor(drill.targetsCategory);
  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <p className="text-sm font-black tracking-wide" style={{ color: '#E8EFFF' }}>
          {drill.name}
        </p>
        <span className="text-[9px] font-mono flex-shrink-0" style={{ color: '#3D4F6E' }}>
          {drill.durationMinutes}MIN
        </span>
      </div>
      <p className="text-xs leading-relaxed" style={{ color: '#7A8BAD' }}>
        {drill.description}
      </p>
    </div>
  );
}

// ── Phase 3: Bottleneck Compass ─────────────────────────────────────────────
// Small widget above OneThingCard showing the player's current highest-leverage
// skill. Reads from compassStore which fetches /coaching/compass via Tauri.

const DOMAIN_LABEL: Record<string, string> = {
  mechanical: 'MECHANICAL',
  game_sense: 'GAME SENSE',
  utility: 'UTILITY',
  mental: 'MENTAL',
};

const DOMAIN_COLOR: Record<string, string> = {
  mechanical: '#FF2D55',
  game_sense: '#00D4FF',
  utility: '#F59E0B',
  mental: '#A78BFA',
};

function BottleneckBadge({ priorityCategory }: { priorityCategory?: string }) {
  const compass = useCompassStore((s) => s.compass);
  const loading = useCompassStore((s) => s.loading);
  const fetchCompass = useCompassStore((s) => s.fetchCompass);

  useEffect(() => {
    fetchCompass(priorityCategory);
  }, [fetchCompass, priorityCategory]);

  // Initial load / error → show nothing (fail-silent so the report never breaks)
  if (loading && !compass) return null;
  if (!compass) return null;

  return renderCompassState(compass);
}

function renderCompassState(compass: CompassState) {
  if (compass.state === 'building') {
    return (
      <div
        className="p-3 flex items-start gap-3"
        style={{
          background: '#0D1221',
          border: '1px solid #1A2440',
          borderLeft: '3px solid #3D4F6E',
        }}
      >
        <span className="text-base flex-shrink-0 leading-none" style={{ color: '#7A8BAD' }}>
          ◈
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-mono tracking-widest mb-1" style={{ color: '#7A8BAD' }}>
            BUILDING YOUR PROFILE
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
            {compass.totalObservations} observations so far. {compass.gamesToGo} more
            {compass.gamesToGo === 1 ? ' game' : ' games'} of data and I can point at your
            bottleneck.
          </p>
        </div>
      </div>
    );
  }

  if (compass.state === 'early') {
    return (
      <div
        className="p-3 flex items-start gap-3"
        style={{
          background: '#0D1221',
          border: '1px solid #1A2440',
          borderLeft: '3px solid #3D4F6E',
        }}
      >
        <span className="text-base flex-shrink-0 leading-none" style={{ color: '#7A8BAD' }}>
          ◈
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-mono tracking-widest mb-1" style={{ color: '#7A8BAD' }}>
            GETTING TO KNOW YOUR PLAY
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
            Not enough consistent signal yet to call a bottleneck. Keep uploading — the coach is
            still mapping you.
          </p>
        </div>
      </div>
    );
  }

  if (compass.state === 'all_mastered') {
    return (
      <div
        className="p-3 flex items-start gap-3"
        style={{
          background: '#0D1221',
          border: '1px solid #00FF8833',
          borderLeft: '3px solid #00FF88',
        }}
      >
        <span className="text-base flex-shrink-0 leading-none" style={{ color: '#00FF88' }}>
          ◈
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-mono tracking-widest mb-1" style={{ color: '#00FF88' }}>
            ALL FUNDAMENTALS AUTOMATIC
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
            Every core skill in your profile is at mastery. Focus on marginal gains and mindset.
          </p>
        </div>
      </div>
    );
  }

  // state === 'ready'
  const { primary, alignedWithPriorityCategory } = compass;
  const domainColor = DOMAIN_COLOR[primary.domain] ?? '#7A8BAD';
  const domainLabel = DOMAIN_LABEL[primary.domain] ?? primary.domain.toUpperCase();

  return (
    <div
      className="p-3"
      style={{
        background: '#0D1221',
        border: `1px solid ${domainColor}33`,
        borderLeft: `3px solid ${domainColor}`,
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="text-base flex-shrink-0 leading-none mt-0.5"
          style={{ color: domainColor }}
        >
          ◈
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="text-[10px] font-mono tracking-widest" style={{ color: '#7A8BAD' }}>
              YOUR BOTTLENECK
            </p>
            <span
              className="text-[9px] font-mono tracking-wider uppercase px-1.5 py-0.5"
              style={{
                color: domainColor,
                background: `${domainColor}0D`,
                border: `1px solid ${domainColor}44`,
              }}
            >
              {domainLabel}
            </span>
            {alignedWithPriorityCategory !== undefined && (
              <span
                className="text-[9px] font-mono tracking-wider uppercase px-1.5 py-0.5 ml-auto flex-shrink-0"
                style={
                  alignedWithPriorityCategory
                    ? { color: '#00FF88', background: '#00FF880D', border: '1px solid #00FF8844' }
                    : { color: '#F59E0B', background: '#F59E0B0D', border: '1px solid #F59E0B44' }
                }
              >
                {alignedWithPriorityCategory
                  ? '✓ REPORT TARGETS IT'
                  : '⚠ REPORT COVERS DIFFERENT SKILL'}
              </span>
            )}
          </div>
          <p className="text-sm font-black leading-snug mb-1" style={{ color: '#E8EFFF' }}>
            {primary.name}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
            {primary.blockedCount === 0
              ? `Mastery ${Math.round(primary.pMastery * 100)}%. Working on this strengthens your foundation.`
              : `Fixing this unlocks ${primary.blockedCount} downstream skill${primary.blockedCount === 1 ? '' : 's'}. Mastery ${Math.round(primary.pMastery * 100)}%.`}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Phase 1A: "One Thing / One Clip / One Drill" layout ─────────────────────
// Above-the-fold condensed view. Old cards preserved above; invoked from the
// EverythingElseDrawer below when the player expands it. See
// docs/YOUR_COACH_PHASE1_PLAN.md.

function OneThingCard({
  issue,
  history,
  continuity,
  isDM,
}: {
  issue: CoachingIssue | null;
  history: CoachingHistoryMeta | null;
  continuity: CoachingContinuity | null;
  isDM?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!issue) return null;
  const color = categoryColor(issue.category);

  // Session context as a one-liner. Look for a pattern entry matching this category.
  // Optional-chain on patterns too — legacy reports may have history without patterns array.
  const patternMatch = history?.patterns?.find((p) => p.category === issue.category);
  const sessionHint =
    history && history.sessionNumber > 1
      ? patternMatch
        ? `Session #${history.sessionNumber} — flagged in ${patternMatch.count} of last 10 games`
        : `Session #${history.sessionNumber}`
      : null;

  return (
    <div
      style={{
        background: '#0D1221',
        border: '1px solid #FF2D5533',
        borderLeft: '4px solid #FF2D55',
        boxShadow: '0 0 20px #FF2D5510',
      }}
    >
      {/* Header body */}
      <div className="p-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span
            className="text-[9px] font-black tracking-widest uppercase px-2 py-0.5"
            style={{ color: '#FF2D55', background: '#FF2D550D', border: '1px solid #FF2D5544' }}
          >
            ONE THING
          </span>
          <CategoryTag category={issue.category} />
          <span
            className="text-[10px] font-mono ml-auto flex-shrink-0"
            style={{ color: '#FF2D55' }}
          >
            {issue.rounds_affected} {isDM ? 'times observed' : 'rounds affected'}
          </span>
        </div>
        <p className="text-base font-black tracking-wide leading-snug" style={{ color: '#E8EFFF' }}>
          {issue.title}
        </p>
        {sessionHint && (
          <p className="text-[11px] font-mono mt-2" style={{ color: '#7A8BAD' }}>
            {sessionHint}
          </p>
        )}
        {continuity?.progress_note && (
          <p className="text-sm mt-3 italic leading-relaxed" style={{ color: '#B0BCDB' }}>
            {continuity.progress_note}
          </p>
        )}
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        className="w-full px-4 py-2.5 text-left text-[10px] font-mono tracking-widest transition-colors"
        style={{
          color: '#7A8BAD',
          background: '#0A0E1A',
          borderTop: '1px solid #1A2440',
          border: 'none',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? '▲  HIDE THE WHY' : '▼  EXPAND THE WHY'}
      </button>

      {/* Expanded body — same info as old PriorityIssueCard */}
      {expanded && (
        <div className="px-4 pb-4 pt-3 space-y-3" style={{ borderTop: '1px solid #1A2440' }}>
          <div>
            <p
              className="text-[10px] font-mono tracking-widest mb-1.5"
              style={{ color: '#3D4F6E' }}
            >
              WHAT HAPPENED
            </p>
            <p className="text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
              {issue.what_happened}
            </p>
          </div>
          <div>
            <p
              className="text-[10px] font-mono tracking-widest mb-1.5"
              style={{ color: '#3D4F6E' }}
            >
              {isDM ? 'WHY IT MATTERS' : 'WHY IT COSTS ROUNDS'}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
              {issue.root_cause}
            </p>
          </div>
          <div className="p-3" style={{ background: `${color}0D`, border: `1px solid ${color}33` }}>
            <p className="text-[10px] font-mono tracking-widest mb-1.5" style={{ color }}>
              DO THIS INSTEAD
            </p>
            <p className="text-sm leading-relaxed font-medium" style={{ color: '#E8EFFF' }}>
              {issue.what_to_do}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function OneClipCard({
  deaths,
  issueCategory,
  matchId,
}: {
  deaths: DeathCoachingEntry[];
  issueCategory?: string;
  matchId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<boolean>(false);

  if (deaths.length === 0) return null;

  // Pick representative death: highest coaching_priority among those matching
  // the priority issue's category. Fall back to first death of matching category,
  // then to the first death overall.
  const pickByCategory = issueCategory ? deaths.filter((d) => d.category === issueCategory) : [];
  const sortByPriority = (list: DeathCoachingEntry[]) =>
    [...list].sort((a, b) => {
      const pa = a.coaching_priority ?? 3;
      const pb = b.coaching_priority ?? 3;
      if (pb !== pa) return pb - pa;
      return (a.death_number ?? 0) - (b.death_number ?? 0);
    });

  const pool = pickByCategory.length > 0 ? pickByCategory : deaths;
  const pick = sortByPriority(pool)[0];

  // Phase 2 — fetch a JPEG frame from the local recording at (death_time - 1.5s).
  // Graceful degradation: if no matchId, no recording, or ffmpeg fails → frame hides.
  useEffect(() => {
    if (!pick || !matchId) return;
    const sec = parseApproxTimeToSec(pick.approximate_time);
    if (sec === null) return;
    const frameSec = Math.max(0, sec - 1.5);
    setFrameError(false);
    setFrameDataUrl(null);
    invoke<string>('get_death_frame', { matchId, timestampSec: frameSec })
      .then((b64) => setFrameDataUrl(`data:image/jpeg;base64,${b64}`))
      .catch((err) => {
        console.warn('[OneClipCard] frame fetch failed:', err);
        setFrameError(true);
      });
    // Only refetch if the picked death or match changes.
  }, [pick?.death_number, matchId]);

  if (!pick) return null;

  const color = categoryColor(pick.category);
  const evidence = pick.visual_evidence;

  return (
    <div
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${pick.avoidable ? '#00D4FF' : '#6B7280'}`,
      }}
    >
      {/* Evidence frame — renders only when we actually have bytes. */}
      {frameDataUrl && (
        <div
          className="relative w-full overflow-hidden"
          style={{
            aspectRatio: '16/9',
            background: '#050810',
            borderBottom: '1px solid #1A2440',
          }}
        >
          <img
            src={frameDataUrl}
            alt={`Death ${pick.death_number} at ${pick.approximate_time}`}
            className="w-full h-full object-cover"
            draggable={false}
          />
          <div
            className="absolute top-2 left-2 text-[9px] font-mono tracking-widest uppercase px-2 py-0.5"
            style={{
              color: '#E8EFFF',
              background: 'rgba(5, 8, 16, 0.75)',
              border: '1px solid #00D4FF44',
            }}
          >
            DECISION MOMENT · {pick.approximate_time}
          </div>
        </div>
      )}

      <div className="p-4">
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span
            className="text-[9px] font-black tracking-widest uppercase px-2 py-0.5"
            style={{ color: '#00D4FF', background: '#00D4FF0D', border: '1px solid #00D4FF44' }}
          >
            ONE CLIP
          </span>
          <CategoryTag category={pick.category} />
          {pick.confidence && (
            <span
              className="text-[9px] font-mono tracking-wider uppercase px-2 py-0.5"
              style={{ color: '#00D4FF', background: '#00D4FF0D', border: '1px solid #00D4FF44' }}
            >
              {pick.confidence} confidence
            </span>
          )}
          {!pick.avoidable && (
            <span
              className="text-[9px] font-mono tracking-wider uppercase px-2 py-0.5"
              style={{ color: '#6B7280', background: '#6B72800D', border: '1px solid #6B728044' }}
            >
              FAIR DUEL
            </span>
          )}
          <span
            className="text-[10px] font-mono ml-auto flex-shrink-0"
            style={{ color: '#3D4F6E' }}
          >
            DEATH {pick.death_number} · {pick.approximate_time}
          </span>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
          {pick.situation}
        </p>
        {evidence && (
          <p className="text-[10px] font-mono mt-2 leading-relaxed" style={{ color: '#3D4F6E' }}>
            SEEN: {evidence}
          </p>
        )}
        {Array.isArray(pick.evidence) && pick.evidence.length > 0 && (
          <div className="mt-3 space-y-1">
            {pick.evidence.slice(0, 3).map((item, idx) => (
              <p
                key={`clip-evidence-${idx}`}
                className="text-[10px] leading-relaxed"
                style={{ color: '#7A8BAD' }}
              >
                <span style={{ color: '#B0BCDB' }}>{item.label}:</span> {item.value}
              </p>
            ))}
          </div>
        )}
        {frameError && (
          <p className="text-[10px] font-mono mt-2 leading-relaxed" style={{ color: '#3D4F6E' }}>
            (Video not available — evidence frame hidden.)
          </p>
        )}
      </div>

      <button
        type="button"
        className="w-full px-4 py-2.5 text-left text-[10px] font-mono tracking-widest"
        style={{
          color: '#7A8BAD',
          background: '#0A0E1A',
          borderTop: '1px solid #1A2440',
          border: 'none',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? '▲  HIDE THE FIX' : '▼  SHOW WHAT TO FIX'}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-3 space-y-3" style={{ borderTop: '1px solid #1A2440' }}>
          <div className="flex gap-2">
            <span className="text-sm flex-shrink-0" style={{ color: '#FF2D55' }}>
              {'\u2717'}
            </span>
            <div className="flex-1">
              <p
                className="text-[10px] font-mono tracking-widest mb-1"
                style={{ color: '#FF2D55' }}
              >
                MISTAKE
              </p>
              <p className="text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
                {pick.mistake}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="text-sm flex-shrink-0" style={{ color: '#00FF88' }}>
              {'\u2192'}
            </span>
            <div
              className="flex-1 p-2.5"
              style={{ background: `${color}0D`, border: `1px solid ${color}22` }}
            >
              <p
                className="text-[10px] font-mono tracking-widest mb-1"
                style={{ color: '#00FF88' }}
              >
                CORRECTION
              </p>
              <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
                {pick.correction}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OneDrillCard({ focus }: { focus: SessionFocus }) {
  const [stepsExpanded, setStepsExpanded] = useState(false);
  // Legacy reports sometimes stored session_focus as a plain string instead of
  // the current {drill_name, drill_steps, drill_duration_minutes, in_game_cue}
  // object. TypeScript casts this at parse time but the runtime shape can drift.
  // Guard and skip rendering rather than crash on .length of undefined.
  if (!focus || typeof focus !== 'object' || typeof (focus as any).drill_steps !== 'string') {
    return null;
  }
  const stepsShort =
    focus.drill_steps.length > 140
      ? `${focus.drill_steps.slice(0, 140).trimEnd()}…`
      : focus.drill_steps;
  const hasMore = focus.drill_steps.length > 140;

  return (
    <div
      style={{
        background: '#0D1221',
        border: '1px solid #F59E0B44',
        borderLeft: '4px solid #F59E0B',
        boxShadow: '0 0 20px #F59E0B0A',
      }}
    >
      <div className="p-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span
            className="text-[9px] font-black tracking-widest uppercase px-2 py-0.5"
            style={{ color: '#F59E0B', background: '#F59E0B0D', border: '1px solid #F59E0B44' }}
          >
            ONE DRILL
          </span>
          <span
            className="text-[10px] font-mono ml-auto flex-shrink-0"
            style={{ color: '#3D4F6E' }}
          >
            {focus.drill_duration_minutes} MIN
          </span>
        </div>
        <p className="text-base font-black mb-2 leading-snug" style={{ color: '#E8EFFF' }}>
          {focus.drill_name}
        </p>
        <p className="text-xs leading-relaxed mb-4" style={{ color: '#B0BCDB' }}>
          {stepsExpanded ? focus.drill_steps : stepsShort}
          {hasMore && (
            <button
              type="button"
              className="ml-1 text-[11px] font-mono"
              style={{
                color: '#F59E0B',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onClick={() => setStepsExpanded((e) => !e)}
            >
              {stepsExpanded ? '(less)' : '(more)'}
            </button>
          )}
        </p>
        {focus.in_game_cue && (
          <div
            className="p-3 mb-4"
            style={{ background: '#F59E0B15', border: '1px solid #F59E0B33' }}
          >
            <p
              className="text-[10px] font-mono tracking-widest mb-1.5"
              style={{ color: '#F59E0B' }}
            >
              SAY THIS BEFORE EACH ROUND
            </p>
            <p className="text-sm italic leading-relaxed" style={{ color: '#E8EFFF' }}>
              "{focus.in_game_cue}"
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function EverythingElseDrawer({
  verdict,
  history,
  continuity,
  deaths,
  secondaries,
  strengths,
}: {
  verdict: string;
  history: CoachingHistoryMeta | null;
  continuity: CoachingContinuity | null;
  deaths: DeathCoachingEntry[];
  secondaries: CoachingIssue[];
  strengths: string[];
}) {
  const [expanded, setExpanded] = useState(false);

  const parts: string[] = [];
  if (verdict) parts.push('Match verdict');
  if (history && history.sessionNumber > 1) parts.push('Session history');
  if (deaths.length > 0) parts.push(`${deaths.length} deaths`);
  if (secondaries.length > 0)
    parts.push(`${secondaries.length} other pattern${secondaries.length === 1 ? '' : 's'}`);
  if (strengths.length > 0)
    parts.push(`${strengths.length} strength${strengths.length === 1 ? '' : 's'}`);

  if (parts.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-3 text-left text-[11px] font-mono tracking-widest flex items-center gap-3 transition-colors"
        style={{
          color: expanded ? '#E8EFFF' : '#7A8BAD',
          background: '#0D1221',
          border: '1px solid #1A2440',
          cursor: 'pointer',
        }}
      >
        <span>{expanded ? '▲' : '▼'}</span>
        <span>EVERYTHING ELSE</span>
        <span className="ml-auto" style={{ color: '#3D4F6E' }}>
          {parts.join(' · ')}
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          {verdict && <MatchVerdictCard verdict={verdict} />}
          {history && history.sessionNumber > 1 && (
            <ChallengeCard history={history} continuity={continuity} />
          )}
          {deaths.length > 0 && <DeathCoachingTimeline deaths={deaths} />}
          {secondaries.length > 0 && (
            <div>
              <SectionHeader title={`OTHER PATTERNS (${secondaries.length})`} />
              <div className="space-y-2">
                {secondaries.map((issue, i) => (
                  <SecondaryIssueRow key={`${issue.category}-${i}`} issue={issue} />
                ))}
              </div>
            </div>
          )}
          {strengths.length > 0 && <StrengthsCard strengths={strengths} />}
        </div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

interface CoachingReportViewProps {
  report: DeepCoachingReport;
}

export function CoachingReportView({ report }: CoachingReportViewProps) {
  const isDM = report.gameMode === 'deathmatch' || report.gameMode === 'team_deathmatch';

  // ── Rejected mode ─────────────────────────────────────────────────────────
  if (report.rejected) {
    return (
      <div className="space-y-4">
        <ModeBadge mode={report.gameMode} />
        <RejectedReportView
          reason={report.rejectionReason ?? 'This game mode is not supported for coaching.'}
        />
      </div>
    );
  }

  const isV2 = !!(report.priorityIssue || report.matchVerdict);

  // ── v2 layout (Phase 1A: One Thing / One Clip / One Drill) ──────────────
  // Condensed above-the-fold view. Everything else lives inside the drawer.
  if (isV2) {
    return (
      <div className="space-y-4">
        {report.gameMode && <ModeBadge mode={report.gameMode} />}

        <BottleneckBadge priorityCategory={report.priorityIssue?.category} />

        <OneThingCard
          issue={report.priorityIssue}
          history={report.coachingHistory}
          continuity={report.coachingContinuity}
          isDM={isDM}
        />

        <OneClipCard
          deaths={report.deathCoaching ?? []}
          issueCategory={report.priorityIssue?.category}
          matchId={report.matchId}
        />

        {report.sessionFocus && <OneDrillCard focus={report.sessionFocus} />}

        <EverythingElseDrawer
          verdict={report.matchVerdict}
          history={report.coachingHistory}
          continuity={report.coachingContinuity}
          deaths={report.deathCoaching ?? []}
          secondaries={report.secondaryIssues}
          strengths={report.strengths}
        />
      </div>
    );
  }

  // ── Legacy layout (old reports) ───────────────────────────────────────────
  const criticals = report.moments.filter((m) => m.severity === 'critical');
  const others = report.moments.filter((m) => m.severity !== 'critical');
  const allMoments = [...criticals, ...others];

  return (
    <div className="space-y-6">
      {report.overallAssessment && (
        <div
          className="p-5"
          style={{
            background: '#0D1221',
            borderLeft: '3px solid #00D4FF',
            border: '1px solid #1A2440',
          }}
        >
          <p className="text-[10px] font-mono tracking-widest mb-3" style={{ color: '#3D4F6E' }}>
            OVERALL ASSESSMENT
          </p>
          <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
            {report.overallAssessment}
          </p>
        </div>
      )}
      {allMoments.length > 0 && (
        <div>
          <SectionHeader title={`KEY MOMENTS (${allMoments.length}) — CLICK TO EXPAND`} />
          <div className="space-y-2">
            {allMoments.map((m, i) => (
              <LegacyMomentCard key={`${m.timestampMs}-${i}`} moment={m} index={i} />
            ))}
          </div>
        </div>
      )}
      {report.positiveHighlights.length > 0 && (
        <div
          className="p-4 space-y-2"
          style={{ background: '#00FF880A', border: '1px solid #00FF8822' }}
        >
          {report.positiveHighlights.map((h, i) => {
            const text = typeof h === 'string' ? h : (h as { description?: unknown })?.description;
            if (typeof text !== 'string' || text.trim().length === 0) return null;
            return (
              <div key={i} className="flex gap-2 text-sm" style={{ color: '#E8EFFF' }}>
                <span style={{ color: '#00FF88', flexShrink: 0 }}>+</span>
                {text}
              </div>
            );
          })}
        </div>
      )}
      {report.drills.length > 0 && (
        <div>
          <SectionHeader title="TRAINING DRILLS" />
          <div className="space-y-2">
            {report.drills.map((d, i) => (
              <LegacyDrillCard key={i} drill={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
