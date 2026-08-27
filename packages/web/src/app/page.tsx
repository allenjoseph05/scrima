import { Footer } from '@/components/Footer';
import { Navbar } from '@/components/Navbar';
import Link from 'next/link';

function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden">
      {/* Background grid */}
      <div className="absolute inset-0 bg-grid opacity-40" />

      {/* Gradient orbs */}
      <div
        className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #7C3AED 0%, transparent 70%)' }}
      />
      <div
        className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full opacity-15 blur-3xl"
        style={{ background: 'radial-gradient(circle, #00D4FF 0%, transparent 70%)' }}
      />

      <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
        <p
          className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-4"
          style={{ color: '#7C3AED' }}
        >
          AI GAMING COACH
        </p>

        <h1 className="text-5xl md:text-7xl font-black uppercase tracking-tight leading-[0.95] mb-6">
          <span className="text-scrima-text">Die Less.</span>
          <br />
          <span style={{ color: '#7C3AED' }}>Rank Up.</span>
        </h1>

        <p className="text-lg md:text-xl text-scrima-muted max-w-2xl mx-auto mb-10 leading-relaxed">
          Scrima watches your Valorant matches, analyzes every death with AI, and gives you{' '}
          <strong className="text-scrima-text">personalized coaching</strong> to fix the mistakes
          holding you back.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/download"
            className="px-8 py-4 bg-scrima-purple text-white font-black text-sm uppercase tracking-widest clip-corner glow-purple hover:brightness-110 transition-all"
          >
            Download Free
          </Link>
          <a
            href="#how-it-works"
            className="px-8 py-4 border border-scrima-border text-scrima-muted font-bold text-sm uppercase tracking-widest clip-corner hover:border-scrima-purple/50 hover:text-scrima-text transition-all"
          >
            See How It Works
          </a>
        </div>

        <p className="text-xs text-scrima-muted/60 mt-6 font-mono">
          Windows 10/11 &middot; Free tier available &middot; No credit card required
        </p>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 5v14m0 0l-5-5m5 5l5-5"
            stroke="#7A8BAD"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </section>
  );
}

const features = [
  {
    icon: (
      <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" stroke="#7C3AED" strokeWidth="1.5" />
        <path
          d="M2 12h4m12 0h4M12 2v4m0 12v4"
          stroke="#7C3AED"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
    title: 'Automatic Death Detection',
    description:
      'Scrima silently monitors your gameplay and detects every death in real-time using pixel analysis — no manual clipping needed.',
  },
  {
    icon: (
      <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2L2 7l10 5 10-5-10-5z"
          stroke="#00D4FF"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M2 17l10 5 10-5M2 12l10 5 10-5"
          stroke="#00D4FF"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    ),
    title: 'AI Death Classification',
    description:
      'Each death clip is sent to advanced AI that classifies why you died — bad positioning, aim duel loss, utility failure, rotation error, and more.',
  },
  {
    icon: (
      <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <path
          d="M3 3v18h18"
          stroke="#7C3AED"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7 16l4-6 4 4 5-8"
          stroke="#00D4FF"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    title: 'Weekly Progress Reports',
    description:
      'Get a weekly coaching report that tracks your improvement, identifies recurring patterns, and gives you specific drills to practice.',
  },
  {
    icon: (
      <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="3" stroke="#00D4FF" strokeWidth="1.5" />
        <path
          d="M9 12l2 2 4-4"
          stroke="#00D4FF"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    title: 'Zero Effort Required',
    description:
      'Install once. Scrima runs silently in the background — it starts when you play Valorant and stops when you close it. Nothing to remember.',
  },
];

function Features() {
  return (
    <section id="features" className="relative py-32 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <p
            className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-3"
            style={{ color: '#7C3AED' }}
          >
            FEATURES
          </p>
          <h2 className="text-3xl md:text-4xl font-black uppercase tracking-tight text-scrima-text">
            Your Personal AI Coach
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="p-8 clip-corner transition-all hover:border-scrima-purple/40"
              style={{
                background: '#0D1221',
                border: '1px solid #1A2338',
              }}
            >
              <div
                className="w-12 h-12 flex items-center justify-center mb-5"
                style={{ background: '#7C3AED0D', border: '1px solid #7C3AED33' }}
              >
                {feature.icon}
              </div>
              <h3 className="text-lg font-bold uppercase tracking-wide text-scrima-text mb-3">
                {feature.title}
              </h3>
              <p className="text-sm text-scrima-muted leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const steps = [
  {
    number: '01',
    title: 'Install Scrima',
    description: 'Download the free Windows app. One-click install, no config needed.',
  },
  {
    number: '02',
    title: 'Play Valorant',
    description:
      "Just play normally. Scrima auto-detects when you're in a match and records your gameplay.",
  },
  {
    number: '03',
    title: 'Get AI Coaching',
    description:
      'After each match, Scrima analyzes your deaths and delivers personalized coaching insights.',
  },
];

function HowItWorks() {
  return (
    <section id="how-it-works" className="relative py-32 px-6">
      <div className="absolute inset-0 bg-grid opacity-20" />

      <div className="relative max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <p
            className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-3"
            style={{ color: '#00D4FF' }}
          >
            HOW IT WORKS
          </p>
          <h2 className="text-3xl md:text-4xl font-black uppercase tracking-tight text-scrima-text">
            Three Steps to Better Gameplay
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {steps.map((step, i) => (
            <div key={step.number} className="relative text-center">
              {/* Connector line */}
              {i < steps.length - 1 && (
                <div
                  className="hidden md:block absolute top-8 left-[60%] w-[80%] h-px"
                  style={{ background: 'linear-gradient(90deg, #7C3AED44, transparent)' }}
                />
              )}

              <div className="text-5xl font-black mb-4" style={{ color: '#7C3AED22' }}>
                {step.number}
              </div>
              <h3 className="text-lg font-bold uppercase tracking-wide text-scrima-text mb-3">
                {step.title}
              </h3>
              <p className="text-sm text-scrima-muted leading-relaxed">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="relative py-32 px-6">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl md:text-5xl font-black uppercase tracking-tight text-scrima-text mb-6">
          Ready to <span style={{ color: '#7C3AED' }}>Rank Up</span>?
        </h2>
        <p className="text-lg text-scrima-muted mb-10 max-w-xl mx-auto">
          Stop guessing why you lost. Let AI show you exactly what to fix.
        </p>
        <Link
          href="/download"
          className="inline-block px-10 py-4 bg-scrima-purple text-white font-black text-sm uppercase tracking-widest clip-corner glow-purple hover:brightness-110 transition-all"
        >
          Download Scrima — It&apos;s Free
        </Link>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
