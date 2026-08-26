/**
 * CoachNotifications (Phase 7D — Proactive Coach)
 *
 * Unread messages the coach has pushed. Rendered above the ChatHero in the
 * Living Mind surface. Each message is a compact card with a Dismiss button
 * that marks it read.
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md §8
 */

import { useEffect } from 'react';
import {
  type CoachMessage,
  type CoachMessageTrigger,
  useCoachMessagesStore,
} from '../../stores/coachMessagesStore';

const TRIGGER_LABEL: Record<CoachMessageTrigger, string> = {
  era_closed: 'CHAPTER WRAPPED',
  era_started: 'NEW CHAPTER',
  hypothesis_new: 'NOTICED',
  returning_player: 'WELCOME BACK',
  plateau_detected: 'PLATEAU CHECK',
};

const TRIGGER_COLOR: Record<CoachMessageTrigger, string> = {
  era_closed: '#00FF88',
  era_started: '#00D4FF',
  hypothesis_new: '#F59E0B',
  returning_player: '#A78BFA',
  plateau_detected: '#FF6B35',
};

function MessageCard({ msg }: { msg: CoachMessage }) {
  const markRead = useCoachMessagesStore((s) => s.markRead);
  const color = TRIGGER_COLOR[msg.data.trigger] ?? '#7C3AED';
  const label = TRIGGER_LABEL[msg.data.trigger] ?? 'COACH NOTE';

  return (
    <div
      className="p-3 flex items-start gap-3"
      style={{
        background: '#0D1221',
        border: `1px solid ${color}44`,
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span
            className="text-[9px] font-mono tracking-widest uppercase px-1.5 py-0.5"
            style={{
              color,
              background: `${color}0D`,
              border: `1px solid ${color}44`,
            }}
          >
            {label}
          </span>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
          {msg.label}
        </p>
        {msg.data.body && (
          <p className="text-[11px] mt-1 leading-relaxed" style={{ color: '#7A8BAD' }}>
            {msg.data.body}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => markRead(msg.id)}
        className="text-[10px] font-mono tracking-wider uppercase px-2 py-1 flex-shrink-0 transition-colors"
        style={{
          color: '#7A8BAD',
          background: 'transparent',
          border: '1px solid #1A2440',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = '#E8EFFF';
          (e.currentTarget as HTMLElement).style.borderColor = '#3D4F6E';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = '#7A8BAD';
          (e.currentTarget as HTMLElement).style.borderColor = '#1A2440';
        }}
      >
        Got it
      </button>
    </div>
  );
}

export function CoachNotifications() {
  const messages = useCoachMessagesStore((s) => s.messages);
  const fetched = useCoachMessagesStore((s) => s.fetched);
  const fetchMessages = useCoachMessagesStore((s) => s.fetchMessages);

  useEffect(() => {
    if (!fetched) fetchMessages();
  }, [fetched, fetchMessages]);

  if (messages.length === 0) return null;

  return (
    <div className="space-y-2">
      {messages.map((m) => (
        <MessageCard key={m.id} msg={m} />
      ))}
    </div>
  );
}
