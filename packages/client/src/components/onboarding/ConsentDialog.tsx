import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { useState } from 'react';

interface ConsentDialogProps {
  onConsent: () => void;
}

export function ConsentDialog({ onConsent }: ConsentDialogProps) {
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleAccept() {
    if (!agreed) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      await invoke('set_setting', { key: 'privacy_consent', value: now });
      onConsent();
    } catch (err) {
      console.error('Failed to save consent:', err);
    } finally {
      setSaving(false);
    }
  }

  async function openLink(url: string) {
    try {
      await open(url);
    } catch {
      // Fallback: silently fail if shell plugin isn't available
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(5, 8, 16, 0.95)' }}
    >
      <div
        className="w-full max-w-lg p-8 rounded-sm"
        style={{
          background: '#0D1221',
          border: '1px solid rgba(124, 58, 237, 0.2)',
          boxShadow: '0 0 40px rgba(124, 58, 237, 0.08)',
        }}
      >
        <h2
          className="text-lg font-black tracking-[0.15em] uppercase mb-2"
          style={{ color: '#E8EFFF' }}
        >
          Before We Begin
        </h2>
        <div
          className="mb-6"
          style={{ height: 1, background: 'linear-gradient(90deg, #7C3AED, transparent)' }}
        />

        <div className="space-y-3 mb-6 text-sm leading-relaxed" style={{ color: '#7A8BAD' }}>
          <p>
            Scrima captures your screen during Valorant matches to detect in-game events like deaths
            and round changes. Here's what happens with your data:
          </p>

          <ul className="space-y-2 pl-4">
            <li className="flex items-start gap-2">
              <span style={{ color: '#7C3AED', flexShrink: 0 }}>{'>'}</span>
              <span>
                <strong style={{ color: '#E8EFFF' }}>Game recordings</strong> are compressed and
                uploaded to our server for AI coaching analysis. Recordings are{' '}
                <strong style={{ color: '#22C55E' }}>deleted after processing</strong>.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: '#7C3AED', flexShrink: 0 }}>{'>'}</span>
              <span>
                <strong style={{ color: '#E8EFFF' }}>Game events</strong> (deaths, rounds, scores)
                are stored on our server for coaching analysis and progress tracking.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: '#7C3AED', flexShrink: 0 }}>{'>'}</span>
              <span>
                Recordings are processed by{' '}
                <strong style={{ color: '#E8EFFF' }}>Google Gemini AI</strong> to generate
                personalised coaching reports.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span style={{ color: '#7C3AED', flexShrink: 0 }}>{'>'}</span>
              <span>
                You can <strong style={{ color: '#EF4444' }}>delete all your data</strong> at any
                time by deleting your account.
              </span>
            </li>
          </ul>
        </div>

        {/* Links */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => openLink('https://scrima.gg/privacy')}
            className="text-xs underline"
            style={{ color: '#A78BFA', cursor: 'pointer', background: 'none', border: 'none' }}
          >
            Privacy Policy
          </button>
          <button
            onClick={() => openLink('https://scrima.gg/terms')}
            className="text-xs underline"
            style={{ color: '#A78BFA', cursor: 'pointer', background: 'none', border: 'none' }}
          >
            Terms of Service
          </button>
        </div>

        {/* Checkbox */}
        <label className="flex items-start gap-3 mb-6 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded accent-purple-600"
          />
          <span className="text-sm" style={{ color: '#E8EFFF' }}>
            I agree to the Privacy Policy and Terms of Service
          </span>
        </label>

        {/* Accept button */}
        <button
          onClick={handleAccept}
          disabled={!agreed || saving}
          className="w-full py-3 rounded text-sm font-semibold uppercase tracking-wider transition-all"
          style={{
            background: agreed ? 'linear-gradient(135deg, #7C3AED, #6D28D9)' : '#1A2440',
            color: agreed ? '#fff' : '#3D4F6E',
            border: 'none',
            cursor: agreed ? 'pointer' : 'not-allowed',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
