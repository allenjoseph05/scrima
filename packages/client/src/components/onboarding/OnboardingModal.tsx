import { invoke } from '@tauri-apps/api/core';
// GAMING REDESIGN — Multi-step onboarding wizard
import { useEffect, useState } from 'react';
import { formatUserError, reportError } from '../../lib/errors';

type Step = 'welcome' | 'ffmpeg' | 'ready' | 'done';

const STEPS: Step[] = ['welcome', 'ffmpeg', 'ready'];

function CrosshairBg() {
  return (
    <svg
      width="320"
      height="320"
      viewBox="0 0 320 320"
      fill="none"
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        opacity: 0.06,
        pointerEvents: 'none',
        animation: 'spin 12s linear infinite',
      }}
    >
      <circle cx="160" cy="160" r="120" stroke="#7C3AED" strokeWidth="1" strokeDasharray="6 4" />
      <circle cx="160" cy="160" r="80" stroke="#7C3AED" strokeWidth="1" />
      <circle cx="160" cy="160" r="8" fill="#7C3AED" />
      <line x1="160" y1="0" x2="160" y2="80" stroke="#7C3AED" strokeWidth="1.5" />
      <line x1="160" y1="240" x2="160" y2="320" stroke="#7C3AED" strokeWidth="1.5" />
      <line x1="0" y1="160" x2="80" y2="160" stroke="#7C3AED" strokeWidth="1.5" />
      <line x1="240" y1="160" x2="320" y2="160" stroke="#7C3AED" strokeWidth="1.5" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L2 20h20L12 2z" stroke="#F59E0B" strokeWidth="1.5" strokeLinejoin="round" />
      <line
        x1="12"
        y1="9"
        x2="12"
        y2="14"
        stroke="#F59E0B"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17" r="0.75" fill="#F59E0B" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="#10B981" strokeWidth="1.5" />
      <polyline
        points="8,12 11,15 16,9"
        stroke="#10B981"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-6">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className="h-1 flex-1 rounded-full transition-all duration-300"
          style={{
            background: i <= current ? 'linear-gradient(90deg, #7C3AED, #00D4FF)' : '#1A2440',
          }}
        />
      ))}
    </div>
  );
}

export function OnboardingModal() {
  const [step, setStep] = useState<Step | null>(null);
  const [ffmpegOk, setFfmpegOk] = useState(false);

  useEffect(() => {
    (async () => {
      // Check if onboarding was already completed
      const completed = await invoke<string | null>('get_setting', {
        key: 'onboarding_done',
      }).catch(() => null);
      if (completed) return;

      const hasFfmpeg = await invoke<boolean>('check_ffmpeg').catch(() => false);
      setFfmpegOk(hasFfmpeg);
      setStep('welcome');
    })();
  }, []);

  if (!step || step === 'done') return null;

  const stepIdx = STEPS.indexOf(step);

  const finish = async () => {
    await invoke('set_setting', { key: 'onboarding_done', value: 'true' }).catch(() => {});
    setStep('done');
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(5, 8, 16, 0.92)', backdropFilter: 'blur(8px)' }}
    >
      <div className="absolute inset-0 pointer-events-none bg-grid" style={{ opacity: 0.3 }} />

      <div
        className="relative w-full max-w-md mx-4 p-8 overflow-hidden"
        style={{
          background: '#0D1221',
          border: '1px solid #7C3AED',
          boxShadow: '0 0 40px #7C3AED44, 0 0 80px #7C3AED18',
          clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%)',
        }}
      >
        <CrosshairBg />

        {/* Header */}
        <div className="relative mb-2">
          <p
            className="text-[10px] font-mono font-black tracking-[0.3em] uppercase mb-1"
            style={{ color: '#7C3AED' }}
          >
            SCRIMA SETUP
          </p>
          <div
            style={{
              height: 1,
              background: 'linear-gradient(90deg, #7C3AED, #00D4FF, transparent)',
            }}
          />
        </div>

        <StepIndicator current={stepIdx} total={STEPS.length} />

        <div className="relative">
          {step === 'welcome' && (
            <WelcomeStep onNext={() => setStep(ffmpegOk ? 'ready' : 'ffmpeg')} />
          )}
          {step === 'ffmpeg' && (
            <FfmpegStep
              onNext={() => {
                setFfmpegOk(true);
                setStep('ready');
              }}
              onSkip={() => setStep('ready')}
            />
          )}
          {step === 'ready' && <ReadyStep ffmpegOk={ffmpegOk} onFinish={finish} />}
        </div>
      </div>
    </div>
  );
}

// ── Step 1: Welcome ──────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <h2
        className="text-xl font-black tracking-[0.1em] uppercase mb-3"
        style={{ color: '#E8EFFF' }}
      >
        WELCOME TO SCRIMA
      </h2>
      <p className="text-sm mb-2 leading-relaxed" style={{ color: '#7A8BAD' }}>
        Your AI-powered Valorant coach. Scrima watches your gameplay, identifies why you died, and
        delivers personalized coaching to help you improve.
      </p>

      <div className="space-y-3 my-5">
        <FeatureRow icon="1" title="Auto-detects deaths" desc="No manual tagging needed" />
        <FeatureRow
          icon="2"
          title="AI classification"
          desc="Gemini VLM analyzes each death cause"
        />
        <FeatureRow
          icon="3"
          title="Coaching reports"
          desc="Actionable drills tailored to your patterns"
        />
      </div>

      <button type="button" onClick={onNext} className="btn-primary w-full">
        GET STARTED
      </button>
    </>
  );
}

function FeatureRow({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-8 h-8 flex items-center justify-center text-xs font-black shrink-0"
        style={{ background: '#7C3AED18', border: '1px solid #7C3AED44', color: '#A78BFA' }}
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-semibold" style={{ color: '#E8EFFF' }}>
          {title}
        </p>
        <p className="text-xs" style={{ color: '#3D4F6E' }}>
          {desc}
        </p>
      </div>
    </div>
  );
}

// ── Step 2: FFmpeg install ────────────────────────────────────────────────────

function FfmpegStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string>('');

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    setStage('downloading');

    try {
      await invoke<string>('install_ffmpeg');
      setStage('done');
      setTimeout(onNext, 1000);
    } catch (err) {
      reportError(err, 'OnboardingModal.installFfmpeg');
      setError(
        formatUserError(
          err,
          'FFmpeg installation failed. Please try again or install it manually.',
        ),
      );
      setInstalling(false);
    }
  }

  return (
    <>
      <div
        className="w-12 h-12 flex items-center justify-center mb-5"
        style={{ background: '#F59E0B0D', border: '1px solid #F59E0B44' }}
      >
        <WarningIcon />
      </div>

      <h2
        className="text-xl font-black tracking-[0.1em] uppercase mb-2"
        style={{ color: '#E8EFFF' }}
      >
        FFMPEG REQUIRED
      </h2>
      <p className="text-sm mb-4 leading-relaxed" style={{ color: '#7A8BAD' }}>
        Scrima uses <strong style={{ color: '#E8EFFF' }}>ffmpeg</strong> to record gameplay and
        extract death clips. Click below to download and install it automatically (~80 MB).
      </p>

      {error && (
        <div
          className="mb-4 p-3 text-xs rounded"
          style={{
            background: 'rgba(239, 68, 68, 0.1)',
            color: '#EF4444',
            border: '1px solid rgba(239, 68, 68, 0.2)',
          }}
        >
          {error}
        </div>
      )}

      {installing && (
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
          />
          <span className="text-sm" style={{ color: '#7A8BAD' }}>
            {stage === 'downloading'
              ? 'Downloading ffmpeg...'
              : stage === 'extracting'
                ? 'Extracting...'
                : stage === 'done'
                  ? 'Installed!'
                  : 'Working...'}
          </span>
        </div>
      )}

      <div className="space-y-2">
        {!installing && (
          <button type="button" onClick={handleInstall} className="btn-primary w-full">
            DOWNLOAD &amp; INSTALL FFMPEG
          </button>
        )}

        <button
          type="button"
          onClick={onSkip}
          className="btn-ghost w-full"
          disabled={installing && stage !== 'done'}
        >
          {installing ? 'PLEASE WAIT...' : 'SKIP FOR NOW'}
        </button>
      </div>

      <p className="text-[10px] font-mono mt-4" style={{ color: '#3D4F6E' }}>
        Without ffmpeg, Scrima will still detect deaths and log events — just without video clips.
      </p>
    </>
  );
}

// ── Step 3: Ready ─────────────────────────────────────────────────────────────

function ReadyStep({ ffmpegOk, onFinish }: { ffmpegOk: boolean; onFinish: () => void }) {
  return (
    <>
      <div
        className="w-12 h-12 flex items-center justify-center mb-5"
        style={{ background: '#10B98118', border: '1px solid #10B98144' }}
      >
        <CheckIcon />
      </div>

      <h2
        className="text-xl font-black tracking-[0.1em] uppercase mb-2"
        style={{ color: '#E8EFFF' }}
      >
        YOU&apos;RE ALL SET
      </h2>
      <p className="text-sm mb-5 leading-relaxed" style={{ color: '#7A8BAD' }}>
        Launch Valorant and Scrima will automatically start recording and analyzing your gameplay.
      </p>

      <div className="space-y-2 mb-5">
        <StatusRow ok={true} label="Account connected" />
        <StatusRow
          ok={ffmpegOk}
          label={ffmpegOk ? 'FFmpeg installed' : 'FFmpeg not installed (limited features)'}
        />
        <StatusRow ok={true} label="Game monitor active" />
      </div>

      <button type="button" onClick={onFinish} className="btn-primary w-full">
        START COACHING
      </button>
    </>
  );
}

function StatusRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-2 h-2 rounded-full"
        style={{
          background: ok ? '#10B981' : '#F59E0B',
          boxShadow: ok ? '0 0 6px #10B981' : '0 0 6px #F59E0B',
        }}
      />
      <span className="text-xs" style={{ color: ok ? '#7A8BAD' : '#F59E0B' }}>
        {label}
      </span>
    </div>
  );
}
