import { useMemo, useState } from 'react';
import { type SkillMastery, useCoachStore } from '../../stores/coachStore';

// ── Skill taxonomy (client-side copy of positions + connections) ─────────────

const DOMAIN_COLORS: Record<string, string> = {
  mechanical: '#FF2D55',
  game_sense: '#00D4FF',
  utility: '#00FF85',
  mental: '#F59E0B',
};

const DOMAIN_LABELS: Record<string, string> = {
  mechanical: 'MECHANICAL',
  game_sense: 'GAME SENSE',
  utility: 'UTILITY',
  mental: 'MENTAL',
};

// Fixed positions for each skill in SVG space (0-1000 x 0-600)
// Quadrants: mechanical=top-right, game_sense=top-left, utility=bottom-left, mental=bottom-right
const SKILL_POSITIONS: Record<string, { x: number; y: number }> = {
  // Mechanical (top-right)
  crosshair_placement: { x: 680, y: 80 },
  spray_control: { x: 800, y: 120 },
  counter_strafing: { x: 720, y: 200 },
  peeking_technique: { x: 850, y: 230 },
  movement_discipline: { x: 750, y: 310 },
  // Game Sense (top-left)
  positioning: { x: 200, y: 80 },
  angle_discipline: { x: 320, y: 120 },
  map_awareness: { x: 140, y: 190 },
  trading: { x: 280, y: 220 },
  economy_management: { x: 100, y: 290 },
  rotation_timing: { x: 240, y: 310 },
  information_gathering: { x: 380, y: 270 },
  post_plant_play: { x: 340, y: 170 },
  // Utility (bottom-left)
  utility_timing: { x: 180, y: 420 },
  ability_economy: { x: 100, y: 500 },
  flash_coordination: { x: 300, y: 450 },
  smoke_usage: { x: 220, y: 530 },
  setup_utility: { x: 350, y: 530 },
  // Mental (bottom-right)
  patience: { x: 700, y: 420 },
  tilt_resistance: { x: 850, y: 450 },
  adaptability: { x: 750, y: 510 },
  aggression_control: { x: 650, y: 530 },
};

// Known skill connections (prerequisites + related)
const SKILL_CONNECTIONS: [string, string][] = [
  ['crosshair_placement', 'spray_control'],
  ['crosshair_placement', 'counter_strafing'],
  ['crosshair_placement', 'peeking_technique'],
  ['counter_strafing', 'peeking_technique'],
  ['counter_strafing', 'movement_discipline'],
  ['positioning', 'angle_discipline'],
  ['positioning', 'post_plant_play'],
  ['map_awareness', 'trading'],
  ['map_awareness', 'rotation_timing'],
  ['map_awareness', 'information_gathering'],
  ['map_awareness', 'smoke_usage'],
  ['utility_timing', 'ability_economy'],
  ['utility_timing', 'flash_coordination'],
  ['utility_timing', 'smoke_usage'],
  ['utility_timing', 'setup_utility'],
  ['patience', 'aggression_control'],
  ['patience', 'adaptability'],
  ['map_awareness', 'adaptability'],
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTrendIcon(trend: string): string {
  if (trend === 'improving') return '\u2191';
  if (trend === 'regressing') return '\u2193';
  return '\u2192';
}

function getTrendColor(trend: string): string {
  if (trend === 'improving') return '#00FF85';
  if (trend === 'regressing') return '#FF2D55';
  return '#3D4F6E';
}

function getMasteryLabel(m: number): string {
  if (m < 0.25) return 'WEAK';
  if (m < 0.45) return 'DEVELOPING';
  if (m < 0.65) return 'SOLID';
  if (m < 0.8) return 'STRONG';
  return 'MASTERED';
}

// ── SVG Constellation ───────────────────────────────────────────────────────

function SkillConstellation({
  skills,
  selectedId,
  onSelect,
}: {
  skills: SkillMastery[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const skillMap = useMemo(() => {
    const m = new Map<string, SkillMastery>();
    for (const s of skills) m.set(s.id, s);
    return m;
  }, [skills]);

  const allIds = Object.keys(SKILL_POSITIONS);

  return (
    <svg viewBox="0 0 1000 600" className="w-full h-full" style={{ maxHeight: '100%' }}>
      {/* Background grid dots */}
      <defs>
        <pattern id="grid-dots" width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="20" cy="20" r="0.5" fill="#1A244040" />
        </pattern>
        {/* Glow filter */}
        <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="1000" height="600" fill="url(#grid-dots)" />

      {/* Domain labels */}
      <text
        x="60"
        y="40"
        fill="#00D4FF30"
        fontSize="11"
        fontFamily="monospace"
        fontWeight="bold"
        letterSpacing="2"
      >
        GAME SENSE
      </text>
      <text
        x="700"
        y="40"
        fill="#FF2D5530"
        fontSize="11"
        fontFamily="monospace"
        fontWeight="bold"
        letterSpacing="2"
      >
        MECHANICAL
      </text>
      <text
        x="60"
        y="580"
        fill="#00FF8530"
        fontSize="11"
        fontFamily="monospace"
        fontWeight="bold"
        letterSpacing="2"
      >
        UTILITY
      </text>
      <text
        x="700"
        y="580"
        fill="#F59E0B30"
        fontSize="11"
        fontFamily="monospace"
        fontWeight="bold"
        letterSpacing="2"
      >
        MENTAL
      </text>

      {/* Center crosshair */}
      <line x1="490" y1="290" x2="510" y2="310" stroke="#1A244060" strokeWidth="0.5" />
      <line x1="510" y1="290" x2="490" y2="310" stroke="#1A244060" strokeWidth="0.5" />

      {/* Connection lines */}
      {SKILL_CONNECTIONS.map(([a, b], i) => {
        const posA = SKILL_POSITIONS[a];
        const posB = SKILL_POSITIONS[b];
        if (!posA || !posB) return null;
        const sA = skillMap.get(a);
        const sB = skillMap.get(b);
        const bothObserved = sA && sA.observations > 0 && sB && sB.observations > 0;
        const opacity = bothObserved ? 0.25 : 0.06;
        const isHighlight =
          selectedId === a || selectedId === b || hoveredId === a || hoveredId === b;
        return (
          <line
            key={i}
            x1={posA.x}
            y1={posA.y}
            x2={posB.x}
            y2={posB.y}
            stroke={isHighlight ? '#7C3AED' : '#1A2440'}
            strokeWidth={isHighlight ? 1.5 : 0.8}
            opacity={isHighlight ? 0.5 : opacity}
          />
        );
      })}

      {/* Skill nodes */}
      {allIds.map((id) => {
        const pos = SKILL_POSITIONS[id];
        if (!pos) return null;
        const skill = skillMap.get(id);
        const mastery = skill?.mastery ?? 0;
        const domain = skill?.domain ?? inferDomain(id);
        const color = DOMAIN_COLORS[domain] ?? '#7A8BAD';
        const radius = 8 + mastery * 12; // 8-20px
        const fillOpacity = skill ? Math.max(0.15, mastery) : 0.05;
        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isImproving = skill?.trend === 'improving';
        const isRegressing = skill?.trend === 'regressing';

        return (
          <g
            key={id}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(isSelected ? null : id)}
            onMouseEnter={() => setHoveredId(id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            {/* Glow ring for improving skills */}
            {isImproving && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={radius + 6}
                fill="none"
                stroke={color}
                strokeWidth="1"
                opacity="0.3"
                style={{ animation: 'glow-pulse 2s ease-in-out infinite' }}
              />
            )}

            {/* Selection ring */}
            {isSelected && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={radius + 4}
                fill="none"
                stroke="#7C3AED"
                strokeWidth="2"
                opacity="0.6"
              />
            )}

            {/* Main node */}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={radius}
              fill={color}
              fillOpacity={fillOpacity}
              stroke={isRegressing ? '#FF2D55' : color}
              strokeWidth={isSelected || isHovered ? 2 : 1.5}
              filter={mastery > 0.5 ? 'url(#node-glow)' : undefined}
            />

            {/* Center dot */}
            {skill && skill.observations > 0 && (
              <circle cx={pos.x} cy={pos.y} r={2} fill={color} opacity={0.8} />
            )}

            {/* Tooltip on hover */}
            {isHovered && (
              <g>
                <rect
                  x={pos.x - 70}
                  y={pos.y - radius - 38}
                  width="140"
                  height="30"
                  rx="3"
                  fill="#0A0E1A"
                  stroke="#1A2440"
                  strokeWidth="1"
                />
                <text
                  x={pos.x}
                  y={pos.y - radius - 24}
                  textAnchor="middle"
                  fill="#E8EFFF"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  {skill?.name ?? formatSkillId(id)}
                </text>
                <text
                  x={pos.x}
                  y={pos.y - radius - 13}
                  textAnchor="middle"
                  fill={color}
                  fontSize="9"
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  {skill ? `${Math.round(mastery * 100)}% · ${skill.observations} obs` : 'No data'}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function inferDomain(skillId: string): string {
  if (
    [
      'crosshair_placement',
      'spray_control',
      'counter_strafing',
      'peeking_technique',
      'movement_discipline',
    ].includes(skillId)
  )
    return 'mechanical';
  if (
    [
      'positioning',
      'angle_discipline',
      'map_awareness',
      'trading',
      'economy_management',
      'rotation_timing',
      'information_gathering',
      'post_plant_play',
    ].includes(skillId)
  )
    return 'game_sense';
  if (
    [
      'utility_timing',
      'ability_economy',
      'flash_coordination',
      'smoke_usage',
      'setup_utility',
    ].includes(skillId)
  )
    return 'utility';
  return 'mental';
}

function formatSkillId(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Forge Detail Panel ──────────────────────────────────────────────────────

function ForgePanel({
  skillId,
  skill,
}: {
  skillId: string;
  skill: SkillMastery | undefined;
}) {
  const brain = useCoachStore((s) => s.brain);
  const domain = skill?.domain ?? inferDomain(skillId);
  const color = DOMAIN_COLORS[domain] ?? '#7A8BAD';
  const name = skill?.name ?? formatSkillId(skillId);
  const mastery = skill?.mastery ?? 0;
  const pct = Math.round(mastery * 100);

  // Find related observations
  const relatedObs = useMemo(() => {
    if (!brain) return [];
    const all = [
      ...brain.observations.habits,
      ...brain.observations.strengths,
      ...brain.observations.insights,
    ];
    const nameLower = name.toLowerCase();
    const idParts = skillId.split('_');
    return all
      .filter((o) => {
        const textLower = o.text.toLowerCase();
        return (
          textLower.includes(nameLower) ||
          idParts.some((part) => part.length > 3 && textLower.includes(part))
        );
      })
      .slice(0, 3);
  }, [brain, name, skillId]);

  // Find related reflection
  const relatedReflection = useMemo(() => {
    if (!brain) return null;
    const nameLower = name.toLowerCase();
    return (
      brain.reflections.find(
        (r) =>
          r.title.toLowerCase().includes(nameLower) || r.insight.toLowerCase().includes(nameLower),
      ) ?? null
    );
  }, [brain, name]);

  return (
    <div className="p-5">
      {/* Skill header */}
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-3 h-3 rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}60` }}
        />
        <h3 className="text-base font-bold" style={{ color }}>
          {name}
        </h3>
        <span
          className="text-[9px] font-mono px-1.5 py-0.5 rounded-sm uppercase tracking-wider"
          style={{ color: `${color}90`, background: `${color}10`, border: `1px solid ${color}25` }}
        >
          {DOMAIN_LABELS[domain] ?? domain}
        </span>
      </div>

      {/* Mastery bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase" style={{ color: '#7A8BAD' }}>
            Mastery
          </span>
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono font-bold" style={{ color }}>
              {pct}%
            </span>
            {skill && (
              <span className="text-xs" style={{ color: getTrendColor(skill.trend) }}>
                {getTrendIcon(skill.trend)} {skill.trend}
              </span>
            )}
          </div>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: '#1A2440' }}>
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}80, ${color})` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[9px] font-mono uppercase" style={{ color: `${color}80` }}>
            {getMasteryLabel(mastery)}
          </span>
          <span className="text-[9px] font-mono" style={{ color: '#3D4F6E' }}>
            {skill?.observations ?? 0} observations
          </span>
        </div>
      </div>

      {/* Related observations */}
      {relatedObs.length > 0 && (
        <div className="mb-3">
          <h4
            className="text-[9px] font-mono font-bold tracking-[0.15em] uppercase mb-2"
            style={{ color: '#7A8BAD' }}
          >
            Related observations
          </h4>
          <div className="space-y-1.5">
            {relatedObs.map((o) => (
              <div
                key={o.id}
                className="px-3 py-2 rounded-sm text-xs leading-relaxed"
                style={{ background: '#0D1221', border: '1px solid #1A2440', color: '#B0BCDB' }}
              >
                {o.text}
                <span className="ml-2 text-[9px] font-mono" style={{ color: `${color}80` }}>
                  {o.occurrences}&times;
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related reflection */}
      {relatedReflection && (
        <div>
          <h4
            className="text-[9px] font-mono font-bold tracking-[0.15em] uppercase mb-2"
            style={{ color: '#A78BFA' }}
          >
            Coach's insight
          </h4>
          <div
            className="px-3 py-2 rounded-sm"
            style={{
              background: '#0D1221',
              border: '1px solid #1A2440',
              borderLeft: '3px solid #7C3AED44',
            }}
          >
            <p className="text-xs font-bold mb-0.5" style={{ color: '#E8EFFF' }}>
              {relatedReflection.title}
            </p>
            <p className="text-[11px] leading-relaxed" style={{ color: '#7A8BAD' }}>
              {relatedReflection.insight}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ForgeSummary({ skills }: { skills: SkillMastery[] }) {
  const observed = skills.filter((s) => s.observations > 0);
  const strongest = [...observed].sort((a, b) => b.mastery - a.mastery).slice(0, 3);
  const weakest = [...observed].sort((a, b) => a.mastery - b.mastery).slice(0, 3);
  const totalObs = observed.reduce((sum, s) => sum + s.observations, 0);

  return (
    <div className="p-5">
      <div className="flex items-center gap-6 mb-4">
        <div className="text-center">
          <div className="text-lg font-black font-mono" style={{ color: '#00D4FF' }}>
            {observed.length}
          </div>
          <div className="text-[9px] font-mono uppercase" style={{ color: '#3D4F6E' }}>
            Skills tracked
          </div>
        </div>
        <div className="text-center">
          <div className="text-lg font-black font-mono" style={{ color: '#7C3AED' }}>
            {totalObs}
          </div>
          <div className="text-[9px] font-mono uppercase" style={{ color: '#3D4F6E' }}>
            Total observations
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Strongest */}
        {strongest.length > 0 && (
          <div>
            <h4
              className="text-[9px] font-mono font-bold tracking-[0.15em] uppercase mb-2"
              style={{ color: '#00FF85' }}
            >
              Strongest
            </h4>
            {strongest.map((s) => {
              const color = DOMAIN_COLORS[s.domain] ?? '#7A8BAD';
              return (
                <div key={s.id} className="flex items-center justify-between py-1">
                  <span className="text-xs" style={{ color: '#E8EFFF' }}>
                    {s.name}
                  </span>
                  <span className="text-[10px] font-mono font-bold" style={{ color }}>
                    {Math.round(s.mastery * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Weakest */}
        {weakest.length > 0 && (
          <div>
            <h4
              className="text-[9px] font-mono font-bold tracking-[0.15em] uppercase mb-2"
              style={{ color: '#FF2D55' }}
            >
              Focus here
            </h4>
            {weakest.map((s) => {
              const color = DOMAIN_COLORS[s.domain] ?? '#7A8BAD';
              return (
                <div key={s.id} className="flex items-center justify-between py-1">
                  <span className="text-xs" style={{ color: '#7A8BAD' }}>
                    {s.name}
                  </span>
                  <span className="text-[10px] font-mono font-bold" style={{ color: `${color}80` }}>
                    {Math.round(s.mastery * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function CoachSkills() {
  const brain = useCoachStore((s) => s.brain);
  const brainLoading = useCoachStore((s) => s.brainLoading);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const skills = brain?.mastery.skills ?? [];
  const selectedSkill = selectedId ? skills.find((s) => s.id === selectedId) : undefined;
  const hasData = skills.some((s) => s.observations > 0);

  if (brainLoading && !brain) {
    return (
      <div className="h-full flex items-center justify-center">
        <div
          className="w-5 h-5 border-2 rounded-full animate-spin"
          style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
        />
        <span className="ml-3 text-xs font-mono" style={{ color: '#3D4F6E' }}>
          Loading skills...
        </span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Constellation (top 60%) */}
      <div className="flex-[3] relative overflow-hidden" style={{ minHeight: 0 }}>
        <SkillConstellation skills={skills} selectedId={selectedId} onSelect={setSelectedId} />

        {/* Empty state overlay */}
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p
              className="text-sm font-mono text-center"
              style={{ color: '#3D4F6E', animation: 'float 3s ease-in-out infinite' }}
            >
              Play your first game to light up your skill map
            </p>
          </div>
        )}
      </div>

      {/* Forge detail panel (bottom 40%) */}
      <div
        className="flex-[2] overflow-auto"
        style={{ borderTop: '1px solid #1A2440', background: '#0A0E1A', minHeight: 0 }}
      >
        {selectedId ? (
          <ForgePanel skillId={selectedId} skill={selectedSkill} />
        ) : (
          <ForgeSummary skills={skills} />
        )}
      </div>
    </div>
  );
}
