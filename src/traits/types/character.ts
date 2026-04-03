import { z } from "zod";

const CharacterLevelSchema = z.number().int().min(1).max(5);

export const CharacterConfigSchema = z.object({
  caution_level: CharacterLevelSchema.default(2),             // 1=conservative, 5=ambitious (feasibility threshold)
  stall_flexibility: CharacterLevelSchema.default(1),         // 1=flexible(pivot fast), 5=persistent
  communication_directness: CharacterLevelSchema.default(3),  // 1=considerate(always show alternatives), 5=direct(facts only)
  proactivity_level: CharacterLevelSchema.default(2),         // 1=events-only, 5=always-detailed
});
export type CharacterConfig = z.infer<typeof CharacterConfigSchema>;

export const DEFAULT_CHARACTER_CONFIG: CharacterConfig = CharacterConfigSchema.parse({});
