/**
 * Game Timeline Builder
 *
 * State machine that processes classified frames and detector outputs
 * to build a structured per-round game timeline.
 *
 * Pipeline:
 *   Frame → Game State Classifier → route to detectors → accumulate events
 *   → build round-by-round timeline → send to LLM for coaching
 *
 * Each round tracks:
 *   - Economy (credits at buy phase)
 *   - Health/shield timeline during gameplay
 *   - Kill events (HSV banner detection)
 *   - Death info (enemy agent, weapon, damage from death screen)
 *   - Abilities used/unused
 *   - Round result (win/loss)
 *   - Timing (when events happened relative to round start)
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type GameState =
  | 'loading'
  | 'buy_phase'
  | 'gameplay'
  | 'death_screen'
  | 'spectating'
  | 'round_end';

export interface HealthSnapshot {
  /** Seconds since round start */
  roundSec: number;
  /** Health bin: "0-25" | "26-50" | "51-75" | "76-100" | "101-150" */
  health: string;
  /** Shield: "0" | "25" | "50" */
  shield: string;
}

export interface KillEvent {
  roundSec: number;
  /** Cumulative kills this round */
  killCount: number;
}

export interface DeathEvent {
  roundSec: number;
  /** Enemy agent that killed the player */
  killedByAgent: string | null;
  /** Weapon used */
  killedByWeapon: string | null;
  /** Damage dealt to enemy before dying */
  damageDealt: number | null;
  /** Damage received */
  damageReceived: number | null;
  /** Abilities still available at time of death */
  abilitiesUnused: string[];
}

export interface AbilityEvent {
  roundSec: number;
  /** Which ability slot: C, Q, E, X */
  slot: string;
  /** "used" | "available" | "cooldown" */
  status: string;
}

export interface RoundData {
  roundNumber: number;
  side: 'attack' | 'defense' | 'unknown';
  startSec: number;
  endSec: number;
  durationSec: number;
  result: 'win' | 'loss' | 'unknown';

  economy: {
    creditsRange: string | null;
  };

  healthTimeline: HealthSnapshot[];
  kills: KillEvent[];
  death: DeathEvent | null;
  abilities: AbilityEvent[];

  /** Did player survive this round? */
  survived: boolean;
}

export interface GameTimeline {
  /** Player's agent (detected once) */
  playerAgent: string | null;
  /** Map name (detected once) */
  map: string | null;
  /** Total rounds played */
  totalRounds: number;
  /** Rounds won */
  roundsWon: number;
  /** Rounds lost */
  roundsLost: number;
  /** All round data */
  rounds: RoundData[];
  /** Game duration in seconds */
  durationSec: number;
}

// ── Detector Result Types ──────────────────────────────────────────────────

export interface FrameDetectionResult {
  timestamp: number;
  gameState: GameState;
  health?: string;
  shield?: string;
  creditsRange?: string;
  killDetected?: boolean;
  deathScreenInfo?: {
    enemyAgent: string | null;
    weapon: string | null;
    damageDealt: number | null;
    damageReceived: number | null;
  };
  abilityStatuses?: Record<string, string>;
}

// ── State Machine ──────────────────────────────────────────────────────────

export class GameTimelineBuilder {
  private timeline: GameTimeline;
  private currentRound: RoundData;
  private currentState: GameState = 'loading';
  private roundStartSec = 0;
  private roundNumber = 0;
  private roundKillCount = 0;
  private lastAbilityState: Record<string, string> = {};
  private lastHealthBin = '76-100';
  private lastShieldBin = '50';

  constructor() {
    this.timeline = {
      playerAgent: null,
      map: null,
      totalRounds: 0,
      roundsWon: 0,
      roundsLost: 0,
      rounds: [],
      durationSec: 0,
    };
    this.currentRound = this.newRound();
  }

  /** Set player agent (detected once at game start or from ability bar) */
  setPlayerAgent(agent: string): void {
    this.timeline.playerAgent = agent;
  }

  /** Set map (detected once at game start or from minimap) */
  setMap(map: string): void {
    this.timeline.map = map;
  }

  /** Process a single frame's detection results */
  processFrame(result: FrameDetectionResult): void {
    const { timestamp, gameState } = result;
    this.timeline.durationSec = timestamp;

    // Handle state transitions
    if (gameState !== this.currentState) {
      this.onStateTransition(this.currentState, gameState, timestamp);
      this.currentState = gameState;
    }

    // Process detections based on current state
    switch (gameState) {
      case 'gameplay':
        this.processGameplay(result);
        break;
      case 'death_screen':
        this.processDeathScreen(result);
        break;
      case 'buy_phase':
        this.processBuyPhase(result);
        break;
    }
  }

  /** Build the final timeline */
  build(): GameTimeline {
    // Finalize current round if in progress
    if (this.roundNumber > 0 && this.currentRound.startSec > 0) {
      this.currentRound.endSec = this.timeline.durationSec;
      this.currentRound.durationSec = this.currentRound.endSec - this.currentRound.startSec;
      this.timeline.rounds.push(this.currentRound);
    }

    this.timeline.totalRounds = this.timeline.rounds.length;
    this.timeline.roundsWon = this.timeline.rounds.filter((r) => r.result === 'win').length;
    this.timeline.roundsLost = this.timeline.rounds.filter((r) => r.result === 'loss').length;

    return this.timeline;
  }

  // ── Private Methods ────────────────────────────────────────────────────

  private onStateTransition(from: GameState, to: GameState, timestamp: number): void {
    // BUY_PHASE → GAMEPLAY = round started
    if (to === 'gameplay' && (from === 'buy_phase' || from === 'loading')) {
      this.roundStartSec = timestamp;
      this.roundKillCount = 0;
    }

    // anything → ROUND_END = round finished
    if (to === 'round_end') {
      this.currentRound.endSec = timestamp;
      this.currentRound.durationSec = this.currentRound.endSec - this.currentRound.startSec;

      // Determine result: if we died this round and didn't see another kill after, likely loss
      // This is a heuristic — could be improved with actual round result detection
      if (this.currentRound.death && this.currentRound.kills.length === 0) {
        this.currentRound.result = 'loss';
      }

      this.timeline.rounds.push(this.currentRound);
    }

    // ROUND_END → BUY_PHASE = new round starting
    if (to === 'buy_phase' && from === 'round_end') {
      this.roundNumber++;
      this.currentRound = this.newRound();
      this.currentRound.startSec = timestamp;
    }

    // First BUY_PHASE after LOADING = round 1
    if (to === 'buy_phase' && from === 'loading') {
      this.roundNumber = 1;
      this.currentRound = this.newRound();
      this.currentRound.startSec = timestamp;
    }
  }

  private processGameplay(result: FrameDetectionResult): void {
    const roundSec = result.timestamp - this.roundStartSec;

    // Track health changes (only record when it changes)
    if (result.health && result.health !== this.lastHealthBin) {
      this.currentRound.healthTimeline.push({
        roundSec,
        health: result.health,
        shield: result.shield || this.lastShieldBin,
      });
      this.lastHealthBin = result.health;
    }
    if (result.shield && result.shield !== this.lastShieldBin) {
      this.lastShieldBin = result.shield;
    }

    // Track kills
    if (result.killDetected) {
      this.roundKillCount++;
      this.currentRound.kills.push({
        roundSec,
        killCount: this.roundKillCount,
      });
    }

    // Track ability state changes
    if (result.abilityStatuses) {
      for (const [slot, status] of Object.entries(result.abilityStatuses)) {
        if (this.lastAbilityState[slot] !== status) {
          this.currentRound.abilities.push({ roundSec, slot, status });
          this.lastAbilityState[slot] = status;
        }
      }
    }
  }

  private processDeathScreen(result: FrameDetectionResult): void {
    // Only record death once per round
    if (this.currentRound.death) return;

    const roundSec = result.timestamp - this.roundStartSec;
    const info = result.deathScreenInfo;

    // Find abilities that were still available at death
    const unusedAbilities: string[] = [];
    for (const [slot, status] of Object.entries(this.lastAbilityState)) {
      if (status === 'available') {
        unusedAbilities.push(slot);
      }
    }

    this.currentRound.death = {
      roundSec,
      killedByAgent: info?.enemyAgent ?? null,
      killedByWeapon: info?.weapon ?? null,
      damageDealt: info?.damageDealt ?? null,
      damageReceived: info?.damageReceived ?? null,
      abilitiesUnused: unusedAbilities,
    };

    this.currentRound.survived = false;

    // Record health at death
    this.currentRound.healthTimeline.push({
      roundSec,
      health: '0-25',
      shield: '0',
    });
  }

  private processBuyPhase(result: FrameDetectionResult): void {
    if (result.creditsRange) {
      this.currentRound.economy.creditsRange = result.creditsRange;
    }
  }

  private newRound(): RoundData {
    return {
      roundNumber: this.roundNumber,
      side: this.roundNumber <= 12 ? 'attack' : 'defense', // simplified
      startSec: 0,
      endSec: 0,
      durationSec: 0,
      result: 'unknown',
      economy: { creditsRange: null },
      healthTimeline: [],
      kills: [],
      death: null,
      abilities: [],
      survived: true,
    };
  }
}

// ── Timeline to Coaching Prompt ────────────────────────────────────────────

export function timelineToCoachingPrompt(timeline: GameTimeline): string {
  const lines: string[] = [];

  lines.push(
    `GAME: ${timeline.playerAgent ?? 'Unknown Agent'} on ${timeline.map ?? 'Unknown Map'}`,
  );
  lines.push(
    `RESULT: ${timeline.roundsWon}W - ${timeline.roundsLost}L (${timeline.totalRounds} rounds)`,
  );
  lines.push(`DURATION: ${Math.round(timeline.durationSec / 60)} minutes`);
  lines.push('');

  for (const round of timeline.rounds) {
    lines.push(`--- ROUND ${round.roundNumber} (${round.side}) ---`);
    lines.push(`  Result: ${round.result} | Duration: ${round.durationSec}s`);

    if (round.economy.creditsRange) {
      lines.push(`  Economy: ${round.economy.creditsRange} credits`);
    }

    if (round.kills.length > 0) {
      lines.push(
        `  Kills: ${round.kills.length} (at ${round.kills.map((k) => `${k.roundSec}s`).join(', ')})`,
      );
    }

    if (round.death) {
      const d = round.death;
      lines.push(`  DEATH at ${d.roundSec}s:`);
      if (d.killedByAgent) lines.push(`    Killed by: ${d.killedByAgent}`);
      if (d.killedByWeapon) lines.push(`    Weapon: ${d.killedByWeapon}`);
      if (d.damageDealt != null)
        lines.push(`    Damage dealt: ${d.damageDealt} / received: ${d.damageReceived}`);
      if (d.abilitiesUnused.length > 0) {
        lines.push(`    UNUSED abilities: ${d.abilitiesUnused.join(', ')}`);
      }
    } else {
      lines.push(`  Survived round`);
    }

    // Health story
    if (round.healthTimeline.length > 1) {
      const healthStory = round.healthTimeline
        .map((h) => `${h.roundSec}s:${h.health}hp/${h.shield}shield`)
        .join(' → ');
      lines.push(`  Health: ${healthStory}`);
    }

    lines.push('');
  }

  // Summary stats
  const totalDeaths = timeline.rounds.filter((r) => r.death).length;
  const deathsWithUnusedAbilities = timeline.rounds.filter(
    (r) => r.death && r.death.abilitiesUnused.length > 0,
  ).length;

  lines.push('--- PATTERNS ---');
  lines.push(`Deaths: ${totalDeaths}`);
  lines.push(`Deaths with unused abilities: ${deathsWithUnusedAbilities}/${totalDeaths}`);

  if (totalDeaths > 0) {
    const avgDeathTime =
      timeline.rounds.filter((r) => r.death).reduce((sum, r) => sum + (r.death?.roundSec ?? 0), 0) /
      totalDeaths;
    lines.push(`Average death timing: ${avgDeathTime.toFixed(0)}s into round`);
  }

  return lines.join('\n');
}
