/**
 * CoachBrain — "What I think I know about you" panel.
 *
 * Phase 6 replacement for the SKILLS constellation. Text-first self-model
 * with agree/disagree interactivity.
 *
 * Four sections:
 *   1. What I think I know about you — observations with agree/disagree
 *   2. What I'm watching — skills currently in the learning zone (ZPD)
 *   3. What's graduated — mastered skills (pride moment)
 *   4. Patterns I haven't figured out — honest uncertainty (hidden if empty)
 *
 * See: docs/YOUR_COACH_PHASE6_PLAN.md
 */

import { useEffect } from 'react';
import { type Observation, type SkillMastery, useCoachStore } from '../../stores/coachStore';
import { type Hypothesis, useHypothesisStore } from '../../stores/hypothesisStore';

// ── Feedback icons (minimal Lucide-style) ───────────────────────────────────

function ThumbsUpIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L15 2a3.13 3.13 0 0 1 0 3.88Z" />
    </svg>
  );
}

function ThumbsDownIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 14V2" />
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L9 22a3.13 3.13 0 0 1 0-3.88Z" />
    </svg>
  );
}

// ── Domain styling ──────────────────────────────────────────────────────────

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

// ── Sorting helpers ─────────────────────────────────────────────────────────

function observationRank(o: Observation): number {
  // 0 = unconfirmed (highest priority to surface), 1 = confirmed, 2 = disagreed
  if (o.disagreedAt) return 2;
  if (o.confirmedAt) return 1;
  return 0;
}

function sortObservations(list: Observation[]): Observation[] {
  return [...list].sort((a, b) => {
    const r = observationRank(a) - observationRank(b);
    if (r !== 0) return r;
    // within same rank, higher occurrences first
    const occ = (b.occurrences ?? 0) - (a.occurrences ?? 0);
    if (occ !== 0) return occ;
    // tiebreak by recency
    return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
  });
}

// ── Section: Still figuring out (hypotheses) ────────────────────────────────

function HypothesisRow({ h }: { h: Hypothesis }) {
  const confirmHypothesis = useHypothesisStore((s) => s.confirmHypothesis);
  const rejectHypothesis = useHypothesisStore((s) => s.rejectHypothesis);

  return (
    <div
      className="p-3"
      style={{
        background: '#0D1221',
        border: '1px solid #F59E0B33',
        borderLeft: '3px solid #F59E0B',
      }}
    >
      <p className="text-sm leading-relaxed mb-2" style={{ color: '#E8EFFF' }}>
        {h.label}
      </p>
      <p className="text-[10px] leading-relaxed mb-3" style={{ color: '#7A8BAD' }}>
        {h.data.evidence}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => confirmHypothesis(h.id)}
          className="text-[10px] font-mono tracking-wider uppercase px-2.5 py-1 transition-colors"
          style={{
            color: '#00FF88',
            background: '#00FF880D',
            border: '1px solid #00FF8844',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = '#00FF8818';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = '#00FF880D';
          }}
        >
          Yes, that's right
        </button>
        <button
          type="button"
          onClick={() => rejectHypothesis(h.id)}
          className="text-[10px] font-mono tracking-wider uppercase px-2.5 py-1 transition-colors"
          style={{
            color: '#FF2D55',
            background: '#FF2D550D',
            border: '1px solid #FF2D5544',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = '#FF2D5518';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = '#FF2D550D';
          }}
        >
          No, not me
        </button>
      </div>
    </div>
  );
}

function StillFiguringOutSection() {
  const hypotheses = useHypothesisStore((s) => s.hypotheses);
  const fetched = useHypothesisStore((s) => s.fetched);
  const fetchHypotheses = useHypothesisStore((s) => s.fetchHypotheses);

  useEffect(() => {
    if (!fetched) fetchHypotheses();
  }, [fetched, fetchHypotheses]);

  if (hypotheses.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <p className="text-[10px] font-mono tracking-widest" style={{ color: '#F59E0B' }}>
          STILL FIGURING OUT
        </p>
        <p className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
          (help me confirm or reject these)
        </p>
      </div>
      <div className="space-y-2">
        {hypotheses.map((h) => (
          <HypothesisRow key={h.id} h={h} />
        ))}
      </div>
    </div>
  );
}

// ── Section: What I think I know ────────────────────────────────────────────

function ObservationRow({ obs }: { obs: Observation }) {
  const agreeObservation = useCoachStore((s) => s.agreeObservation);
  const disagreeObservation = useCoachStore((s) => s.disagreeObservation);
  const hasActed = obs.confirmedAt != null || obs.disagreedAt != null;

  return (
    <div
      className="p-3"
      style={{
        background: '#0D1221',
        border: obs.confirmedAt
          ? '1px solid #00FF8844'
          : obs.disagreedAt
            ? '1px solid #6B728044'
            : '1px solid #1A2440',
        borderLeft: obs.confirmedAt
          ? '3px solid #00FF88'
          : obs.disagreedAt
            ? '3px solid #6B7280'
            : '3px solid #7C3AED',
        opacity: obs.disagreedAt ? 0.55 : 1,
      }}
    >
      <p className="text-sm leading-relaxed mb-2" style={{ color: '#E8EFFF' }}>
        {obs.text}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
          Seen {obs.occurrences ?? 1}× · {obs.category}
        </span>
        <div className="ml-auto flex gap-2">
          {hasActed ? (
            <span
              className="text-[10px] font-mono tracking-wider uppercase px-2 py-0.5"
              style={
                obs.confirmedAt
                  ? { color: '#00FF88', background: '#00FF880D', border: '1px solid #00FF8844' }
                  : { color: '#6B7280', background: '#6B72800D', border: '1px solid #6B728044' }
              }
            >
              {obs.confirmedAt ? '✓ You confirmed' : '✗ You disagreed'}
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => agreeObservation(obs.id)}
                className="text-[10px] font-mono tracking-wider uppercase px-2.5 py-1 transition-colors inline-flex items-center gap-1.5"
                style={{
                  color: '#00FF88',
                  background: 'transparent',
                  border: '1px solid #00FF8844',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = '#00FF8818';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
                aria-label="Agree with this observation"
              >
                <ThumbsUpIcon />
                Agree
              </button>
              <button
                type="button"
                onClick={() => disagreeObservation(obs.id)}
                className="text-[10px] font-mono tracking-wider uppercase px-2.5 py-1 transition-colors inline-flex items-center gap-1.5"
                style={{
                  color: '#FF2D55',
                  background: 'transparent',
                  border: '1px solid #FF2D5544',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = '#FF2D5518';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
                aria-label="Disagree with this observation"
              >
                <ThumbsDownIcon />
                Disagree
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function WhatIKnowSection({ observations }: { observations: Observation[] }) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <p
          className="text-[10px] font-mono tracking-widest"
          style={{ color: '#A78BFA' }}
          title="These aren't guesses — they're patterns I've seen repeatedly in your games, each with a confidence score. Agree or disagree to teach me."
        >
          WHAT I THINK I KNOW ABOUT YOU
        </p>
        <p className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
          built from what I've watched · agree / disagree to teach me
        </p>
      </div>

      {observations.length === 0 ? (
        <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
          <p className="text-sm leading-relaxed" style={{ color: '#7A8BAD' }}>
            No observations yet. Play a few games and I'll start noticing your patterns.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {observations.map((o) => (
            <ObservationRow key={o.id} obs={o} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section: What I'm watching ──────────────────────────────────────────────

function SkillBar({ skill }: { skill: SkillMastery }) {
  const color = DOMAIN_COLOR[skill.domain] ?? '#7A8BAD';
  const pct = Math.round(skill.mastery * 100);
  const trendIcon = skill.trend === 'improving' ? '↗' : skill.trend === 'regressing' ? '↘' : '→';
  const trendColor =
    skill.trend === 'improving' ? '#00FF88' : skill.trend === 'regressing' ? '#FF2D55' : '#7A8BAD';

  return (
    <div
      className="p-3"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <p className="text-sm font-bold" style={{ color: '#E8EFFF' }}>
          {skill.name}
        </p>
        <span
          className="text-[9px] font-mono tracking-wider uppercase px-1.5 py-0.5"
          style={{ color, background: `${color}0D`, border: `1px solid ${color}44` }}
        >
          {DOMAIN_LABEL[skill.domain] ?? skill.domain}
        </span>
        <span className="ml-auto text-[11px] font-mono" style={{ color: trendColor }}>
          {trendIcon} {skill.trend}
        </span>
      </div>
      {/* Mastery bar */}
      <div className="relative h-1.5 w-full" style={{ background: '#1A2440' }}>
        <div
          className="absolute top-0 left-0 h-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <p className="text-[10px] font-mono mt-1" style={{ color: '#7A8BAD' }}>
        Mastery {pct}% · {skill.observations ?? 0} observation
        {(skill.observations ?? 0) === 1 ? '' : 's'}
      </p>
    </div>
  );
}

function WhatImWatchingSection({ skills }: { skills: SkillMastery[] }) {
  const inZPD = skills
    .filter((s) => s.mastery >= 0.3 && s.mastery <= 0.7)
    .sort((a, b) => a.mastery - b.mastery) // lowest mastery first (most urgent)
    .slice(0, 3);

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-mono tracking-widest" style={{ color: '#00D4FF' }}>
        WHAT I'M WATCHING
      </p>

      {inZPD.length === 0 ? (
        <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
          <p className="text-sm leading-relaxed" style={{ color: '#7A8BAD' }}>
            No skills in the learning zone yet. Keep uploading games — once I see consistent
            patterns, I'll highlight what's trending.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {inZPD.map((s) => (
            <SkillBar key={s.id} skill={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section: What's graduated ───────────────────────────────────────────────

function WhatsGraduatedSection({ skills }: { skills: SkillMastery[] }) {
  const graduated = skills
    .filter((s) => s.mastery > 0.7)
    .sort((a, b) => b.mastery - a.mastery)
    .slice(0, 5);

  if (graduated.length === 0) return null; // hide section when empty

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-mono tracking-widest" style={{ color: '#00FF88' }}>
        WHAT'S GRADUATED
      </p>
      <div
        className="p-3"
        style={{
          background: '#00FF880A',
          border: '1px solid #00FF8822',
        }}
      >
        <div className="space-y-1.5">
          {graduated.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="text-base flex-shrink-0" style={{ color: '#00FF88' }}>
                ✓
              </span>
              <span className="text-sm flex-1" style={{ color: '#E8EFFF' }}>
                {s.name}
              </span>
              <span className="text-[11px] font-mono" style={{ color: '#7A8BAD' }}>
                {Math.round(s.mastery * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Stackable content (Phase 7A — used by CoachLivingMind) ─────────────────

/**
 * BrainSections renders the 3 brain sections without the outer scroll shell.
 * Use this when composing inside CoachLivingMind. Use <CoachBrain /> when
 * rendering as a standalone scrollable view (legacy tab fallback).
 */
export function BrainSections() {
  const brain = useCoachStore((s) => s.brain);

  const mergedObs = brain
    ? sortObservations([
        ...brain.observations.habits,
        ...brain.observations.strengths,
        ...brain.observations.insights,
      ]).slice(0, 5)
    : [];

  const skills = brain?.mastery?.skills ?? [];

  return (
    <div className="space-y-8">
      <WhatIKnowSection observations={mergedObs} />
      <StillFiguringOutSection />
      <WhatImWatchingSection skills={skills} />
      <WhatsGraduatedSection skills={skills} />
    </div>
  );
}

// ── Main component (legacy full-view; kept for rollback safety) ────────────

export function CoachBrain() {
  const brain = useCoachStore((s) => s.brain);
  const brainLoading = useCoachStore((s) => s.brainLoading);

  if (!brain && brainLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div
            className="w-4 h-4 border-2 rounded-full animate-spin"
            style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
          />
          <span className="text-xs font-mono" style={{ color: '#3D4F6E' }}>
            Loading brain...
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
        <BrainSections />
      </div>
    </div>
  );
}
