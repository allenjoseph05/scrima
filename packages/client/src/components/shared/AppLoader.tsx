import { useEffect, useState } from 'react';

interface AppLoaderProps {
  label?: string;
}

export function AppLoader({ label = 'Loading...' }: AppLoaderProps) {
  // Delay showing the loader slightly so fast mounts don't produce a flash.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 120);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0a0a0f',
        color: '#e2e2e8',
        fontFamily: "'Inter', system-ui, sans-serif",
        opacity: visible ? 1 : 0,
        transition: 'opacity 180ms ease-out',
      }}
    >
      <img
        src="/scrima-logo.png"
        alt="Scrima"
        width={64}
        height={64}
        style={{ marginBottom: 24, opacity: 0.9 }}
        onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
      />
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Scrima</div>
      <div style={{ fontSize: 13, color: '#888', marginBottom: 24 }}>{label}</div>
      <div
        style={{
          width: 120,
          height: 3,
          background: '#1a1a2e',
          borderRadius: 2,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: '40%',
            height: '100%',
            background: 'linear-gradient(90deg, #6366f1, #818cf8)',
            borderRadius: 2,
            animation: 'scrima-loader-slide 1.2s ease-in-out infinite',
            position: 'absolute',
            left: 0,
            top: 0,
          }}
        />
      </div>
      <style>{`
        @keyframes scrima-loader-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}
