import { Footer } from '@/components/Footer';
import { Navbar } from '@/components/Navbar';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Download Scrima — Free AI Valorant Coach',
  description: 'Download Scrima for Windows. One-click install, no configuration needed.',
};

export default function DownloadPage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-24 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <p
              className="text-xs font-mono font-bold tracking-[0.4em] uppercase mb-3"
              style={{ color: '#7C3AED' }}
            >
              DOWNLOAD
            </p>
            <h1 className="text-4xl md:text-5xl font-black uppercase tracking-tight text-scrima-text mb-4">
              Get Scrima
            </h1>
            <p className="text-lg text-scrima-muted">
              Install in under a minute. Start getting coached today.
            </p>
          </div>

          {/* Download card */}
          <div
            className="p-10 clip-corner text-center mb-10"
            style={{
              background: '#0D1221',
              border: '1px solid #7C3AED',
              boxShadow: '0 0 60px #7C3AED22',
            }}
          >
            <div className="w-16 h-16 rounded bg-scrima-purple/10 border border-scrima-purple/30 flex items-center justify-center mx-auto mb-6">
              <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="3"
                  width="18"
                  height="18"
                  rx="2"
                  stroke="#7C3AED"
                  strokeWidth="1.5"
                />
                <path d="M7 7h4v4H7zM13 7h4v4h-4zM7 13h4v4H7z" fill="#7C3AED" opacity="0.6" />
                <path d="M13 13h4v4h-4z" fill="#7C3AED" />
              </svg>
            </div>

            <h2 className="text-2xl font-black uppercase tracking-wide text-scrima-text mb-2">
              Scrima for Windows
            </h2>
            <p className="text-sm text-scrima-muted mb-6">
              Version 0.1.0 &middot; Windows 10/11 &middot; ~80 MB
            </p>

            <a
              href="https://github.com/scrima-gg/scrima/releases/latest"
              className="inline-block px-10 py-4 bg-scrima-purple text-white font-black text-sm uppercase tracking-widest clip-corner glow-purple hover:brightness-110 transition-all mb-4"
            >
              Download Installer (.exe)
            </a>

            <p className="text-xs text-scrima-muted/50 font-mono">
              You may see a SmartScreen warning — click &quot;More info&quot; &rarr; &quot;Run
              anyway&quot;
            </p>
          </div>

          {/* Installation steps */}
          <div className="mb-12">
            <h3 className="text-lg font-bold uppercase tracking-wide text-scrima-text mb-6 text-center">
              Installation
            </h3>
            <div className="grid md:grid-cols-3 gap-6">
              {[
                {
                  step: '1',
                  title: 'Download',
                  desc: 'Click the download button above to get the installer.',
                },
                {
                  step: '2',
                  title: 'Install',
                  desc: 'Run the .exe file. Scrima installs to your user folder — no admin required.',
                },
                {
                  step: '3',
                  title: 'Launch',
                  desc: 'Open Scrima from the Start Menu. Sign in and start playing.',
                },
              ].map((item) => (
                <div key={item.step} className="text-center">
                  <div className="text-3xl font-black mb-2" style={{ color: '#7C3AED33' }}>
                    {item.step}
                  </div>
                  <h4 className="text-sm font-bold uppercase tracking-wider text-scrima-text mb-2">
                    {item.title}
                  </h4>
                  <p className="text-xs text-scrima-muted leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* System requirements */}
          <div
            className="p-6 clip-corner-sm"
            style={{ background: '#0D1221', border: '1px solid #1A2338' }}
          >
            <h3 className="text-sm font-bold uppercase tracking-wider text-scrima-text mb-4">
              System Requirements
            </h3>
            <ul className="grid grid-cols-2 gap-3 text-sm text-scrima-muted">
              <li>
                <span className="text-scrima-text font-medium">OS:</span> Windows 10 or 11
              </li>
              <li>
                <span className="text-scrima-text font-medium">RAM:</span> 4 GB minimum
              </li>
              <li>
                <span className="text-scrima-text font-medium">Disk:</span> 500 MB free space
              </li>
              <li>
                <span className="text-scrima-text font-medium">Network:</span> Internet for AI
                features
              </li>
            </ul>
          </div>

          {/* Other platforms */}
          <div className="mt-8 text-center">
            <p className="text-sm text-scrima-muted">
              Mac and Linux support coming soon.{' '}
              <Link href="mailto:support@scrima.gg" className="text-scrima-purple hover:underline">
                Get notified
              </Link>
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
