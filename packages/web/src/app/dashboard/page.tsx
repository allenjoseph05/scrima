import { Footer } from '@/components/Footer';
import { Navbar } from '@/components/Navbar';
import { currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  tier: string;
  tier2DailyLimit: number;
  tier2DailyUsed: number;
  tier3MonthlyLimit: number;
  tier3MonthlyUsed: number;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
}

function ProgressBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-scrima-muted">{label}</span>
        <span className="text-scrima-text font-mono">
          {used}/{limit}
        </span>
      </div>
      <div className="h-2 rounded-full" style={{ background: '#1A2338' }}>
        <div
          className="h-2 rounded-full transition-all"
          style={{ width: `${pct}%`, background: pct >= 90 ? '#EF4444' : '#7C3AED' }}
        />
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect('/sign-in');

  // Get Clerk session token to call our API
  // In production, use auth().getToken() or pass the session through server action
  // Will be populated once API is live and Clerk token forwarding is set up
  const profile = null as UserProfile | null;

  const displayName = user.firstName || user.emailAddresses[0]?.emailAddress || 'User';
  const tier = profile?.tier || 'free';
  const tierLabel = tier === 'ultra' ? 'Ultra' : tier === 'pro' ? 'Pro' : 'Free';

  return (
    <>
      <Navbar />
      <main className="pt-24 pb-24 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Welcome */}
          <div className="mb-10">
            <p
              className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-2"
              style={{ color: '#7C3AED' }}
            >
              DASHBOARD
            </p>
            <h1 className="text-3xl font-black uppercase tracking-tight text-scrima-text">
              Welcome, {displayName}
            </h1>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Plan overview */}
            <div
              className="p-6 clip-corner"
              style={{ background: '#0D1221', border: '1px solid #1A2338' }}
            >
              <h2 className="text-sm font-bold uppercase tracking-wider text-scrima-text mb-4">
                Current Plan
              </h2>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="px-3 py-1 text-xs font-mono font-bold uppercase tracking-wider"
                  style={{
                    background: tier === 'free' ? '#1A2338' : '#7C3AED22',
                    color: tier === 'free' ? '#7A8BAD' : '#7C3AED',
                    border: tier === 'free' ? '1px solid #2A3548' : '1px solid #7C3AED44',
                  }}
                >
                  {tierLabel}
                </span>
                {profile?.currentPeriodEnd && (
                  <span className="text-xs text-scrima-muted">
                    Renews {new Date(profile.currentPeriodEnd).toLocaleDateString()}
                  </span>
                )}
              </div>

              <div className="space-y-4">
                <ProgressBar
                  used={profile?.tier2DailyUsed ?? 0}
                  limit={profile?.tier2DailyLimit ?? 5}
                  label="Tier 2 (today)"
                />
                <ProgressBar
                  used={profile?.tier3MonthlyUsed ?? 0}
                  limit={profile?.tier3MonthlyLimit ?? 0}
                  label="Tier 3 (this month)"
                />
              </div>

              {tier === 'free' && (
                <Link
                  href="/pricing"
                  className="block mt-6 text-center py-3 text-sm font-bold uppercase tracking-wider bg-scrima-purple text-white clip-corner-sm hover:brightness-110 transition-all"
                >
                  Upgrade to Pro
                </Link>
              )}
            </div>

            {/* Quick actions */}
            <div
              className="p-6 clip-corner"
              style={{ background: '#0D1221', border: '1px solid #1A2338' }}
            >
              <h2 className="text-sm font-bold uppercase tracking-wider text-scrima-text mb-4">
                Quick Actions
              </h2>
              <div className="space-y-3">
                <Link
                  href="/download"
                  className="flex items-center gap-3 p-3 text-sm text-scrima-muted hover:text-scrima-text transition-colors"
                  style={{ background: '#0A0F1A', border: '1px solid #1A2338' }}
                >
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 2v14m0 0l-5-5m5 5l5-5M5 20h14"
                      stroke="#7C3AED"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Download Desktop App
                </Link>

                <Link
                  href="/pricing"
                  className="flex items-center gap-3 p-3 text-sm text-scrima-muted hover:text-scrima-text transition-colors"
                  style={{ background: '#0A0F1A', border: '1px solid #1A2338' }}
                >
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3v18h18" stroke="#00D4FF" strokeWidth="1.5" strokeLinecap="round" />
                    <path
                      d="M7 16l4-6 4 4 5-8"
                      stroke="#00D4FF"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  View Plans &amp; Pricing
                </Link>

                <a
                  href="mailto:support@scrima.gg"
                  className="flex items-center gap-3 p-3 text-sm text-scrima-muted hover:text-scrima-text transition-colors"
                  style={{ background: '#0A0F1A', border: '1px solid #1A2338' }}
                >
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <rect
                      x="3"
                      y="5"
                      width="18"
                      height="14"
                      rx="2"
                      stroke="#7A8BAD"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M3 7l9 6 9-6"
                      stroke="#7A8BAD"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                  Contact Support
                </a>
              </div>
            </div>
          </div>

          {/* Placeholder for future usage history */}
          <div
            className="mt-8 p-6 clip-corner text-center"
            style={{ background: '#0D1221', border: '1px solid #1A2338' }}
          >
            <p className="text-sm text-scrima-muted">
              Your match history and coaching insights will appear here once you start playing with
              Scrima installed.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
