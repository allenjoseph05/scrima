// FUTURISTIC HUD REDESIGN
import { useEffect, useState } from 'react';
import { useRecording } from '../../hooks/useRecording';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { useBriefingStore } from '../../stores/briefingStore';
import { useMatchStore } from '../../stores/matchStore';
import { CoachBriefingCard } from './CoachBriefingCard';
import { PostGameDashboard } from './PostGameDashboard';

// ── Crosshair SVG (reused) ────────────────────────────────────────────────────

function CrosshairSvg({ size = 64 }: { size?: number }) {
  const c = size / 2;
  const r1 = size * 0.22;
  const r2 = size * 0.07;
  const gap = size * 0.32;
  const end = size * 0.07;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <circle cx={c} cy={c} r={r1} stroke="#7C3AED" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx={c} cy={c} r={r2} fill="#7C3AED" />
      <line
        x1={c}
        y1={end}
        x2={c}
        y2={c - gap}
        stroke="#7C3AED"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1={c}
        y1={c + gap}
        x2={c}
        y2={size - end}
        stroke="#7C3AED"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1={end}
        y1={c}
        x2={c - gap}
        y2={c}
        stroke="#7C3AED"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1={c + gap}
        y1={c}
        x2={size - end}
        y2={c}
        stroke="#7C3AED"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── HUD Ring — animated decorative element ────────────────────────────────────

function HudRing() {
  return (
    <div className="relative w-32 h-32 mx-auto mb-6">
      {/* Outer rotating ring */}
      <svg
        className="absolute inset-0"
        width="128"
        height="128"
        viewBox="0 0 128 128"
        fill="none"
        style={{ animation: 'rotate-slow 20s linear infinite' }}
      >
        <circle
          cx="64"
          cy="64"
          r="60"
          stroke="#7C3AED"
          strokeWidth="0.5"
          strokeDasharray="8 12"
          opacity="0.3"
        />
      </svg>
      {/* Inner counter-rotating ring */}
      <svg
        className="absolute inset-0"
        width="128"
        height="128"
        viewBox="0 0 128 128"
        fill="none"
        style={{ animation: 'rotate-slow 15s linear infinite', animationDirection: 'reverse' }}
      >
        <circle
          cx="64"
          cy="64"
          r="48"
          stroke="#00D4FF"
          strokeWidth="0.5"
          strokeDasharray="4 16"
          opacity="0.2"
        />
      </svg>
      {/* Center crosshair */}
      <div className="absolute inset-0 flex items-center justify-center">
        <CrosshairSvg size={48} />
      </div>
      {/* Glow backdrop */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(circle, #7C3AED10 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

// ── Live Status Bar ───────────────────────────────────────────────────────────

function LiveStatusBar({
  isRecording,
  estimatedSizeMb,
  onToggleRecording,
  isToggling,
}: {
  isRecording: boolean;
  estimatedSizeMb: number;
  onToggleRecording: () => void;
  isToggling: boolean;
}) {
  return (
    <div
      className="flex items-center gap-4 px-6 py-3"
      style={{
        background: isRecording
          ? 'linear-gradient(90deg, #FF2D5508, #0A0E1A, #FF2D5508)'
          : '#0A0E1A',
        borderBottom: `1px solid ${isRecording ? '#FF2D5520' : '#1A244040'}`,
        fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
      }}
    >
      {/* Start / Stop button */}
      <button
        type="button"
        onClick={onToggleRecording}
        disabled={isToggling}
        className="flex items-center gap-2.5 px-5 py-2 text-xs font-bold tracking-widest uppercase transition-all duration-200 rounded-sm"
        style={{
          background: isRecording
            ? 'linear-gradient(135deg, rgba(255, 45, 85, 0.15), rgba(255, 45, 85, 0.08))'
            : 'linear-gradient(135deg, rgba(0, 255, 133, 0.12), rgba(0, 255, 133, 0.04))',
          border: `1px solid ${isRecording ? '#FF2D5540' : '#00FF8530'}`,
          color: isRecording ? '#FF2D55' : '#00FF85',
          cursor: isToggling ? 'wait' : 'pointer',
          opacity: isToggling ? 0.5 : 1,
          boxShadow: isRecording ? '0 0 20px #FF2D5515' : '0 0 20px #00FF8510',
        }}
      >
        {isRecording ? (
          <>
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: '#FF2D55', boxShadow: '0 0 4px #FF2D55' }}
            />
            STOP
          </>
        ) : (
          <>
            <span
              className="w-0 h-0"
              style={{
                borderLeft: '7px solid #00FF85',
                borderTop: '5px solid transparent',
                borderBottom: '5px solid transparent',
                filter: 'drop-shadow(0 0 3px #00FF85)',
              }}
            />
            RECORD
          </>
        )}
      </button>

      {/* Recording status */}
      <div className="flex items-center gap-2">
        <span
          className="live-dot"
          style={{
            background: isRecording ? '#FF2D55' : '#3D4F6E',
            animation: isRecording ? 'pulse-dot 0.9s ease-in-out infinite' : 'none',
          }}
        />
        <span
          className="text-xs font-mono font-semibold tracking-widest uppercase"
          style={{ color: isRecording ? '#FF2D55' : '#3D4F6E' }}
        >
          {isRecording
            ? `REC${estimatedSizeMb > 0 ? ` ${estimatedSizeMb.toFixed(0)}MB` : ''}`
            : 'IDLE'}
        </span>
      </div>

      {/* Decorative separator */}
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        <span className="text-[10px] tracking-widest uppercase" style={{ color: '#1A2440' }}>
          SESSION CONTROL
        </span>
      </div>
    </div>
  );
}

// ── Welcome hero ─────────────────────────────────────────────────────────────

function DashboardHero({
  displayName,
  matchCount,
}: { displayName: string | null; matchCount: number }) {
  const firstName = displayName?.trim().split(/\s+/)[0] ?? null;
  const greeting = firstName ? `Welcome back, ${firstName}` : 'Welcome back';
  const subtitle =
    matchCount === 0
      ? 'Hit RECORD above, play a match, then come back here for your coach.'
      : matchCount === 1
        ? 'One match on the books. Keep the streak going.'
        : `${matchCount} matches analyzed. Every game sharpens the model.`;

  return (
    <div
      className="relative overflow-hidden px-6 py-5 fade-in-up"
      style={{
        background:
          'linear-gradient(135deg, rgba(124, 58, 237, 0.08) 0%, rgba(0, 212, 255, 0.04) 50%, rgba(124, 58, 237, 0.08) 100%)',
        border: '1px solid #1A2440',
        borderLeft: '3px solid #7C3AED',
      }}
    >
      <div
        className="absolute top-0 right-0 w-48 h-full pointer-events-none opacity-40"
        style={{
          background: 'radial-gradient(circle at 100% 50%, #7C3AED33 0%, transparent 60%)',
        }}
      />
      <div className="relative">
        <p
          className="text-[10px] font-mono tracking-[0.25em] uppercase mb-1"
          style={{ color: '#A78BFA' }}
        >
          SCRIMA SESSION
        </p>
        <h1 className="text-2xl font-black leading-tight mb-1" style={{ color: '#E8EFFF' }}>
          {greeting}
        </h1>
        <p className="text-xs" style={{ color: '#B0BCDB' }}>
          {subtitle}
        </p>
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyDashboardCard() {
  return (
    <div
      className="px-6 py-10 text-center fade-in-up"
      style={{ background: '#0D1221', border: '1px solid #1A2440' }}
    >
      <div className="mx-auto mb-5">
        <HudRing />
      </div>
      <h2
        className="text-sm font-black tracking-[0.2em] uppercase mb-2"
        style={{ color: '#E8EFFF' }}
      >
        Your coach is waiting
      </h2>
      <p className="text-xs leading-relaxed max-w-md mx-auto" style={{ color: '#7A8BAD' }}>
        Press <span style={{ color: '#00FF85' }}>RECORD</span> above, play your first match, then
        come back. Scrima will watch, build observations, and write your first report.
      </p>
    </div>
  );
}

// ── Briefing skeleton ────────────────────────────────────────────────────────

function BriefingSkeleton() {
  return (
    <div
      className="p-5 fade-in-up"
      style={{
        background: '#0D1221',
        border: '1px solid #1A2440',
        borderLeft: '3px solid #7C3AED33',
      }}
    >
      <div
        className="h-3 mb-3"
        style={{
          width: '30%',
          background: 'linear-gradient(90deg, #1A2440, #2a3450, #1A2440)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s linear infinite',
        }}
      />
      <div
        className="h-5 mb-2"
        style={{
          width: '70%',
          background: 'linear-gradient(90deg, #1A2440, #2a3450, #1A2440)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s linear infinite',
        }}
      />
      <div
        className="h-3"
        style={{
          width: '50%',
          background: 'linear-gradient(90deg, #1A2440, #2a3450, #1A2440)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s linear infinite',
        }}
      />
      <style>
        {
          '@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }'
        }
      </style>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function DashboardView() {
  const { recording, lastMatchSummary, matchHistory, refreshMatchHistory } = useMatchStore();

  const displayName = useAuthStore((s) => s.displayName);
  const briefing = useBriefingStore((s) => s.briefing);
  const briefingLoading = useBriefingStore((s) => s.loading);

  // setActiveView import retained for future per-dashboard navigation hooks
  useAppStore(); // eslint-disable-line @typescript-eslint/no-unused-expressions
  const { startRecording, stopRecording } = useRecording();
  const [isToggling, setIsToggling] = useState(false);

  useEffect(() => {
    refreshMatchHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isRecording = recording.isRecording;

  const handleToggleRecording = async () => {
    setIsToggling(true);
    try {
      if (isRecording) {
        await stopRecording();
      } else {
        await startRecording();
      }
    } finally {
      setIsToggling(false);
    }
  };

  const lastMatchRow = lastMatchSummary && matchHistory.length > 0 ? matchHistory[0] : undefined;

  const hasBriefingContent = briefing && (briefing.practice || briefing.lookFor || briefing.avoid);
  // Show skeleton whenever briefing hasn't landed yet, including during a
  // recording that began before the fetch resolved. Prevents a blank screen
  // for users who hit Record the instant they open the app.
  const showBriefingSkeleton = briefingLoading && !briefing;
  const isEmpty =
    !isRecording &&
    matchHistory.length === 0 &&
    !lastMatchSummary &&
    !hasBriefingContent &&
    !briefingLoading;

  return (
    <div className="flex flex-col h-full" style={{ color: '#E8EFFF' }}>
      {/* Live status bar */}
      <LiveStatusBar
        isRecording={isRecording}
        estimatedSizeMb={recording.estimatedSizeMb}
        onToggleRecording={handleToggleRecording}
        isToggling={isToggling}
      />

      <div className="flex-1 overflow-auto p-6 space-y-5">
        {/* Welcome hero (only when idle) */}
        {!isRecording && (
          <DashboardHero displayName={displayName} matchCount={matchHistory.length} />
        )}

        {/* Phase 4 — Coach Briefing (primary content, hides while recording) */}
        {showBriefingSkeleton ? (
          <BriefingSkeleton />
        ) : (
          <CoachBriefingCard isRecording={isRecording} />
        )}

        {/* Recent game summary (below briefing, optional deeper review) */}
        {lastMatchSummary && !isRecording && (
          <div className="fade-in-up">
            <PostGameDashboard summary={lastMatchSummary} matchRow={lastMatchRow} />
          </div>
        )}

        {/* First-time empty state */}
        {isEmpty && <EmptyDashboardCard />}
      </div>
    </div>
  );
}
