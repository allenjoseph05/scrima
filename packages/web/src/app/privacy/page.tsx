import { Footer } from '@/components/Footer';
import { Navbar } from '@/components/Navbar';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — Scrima',
  description: 'How Scrima collects, uses, and protects your data.',
};

export default function PrivacyPage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-24 px-6">
        <article className="max-w-3xl mx-auto prose-sm">
          <p
            className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-3"
            style={{ color: '#7C3AED' }}
          >
            LEGAL
          </p>
          <h1 className="text-3xl font-black uppercase tracking-tight text-scrima-text mb-2">
            Privacy Policy
          </h1>
          <p className="text-xs text-scrima-muted mb-10 font-mono">Last updated: March 22, 2026</p>

          <div className="space-y-8 text-sm text-scrima-muted leading-relaxed">
            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                1. What We Collect
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-scrima-text">Account information:</strong> email address,
                  display name (via Clerk authentication).
                </li>
                <li>
                  <strong className="text-scrima-text">Gameplay clips:</strong> short video clips
                  (~10 seconds) extracted around in-game death events. These are used solely for AI
                  analysis.
                </li>
                <li>
                  <strong className="text-scrima-text">Game events:</strong> detected events such as
                  deaths, kills, and match metadata (map, agent, duration, score).
                </li>
                <li>
                  <strong className="text-scrima-text">Usage data:</strong> feature usage, error
                  logs, and app version for improving the product.
                </li>
                <li>
                  <strong className="text-scrima-text">Payment information:</strong> processed by
                  Stripe. We never see or store your credit card details.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                2. How We Use Your Data
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  Gameplay clips are sent to Google Gemini API for AI-powered death classification
                  and coaching analysis.
                </li>
                <li>
                  Match events and classifications are stored to generate coaching reports and track
                  improvement over time.
                </li>
                <li>
                  Email is used for account authentication, subscription management, and important
                  product updates.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                3. Data Retention
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-scrima-text">Video clips:</strong> deleted from cloud
                  storage within 1 hour of processing. Local recordings are managed by you.
                </li>
                <li>
                  <strong className="text-scrima-text">Match data &amp; classifications:</strong>{' '}
                  retained until you delete your account.
                </li>
                <li>
                  <strong className="text-scrima-text">Account data:</strong> deleted within 30 days
                  of account deletion request.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                4. Third-Party Services
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-scrima-text">Clerk</strong> — authentication and account
                  management.
                </li>
                <li>
                  <strong className="text-scrima-text">Stripe</strong> — payment processing and
                  subscription billing.
                </li>
                <li>
                  <strong className="text-scrima-text">Google Gemini</strong> — AI analysis of
                  gameplay clips.
                </li>
                <li>
                  <strong className="text-scrima-text">Neon</strong> — PostgreSQL database hosting.
                </li>
                <li>
                  <strong className="text-scrima-text">Upstash</strong> — Redis caching layer.
                </li>
                <li>
                  <strong className="text-scrima-text">Fly.io</strong> — server infrastructure
                  hosting.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                5. Your Rights
              </h2>
              <p>You have the right to:</p>
              <ul className="list-disc pl-5 space-y-2 mt-2">
                <li>
                  <strong className="text-scrima-text">Access</strong> your personal data.
                </li>
                <li>
                  <strong className="text-scrima-text">Delete</strong> your account and all
                  associated data.
                </li>
                <li>
                  <strong className="text-scrima-text">Export</strong> your match history and
                  coaching data.
                </li>
                <li>
                  <strong className="text-scrima-text">Opt out</strong> of non-essential data
                  collection.
                </li>
              </ul>
              <p className="mt-3">
                To exercise these rights, use the &quot;Delete Account&quot; option in your
                dashboard or contact us at{' '}
                <a href="mailto:privacy@scrima.gg" className="text-scrima-purple hover:underline">
                  privacy@scrima.gg
                </a>
                .
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                6. Contact
              </h2>
              <p>
                For privacy-related questions or requests, email us at{' '}
                <a href="mailto:privacy@scrima.gg" className="text-scrima-purple hover:underline">
                  privacy@scrima.gg
                </a>
                .
              </p>
            </section>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
