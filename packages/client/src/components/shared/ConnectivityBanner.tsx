import { useConnectivityStore } from '../../stores/connectivityStore';

export function ConnectivityBanner() {
  const status = useConnectivityStore((s) => s.status);

  if (status === 'online' || status === 'unknown') return null;

  const config =
    status === 'offline'
      ? {
          label: 'OFFLINE',
          message: "You're offline. Recording and coaching will resume when you reconnect.",
          accent: '#F59E0B',
          bg: '#F59E0B12',
          border: '#F59E0B44',
        }
      : {
          label: 'SERVER UNREACHABLE',
          message: "We can't reach Scrima right now. We'll keep retrying in the background.",
          accent: '#FF8C42',
          bg: '#FF8C4212',
          border: '#FF8C4244',
        };

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full flex items-center gap-3 px-4 py-2"
      style={{
        background: config.bg,
        borderBottom: `1px solid ${config.border}`,
        color: config.accent,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span
        className="w-2 h-2 rounded-full"
        style={{
          background: config.accent,
          boxShadow: `0 0 6px ${config.accent}`,
          animation: 'pulse-dot 1.5s ease-in-out infinite',
        }}
      />
      <span className="text-[10px] font-bold tracking-[0.2em] uppercase">{config.label}</span>
      <span className="text-[11px]" style={{ color: '#B0BCDB' }}>
        {config.message}
      </span>
    </div>
  );
}
