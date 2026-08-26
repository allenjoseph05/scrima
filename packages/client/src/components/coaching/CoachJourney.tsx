import { useMemo } from 'react';
import { type SkillMastery, useCoachStore } from '../../stores/coachStore';

// ── Types ────────────────────────────────────────────────────────────────────

interface TimelineEvent {
  id: string;
  type: 'game' | 'reflection' | 'milestone';
  title: string;
  description: string;
  timestamp: number; // ms epoch for sorting
  dateLabel: string; // relative date string
  color: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeDate(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return 'Last week';
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function generateMilestones(skills: SkillMastery[]): TimelineEvent[] {
  const milestones: TimelineEvent[] = [];

  for (const skill of skills) {
    if (skill.observations === 0) continue;

    // Milestones based on mastery thresholds
    if (skill.mastery >= 0.8) {
      milestones.push({
        id: `milestone-${skill.id}-mastered`,
        type: 'milestone',
        title: `${skill.name} Mastered`,
        description: `Your ${skill.name.toLowerCase()} has reached mastery level. Keep it up!`,
        timestamp: Date.now() - 86400000, // approximate — we don't track when threshold was crossed
        dateLabel: 'Recently',
        color: '#00FF85',
      });
    } else if (skill.mastery >= 0.6) {
      milestones.push({
        id: `milestone-${skill.id}-solid`,
        type: 'milestone',
        title: `${skill.name} Getting Solid`,
        description: `Your ${skill.name.toLowerCase()} is solidifying. ${skill.observations} observations tracked.`,
        timestamp: Date.now() - 172800000,
        dateLabel: 'Recently',
        color: '#00FF85',
      });
    } else if (skill.mastery >= 0.3 && skill.observations >= 3) {
      milestones.push({
        id: `milestone-${skill.id}-learning`,
        type: 'milestone',
        title: `Started Learning ${skill.name}`,
        description: `Your coach has identified ${skill.name.toLowerCase()} as an active area of growth.`,
        timestamp: Date.now() - 259200000,
        dateLabel: 'Recently',
        color: '#00D4FF',
      });
    }
  }

  return milestones;
}

// ── Timeline event icons ────────────────────────────────────────────────────

function EventIcon({ type, color }: { type: string; color: string }) {
  if (type === 'game') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" fill={color} />
        <line x1="12" y1="2" x2="12" y2="7" stroke={color} strokeWidth="1.5" />
        <line x1="12" y1="17" x2="12" y2="22" stroke={color} strokeWidth="1.5" />
        <line x1="2" y1="12" x2="7" y2="12" stroke={color} strokeWidth="1.5" />
        <line x1="17" y1="12" x2="22" y2="12" stroke={color} strokeWidth="1.5" />
      </svg>
    );
  }
  if (type === 'reflection') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2L14.5 8.5L21 9.5L16.5 14.5L17.5 21L12 18L6.5 21L7.5 14.5L3 9.5L9.5 8.5L12 2Z"
          fill={color}
          fillOpacity="0.3"
          stroke={color}
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  // milestone — star
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <polygon
        points="12,2 15,9 22,9 17,14 19,21 12,17 5,21 7,14 2,9 9,9"
        fill={color}
        fillOpacity="0.4"
        stroke={color}
        strokeWidth="1.5"
      />
    </svg>
  );
}

// ── Timeline Card ───────────────────────────────────────────────────────────

function TimelineCard({ event, side }: { event: TimelineEvent; side: 'left' | 'right' }) {
  const isReflection = event.type === 'reflection';

  return (
    <div
      className={`fade-in-up px-4 py-3 rounded-sm max-w-[340px] ${side === 'left' ? 'mr-auto' : 'ml-auto'}`}
      style={{
        background: isReflection ? '#0D122180' : '#0D1221',
        border: `1px solid ${isReflection ? '#7C3AED25' : '#1A2440'}`,
        borderLeft: side === 'left' ? `3px solid ${event.color}44` : undefined,
        borderRight: side === 'right' ? `3px solid ${event.color}44` : undefined,
        backdropFilter: isReflection ? 'blur(4px)' : undefined,
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <EventIcon type={event.type} color={event.color} />
        <span className="text-xs font-bold" style={{ color: '#E8EFFF' }}>
          {event.title}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed mb-1" style={{ color: '#7A8BAD' }}>
        {event.description}
      </p>
      <span className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
        {event.dateLabel}
      </span>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function CoachJourney() {
  const brain = useCoachStore((s) => s.brain);
  const brainLoading = useCoachStore((s) => s.brainLoading);

  const events = useMemo<TimelineEvent[]>(() => {
    if (!brain) return [];

    const items: TimelineEvent[] = [];

    // Game events
    for (const game of brain.graph.recentGames) {
      const ts = new Date(game.createdAt).getTime();
      items.push({
        id: `game-${game.label}-${ts}`,
        type: 'game',
        title: game.label,
        description: 'Game analyzed by your coach',
        timestamp: ts,
        dateLabel: formatRelativeDate(game.createdAt),
        color: '#00D4FF',
      });
    }

    // Reflections
    for (let i = 0; i < brain.reflections.length; i++) {
      const r = brain.reflections[i];
      items.push({
        id: `reflection-${i}`,
        type: 'reflection',
        title: r.title,
        description: r.insight,
        timestamp: Date.now() - (i + 1) * 86400000 * 3, // approximate spacing
        dateLabel: formatRelativeDate(Date.now() - (i + 1) * 86400000 * 3),
        color: '#A78BFA',
      });
    }

    // Milestones
    items.push(...generateMilestones(brain.mastery.skills));

    // Sort newest first
    items.sort((a, b) => b.timestamp - a.timestamp);

    return items;
  }, [brain]);

  if (brainLoading && !brain) {
    return (
      <div className="h-full flex items-center justify-center">
        <div
          className="w-5 h-5 border-2 rounded-full animate-spin"
          style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
        />
        <span className="ml-3 text-xs font-mono" style={{ color: '#3D4F6E' }}>
          Loading journey...
        </span>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-8">
        <div className="relative mb-6">
          {/* Vertical line */}
          <div
            className="w-px h-24 mx-auto"
            style={{
              background: 'linear-gradient(to bottom, transparent, #1A2440, transparent)',
              animation: 'dash-offset 2s linear infinite',
            }}
          />
          {/* Start node */}
          <div
            className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full"
            style={{ background: '#7C3AED', boxShadow: '0 0 8px #7C3AED60' }}
          />
        </div>
        <p className="text-sm font-mono text-center" style={{ color: '#3D4F6E' }}>
          Your journey begins here
        </p>
        <p className="text-[11px] font-mono text-center mt-1" style={{ color: '#3D4F6E80' }}>
          Play and analyze games to build your timeline
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-6 py-6">
      <div className="relative max-w-xl mx-auto">
        {/* Central timeline line */}
        <div
          className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2"
          style={{
            background:
              'linear-gradient(to bottom, transparent, #1A2440 5%, #1A2440 95%, transparent)',
          }}
        />

        {/* Events */}
        <div className="space-y-6">
          {events.map((event, i) => {
            const side = i % 2 === 0 ? 'left' : 'right';
            return (
              <div key={event.id} className="relative">
                {/* Node on timeline */}
                <div
                  className="absolute left-1/2 top-4 -translate-x-1/2 w-2.5 h-2.5 rounded-full z-10"
                  style={{
                    background: event.color,
                    boxShadow: `0 0 6px ${event.color}60`,
                  }}
                />

                {/* Card */}
                <div className={`${side === 'left' ? 'pr-[55%]' : 'pl-[55%]'}`}>
                  <TimelineCard event={event} side={side} />
                </div>
              </div>
            );
          })}
        </div>

        {/* End node */}
        <div className="relative mt-6 text-center">
          <div className="mx-auto w-2 h-2 rounded-full" style={{ background: '#3D4F6E' }} />
          <p className="text-[9px] font-mono mt-2" style={{ color: '#3D4F6E' }}>
            Keep playing to extend your journey
          </p>
        </div>
      </div>
    </div>
  );
}
