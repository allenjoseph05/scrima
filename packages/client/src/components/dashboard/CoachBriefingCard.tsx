/**
 * CoachBriefingCard — "Before you play" pre-session card (Phase 4).
 *
 * Rendered on the Dashboard above the main content area, hidden while
 * recording. Four sections: PRACTICE, LOOK FOR, AVOID, ONE FOCUS (picker).
 *
 * See: docs/YOUR_COACH_PHASE4_PLAN.md
 */

import { useEffect } from 'react';
import { useBriefingStore } from '../../stores/briefingStore';

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

// ── Section primitives ─────────────────────────────────────────────────────

function SectionHeader({
  icon,
  label,
  subLabel,
  color,
}: {
  icon: string;
  label: string;
  subLabel?: string;
  color: string;
}) {
  return (
    <div className="flex items-baseline gap-2 mb-2">
      <span className="text-xs flex-shrink-0 leading-none" style={{ color }}>
        {icon}
      </span>
      <p className="text-[10px] font-mono tracking-widest" style={{ color }}>
        {label}
      </p>
      {subLabel && (
        <p className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
          {subLabel}
        </p>
      )}
    </div>
  );
}

// ── Main card ──────────────────────────────────────────────────────────────

export function CoachBriefingCard({ isRecording }: { isRecording: boolean }) {
  const briefing = useBriefingStore((s) => s.briefing);
  const fetchBriefing = useBriefingStore((s) => s.fetchBriefing);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  // Hide during recording — no distractions while playing
  if (isRecording) return null;

  // First load or degraded — render nothing rather than an empty shell
  if (!briefing) return null;

  const { detected, practice, lookFor, avoid } = briefing;
  const hasAnyContent = practice || lookFor || avoid;
  if (!hasAnyContent) return null;

  const bottleneckColor = detected?.domain
    ? (DOMAIN_COLOR[detected.domain] ?? '#7C3AED')
    : '#7C3AED';

  return (
    <div
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${bottleneckColor}`,
        padding: '20px 22px',
      }}
    >
      {/* Header */}
      <div className="flex items-baseline gap-3 flex-wrap mb-5">
        <p className="text-[10px] font-mono tracking-widest" style={{ color: '#7A8BAD' }}>
          BEFORE YOU PLAY
        </p>
        {detected?.primarySkillName && (
          <span
            className="text-[9px] font-mono tracking-wider uppercase px-2 py-0.5 ml-auto"
            style={{
              color: bottleneckColor,
              background: `${bottleneckColor}0D`,
              border: `1px solid ${bottleneckColor}44`,
            }}
          >
            Focus: {detected.primarySkillName} · {DOMAIN_LABEL[detected.domain ?? ''] ?? ''}
          </span>
        )}
      </div>

      {/* Sections */}
      <div className="space-y-5">
        {practice && (
          <div>
            <SectionHeader
              icon="▸"
              label="PRACTICE"
              subLabel={`${practice.durationMinutes} MIN`}
              color="#F59E0B"
            />
            <p className="text-sm font-bold leading-snug mb-1 pl-4" style={{ color: '#E8EFFF' }}>
              {practice.drillName}
            </p>
            {practice.drillSteps && (
              <p className="text-xs leading-relaxed pl-4" style={{ color: '#B0BCDB' }}>
                {practice.drillSteps}
              </p>
            )}
          </div>
        )}

        {lookFor && (
          <div>
            <SectionHeader icon="▸" label="LOOK FOR" color="#00D4FF" />
            <p className="text-sm italic leading-relaxed pl-4 mb-2" style={{ color: '#E8EFFF' }}>
              "{lookFor.cue}"
            </p>
            {(lookFor.when || lookFor.check || lookFor.ifYes || lookFor.ifNo) && (
              <div className="pl-4 space-y-1.5 mb-2">
                {lookFor.when && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#00D4FF' }}>
                      WHEN{' '}
                    </span>
                    {lookFor.when}
                  </p>
                )}
                {lookFor.check && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#00D4FF' }}>
                      CHECK{' '}
                    </span>
                    {lookFor.check}
                  </p>
                )}
                {lookFor.ifYes && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#00FF88' }}>
                      IF YES
                    </span>{' '}
                    {lookFor.ifYes}
                  </p>
                )}
                {lookFor.ifNo && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#FF2D55' }}>
                      IF NO{' '}
                    </span>{' '}
                    {lookFor.ifNo}
                  </p>
                )}
              </div>
            )}
            {lookFor.context && (
              <p className="text-xs leading-relaxed pl-4" style={{ color: '#7A8BAD' }}>
                {lookFor.context}
              </p>
            )}
          </div>
        )}

        {avoid && (
          <div>
            <SectionHeader icon="▸" label="AVOID" color="#FF2D55" />
            {avoid.signature ? (
              <p className="text-sm leading-relaxed pl-4 mb-2" style={{ color: '#E8EFFF' }}>
                {avoid.signature}
              </p>
            ) : (
              <p className="text-sm leading-relaxed pl-4 mb-2" style={{ color: '#E8EFFF' }}>
                {avoid.pattern}
              </p>
            )}
            {(avoid.trigger || avoid.instinct || avoid.rule) && (
              <div className="pl-4 space-y-1.5 mb-2">
                {avoid.trigger && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#FF2D55' }}>
                      TRIGGER{' '}
                    </span>
                    {avoid.trigger}
                  </p>
                )}
                {avoid.instinct && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#F59E0B' }}>
                      INSTINCT
                    </span>{' '}
                    {avoid.instinct}
                  </p>
                )}
                {avoid.rule && (
                  <p className="text-xs leading-relaxed" style={{ color: '#B0BCDB' }}>
                    <span className="font-mono" style={{ color: '#00FF88' }}>
                      INSTEAD{' '}
                    </span>{' '}
                    {avoid.rule}
                  </p>
                )}
              </div>
            )}
            <p className="text-xs pl-4" style={{ color: '#7A8BAD' }}>
              {avoid.occurrenceLine}.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
