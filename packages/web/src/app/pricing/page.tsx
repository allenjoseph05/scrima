import { Footer } from '@/components/Footer';
import { Navbar } from '@/components/Navbar';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Pricing — Scrima',
  description: 'Choose the Scrima plan that fits your competitive goals. Free tier available.',
};

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    description: 'Start improving right away',
    cta: 'Get Started Free',
    ctaHref: '/download',
    highlight: false,
    features: [
      { text: 'Death detection', included: true },
      { text: 'AI death classification', included: true, note: '5/day' },
      { text: 'Match history', included: true },
      { text: 'Deep game analysis', included: false },
      { text: 'Weekly coaching reports', included: false },
      { text: 'Priority support', included: false },
    ],
  },
  {
    name: 'Pro',
    price: '$12',
    period: '/month',
    description: 'For players serious about ranking up',
    cta: 'Upgrade to Pro',
    ctaHref: '/sign-up',
    highlight: true,
    features: [
      { text: 'Death detection', included: true },
      { text: 'AI death classification', included: true, note: 'Unlimited' },
      { text: 'Match history', included: true },
      { text: 'Deep game analysis', included: true, note: '4/month' },
      { text: 'Weekly coaching reports', included: true },
      { text: 'Priority support', included: false },
    ],
  },
  {
    name: 'Ultra',
    price: '$30',
    period: '/month',
    description: 'Maximum coaching power',
    cta: 'Upgrade to Ultra',
    ctaHref: '/sign-up',
    highlight: false,
    features: [
      { text: 'Death detection', included: true },
      { text: 'AI death classification', included: true, note: 'Unlimited' },
      { text: 'Match history', included: true },
      { text: 'Deep game analysis', included: true, note: '15/month' },
      { text: 'Weekly coaching reports', included: true },
      { text: 'Priority support', included: true },
    ],
  },
];

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="flex-shrink-0"
    >
      <path
        d="M5 13l4 4L19 7"
        stroke="#7C3AED"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="flex-shrink-0"
    >
      <path d="M18 6L6 18M6 6l12 12" stroke="#3D4F6E" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function PricingPage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p
              className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-3"
              style={{ color: '#7C3AED' }}
            >
              PRICING
            </p>
            <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tight text-scrima-text mb-4">
              Choose Your Plan
            </h1>
            <p className="text-lg text-scrima-muted max-w-xl mx-auto">
              Start free. Upgrade when you&apos;re ready for deeper coaching.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className="relative p-8 clip-corner flex flex-col"
                style={{
                  background: '#0D1221',
                  border: plan.highlight ? '1px solid #7C3AED' : '1px solid #1A2338',
                  boxShadow: plan.highlight ? '0 0 40px #7C3AED22' : 'none',
                }}
              >
                {plan.highlight && (
                  <div
                    className="absolute -top-px left-1/2 -translate-x-1/2 px-4 py-1 text-[10px] font-mono font-bold uppercase tracking-widest"
                    style={{ background: '#7C3AED', color: '#fff' }}
                  >
                    Most Popular
                  </div>
                )}

                <h3 className="text-lg font-bold uppercase tracking-wider text-scrima-text mt-2">
                  {plan.name}
                </h3>
                <div className="flex items-baseline gap-1 mt-3 mb-1">
                  <span className="text-4xl font-black text-scrima-text">{plan.price}</span>
                  <span className="text-sm text-scrima-muted">{plan.period}</span>
                </div>
                <p className="text-sm text-scrima-muted mb-6">{plan.description}</p>

                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map((feature) => (
                    <li key={feature.text} className="flex items-start gap-3">
                      {feature.included ? <CheckIcon /> : <XIcon />}
                      <span
                        className={`text-sm ${feature.included ? 'text-scrima-text' : 'text-scrima-muted/50'}`}
                      >
                        {feature.text}
                        {feature.note && (
                          <span className="ml-1 text-xs text-scrima-muted">({feature.note})</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>

                <Link
                  href={plan.ctaHref}
                  className={`block text-center py-3 text-sm font-bold uppercase tracking-wider clip-corner-sm transition-all ${
                    plan.highlight
                      ? 'bg-scrima-purple text-white hover:brightness-110'
                      : 'border border-scrima-border text-scrima-muted hover:border-scrima-purple/50 hover:text-scrima-text'
                  }`}
                >
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>

          <p className="text-center text-xs text-scrima-muted/60 mt-8 font-mono">
            All plans include automatic death detection and match recording. Cancel anytime.
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
