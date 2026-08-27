import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-scrima-border/50 py-12 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8 mb-12">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <img
                src="/scrima-logo.png"
                alt="Scrima"
                className="w-8 h-8"
                style={{ filter: 'drop-shadow(0 0 6px rgba(124, 58, 237, 0.3))' }}
              />
              <span className="text-scrima-text font-black tracking-[0.2em] uppercase text-sm">
                Scrima
              </span>
            </div>
            <p className="text-xs text-scrima-muted leading-relaxed">
              AI-powered coaching for competitive gamers.
            </p>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-scrima-text mb-4">
              Product
            </h4>
            <ul className="space-y-2 text-sm text-scrima-muted">
              <li>
                <Link href="/#features" className="hover:text-scrima-text transition-colors">
                  Features
                </Link>
              </li>
              <li>
                <Link href="/pricing" className="hover:text-scrima-text transition-colors">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/download" className="hover:text-scrima-text transition-colors">
                  Download
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-scrima-text mb-4">
              Legal
            </h4>
            <ul className="space-y-2 text-sm text-scrima-muted">
              <li>
                <Link href="/privacy" className="hover:text-scrima-text transition-colors">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="hover:text-scrima-text transition-colors">
                  Terms of Service
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-scrima-text mb-4">
              Support
            </h4>
            <ul className="space-y-2 text-sm text-scrima-muted">
              <li>
                <a
                  href="mailto:support@scrima.gg"
                  className="hover:text-scrima-text transition-colors"
                >
                  Contact
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-scrima-border/30 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-scrima-muted/60">
            &copy; 2026 Scrima. Not affiliated with Riot Games.
          </p>
          <p className="text-xs text-scrima-muted/40 font-mono">v0.1.0</p>
        </div>
      </div>
    </footer>
  );
}
