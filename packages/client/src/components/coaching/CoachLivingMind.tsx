/**
 * CoachLivingMind (Phase 7A — single-surface Your Coach redesign)
 *
 * Replaces the 4-tab structure (COACH | BRAIN | JOURNEY | DATA) with one
 * scrollable surface. Stack: chat hero → right now → brain → chapters →
 * utilities footer.
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md
 */

import { useEffect, useState } from 'react';
import { useCoachStore } from '../../stores/coachStore';
import { useEraStore } from '../../stores/eraStore';
import { ConfirmDialog, TrashIcon } from '../shared/ConfirmDialog';
import { BrainSections } from './CoachBrain';
import { CoachChat } from './CoachChat';
import { ErasSections } from './CoachEras';
import { CoachNotifications } from './CoachNotifications';

// ── Chat hero (embedded, bounded-height) ────────────────────────────────────

function ChatHero() {
  return (
    <div
      className="flex flex-col"
      style={{
        height: '440px',
        background: '#0A0E1A',
        border: '1px solid #1A2440',
      }}
    >
      <CoachChat />
    </div>
  );
}

// ── Right Now (current active era, compact) ────────────────────────────────

function RightNow() {
  const eras = useEraStore((s) => s.eras);
  const fetched = useEraStore((s) => s.fetched);
  const fetchEras = useEraStore((s) => s.fetchEras);
  const brain = useCoachStore((s) => s.brain);

  useEffect(() => {
    if (!fetched) fetchEras();
  }, [fetched, fetchEras]);

  const activeEra = eras.find((e) => e.data.status === 'active');
  if (!activeEra) return null;

  // Pull current mastery from brain (updated post-enrichment)
  const currentSkill = brain?.mastery?.skills.find((s) => s.id === activeEra.data.primarySkillId);
  const currentPct = currentSkill ? Math.round(currentSkill.mastery * 100) : null;
  const startPct = Math.round(activeEra.data.startMastery * 100);
  const delta = currentPct != null ? currentPct - startPct : null;

  return (
    <div
      className="p-4"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: '3px solid #00D4FF',
      }}
    >
      <p className="text-[10px] font-mono tracking-widest mb-2" style={{ color: '#00D4FF' }}>
        RIGHT NOW
      </p>
      <p className="text-base font-black leading-snug mb-2" style={{ color: '#E8EFFF' }}>
        Working on: {activeEra.data.primarySkillName}
      </p>
      {currentPct != null ? (
        <div className="flex items-center gap-3 mb-1">
          <div className="flex-1 relative h-1.5" style={{ background: '#1A2440' }}>
            <div
              className="absolute top-0 left-0 h-full"
              style={{ width: `${currentPct}%`, background: '#00D4FF' }}
            />
          </div>
          <span className="text-[11px] font-mono flex-shrink-0" style={{ color: '#B0BCDB' }}>
            {startPct}% → {currentPct}%
            {delta != null && delta > 0 && (
              <span className="ml-1" style={{ color: '#00FF88' }}>
                ↗ +{delta}
              </span>
            )}
          </span>
        </div>
      ) : (
        <p className="text-xs" style={{ color: '#7A8BAD' }}>
          Started this chapter at {startPct}% mastery.
        </p>
      )}
      <p className="text-[11px] mt-2" style={{ color: '#7A8BAD' }}>
        This chapter closes when mastery hits 70% with 5+ consistent games.
      </p>
    </div>
  );
}

// ── Footer utilities (replaces DATA tab's Danger Zone) ─────────────────────

function LivingMindFooter() {
  const resetBrain = useCoachStore((s) => s.resetBrain);
  const [open, setOpen] = useState(false);

  return (
    <div
      className="flex items-center gap-3 flex-wrap pt-4"
      style={{ borderTop: '1px solid #1A244040' }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] font-mono tracking-wider uppercase inline-flex items-center gap-1.5"
        style={{
          color: '#3D4F6E',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#FF2D55')}
        onMouseLeave={(e) => (e.currentTarget.style.color = '#3D4F6E')}
      >
        <TrashIcon size={10} />
        Reset coaching memory
      </button>
      <ConfirmDialog
        open={open}
        title="Reset coaching memory?"
        body={
          <span>
            This permanently erases every observation, skill mastery record, graph node, and
            strategy your coach has learned about you. Your match history and reports are not
            affected. This cannot be undone.
          </span>
        }
        confirmLabel="Reset coach memory"
        typeToConfirm="RESET"
        danger
        onConfirm={async () => {
          await resetBrain();
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function CoachLivingMind() {
  const fetchBrain = useCoachStore((s) => s.fetchBrain);

  useEffect(() => {
    fetchBrain();
  }, [fetchBrain]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 pb-20 space-y-10">
        <CoachNotifications />
        <ChatHero />
        <RightNow />
        <BrainSections />
        <ErasSections />
        <LivingMindFooter />
      </div>
    </div>
  );
}
