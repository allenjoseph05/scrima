import { useState } from 'react';
import { type Observation, useCoachStore } from '../../stores/coachStore';
import { ConfirmDialog, TrashIcon } from '../shared/ConfirmDialog';

// ── Observation card with dismiss ───────────────────────────────────────────

function ObservationRow({
  obs,
  accent,
  onDismiss,
}: {
  obs: Observation;
  accent: string;
  onDismiss: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const handleDismiss = async () => {
    setDismissing(true);
    await onDismiss(obs.id);
  };

  if (dismissing) {
    return (
      <div
        className="px-4 py-3 rounded-sm transition-opacity duration-500"
        style={{ opacity: 0 }}
      />
    );
  }

  return (
    <div
      className="px-4 py-3 rounded-sm transition-all duration-300"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: `3px solid ${accent}44`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed flex-1" style={{ color: '#E8EFFF' }}>
          {obs.text}
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-sm"
            style={{ color: accent, background: `${accent}15`, border: `1px solid ${accent}30` }}
          >
            {obs.occurrences}&times;
          </span>
          <button
            onClick={() => setConfirming(true)}
            className="w-5 h-5 flex items-center justify-center rounded-sm transition-colors duration-150"
            style={{ color: '#3D4F6E' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#FF2D55')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#3D4F6E')}
            title="Remove from memory"
            aria-label="Remove this observation from coaching memory"
          >
            <TrashIcon size={12} />
          </button>
          <ConfirmDialog
            open={confirming}
            title="Remove this thought?"
            body={
              <span>
                The coach will stop using this observation when it coaches you. You can always earn
                it back by repeating the behavior.
              </span>
            }
            confirmLabel="Remove"
            danger
            onConfirm={async () => {
              await handleDismiss();
              setConfirming(false);
            }}
            onCancel={() => setConfirming(false)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
          Last seen {formatRelative(obs.lastSeenAt)}
        </span>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `${diff}d ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return d.toLocaleDateString();
}

// ── Collapsible section ─────────────────────────────────────────────────────

function ObservationSection({
  title,
  accent,
  observations,
  onDismiss,
}: {
  title: string;
  accent: string;
  observations: Observation[];
  onDismiss: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (observations.length === 0) return null;

  return (
    <div className="mb-5">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-2 w-full text-left"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
      >
        <span
          className="text-[10px] font-mono font-bold tracking-[0.15em] uppercase"
          style={{ color: accent }}
        >
          {title} ({observations.length})
        </span>
        <span
          className="text-[10px] transition-transform duration-200"
          style={{ color: '#3D4F6E', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)' }}
        >
          &#9660;
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-2">
          {observations.map((obs) => (
            <ObservationRow key={obs.id} obs={obs} accent={accent} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Danger Zone ─────────────────────────────────────────────────────────────

function DangerZone({ onReset }: { onReset: () => Promise<void> }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="p-4 rounded-sm"
      style={{ background: '#FF2D5508', border: '1px solid #FF2D5520' }}
    >
      <h4
        className="text-[10px] font-mono font-bold tracking-[0.15em] uppercase mb-2"
        style={{ color: '#FF2D55' }}
      >
        Danger zone
      </h4>
      <p className="text-xs leading-relaxed mb-3" style={{ color: '#7A8BAD' }}>
        Reset your coach's memory completely. This deletes all observations, skill mastery data,
        knowledge graph, and coaching strategies. Your coach will start learning from scratch.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 rounded-sm text-[10px] font-mono font-bold uppercase tracking-wider transition-all duration-200 inline-flex items-center gap-1.5"
        style={{
          background: 'transparent',
          color: '#FF2D55',
          border: '1px solid #FF2D5544',
          cursor: 'pointer',
        }}
      >
        <TrashIcon size={11} />
        Reset coach memory
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
          await onReset();
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function CoachData() {
  const brain = useCoachStore((s) => s.brain);
  const brainLoading = useCoachStore((s) => s.brainLoading);
  const dismissObservation = useCoachStore((s) => s.dismissObservation);
  const resetBrain = useCoachStore((s) => s.resetBrain);

  if (brainLoading && !brain) {
    return (
      <div className="h-full flex items-center justify-center">
        <div
          className="w-5 h-5 border-2 rounded-full animate-spin"
          style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
        />
        <span className="ml-3 text-xs font-mono" style={{ color: '#3D4F6E' }}>
          Loading data...
        </span>
      </div>
    );
  }

  const obs = brain?.observations ?? { habits: [], strengths: [], insights: [] };
  const totalObs = obs.habits.length + obs.strengths.length + obs.insights.length;
  const totalSkills = brain?.mastery.skills.filter((s) => s.observations > 0).length ?? 0;
  const totalPatterns = brain?.graph.patterns.length ?? 0;
  const totalReflections = brain?.reflections.length ?? 0;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-xl mx-auto px-6 py-6">
        {/* Brain overview stats */}
        <div
          className="flex items-center gap-6 mb-6 pb-4"
          style={{ borderBottom: '1px solid #1A2440' }}
        >
          <Stat icon="eye" value={totalObs} label="Observations" color="#7C3AED" />
          <Stat icon="target" value={totalSkills} label="Skills" color="#00D4FF" />
          <Stat icon="link" value={totalPatterns} label="Patterns" color="#F59E0B" />
          <Stat icon="bulb" value={totalReflections} label="Reflections" color="#A78BFA" />
        </div>

        {/* Observations */}
        <ObservationSection
          title="Habits"
          accent="#FF2D55"
          observations={obs.habits}
          onDismiss={dismissObservation}
        />
        <ObservationSection
          title="Strengths"
          accent="#00FF85"
          observations={obs.strengths}
          onDismiss={dismissObservation}
        />
        <ObservationSection
          title="Insights"
          accent="#A78BFA"
          observations={obs.insights}
          onDismiss={dismissObservation}
        />

        {/* Empty state */}
        {totalObs === 0 && (
          <div className="text-center py-8">
            <p className="text-sm" style={{ color: '#3D4F6E' }}>
              No observations yet. Play and analyze games to build your coach's memory.
            </p>
          </div>
        )}

        {/* Danger zone */}
        <div className="mt-8">
          <DangerZone onReset={resetBrain} />
        </div>
      </div>
    </div>
  );
}

// ── Stat display ────────────────────────────────────────────────────────────

function Stat({
  value,
  label,
  color,
}: { icon: string; value: number; label: string; color: string }) {
  return (
    <div className="text-center">
      <div className="text-lg font-black font-mono" style={{ color }}>
        {value}
      </div>
      <div className="text-[9px] font-mono uppercase tracking-wider" style={{ color: '#3D4F6E' }}>
        {label}
      </div>
    </div>
  );
}
