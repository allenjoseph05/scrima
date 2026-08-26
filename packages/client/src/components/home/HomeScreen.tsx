import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { GAME_DEFINITIONS, type GameDefinition } from '../../stores/gameStore';
import { useMatchStore } from '../../stores/matchStore';
import { SettingsView } from '../settings/SettingsView';

// ── Game Card ────────────────────────────────────────────────────────────────

function GameCard({ game }: { game: GameDefinition }) {
  const enterGame = useAppStore((s) => s.enterGame);
  const accent = game.accentColor;

  return (
    <button
      type="button"
      disabled={!game.enabled}
      onClick={() => game.enabled && enterGame(game.id)}
      className="group relative w-full text-left transition-all duration-300"
      style={{
        background: game.enabled
          ? `linear-gradient(135deg, ${accent}08 0%, #0D1221 40%, ${accent}04 100%)`
          : '#0A0E1A',
        border: `1px solid ${game.enabled ? `${accent}30` : '#1A244040'}`,
        opacity: game.enabled ? 1 : 0.5,
        cursor: game.enabled ? 'pointer' : 'default',
        overflow: 'hidden',
      }}
    >
      {/* Top glow edge */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '2px',
          background: game.enabled
            ? `linear-gradient(90deg, transparent, ${accent}90, transparent)`
            : 'transparent',
          transition: 'opacity 0.3s',
        }}
      />

      {/* Left accent bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '3px',
          height: '100%',
          background: game.enabled
            ? `linear-gradient(180deg, ${accent}, ${accent}40)`
            : '#1A244060',
        }}
      />

      {/* Hover glow overlay */}
      {game.enabled && (
        <div
          className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at center, ${accent}08 0%, transparent 70%)`,
          }}
        />
      )}

      <div className="relative p-8 pl-7">
        {/* Game name + status row */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2
              className="text-2xl font-black tracking-[0.15em] uppercase leading-none"
              style={{ color: game.enabled ? accent : '#3D4F6E' }}
            >
              {game.name}
            </h2>
            <p
              className="text-[10px] font-mono tracking-[0.2em] uppercase mt-2"
              style={{ color: game.enabled ? '#7A8BAD' : '#3D4F6E' }}
            >
              {game.enabled ? 'AI COACHING AVAILABLE' : 'COMING SOON'}
            </p>
          </div>

          {/* Status badge */}
          <span
            className="text-[9px] font-mono font-bold tracking-widest uppercase px-2.5 py-1"
            style={{
              color: game.enabled ? accent : '#3D4F6E',
              background: game.enabled ? `${accent}12` : '#0A0E1A',
              border: `1px solid ${game.enabled ? `${accent}25` : '#1A244040'}`,
            }}
          >
            {game.enabled ? 'ACTIVE' : 'LOCKED'}
          </span>
        </div>

        {/* Enter button / Coming Soon */}
        {game.enabled ? (
          <div className="flex items-center gap-3">
            <span
              className="text-xs font-black tracking-[0.2em] uppercase px-5 py-2 transition-all duration-200 group-hover:shadow-lg"
              style={{
                background: `linear-gradient(135deg, ${accent}, ${accent}CC)`,
                color: '#fff',
                boxShadow: `0 0 12px ${accent}40`,
              }}
            >
              ENTER
            </span>
            <span
              className="text-[10px] tracking-wider opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{ color: '#7A8BAD' }}
            >
              Dashboard, History, Coaching
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#3D4F6E' }} />
            <span className="text-[10px] font-mono tracking-wider" style={{ color: '#3D4F6E' }}>
              IN DEVELOPMENT
            </span>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Home Screen ──────────────────────────────────────────────────────────────

export function HomeScreen() {
  const { showSettings, toggleSettings } = useAppStore();
  const { email, displayName, logout } = useAuthStore();
  const recording = useMatchStore((s) => s.recording);

  if (showSettings) {
    return (
      <div
        className="flex flex-col h-screen overflow-hidden"
        style={{ backgroundColor: '#050810', color: '#E8EFFF' }}
      >
        {/* Settings header */}
        <header
          className="flex items-center justify-between px-6 py-3 flex-shrink-0"
          style={{
            background: 'linear-gradient(90deg, #0A0E1A 0%, #0D1221 100%)',
            borderBottom: '1px solid #1A244060',
          }}
        >
          <button
            type="button"
            onClick={toggleSettings}
            className="flex items-center gap-2 text-sm font-medium transition-colors hover:text-white"
            style={{ color: '#7A8BAD' }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 12L6 8L10 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="tracking-wider uppercase text-xs font-bold">BACK</span>
          </button>
          <span
            className="text-[10px] font-mono tracking-[0.2em] uppercase"
            style={{ color: '#3D4F6E' }}
          >
            SETTINGS
          </span>
        </header>
        <main className="flex-1 overflow-auto bg-dots">
          <SettingsView />
        </main>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ backgroundColor: '#050810', color: '#E8EFFF' }}
    >
      {/* Background accents */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 20% 20%, #7C3AED06 0%, transparent 50%), radial-gradient(ellipse at 80% 80%, #00D4FF04 0%, transparent 50%)',
        }}
      />

      {/* Top bar */}
      <header
        className="relative z-10 flex items-center justify-between px-8 py-5 flex-shrink-0"
        style={{ borderBottom: '1px solid #1A244040' }}
      >
        <div className="flex items-center gap-4">
          <div className="relative">
            <img
              src="/scrima-logo.png"
              alt="Scrima"
              className="w-10 h-10"
              style={{ filter: 'drop-shadow(0 0 12px rgba(124, 58, 237, 0.5))' }}
            />
            <svg
              className="absolute -inset-2"
              width="56"
              height="56"
              viewBox="0 0 56 56"
              fill="none"
              style={{ animation: 'rotate-slow 12s linear infinite', opacity: 0.12 }}
            >
              <circle
                cx="28"
                cy="28"
                r="26"
                stroke="#7C3AED"
                strokeWidth="0.5"
                strokeDasharray="4 6"
              />
            </svg>
          </div>
          <div>
            <span
              className="text-lg font-black tracking-[0.3em] uppercase leading-none"
              style={{ color: '#E8EFFF' }}
            >
              SCRIMA
            </span>
            <span
              className="block text-[9px] tracking-[0.2em] uppercase mt-0.5"
              style={{ color: '#3D4F6E' }}
            >
              AI COACHING PLATFORM
            </span>
          </div>
        </div>

        <div className="flex items-center gap-5">
          {/* Recording indicator */}
          {recording.isRecording && (
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full"
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
                RECORDING
              </span>
            </div>
          )}

          {/* User info */}
          {(displayName || email) && (
            <div className="flex items-center gap-2">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold"
                style={{
                  background: 'linear-gradient(135deg, #7C3AED30, #7C3AED10)',
                  border: '1px solid #7C3AED30',
                  color: '#A78BFA',
                }}
              >
                {(displayName || email || '?')[0].toUpperCase()}
              </div>
              <span className="text-xs" style={{ color: '#7A8BAD' }}>
                {displayName || email}
              </span>
            </div>
          )}

          {/* Settings */}
          <button
            type="button"
            onClick={toggleSettings}
            className="p-2 transition-colors hover:text-white"
            style={{ color: '#3D4F6E' }}
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Sign out */}
          <button
            type="button"
            onClick={logout}
            className="text-[10px] font-bold tracking-[0.15em] uppercase px-3 py-1.5 transition-colors"
            style={{ color: '#3D4F6E', border: '1px solid #1A244060' }}
          >
            SIGN OUT
          </button>
        </div>
      </header>

      {/* Game cards */}
      <main className="relative z-10 flex-1 overflow-auto bg-dots">
        <div className="max-w-3xl mx-auto px-8 py-12">
          {/* Section label */}
          <div className="flex items-center gap-3 mb-8">
            <span
              style={{ display: 'inline-block', width: 16, height: 1, background: '#7C3AED' }}
            />
            <span
              className="text-[10px] font-bold tracking-[0.25em] uppercase"
              style={{ color: '#3D4F6E' }}
            >
              SELECT YOUR GAME
            </span>
            <span
              className="flex-1"
              style={{ height: 1, background: 'linear-gradient(90deg, #1A244040, transparent)' }}
            />
          </div>

          {/* Cards */}
          <div className="space-y-4">
            {GAME_DEFINITIONS.map((game) => (
              <GameCard key={game.id} game={game} />
            ))}
          </div>

          {/* Footer hint */}
          <p
            className="text-center text-[10px] font-mono tracking-wider mt-10"
            style={{ color: '#1A2440' }}
          >
            v0.1.0
          </p>
        </div>
      </main>
    </div>
  );
}
