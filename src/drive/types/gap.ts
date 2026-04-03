import { z } from "zod";

// --- Raw Gap (per dimension) ---

const RawGapSchema = z.object({
  dimension_name: z.string(),
  raw_gap: z.number(),
});
export type RawGap = z.infer<typeof RawGapSchema>;

// --- Normalized Gap (per dimension, [0, 1]) ---

const NormalizedGapSchema = z.object({
  dimension_name: z.string(),
  raw_gap: z.number(),
  normalized_gap: z.number().min(0).max(1),
});
export type NormalizedGap = z.infer<typeof NormalizedGapSchema>;

// --- Weighted Gap (per dimension, confidence-adjusted) ---

export const WeightedGapSchema = z.object({
  dimension_name: z.string(),
  raw_gap: z.number(),
  normalized_gap: z.number().min(0).max(1),
  normalized_weighted_gap: z.number().min(0),
  confidence: z.number().min(0).max(1),
  uncertainty_weight: z.number(),
});
export type WeightedGap = z.infer<typeof WeightedGapSchema>;

// --- Gap Vector (the full gap state for a goal) ---

export const GapVectorSchema = z.object({
  goal_id: z.string(),
  gaps: z.array(WeightedGapSchema),
  timestamp: z.string(),
});
export type GapVector = z.infer<typeof GapVectorSchema>;

// --- Gap History Entry (snapshot per iteration) ---

export const GapHistoryEntrySchema = z.object({
  iteration: z.number(),
  timestamp: z.string(),
  gap_vector: z.array(
    z.object({
      dimension_name: z.string(),
      normalized_weighted_gap: z.number(),
    })
  ),
  confidence_vector: z.array(
    z.object({
      dimension_name: z.string(),
      confidence: z.number(),
    })
  ),
});
export type GapHistoryEntry = z.infer<typeof GapHistoryEntrySchema>;
