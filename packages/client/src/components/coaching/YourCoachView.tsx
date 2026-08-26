import { useEffect, useState } from 'react';
import { useCoachStore } from '../../stores/coachStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { CoachLivingMind } from './CoachLivingMind';

// Phase 7A: the 4 tabs (COACH | BRAIN | JOURNEY | DATA) are gone.
// Everything now lives in CoachLivingMind — one scrollable surface with chat
// hero, right-now, brain, chapters, utilities. Retired components stay in the
// repo as dead code for rollback:
//   - CoachChat (still used inside CoachLivingMind via ChatHero)
//   - CoachBrain (legacy wrapper; BrainSections is the composable export)
//   - CoachEras (legacy wrapper; ErasSections is the composable export)
//   - CoachJourney (fully retired; replaced by Eras)
//   - CoachData (fully retired; reset moved to CoachLivingMind footer)

// ── Boot sequence ───────────────────────────────────────────────────────────

function BootScreen({ onComplete }: { onComplete: () => void }) {
  const [phase, setPhase] = useState<'scan' | 'text' | 'done'>('scan');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('text'), 600);
    const t2 = setTimeout(() => setPhase('done'), 1800);
    const t3 = setTimeout(onComplete, 2000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [onComplete]);

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center cursor-pointer"
      style={{ background: '#050810' }}
      onClick={onComplete}
    >
      {/* Scan line */}
      {phase === 'scan' && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(transparent 0%, #7C3AED08 45%, #7C3AED18 50%, #7C3AED08 55%, transparent 100%)',
            animation: 'scan 1s linear forwards',
          }}
        />
      )}

      {/* Title */}
      <div
        className="transition-opacity duration-500"
        style={{ opacity: phase === 'scan' ? 0 : 1 }}
      >
        <h1
          className="text-2xl font-black tracking-[0.3em] uppercase text-center"
          style={{ color: '#E8EFFF' }}
        >
          SCRIMA COACH
        </h1>
        <div className="flex items-center justify-center gap-2 mt-3">
          <div
            className="h-px flex-1 max-w-[60px]"
            style={{ background: 'linear-gradient(to right, transparent, #7C3AED40)' }}
          />
          <span
            className="text-[10px] font-mono tracking-[0.2em] uppercase"
            style={{
              color: '#7C3AED',
              backgroundImage: 'linear-gradient(90deg, #7C3AED, #00D4FF, #7C3AED)',
              backgroundSize: '200% 100%',
              animation: 'shimmer 2s linear infinite',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            INITIALIZING
          </span>
          <div
            className="h-px flex-1 max-w-[60px]"
            style={{ background: 'linear-gradient(to left, transparent, #7C3AED40)' }}
          />
        </div>
      </div>

      {/* Flash */}
      {phase === 'done' && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: '#E8EFFF',
            animation: 'flicker 0.3s ease-out forwards',
            opacity: 0.05,
          }}
        />
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export function YourCoachView() {
  const booted = useCoachStore((s) => s.booted);
  const setBooted = useCoachStore((s) => s.setBooted);
  const brainLoading = useCoachStore((s) => s.brainLoading);
  const dismissForView = useNotificationStore((s) => s.dismissForView);

  useEffect(() => {
    dismissForView('your_coach');
  }, [dismissForView]);

  // Show boot animation once per session
  if (!booted) {
    return (
      <div className="h-full relative">
        <BootScreen onComplete={setBooted} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Sync indicator (tiny, top-right) */}
      {brainLoading && (
        <div className="absolute top-3 right-5 z-10 flex items-center gap-2">
          <div
            className="w-3 h-3 border border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
          />
          <span className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
            SYNCING
          </span>
        </div>
      )}

      <div className="flex-1 overflow-hidden fade-in-up">
        <CoachLivingMind />
      </div>
    </div>
  );
}
