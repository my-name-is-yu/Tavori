import { z } from "zod";

export const EmbeddingConfigSchema = z.object({
  model: z.string().default("nomic-embed-text"),
  dimensions: z.number().int().positive().default(768),
  provider: z.enum(["openai", "ollama", "mock"]).default("mock"),
  base_url: z.string().optional(),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const EmbeddingEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  vector: z.array(z.number()),
  model: z.string(),
  created_at: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EmbeddingEntry = z.infer<typeof EmbeddingEntrySchema>;

export const VectorSearchResultSchema = z.object({
  id: z.string(),
  text: z.string(),
  similarity: z.number(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>;
