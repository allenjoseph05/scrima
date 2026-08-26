import { invoke } from '@tauri-apps/api/core';
// GAMING REDESIGN
import { useEffect, useState } from 'react';
import { SubscriptionView } from './SubscriptionView';

const SETTINGS_KEYS = [
  'recording_encoder',
  'recording_resolution',
  'recording_fps',
  'buffer_max_games',
  'notify_analysis_complete',
  'notify_deep_coaching',
  'notify_weekly_report',
  'recording_quality',
] as const;
type SettingKey = (typeof SETTINGS_KEYS)[number];

const DEFAULTS: Record<SettingKey, string> = {
  recording_encoder: 'auto',
  recording_resolution: '1080p',
  recording_fps: '60',
  buffer_max_games: '20',
  notify_analysis_complete: 'true',
  notify_deep_coaching: 'true',
  notify_weekly_report: 'true',
  recording_quality: 'balanced',
};

function SectionHeader({ label }: { label: string }) {
  return (
    <h2
      className="text-[10px] font-black tracking-[0.2em] uppercase mb-4 flex items-center gap-2"
      style={{ color: '#3D4F6E' }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 1,
          background: '#7C3AED',
          verticalAlign: 'middle',
        }}
      />
      {label}
    </h2>
  );
}

function SettingCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="p-6 space-y-5 mb-8"
      style={{
        background: '#0D1221',
        borderLeft: '3px solid #7C3AED',
        border: '1px solid #1A2440',
        borderLeftWidth: 3,
        borderLeftColor: '#7C3AED',
        boxShadow: 'inset 2px 0 12px #7C3AED10',
      }}
    >
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <div>
      <label
        className="block text-[10px] font-black tracking-[0.15em] uppercase mb-2"
        style={{ color: '#7A8BAD' }}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm font-mono focus:outline-none appearance-none"
        style={{
          background: '#0A0E1A',
          border: '1px solid #1A2440',
          borderRadius: 2,
          padding: '0.5rem 0.75rem',
          color: '#E8EFFF',
          cursor: 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <p className="mt-1.5 text-xs font-mono" style={{ color: '#3D4F6E' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function ToggleField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span
          className="block text-[10px] font-black tracking-[0.15em] uppercase"
          style={{ color: '#7A8BAD' }}
        >
          {label}
        </span>
        {hint && (
          <p className="text-xs font-mono mt-0.5" style={{ color: '#3D4F6E' }}>
            {hint}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200"
        style={{
          background: value ? '#7C3AED' : '#1A2440',
          border: value ? '1px solid rgba(124, 58, 237, 0.5)' : '1px solid #2D4A6B',
        }}
      >
        <span
          className="absolute top-[3px] left-[3px] w-[18px] h-[18px] rounded-full transition-transform duration-200"
          style={{
            background: value ? '#E8EFFF' : '#7A8BAD',
            transform: value ? 'translateX(20px)' : 'translateX(0)',
            boxShadow: value ? '0 0 6px rgba(124, 58, 237, 0.5)' : 'none',
          }}
        />
      </button>
    </div>
  );
}

function StorageInfo() {
  const [info, setInfo] = useState<{ totalMatches: number; pendingUploads: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const matches = await invoke<Array<unknown>>('list_recent_matches', { limit: 999 }).catch(
          () => [],
        );
        const pending = await invoke<number>('get_pending_upload_count').catch(() => 0);
        setInfo({ totalMatches: matches.length, pendingUploads: pending });
      } catch {
        // ignore
      }
    })();
  }, []);

  if (!info) return null;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs">
        <span style={{ color: '#7A8BAD' }}>Stored matches</span>
        <span className="font-mono" style={{ color: '#E8EFFF' }}>
          {info.totalMatches}
        </span>
      </div>
      {info.pendingUploads > 0 && (
        <div className="flex justify-between text-xs">
          <span style={{ color: '#F59E0B' }}>Pending uploads (offline queue)</span>
          <span className="font-mono" style={{ color: '#F59E0B' }}>
            {info.pendingUploads}
          </span>
        </div>
      )}
    </div>
  );
}

export function SettingsView() {
  const [values, setValues] = useState<Record<SettingKey, string>>({ ...DEFAULTS });
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const all = await invoke<Record<string, string>>('get_all_settings');
        setValues((v) => ({ ...v, ...all }));
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    try {
      for (const key of SETTINGS_KEYS) {
        await invoke('set_setting', { key, value: values[key] });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('save settings failed:', e);
    }
  };

  const set = (key: SettingKey) => (v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3">
          <div
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
          />
          <span className="text-sm font-mono tracking-widest" style={{ color: '#7A8BAD' }}>
            LOADING…
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl mx-auto" style={{ color: '#E8EFFF' }}>
      {/* Header */}
      <div className="mb-8">
        <h1
          className="text-2xl font-black tracking-[0.15em] uppercase"
          style={{ color: '#E8EFFF' }}
        >
          SETTINGS
        </h1>
        <p className="text-xs font-mono tracking-widest mt-1" style={{ color: '#7A8BAD' }}>
          CONFIGURE SCRIMA FOR YOUR SETUP
        </p>
        <div
          className="mt-4"
          style={{ height: 1, background: 'linear-gradient(90deg, #7C3AED, transparent)' }}
        />
      </div>

      {/* Recording */}
      <section className="mb-8">
        <SectionHeader label="RECORDING" />
        <SettingCard>
          <SelectField
            label="VIDEO ENCODER"
            value={values.recording_encoder}
            onChange={set('recording_encoder')}
            options={[
              { value: 'auto', label: 'Auto (prefer hardware)' },
              { value: 'nvenc', label: 'NVENC (NVIDIA)' },
              { value: 'amf', label: 'AMF (AMD)' },
              { value: 'software', label: 'Software (libx264)' },
            ]}
            hint="NVENC/AMF use <2% GPU. Software is a fallback if no GPU encoder is available."
          />
          <SelectField
            label="RESOLUTION"
            value={values.recording_resolution}
            onChange={set('recording_resolution')}
            options={[
              { value: '1080p', label: '1080p (recommended)' },
              { value: '1440p', label: '1440p' },
              { value: '720p', label: '720p (low storage)' },
            ]}
          />
          <SelectField
            label="FRAME RATE"
            value={values.recording_fps}
            onChange={set('recording_fps')}
            options={[
              { value: '60', label: '60 FPS (recommended)' },
              { value: '30', label: '30 FPS (smaller files)' },
              { value: '120', label: '120 FPS' },
            ]}
          />
        </SettingCard>
      </section>

      {/* Recording Quality */}
      <section className="mb-8">
        <SectionHeader label="QUALITY" />
        <SettingCard>
          <SelectField
            label="RECORDING QUALITY PRESET"
            value={values.recording_quality}
            onChange={set('recording_quality')}
            options={[
              { value: 'performance', label: 'Performance (smaller files, lower bitrate)' },
              { value: 'balanced', label: 'Balanced (recommended)' },
              { value: 'quality', label: 'Quality (larger files, higher bitrate)' },
            ]}
            hint="Higher quality produces better AI analysis results but uses more disk space."
          />
        </SettingCard>
      </section>

      {/* Storage */}
      <section className="mb-8">
        <SectionHeader label="STORAGE" />
        <SettingCard>
          <SelectField
            label="ROLLING BUFFER SIZE"
            value={values.buffer_max_games}
            onChange={set('buffer_max_games')}
            options={[
              { value: '10', label: '10 games (~25 GB)' },
              { value: '20', label: '20 games (~50 GB) — recommended' },
              { value: '30', label: '30 games (~75 GB)' },
              { value: '50', label: '50 games (~125 GB)' },
            ]}
            hint="Oldest recordings are deleted automatically when the buffer is full. Death clips are kept separately."
          />
          <StorageInfo />
        </SettingCard>
      </section>

      {/* Notifications */}
      <section className="mb-8">
        <SectionHeader label="NOTIFICATIONS" />
        <SettingCard>
          <ToggleField
            label="ANALYSIS COMPLETE"
            value={values.notify_analysis_complete === 'true'}
            onChange={(v) => set('notify_analysis_complete')(v ? 'true' : 'false')}
            hint="When death classifications finish for a match"
          />
          <ToggleField
            label="DEEP COACHING READY"
            value={values.notify_deep_coaching === 'true'}
            onChange={(v) => set('notify_deep_coaching')(v ? 'true' : 'false')}
            hint="When a full-game coaching report completes"
          />
          <ToggleField
            label="WEEKLY REPORT"
            value={values.notify_weekly_report === 'true'}
            onChange={(v) => set('notify_weekly_report')(v ? 'true' : 'false')}
            hint="When your weekly coaching summary is ready"
          />
        </SettingCard>
      </section>

      {/* Subscription & Account */}
      <section className="mb-8">
        <SubscriptionView />
      </section>

      {/* Save */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleSave}
          className="btn-primary"
          style={{ minWidth: '10rem' }}
        >
          {saved ? 'SAVED' : 'SAVE SETTINGS'}
        </button>
        {saved && (
          <span
            className="text-xs font-mono font-bold tracking-widest"
            style={{ color: '#00FF85' }}
          >
            SETTINGS SAVED
          </span>
        )}
      </div>
    </div>
  );
}
