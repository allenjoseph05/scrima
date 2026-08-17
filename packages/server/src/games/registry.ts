import type { GameKnowledgeService } from '../services/knowledge/game-knowledge.service.js';
import type { ServerGameConfig } from './types.js';
import { createValorantConfig } from './valorant/index.js';

class GameRegistry {
  private configs = new Map<string, ServerGameConfig>();

  register(config: ServerGameConfig) {
    this.configs.set(config.gameId, config);
  }

  get(gameId: string): ServerGameConfig | undefined {
    return this.configs.get(gameId);
  }

  getOrThrow(gameId: string): ServerGameConfig {
    const config = this.configs.get(gameId);
    if (!config) throw new Error(`Unknown game: ${gameId}`);
    return config;
  }

  allGameIds(): string[] {
    return [...this.configs.keys()];
  }

  /** Inject the knowledge service into all registered game configs. */
  setKnowledgeService(service: GameKnowledgeService): void {
    for (const config of this.configs.values()) {
      config.setKnowledgeService(service);
    }
  }
}

export const gameRegistry = new GameRegistry();
gameRegistry.register(createValorantConfig());
