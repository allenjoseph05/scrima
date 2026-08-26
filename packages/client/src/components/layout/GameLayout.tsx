import { type GameView, useAppStore } from '../../stores/appStore';
import { useGameStore } from '../../stores/gameStore';
import { useMatchStore } from '../../stores/matchStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { CoachingView } from '../coaching/CoachingView';
import { YourCoachView } from '../coaching/YourCoachView';
import { DashboardView } from '../dashboard/DashboardView';
import { HistoryView } from '../history/HistoryView';

// ── Tab config ───────────────────────────────────────────────────────────────

const TABS: { id: GameView; label: string }[] = [
  { id: 'dashboard', label: 'DASHBOARD' },
  { id: 'history', label: 'HISTORY' },
  { id: 'coaching', label: 'COACHING' },
  { id: 'your_coach', label: 'YOUR COACH' },
];

// ── Game Layout ──────────────────────────────────────────────────────────────

export function GameLayout() {
  const { activeView, setActiveView, goHome } = useAppStore();
  const game = useGameStore((s) => s.getDefinition());
  const recording = useMatchStore((s) => s.recording);
  const unreadCountForView = useNotificationStore((s) => s.unreadCountForView);
  const accent = game.accentColor;

  const renderView = () => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardView />;
      case 'history':
        return <HistoryView />;
      case 'coaching':
        return <CoachingView />;
      case 'your_coach':
        return <YourCoachView />;
      default:
        return null;
    }
  };

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ backgroundColor: '#050810', color: '#E8EFFF' }}
    >
      {/* Top bar */}
      <header
        className="flex items-center justify-between px-5 py-0 flex-shrink-0 relative"
        style={{
          background: 'linear-gradient(90deg, #0A0E1A 0%, #0D1221 100%)',
          borderBottom: '1px solid #1A244060',
          minHeight: 48,
        }}
      >
        {/* Animated bottom edge */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '1px',
            background: `linear-gradient(90deg, transparent, ${accent}30, #00D4FF20, transparent)`,
          }}
        />

        {/* Left: back + game name */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={goHome}
            className="flex items-center gap-1.5 text-sm transition-colors hover:text-white py-3"
            style={{ color: '#7A8BAD' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 12L6 8L10 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Accent separator */}
          <div
            style={{
              width: 1,
              height: 20,
              background: `${accent}30`,
            }}
          />

          {/* Game name */}
          <span className="text-sm font-black tracking-[0.2em] uppercase" style={{ color: accent }}>
            {game.name}
          </span>
        </div>

        {/* Center: tabs */}
        <nav className="flex items-center gap-1">
          {TABS.map(({ id, label }) => {
            const isActive = activeView === id;
            const unread = unreadCountForView(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveView(id)}
                className="relative px-4 py-3 text-[11px] font-bold tracking-[0.15em] uppercase transition-all duration-200"
                style={{
                  color: isActive ? '#E8EFFF' : '#7A8BAD',
                  textShadow: isActive ? `0 0 10px ${accent}60` : 'none',
                }}
              >
                {label}
                {unread > 0 && !isActive && (
                  <span
                    className="absolute top-2 right-1 w-1.5 h-1.5 rounded-full"
                    style={{ background: '#00D4FF', boxShadow: '0 0 6px #00D4FF' }}
                  />
                )}
                {/* Active underline */}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-3 right-3 h-[2px]"
                    style={{
                      background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
                      boxShadow: `0 0 8px ${accent}60`,
                    }}
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Right: recording status */}
        <div className="flex items-center gap-3 min-w-[120px] justify-end">
          {recording.isRecording ? (
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  background: '#FF2D55',
                  boxShadow: '0 0 6px #FF2D55',
                  animation: 'pulse-dot 0.9s ease-in-out infinite',
                }}
              />
              <span
                className="text-[10px] font-mono font-bold tracking-widest"
                style={{ color: '#FF2D55' }}
              >
                REC{' '}
                {recording.estimatedSizeMb > 0 ? `${recording.estimatedSizeMb.toFixed(0)}MB` : ''}
              </span>
            </div>
          ) : (
            <span className="text-[10px] font-mono tracking-wider" style={{ color: '#1A2440' }}>
              STANDBY
            </span>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto relative bg-dots">
        {/* Corner accent decorations */}
        <div
          className="absolute top-0 right-0 pointer-events-none"
          style={{
            width: 120,
            height: 120,
            background: `radial-gradient(ellipse at top right, ${accent}06 0%, transparent 70%)`,
          }}
        />
        <div className="relative z-10 h-full">{renderView()}</div>
      </main>
    </div>
  );
}
