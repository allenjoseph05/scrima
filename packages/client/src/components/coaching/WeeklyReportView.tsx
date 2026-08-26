import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { formatUserError, reportError } from '../../lib/errors';
import { useNotificationStore } from '../../stores/notificationStore';

interface WeeklyReport {
  id: string;
  status: 'awaiting_uploads' | 'processing' | 'completed' | 'failed';
  weekStart: string;
  weekEnd: string;
  selectedMatchIds: string[];
  gamesAnalyzed: number;
  report: {
    overallAssessment?: string;
    patternBreakdown?: Record<string, number>;
    topMoments?: Array<{
      timestamp: string;
      round?: number;
      category: string;
      whatHappened: string;
      whatToDo: string;
    }>;
    positiveHighlights?: string[];
    drills?: Array<{
      name: string;
      description: string;
      durationMinutes: number;
      frequency: string;
      targetsCategory: string;
    }>;
    trends?: Record<string, 'improving' | 'stable' | 'worsening'>;
  } | null;
  createdAt: string;
}

export function WeeklyReportView() {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    try {
      setLoading(true);
      const data = await invoke<WeeklyReport | null>('get_weekly_report_latest');
      setReport(data ?? null);
      setError(null);
    } catch (e) {
      reportError(e, 'WeeklyReportView.loadReport');
      setError(formatUserError(e, 'Could not load the weekly report.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  // Dismiss weekly notifications when this view opens
  const dismissForView = useNotificationStore((s) => s.dismissForView);
  useEffect(() => {
    dismissForView('coaching');
  }, [dismissForView]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center" style={{ color: '#7A8BAD' }}>
        <span className="text-sm font-mono">Loading weekly report...</span>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="p-6">
        <SectionHeader title="WEEKLY COACHING REPORT" />
        <div
          className="p-8 text-center mt-4"
          style={{ background: '#0D1221', border: '1px solid #1A2440' }}
        >
          <p className="text-sm font-mono" style={{ color: '#3D4F6E' }}>
            {error ??
              'No weekly report available yet. Reports are generated every Sunday for Pro and Ultra subscribers.'}
          </p>
        </div>
      </div>
    );
  }

  const weekLabel = formatWeekLabel(report.weekStart, report.weekEnd);

  if (report.status === 'awaiting_uploads') {
    return (
      <div className="p-6 space-y-4">
        <SectionHeader title="WEEKLY COACHING REPORT" />
        <div className="p-6" style={{ background: '#0D1221', border: '1px solid #F59E0B44' }}>
          <div className="flex items-center gap-3 mb-3">
            <div
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ background: '#F59E0B', boxShadow: '0 0 8px #F59E0B' }}
            />
            <span
              className="text-sm font-bold tracking-widest uppercase"
              style={{ color: '#F59E0B' }}
            >
              UPLOADS PENDING
            </span>
          </div>
          <p className="text-sm font-mono mb-2" style={{ color: '#E8EFFF' }}>
            {weekLabel}
          </p>
          <p className="text-xs font-mono" style={{ color: '#7A8BAD' }}>
            {report.selectedMatchIds.length} match{report.selectedMatchIds.length !== 1 ? 'es' : ''}{' '}
            selected for analysis. Your recordings will be uploaded and analyzed automatically.
          </p>
        </div>
      </div>
    );
  }

  if (report.status === 'processing') {
    return (
      <div className="p-6 space-y-4">
        <SectionHeader title="WEEKLY COACHING REPORT" />
        <div className="p-6" style={{ background: '#0D1221', border: '1px solid #7C3AED44' }}>
          <div className="flex items-center gap-3 mb-3">
            <div
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ background: '#7C3AED', boxShadow: '0 0 8px #7C3AED' }}
            />
            <span
              className="text-sm font-bold tracking-widest uppercase"
              style={{ color: '#A78BFA' }}
            >
              PROCESSING
            </span>
          </div>
          <p className="text-sm font-mono" style={{ color: '#E8EFFF' }}>
            {weekLabel}
          </p>
          <p className="text-xs font-mono" style={{ color: '#7A8BAD' }}>
            Your weekly report is being generated. This may take a few minutes.
          </p>
        </div>
      </div>
    );
  }

  // Completed report
  const r = report.report;
  const breakdown = r?.patternBreakdown ?? {};
  const moments = r?.topMoments ?? [];
  const highlights = r?.positiveHighlights ?? [];
  const drills = r?.drills ?? [];
  const trends = r?.trends ?? {};

  return (
    <div className="p-6 space-y-5">
      <SectionHeader title="WEEKLY COACHING REPORT" />

      {/* Overview card */}
      <div
        className="p-5"
        style={{
          background: 'linear-gradient(135deg, #0D1221 0%, #121929 100%)',
          border: '1px solid #1A2440',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <span
            className="text-sm font-bold tracking-widest uppercase"
            style={{ color: '#00D4FF' }}
          >
            {weekLabel}
          </span>
          <span
            className="text-[10px] font-mono px-2 py-0.5"
            style={{ background: '#00FF850D', border: '1px solid #00FF8544', color: '#00FF85' }}
          >
            {report.gamesAnalyzed} GAMES
          </span>
        </div>

        {r?.overallAssessment && (
          <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
            {r.overallAssessment}
          </p>
        )}
      </div>

      {/* Pattern breakdown */}
      {Object.keys(breakdown).length > 0 && (
        <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
          <h3
            className="text-[10px] font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
            style={{ color: '#3D4F6E' }}
          >
            <span style={{ display: 'inline-block', width: 8, height: 1, background: '#7C3AED' }} />
            PATTERN BREAKDOWN
          </h3>
          <div className="space-y-2">
            {Object.entries(breakdown)
              .sort(([, a], [, b]) => b - a)
              .map(([category, pct]) => (
                <PatternBar
                  key={category}
                  category={category}
                  percentage={pct}
                  trend={trends[category]}
                />
              ))}
          </div>
        </div>
      )}

      {/* Top coaching moments */}
      {moments.length > 0 && (
        <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
          <h3
            className="text-[10px] font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
            style={{ color: '#3D4F6E' }}
          >
            <span style={{ display: 'inline-block', width: 8, height: 1, background: '#FF2D55' }} />
            KEY MOMENTS ({moments.length})
          </h3>
          <div className="space-y-2">
            {moments.map((m, i) => (
              <MomentCard key={i} moment={m} />
            ))}
          </div>
        </div>
      )}

      {/* Positive highlights */}
      {highlights.length > 0 && (
        <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
          <h3
            className="text-[10px] font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
            style={{ color: '#3D4F6E' }}
          >
            <span style={{ display: 'inline-block', width: 8, height: 1, background: '#00FF85' }} />
            POSITIVE HIGHLIGHTS
          </h3>
          <ul className="space-y-1.5">
            {highlights.map((h, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-xs mt-0.5" style={{ color: '#00FF85' }}>
                  +
                </span>
                <span className="text-sm" style={{ color: '#E8EFFF' }}>
                  {h}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Drills */}
      {drills.length > 0 && (
        <div className="p-4" style={{ background: '#0D1221', border: '1px solid #1A2440' }}>
          <h3
            className="text-[10px] font-black tracking-[0.2em] uppercase mb-3 flex items-center gap-2"
            style={{ color: '#3D4F6E' }}
          >
            <span style={{ display: 'inline-block', width: 8, height: 1, background: '#F59E0B' }} />
            RECOMMENDED DRILLS
          </h3>
          <div className="space-y-2">
            {drills.map((d, i) => (
              <DrillCard key={i} drill={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <h2
      className="text-xs font-black tracking-[0.2em] uppercase flex items-center gap-2"
      style={{ color: '#7A8BAD' }}
    >
      <span style={{ display: 'inline-block', width: 12, height: 1, background: '#7C3AED' }} />
      {title}
    </h2>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  crosshair: '#FF2D55',
  positioning: '#F59E0B',
  utility: '#00D4FF',
  decision: '#7C3AED',
  outplayed: '#00FF85',
};

function PatternBar({
  category,
  percentage,
  trend,
}: {
  category: string;
  percentage: number;
  trend?: 'improving' | 'stable' | 'worsening';
}) {
  const color = CATEGORY_COLORS[category] ?? '#7A8BAD';
  const trendLabel =
    trend === 'improving' ? ' (improving)' : trend === 'worsening' ? ' (worsening)' : '';
  const trendColor =
    trend === 'improving' ? '#00FF85' : trend === 'worsening' ? '#FF2D55' : '#7A8BAD';

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono font-semibold uppercase" style={{ color }}>
          {category}
        </span>
        <span className="text-xs font-mono" style={{ color: '#E8EFFF' }}>
          {Math.round(percentage)}%
          {trendLabel && (
            <span className="ml-1" style={{ color: trendColor, fontSize: '0.6rem' }}>
              {trendLabel}
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5" style={{ background: '#1A2440' }}>
        <div
          className="h-full transition-all"
          style={{
            width: `${Math.min(percentage, 100)}%`,
            background: color,
            boxShadow: `0 0 4px ${color}88`,
          }}
        />
      </div>
    </div>
  );
}

function MomentCard({
  moment,
}: {
  moment: {
    timestamp: string;
    round?: number;
    category: string;
    whatHappened: string;
    whatToDo: string;
  };
}) {
  const color = CATEGORY_COLORS[moment.category] ?? '#7A8BAD';

  return (
    <div
      className="p-3"
      style={{
        background: '#0A0E1A',
        borderLeft: `3px solid ${color}`,
        border: '1px solid #1A2440',
        borderLeftColor: color,
        borderLeftWidth: 3,
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
          {moment.timestamp}
          {moment.round ? ` R${moment.round}` : ''}
        </span>
        <span
          className="text-[10px] font-mono font-semibold uppercase px-1 py-0.5"
          style={{ background: `${color}14`, border: `1px solid ${color}44`, color }}
        >
          {moment.category}
        </span>
      </div>
      <p className="text-sm mb-1" style={{ color: '#E8EFFF' }}>
        {moment.whatHappened}
      </p>
      <p className="text-xs" style={{ color: '#00D4FF' }}>
        {moment.whatToDo}
      </p>
    </div>
  );
}

function DrillCard({
  drill,
}: {
  drill: {
    name: string;
    description: string;
    durationMinutes: number;
    frequency: string;
    targetsCategory: string;
  };
}) {
  const color = CATEGORY_COLORS[drill.targetsCategory] ?? '#7A8BAD';

  return (
    <div
      className="flex items-start gap-3 p-3"
      style={{ background: '#0A0E1A', border: '1px solid #1A2440' }}
    >
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold" style={{ color: '#E8EFFF' }}>
            {drill.name}
          </span>
          <span
            className="text-[10px] font-mono px-1 py-0.5"
            style={{ background: `${color}14`, border: `1px solid ${color}44`, color }}
          >
            {drill.targetsCategory}
          </span>
        </div>
        <p className="text-xs mb-1" style={{ color: '#7A8BAD' }}>
          {drill.description}
        </p>
        <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
          {drill.durationMinutes}min {drill.frequency}
        </span>
      </div>
    </div>
  );
}

function formatWeekLabel(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    return `Week of ${s.toLocaleDateString('en-US', opts)} — ${e.toLocaleDateString('en-US', opts)}`;
  } catch {
    return 'Weekly Report';
  }
}
