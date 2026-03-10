import { z } from "zod";

// --- Trust Balance (per domain) ---

export const TrustBalanceSchema = z.object({
  domain: z.string(),
  balance: z.number().min(-100).max(100).default(0),
  success_delta: z.number().default(3),
  failure_delta: z.number().default(-10),
});
export type TrustBalance = z.infer<typeof TrustBalanceSchema>;

// --- Trust Override Log Entry ---

export const TrustOverrideLogEntrySchema = z.object({
  timestamp: z.string(),
  override_type: z.enum(["trust_grant", "permanent_gate"]),
  domain: z.string(),
  target_category: z.string().nullable().default(null),
  balance_before: z.number().nullable().default(null),
  balance_after: z.number().nullable().default(null),
});
export type TrustOverrideLogEntry = z.infer<typeof TrustOverrideLogEntrySchema>;

// --- Trust Store (all domains) ---

export const TrustStoreSchema = z.object({
  balances: z.record(z.string(), TrustBalanceSchema),
  permanent_gates: z.record(z.string(), z.array(z.string())).default({}),
  override_log: z.array(TrustOverrideLogEntrySchema).default([]),
});
export type TrustStore = z.infer<typeof TrustStoreSchema>;

// --- Action Quadrant ---

export const ActionQuadrantEnum = z.enum([
  "autonomous",           // high trust + high confidence
  "execute_with_confirm", // high trust + low confidence OR low trust + high confidence
  "observe_and_propose",  // low trust + low confidence
]);
export type ActionQuadrant = z.infer<typeof ActionQuadrantEnum>;

/** High trust threshold: trust_balance >= 20 */
export const HIGH_TRUST_THRESHOLD = 20;

/** High confidence threshold: confidence >= 0.50 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.50;

/** Trust change on success */
export const TRUST_SUCCESS_DELTA = 3;

/** Trust change on failure */
export const TRUST_FAILURE_DELTA = -10;
