/**
 * Per-agent ability slot categorization
 *
 * For X3 anti-pattern detection we need to know what KIND of ability lives
 * in each slot, not just whether it's lit. Categories drive different rules:
 *   - 'setup'     → must deploy in buy phase / round start; if still lit at
 *                   first contact, the round was griefed
 *   - 'info'      → recon / flash / reveal — should precede entries
 *   - 'damage'    → molly / burst — used during fights
 *   - 'mobility'  → dash / dismiss / teleport — escape or repositioning
 *   - 'heal'      → self/teammate heals
 *   - 'ult'       → all X slots (orb-based, not per-round cooldown)
 *
 * Slots: C, Q, E, X. Ult is always X.
 *
 * Coverage: 25 agents as of 2026-04. New agents fall through to a default
 * categorization derived from agent role (set in `defaultByRole`).
 *
 * NOTE: We deliberately keep this hand-curated rather than scraping
 * `knowledge.ts` ability strings — that text is for the LLM, this is for
 * deterministic logic.
 */

export type AbilityCategory = 'setup' | 'info' | 'damage' | 'mobility' | 'heal' | 'ult' | 'utility';
export type AgentRole = 'duelist' | 'sentinel' | 'controller' | 'initiator' | 'flex';

export interface AgentAbilityProfile {
  role: AgentRole;
  C: AbilityCategory;
  Q: AbilityCategory;
  E: AbilityCategory;
  X: 'ult';
  /** Slots that are typically setup-style and SHOULD deploy at round start. */
  setupSlots: ('C' | 'Q' | 'E')[];
  /** Slots that are typically info/intel that SHOULD precede entries. */
  infoSlots: ('C' | 'Q' | 'E')[];
}

const A = (
  role: AgentRole,
  C: AbilityCategory,
  Q: AbilityCategory,
  E: AbilityCategory,
): AgentAbilityProfile => {
  const allSlots: ('C' | 'Q' | 'E')[] = ['C', 'Q', 'E'];
  const map: Record<'C' | 'Q' | 'E', AbilityCategory> = { C, Q, E };
  return {
    role,
    C,
    Q,
    E,
    X: 'ult',
    setupSlots: allSlots.filter((s) => map[s] === 'setup'),
    infoSlots: allSlots.filter((s) => map[s] === 'info'),
  };
};

/** Lookup keyed by lowercased canonical agent name (matches game_knowledge entry_key). */
export const AGENT_ABILITIES: Record<string, AgentAbilityProfile> = {
  // ── Duelists ───────────────────────────────────────────────────────────
  jett: A('duelist', 'utility', 'mobility', 'mobility'),
  phoenix: A('duelist', 'damage', 'info', 'damage'),
  reyna: A('duelist', 'info', 'mobility', 'heal'),
  raze: A('duelist', 'damage', 'damage', 'mobility'),
  yoru: A('duelist', 'info', 'utility', 'mobility'),
  neon: A('duelist', 'damage', 'mobility', 'damage'),
  iso: A('duelist', 'utility', 'damage', 'utility'),
  waylay: A('duelist', 'utility', 'mobility', 'mobility'),

  // ── Sentinels ──────────────────────────────────────────────────────────
  cypher: A('sentinel', 'setup', 'utility', 'info'),
  killjoy: A('sentinel', 'damage', 'setup', 'setup'),
  sage: A('sentinel', 'damage', 'heal', 'setup'),
  chamber: A('sentinel', 'setup', 'damage', 'mobility'),
  deadlock: A('sentinel', 'damage', 'setup', 'setup'),
  vyse: A('sentinel', 'utility', 'setup', 'setup'),
  veto: A('sentinel', 'setup', 'mobility', 'setup'),

  // ── Controllers ────────────────────────────────────────────────────────
  brimstone: A('controller', 'damage', 'utility', 'utility'),
  omen: A('controller', 'utility', 'utility', 'mobility'),
  viper: A('controller', 'damage', 'utility', 'setup'),
  astra: A('controller', 'utility', 'utility', 'utility'),
  harbor: A('controller', 'utility', 'utility', 'utility'),
  clove: A('controller', 'damage', 'heal', 'utility'),
  miks: A('controller', 'heal', 'utility', 'setup'),

  // ── Initiators ─────────────────────────────────────────────────────────
  sova: A('initiator', 'damage', 'info', 'info'),
  breach: A('initiator', 'info', 'damage', 'info'),
  skye: A('initiator', 'heal', 'info', 'info'),
  kayo: A('initiator', 'damage', 'info', 'utility'),
  fade: A('initiator', 'info', 'info', 'info'),
  gekko: A('initiator', 'info', 'damage', 'info'),
  tejo: A('initiator', 'damage', 'info', 'damage'),
};

/** Default profile when an unknown agent shows up — neutral assumptions. */
const DEFAULT_PROFILE: AgentAbilityProfile = A('flex', 'utility', 'utility', 'utility');

/** Get the ability profile for an agent, falling back to a neutral default. */
export function getAgentAbilityProfile(agentName: string | null | undefined): AgentAbilityProfile {
  if (!agentName) return DEFAULT_PROFILE;
  const key = agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return AGENT_ABILITIES[key] ?? DEFAULT_PROFILE;
}

/**
 * Cooldown durations in seconds — used for self-verifying detected casts.
 * Real Valorant cooldowns vary per agent; these are conservative averages.
 * Self-verification only requires the slot to STAY DARK for at least this
 * many seconds after a candidate cast event, so being slightly low is safer
 * than slightly high (false-positive rejection vs false-negative).
 */
export const ABILITY_COOLDOWN_SEC: Record<AbilityCategory, number> = {
  info: 30, // most flashes/recon abilities
  setup: 99, // setups don't really have CDs — gone for the round once placed
  damage: 30, // mollies, projectiles
  mobility: 25, // dashes, dismisses (some have multiple charges)
  heal: 35, // sage heal, others
  utility: 30, // generic
  ult: 99, // ults: not per-round CD; self-verification doesn't apply
};
