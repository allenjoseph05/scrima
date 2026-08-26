// GAMING REDESIGN
import { useEffect, useState } from 'react';
import { useAnalysisStore } from '../../stores/analysisStore';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TREND_CONFIG: Record<string, { label: string; text: string; border: string; bg: string }> = {
  improving: { label: 'IMPROVING', text: '#00FF85', border: '#00FF8544', bg: '#00FF850D' },
  declining: { label: 'DECLINING', text: '#FF2D55', border: '#FF2D5544', bg: '#FF2D550D' },
  stable: { label: 'STABLE', text: '#F59E0B', border: '#F59E0B44', bg: '#F59E0B0D' },
};

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({
  title,
  accentColor = '#7C3AED',
  children,
}: {
  title: string;
  accentColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="p-5"
      style={{
        background: '#0D1221',
        borderLeft: `3px solid ${accentColor}`,
        borderTop: '1px solid #1A2440',
        borderRight: '1px solid #1A2440',
        borderBottom: '1px solid #1A2440',
        boxShadow: `inset 2px 0 12px ${accentColor}10`,
      }}
    >
      <h3
        className="text-[10px] font-black tracking-[0.2em] uppercase mb-3"
        style={{ color: '#3D4F6E' }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function BulletList({ items, color = '#00D4FF' }: { items: string[]; color?: string }) {
  if (!items?.length) {
    return (
      <p className="text-xs font-mono" style={{ color: '#3D4F6E' }}>
        NONE IDENTIFIED.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm" style={{ color: '#E8EFFF' }}>
          <span style={{ color, flexShrink: 0 }}>—</span>
          {item}
        </li>
      ))}
    </ul>
  );
}

function CategoryInsights({ insights }: { insights: Record<string, string | null> }) {
  const entries = Object.entries(insights).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <div className="space-y-3">
      {entries.map(([cat, text]) => (
        <div key={cat} className="flex gap-3">
          <span
            className="text-[10px] font-bold tracking-widest uppercase w-20 flex-shrink-0 mt-0.5"
            style={{ color: '#7C3AED' }}
          >
            {cat}
          </span>
          <span className="text-sm" style={{ color: '#E8EFFF' }}>
            {text}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function TrendView() {
  const trendReport = useAnalysisStore((s) => s.trendReport);
  const trendProgress = useAnalysisStore((s) => s.trendProgress);
  const runTrend = useAnalysisStore((s) => s.runTrendAnalysis);
  const loadTrend = useAnalysisStore((s) => s.loadTrendReport);
  const [nMatches, setNMatches] = useState(10);

  useEffect(() => {
    loadTrend();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isRunning = trendProgress.stage === 'analysing';

  let parsed: Record<string, unknown> = {};
  if (trendReport) {
    try {
      parsed = JSON.parse(trendReport.reportJson);
    } catch {
      /* raw */
    }
  }

  const assessment = parsed.overall_assessment as string | undefined;
  const weakness = parsed.top_weakness as string | undefined;
  const improving = parsed.improving_areas as string[] | undefined;
  const strengths = parsed.consistent_strengths as string[] | undefined;
  const weekly = parsed.weekly_focus as { drill?: string; goal?: string } | undefined;
  const catInsights = parsed.category_insights as Record<string, string | null> | undefined;
  const trend = parsed.trend as string | undefined;
  const badge = trend ? (TREND_CONFIG[trend] ?? null) : null;

  return (
    <div className="p-6 max-w-3xl mx-auto" style={{ color: '#E8EFFF' }}>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1
            className="text-2xl font-black tracking-[0.15em] uppercase"
            style={{ color: '#E8EFFF' }}
          >
            TREND ANALYSIS
          </h1>
          <p className="text-xs font-mono tracking-widest mt-1" style={{ color: '#7A8BAD' }}>
            CROSS-MATCH PATTERNS FROM YOUR LAST SESSIONS
          </p>
        </div>

        {/* Run controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <select
            value={nMatches}
            onChange={(e) => setNMatches(Number(e.target.value))}
            disabled={isRunning}
            className="text-xs font-mono focus:outline-none disabled:opacity-50"
            style={{
              background: '#0D1221',
              border: '1px solid #1A2440',
              color: '#E8EFFF',
              padding: '0.35rem 0.5rem',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            {[5, 10, 20, 30].map((n) => (
              <option key={n} value={n} style={{ background: '#0D1221' }}>
                LAST {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => runTrend(nMatches)}
            disabled={isRunning}
            className="btn-primary"
            style={{ padding: '0.35rem 1rem', fontSize: '0.65rem' }}
          >
            {isRunning ? 'ANALYSING…' : 'RUN ANALYSIS'}
          </button>
        </div>
      </div>

      {/* Progress */}
      {isRunning && (
        <div
          className="mb-6 p-4 flex items-center gap-3"
          style={{ background: '#0D1221', border: '1px solid #1A2440' }}
        >
          <div
            className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin flex-shrink-0"
            style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
          />
          <span className="text-sm font-mono" style={{ color: '#00D4FF' }}>
            ANALYSING {trendProgress.deaths ?? '…'} DEATHS ACROSS {nMatches} MATCHES
          </span>
        </div>
      )}

      {/* Error */}
      {trendProgress.stage === 'error' && (
        <div
          className="mb-6 p-4"
          style={{ background: '#FF2D550D', border: '1px solid #FF2D5544' }}
        >
          <p className="text-sm font-mono" style={{ color: '#FF2D55' }}>
            ANALYSIS FAILED. CHECK YOUR API KEY IN SETTINGS.
          </p>
        </div>
      )}

      {/* No data yet */}
      {!trendReport && !isRunning && trendProgress.stage !== 'error' && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p
            className="text-lg font-black tracking-[0.15em] uppercase mb-2"
            style={{ color: '#E8EFFF' }}
          >
            NO TREND REPORT
          </p>
          <p className="text-sm font-mono" style={{ color: '#3D4F6E' }}>
            Run an analysis after recording several matches.
          </p>
        </div>
      )}

      {/* Report */}
      {trendReport && (
        <div className="space-y-4">
          {/* Meta row + trend badge */}
          <div className="flex items-center gap-3 mb-2">
            <span className="text-xs font-mono" style={{ color: '#3D4F6E' }}>
              {trendReport.matchesAnalyzed} MATCHES · {formatDate(trendReport.generatedAt)}
            </span>
            {badge && (
              <span
                className="text-xs font-mono font-black tracking-widest uppercase px-3 py-1"
                style={{
                  color: badge.text,
                  border: `1px solid ${badge.border}`,
                  background: badge.bg,
                  boxShadow: `0 0 8px ${badge.border}`,
                }}
              >
                {badge.label}
              </span>
            )}
          </div>

          {assessment && (
            <Section title="OVERALL ASSESSMENT" accentColor="#00D4FF">
              <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
                {assessment}
              </p>
            </Section>
          )}

          {weakness && (
            <Section title="TOP WEAKNESS TO FIX" accentColor="#FF2D55">
              <p className="text-sm leading-relaxed" style={{ color: '#F59E0B' }}>
                {weakness}
              </p>
            </Section>
          )}

          {weekly && (weekly.drill || weekly.goal) && (
            <Section title="THIS WEEK'S FOCUS" accentColor="#F59E0B">
              {weekly.drill && (
                <div className="mb-3">
                  <span
                    className="text-[10px] font-black tracking-widest uppercase"
                    style={{ color: '#3D4F6E' }}
                  >
                    DRILL
                  </span>
                  <p className="text-sm mt-0.5" style={{ color: '#E8EFFF' }}>
                    {weekly.drill}
                  </p>
                </div>
              )}
              {weekly.goal && (
                <div>
                  <span
                    className="text-[10px] font-black tracking-widest uppercase"
                    style={{ color: '#3D4F6E' }}
                  >
                    SUCCESS METRIC
                  </span>
                  <p className="text-sm mt-0.5" style={{ color: '#E8EFFF' }}>
                    {weekly.goal}
                  </p>
                </div>
              )}
            </Section>
          )}

          <div className="grid grid-cols-2 gap-4">
            {improving && improving.length > 0 && (
              <Section title="IMPROVING AREAS" accentColor="#00FF85">
                <BulletList items={improving} color="#00FF85" />
              </Section>
            )}
            {strengths && strengths.length > 0 && (
              <Section title="CONSISTENT STRENGTHS" accentColor="#00D4FF">
                <BulletList items={strengths} color="#00D4FF" />
              </Section>
            )}
          </div>

          {catInsights && Object.keys(catInsights).length > 0 && (
            <Section title="CATEGORY-BY-CATEGORY INSIGHTS" accentColor="#7C3AED">
              <CategoryInsights insights={catInsights} />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
