import { Footer } from '@/components/Footer';
import { Navbar } from '@/components/Navbar';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — Scrima',
  description: 'Terms and conditions for using Scrima.',
};

export default function TermsPage() {
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
            Terms of Service
          </h1>
          <p className="text-xs text-scrima-muted mb-10 font-mono">Last updated: March 22, 2026</p>

          <div className="space-y-8 text-sm text-scrima-muted leading-relaxed">
            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                1. Acceptance of Terms
              </h2>
              <p>
                By downloading, installing, or using Scrima (&quot;the Service&quot;), you agree to
                these Terms of Service. If you do not agree, do not use the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                2. Description of Service
              </h2>
              <p>
                Scrima is an AI-powered gaming coach that analyzes your Valorant gameplay to provide
                personalized coaching insights. The Service includes a desktop application and web
                dashboard.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                3. Acceptable Use
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>Scrima is intended for personal gaming improvement only.</li>
                <li>
                  You must not use the Service to gain unfair competitive advantages that violate
                  game Terms of Service.
                </li>
                <li>You must not reverse engineer, decompile, or modify the application.</li>
                <li>You must not share your account credentials with others.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                4. Subscriptions &amp; Billing
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>Free accounts have usage limits as described on the pricing page.</li>
                <li>Paid subscriptions (Pro, Ultra) are billed monthly via Stripe.</li>
                <li>
                  You may cancel your subscription at any time. Access continues until the end of
                  the billing period.
                </li>
                <li>
                  Refunds are handled on a case-by-case basis. Contact support within 7 days of
                  purchase.
                </li>
                <li>Credits (Tier 3 analyses) do not roll over between billing periods.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                5. Intellectual Property
              </h2>
              <p>
                Scrima and its original content, features, and functionality are owned by Scrima and
                are protected by copyright and trademark laws.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                6. Disclaimer
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  Scrima is not affiliated with, endorsed by, or connected to Riot Games or
                  Valorant.
                </li>
                <li>
                  AI coaching insights are advisory. We do not guarantee rank improvement or
                  specific results.
                </li>
                <li>The Service is provided &quot;as is&quot; without warranties of any kind.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                7. Limitation of Liability
              </h2>
              <p>
                To the maximum extent permitted by law, Scrima shall not be liable for any indirect,
                incidental, special, or consequential damages arising from your use of the Service,
                including but not limited to loss of data, game rank, or revenue.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                8. Account Termination
              </h2>
              <p>
                We reserve the right to suspend or terminate accounts that violate these terms. You
                may delete your account at any time through the dashboard.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                9. Changes to Terms
              </h2>
              <p>
                We may update these terms from time to time. Continued use of the Service after
                changes constitutes acceptance of the updated terms.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-bold text-scrima-text uppercase tracking-wide mb-3">
                10. Contact
              </h2>
              <p>
                Questions about these terms? Email{' '}
                <a href="mailto:support@scrima.gg" className="text-scrima-purple hover:underline">
                  support@scrima.gg
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
