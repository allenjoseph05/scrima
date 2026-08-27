import Link from 'next/link';

export function Navbar() {
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 border-b border-scrima-border/50 backdrop-blur-md"
      style={{ background: 'rgba(5, 8, 16, 0.85)' }}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <img
            src="/scrima-logo.png"
            alt="Scrima"
            className="w-10 h-10"
            style={{ filter: 'drop-shadow(0 0 8px rgba(124, 58, 237, 0.4))' }}
          />
          <span className="text-scrima-text font-black text-lg tracking-[0.2em] uppercase">
            Scrima
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-8 text-sm font-medium">
          <Link
            href="/#features"
            className="text-scrima-muted hover:text-scrima-text transition-colors"
          >
            Features
          </Link>
          <Link
            href="/pricing"
            className="text-scrima-muted hover:text-scrima-text transition-colors"
          >
            Pricing
          </Link>
          <Link
            href="/download"
            className="px-5 py-2 bg-scrima-purple text-white font-bold text-xs uppercase tracking-wider clip-corner-sm hover:brightness-110 transition-all"
          >
            Download
          </Link>
        </div>
      </div>
    </nav>
  );
}
