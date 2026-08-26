import { useAuthStore } from '../../stores/authStore';

export function LoginView() {
  const { isLoggingIn, loginUserCode, loginError, startLogin, cancelLogin } = useAuthStore();

  return (
    <div
      className="flex h-screen items-center justify-center bg-dots"
      style={{ background: '#050810' }}
    >
      {/* Background ambient glows */}
      <div
        style={{
          position: 'fixed',
          top: '20%',
          left: '30%',
          width: 400,
          height: 400,
          background: 'radial-gradient(circle, rgba(124, 58, 237, 0.04) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'fixed',
          bottom: '20%',
          right: '30%',
          width: 300,
          height: 300,
          background: 'radial-gradient(circle, rgba(0, 212, 255, 0.03) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div className="relative" style={{ width: 440 }}>
        <div
          className="relative z-10 text-center px-8 py-12 hud-corners"
          style={{
            background: 'linear-gradient(135deg, #0D1221 0%, #0A0E1A 100%)',
            border: '1px solid #1A244060',
          }}
        >
          {/* Inner HUD corners */}
          <div
            className="hud-corners-full"
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          />

          {/* Animated top edge */}
          <div
            style={{
              position: 'absolute',
              top: -1,
              left: 12,
              right: 12,
              height: '1px',
              background: 'linear-gradient(90deg, transparent, #7C3AED60, transparent)',
            }}
          />

          {/* Logo / Title */}
          <div className="mb-8 flex flex-col items-center relative">
            <div className="relative mb-4">
              <img
                src="/scrima-logo.png"
                alt="Scrima"
                className="w-20 h-20"
                style={{ filter: 'drop-shadow(0 0 20px rgba(124, 58, 237, 0.5))' }}
              />
              {/* Rotating ring */}
              <svg
                className="absolute -inset-3"
                width="104"
                height="104"
                viewBox="0 0 104 104"
                fill="none"
                style={{ animation: 'rotate-slow 12s linear infinite', opacity: 0.2 }}
              >
                <circle
                  cx="52"
                  cy="52"
                  r="48"
                  stroke="#7C3AED"
                  strokeWidth="0.5"
                  strokeDasharray="6 10"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-black tracking-[0.3em] mb-2" style={{ color: '#E8EFFF' }}>
              SCRIMA
            </h1>
            <p className="text-xs tracking-[0.15em] uppercase" style={{ color: '#3D4F6E' }}>
              AI Coaching Platform
            </p>
          </div>

          {/* Not logging in — show sign-in button */}
          {!isLoggingIn && !loginError && (
            <div>
              <button
                onClick={startLogin}
                className="w-full py-3 px-6 font-bold text-sm uppercase tracking-[0.15em] transition-all duration-200 rounded-sm"
                style={{
                  background: 'linear-gradient(135deg, #7C3AED, #6D28D9)',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 0 20px #7C3AED30',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = '0 0 30px #7C3AED50';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = '0 0 20px #7C3AED30';
                }}
              >
                Sign In
              </button>
              <p
                className="mt-4"
                style={{ color: '#3D4F6E', fontSize: '0.7rem', letterSpacing: '0.1em' }}
              >
                A BROWSER WINDOW WILL OPEN FOR SIGN-IN
              </p>
            </div>
          )}

          {/* Logging in — show code and spinner */}
          {isLoggingIn && (
            <div>
              {loginUserCode && (
                <div className="mb-6">
                  <p
                    className="mb-2"
                    style={{ color: '#7A8BAD', fontSize: '0.75rem', letterSpacing: '0.1em' }}
                  >
                    ENTER THIS CODE IN YOUR BROWSER:
                  </p>
                  <div
                    className="py-3 px-4 text-2xl tracking-[0.2em] font-mono font-bold hud-corners"
                    style={{
                      background: '#7C3AED10',
                      border: '1px solid #7C3AED30',
                      color: '#A78BFA',
                      textShadow: '0 0 8px #A78BFA40',
                    }}
                  >
                    {loginUserCode}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-center gap-3 mb-4">
                <div
                  className="w-5 h-5 border-2 rounded-full animate-spin"
                  style={{ borderColor: '#7C3AED40', borderTopColor: '#7C3AED' }}
                />
                <span style={{ color: '#7A8BAD', fontSize: '0.8rem', letterSpacing: '0.05em' }}>
                  Waiting for sign-in...
                </span>
              </div>

              <button
                onClick={cancelLogin}
                className="text-xs uppercase tracking-wider"
                style={{ color: '#3D4F6E', cursor: 'pointer', background: 'none', border: 'none' }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Error state */}
          {loginError && !isLoggingIn && (
            <div>
              <p className="mb-4 text-sm" style={{ color: '#FF2D55' }}>
                {loginError}
              </p>
              <button
                onClick={startLogin}
                className="w-full py-3 px-6 font-bold text-sm uppercase tracking-[0.15em] rounded-sm"
                style={{
                  background: 'linear-gradient(135deg, #7C3AED, #6D28D9)',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 0 20px #7C3AED30',
                }}
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
