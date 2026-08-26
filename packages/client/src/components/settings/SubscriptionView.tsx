import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { useEffect, useState } from 'react';
import { formatUserError, reportError } from '../../lib/errors';
import { useAuthStore } from '../../stores/authStore';

interface Credits {
  total: number;
  used: number;
  remaining: number;
  resetsAt: string;
  month: string;
}

interface UserProfile {
  subscriptionTier: string;
  subscriptionStatus: string;
  email: string;
  displayName: string;
}

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: '',
    features: ['3 death classifications / week', 'Local death detection', 'Match history'],
    limits: ['No deep game analysis', 'No weekly reports'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$12',
    period: '/month',
    features: [
      'Unlimited death classifications',
      '4 deep game analyses / month',
      'Weekly coaching reports',
      'Pattern trend analysis',
    ],
    limits: [],
  },
  {
    id: 'ultra',
    name: 'Ultra',
    price: '$25',
    period: '/month',
    features: [
      'Unlimited death classifications',
      '12 deep game analyses / month',
      'Weekly coaching reports',
      'Advanced AI model (Gemini Pro)',
      'Priority support',
    ],
    limits: [],
  },
];

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

export function SubscriptionView() {
  const { subscriptionTier, email, displayName, checkAuth } = useAuthStore();
  const [credits, setCredits] = useState<Credits | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentTier = subscriptionTier || 'free';

  useEffect(() => {
    loadCredits();
  }, []);

  async function loadCredits() {
    try {
      const c = await invoke<Credits>('get_coaching_credits');
      setCredits(c);
    } catch {
      // Credits may not be available if not connected to server
    }
  }

  async function handleUpgrade(tier: string) {
    setLoading(true);
    setError(null);
    try {
      const url = await invoke<string>('create_checkout_session', { tier });
      await open(url);
    } catch (err) {
      reportError(err, 'SubscriptionView.handleUpgrade');
      setError(formatUserError(err, "We couldn't start checkout. Please try again in a moment."));
    } finally {
      setLoading(false);
    }
  }

  async function handleManageSubscription() {
    setLoading(true);
    setError(null);
    try {
      const url = await invoke<string>('create_portal_session');
      await open(url);
    } catch (err) {
      reportError(err, 'SubscriptionView.handleManageSubscription');
      setError(formatUserError(err, "We couldn't open the billing portal. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshStatus() {
    setLoading(true);
    try {
      await invoke('get_user_profile');
      await checkAuth();
      await loadCredits();
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {/* Current Plan */}
      <SectionHeader label="Current Plan" />
      <div
        className="p-6 mb-6"
        style={{
          background: '#0D1221',
          border: '1px solid #1A2440',
          borderLeftWidth: 3,
          borderLeftColor:
            currentTier === 'ultra' ? '#00D4FF' : currentTier === 'pro' ? '#7C3AED' : '#3D4F6E',
          boxShadow: currentTier !== 'free' ? 'inset 2px 0 12px #7C3AED10' : undefined,
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <span
              className="text-lg font-bold tracking-wider uppercase"
              style={{ color: '#E8EFFF' }}
            >
              {currentTier.charAt(0).toUpperCase() + currentTier.slice(1)}
            </span>
            {(displayName || email) && (
              <span className="ml-3 text-xs" style={{ color: '#7A8BAD' }}>
                {displayName || email}
              </span>
            )}
          </div>
          <button
            onClick={handleRefreshStatus}
            disabled={loading}
            className="text-xs px-3 py-1 rounded"
            style={{
              background: 'rgba(124, 58, 237, 0.1)',
              border: '1px solid rgba(124, 58, 237, 0.3)',
              color: '#A78BFA',
              cursor: loading ? 'wait' : 'pointer',
            }}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {/* Credits display */}
        {credits && credits.total > 0 && (
          <div className="flex items-center gap-6">
            <div>
              <div
                className="text-[10px] font-black tracking-[0.15em] uppercase mb-1"
                style={{ color: '#7A8BAD' }}
              >
                Deep Analysis Credits
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold" style={{ color: '#E8EFFF' }}>
                  {credits.remaining}
                </span>
                <span className="text-sm" style={{ color: '#7A8BAD' }}>
                  / {credits.total}
                </span>
              </div>
            </div>

            {/* Progress bar */}
            <div className="flex-1">
              <div className="h-2 rounded-full overflow-hidden" style={{ background: '#1A2440' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(credits.used / credits.total) * 100}%`,
                    background:
                      credits.remaining === 0
                        ? '#EF4444'
                        : 'linear-gradient(90deg, #7C3AED, #A78BFA)',
                  }}
                />
              </div>
              <div className="text-[10px] mt-1" style={{ color: '#3D4F6E' }}>
                Resets {new Date(credits.resetsAt).toLocaleDateString()}
              </div>
            </div>
          </div>
        )}

        {currentTier === 'free' && (
          <p className="text-xs" style={{ color: '#7A8BAD' }}>
            Upgrade to Pro or Ultra to unlock deep game analysis and weekly coaching reports.
          </p>
        )}

        {currentTier !== 'free' && (
          <button
            onClick={handleManageSubscription}
            disabled={loading}
            className="mt-4 text-xs underline"
            style={{ color: '#7A8BAD', cursor: 'pointer', background: 'none', border: 'none' }}
          >
            Manage billing &amp; invoices
          </button>
        )}
      </div>

      {error && (
        <div
          className="mb-4 p-3 text-sm rounded"
          style={{
            background: 'rgba(239, 68, 68, 0.1)',
            color: '#EF4444',
            border: '1px solid rgba(239, 68, 68, 0.2)',
          }}
        >
          {error}
        </div>
      )}

      {/* Plan Comparison */}
      <SectionHeader label="Plans" />
      <div className="grid grid-cols-3 gap-4">
        {PLANS.map((plan) => {
          const isCurrent = currentTier === plan.id;
          const isUpgrade =
            (plan.id === 'pro' && currentTier === 'free') ||
            (plan.id === 'ultra' && (currentTier === 'free' || currentTier === 'pro'));

          return (
            <div
              key={plan.id}
              className="p-5 rounded-sm flex flex-col"
              style={{
                background: '#0D1221',
                border: isCurrent ? '1px solid rgba(124, 58, 237, 0.5)' : '1px solid #1A2440',
                boxShadow: isCurrent ? '0 0 20px rgba(124, 58, 237, 0.1)' : undefined,
              }}
            >
              <div className="mb-4">
                <div
                  className="text-xs font-bold uppercase tracking-wider mb-1"
                  style={{ color: isCurrent ? '#A78BFA' : '#7A8BAD' }}
                >
                  {plan.name}
                  {isCurrent && (
                    <span
                      className="ml-2 text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(124, 58, 237, 0.2)', color: '#A78BFA' }}
                    >
                      CURRENT
                    </span>
                  )}
                </div>
                <div className="flex items-baseline">
                  <span className="text-xl font-bold" style={{ color: '#E8EFFF' }}>
                    {plan.price}
                  </span>
                  {plan.period && (
                    <span className="text-xs ml-1" style={{ color: '#3D4F6E' }}>
                      {plan.period}
                    </span>
                  )}
                </div>
              </div>

              <ul className="flex-1 space-y-2 mb-4">
                {plan.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2 text-xs"
                    style={{ color: '#7A8BAD' }}
                  >
                    <span style={{ color: '#22C55E', flexShrink: 0 }}>+</span>
                    {f}
                  </li>
                ))}
                {plan.limits.map((l) => (
                  <li
                    key={l}
                    className="flex items-start gap-2 text-xs"
                    style={{ color: '#3D4F6E' }}
                  >
                    <span style={{ color: '#3D4F6E', flexShrink: 0 }}>-</span>
                    {l}
                  </li>
                ))}
              </ul>

              {isUpgrade && (
                <button
                  onClick={() => handleUpgrade(plan.id)}
                  disabled={loading}
                  className="w-full py-2 rounded text-xs font-semibold uppercase tracking-wider transition-all"
                  style={{
                    background:
                      plan.id === 'ultra'
                        ? 'linear-gradient(135deg, #00D4FF, #0099CC)'
                        : 'linear-gradient(135deg, #7C3AED, #6D28D9)',
                    color: '#fff',
                    border: 'none',
                    cursor: loading ? 'wait' : 'pointer',
                  }}
                >
                  Upgrade to {plan.name}
                </button>
              )}

              {isCurrent && plan.id !== 'free' && (
                <button
                  onClick={handleManageSubscription}
                  disabled={loading}
                  className="w-full py-2 rounded text-xs font-semibold uppercase tracking-wider"
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(124, 58, 237, 0.3)',
                    color: '#A78BFA',
                    cursor: loading ? 'wait' : 'pointer',
                  }}
                >
                  Manage
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
