import { CharacterConfigSchema, DEFAULT_CHARACTER_CONFIG } from "../types/character.js";
import type { CharacterConfig } from "../types/character.js";
import type { StateManager } from "../state/state-manager.js";

const CHARACTER_CONFIG_PATH = "character-config.json";

/**
 * CharacterConfigManager handles persistence of character configuration.
 *
 * File layout:
 *   <base>/character-config.json
 *
 * Uses StateManager.readRaw / writeRaw for filesystem access (DI pattern).
 */
export class CharacterConfigManager {
  private readonly stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Loads character config from disk.
   * Returns DEFAULT_CHARACTER_CONFIG when no file exists.
   * Validates the stored data with Zod before returning.
   */
  async load(): Promise<CharacterConfig> {
    const raw = await this.stateManager.readRaw(CHARACTER_CONFIG_PATH);
    if (raw === null) {
      return DEFAULT_CHARACTER_CONFIG;
    }
    return CharacterConfigSchema.parse(raw);
  }

  /**
   * Validates config with Zod and writes it to disk atomically.
   */
  async save(config: CharacterConfig): Promise<void> {
    const parsed = CharacterConfigSchema.parse(config);
    await this.stateManager.writeRaw(CHARACTER_CONFIG_PATH, parsed);
  }

  /**
   * Resets config to DEFAULT_CHARACTER_CONFIG and persists it.
   */
  async reset(): Promise<void> {
    await this.save(DEFAULT_CHARACTER_CONFIG);
  }

  /**
   * Merges partial values into the current config, saves the result,
   * and returns the updated config.
   */
  async update(partial: Partial<CharacterConfig>): Promise<CharacterConfig> {
    const current = await this.load();
    const merged = { ...current, ...partial };
    const validated = CharacterConfigSchema.parse(merged);
    await this.save(validated);
    return validated;
  }
}
