import type { StateManager } from "../../state/state-manager.js";
import { TransferCandidateSchema, TransferEffectivenessSchema } from "../../types/cross-portfolio.js";
import type {
  TransferCandidate,
  TransferResult,
  TransferEffectivenessRecord,
  TransferEffectiveness,
} from "../../types/cross-portfolio.js";
import type { TransferTrustManager } from "./transfer-trust.js";
import type { TransferContext, PatternEffectivenessTracker } from "./knowledge-transfer-types.js";
import { estimateCurrentGap } from "./knowledge-transfer-types.js";

// ─── evaluateTransferEffect ───

/**
 * Evaluate the effectiveness of a previously applied transfer.
 *
 * Compares gap before and after application.
 * If 3 consecutive neutral/negative for the same source pattern,
 * marks that pattern as ineffective for transfer.
 */
export async function evaluateTransferEffect(
  transferId: string,
  stateManager: StateManager,
  transferTrust: TransferTrustManager,
  results: Map<string, TransferResult>,
  applyContexts: Map<string, TransferContext>,
  effectivenessRecords: Map<string, TransferEffectivenessRecord>,
  candidates: Map<string, TransferCandidate>,
  patternTrackers: Map<string, PatternEffectivenessTracker>
): Promise<TransferEffectivenessRecord> {
  const result = results.get(transferId);
  const context = applyContexts.get(transferId);

  if (!result || !context) {
    // Return a neutral record when the transfer is unknown
    return TransferEffectivenessSchema.parse({
      transfer_id: transferId,
      gap_delta_before: 0,
      gap_delta_after: 0,
      effectiveness: "neutral" satisfies TransferEffectiveness,
      evaluated_at: new Date().toISOString(),
    });
  }

  const gapNow = await estimateCurrentGap(context.candidate.target_goal_id, stateManager);
  const gapDeltaBefore = context.gap_at_apply;
  const gapDeltaAfter = gapNow;

  // Positive = gap reduced (improvement), negative = gap increased (worse)
  const delta = gapDeltaBefore - gapDeltaAfter;
  let effectiveness: TransferEffectiveness;
  if (delta > 0.05) {
    effectiveness = "positive";
  } else if (delta < -0.05) {
    effectiveness = "negative";
  } else {
    effectiveness = "neutral";
  }

  const record = TransferEffectivenessSchema.parse({
    transfer_id: transferId,
    gap_delta_before: gapDeltaBefore,
    gap_delta_after: gapDeltaAfter,
    effectiveness,
    evaluated_at: new Date().toISOString(),
  });

  effectivenessRecords.set(transferId, record);

  // Track consecutive non-positive outcomes for the source pattern
  if (context.source_pattern !== null) {
    const patternId = context.source_pattern.pattern_id;
    const tracker = patternTrackers.get(patternId) ?? {
      consecutive_non_positive: 0,
      invalidated: false,
    };

    if (effectiveness === "positive") {
      tracker.consecutive_non_positive = 0;
    } else {
      tracker.consecutive_non_positive += 1;
    }

    // Auto-invalidate after 3 consecutive neutral/negative
    if (tracker.consecutive_non_positive >= 3) {
      tracker.invalidated = true;
    }

    patternTrackers.set(patternId, tracker);
  }

  // Update transfer trust score for the domain pair
  const domainPair =
    context.source_pattern !== null &&
    context.source_pattern.applicable_domains.length > 0
      ? [...context.source_pattern.applicable_domains].sort().join("::")
      : `${context.candidate.source_goal_id}::${context.candidate.target_goal_id}`;

  try {
    await transferTrust.updateTrust(domainPair, effectiveness);

    // If this domain pair should now be invalidated, mark the candidate
    const shouldInvalidate = await transferTrust.shouldInvalidate(domainPair);
    if (shouldInvalidate) {
      const candidate = candidates.get(context.candidate.candidate_id);
      if (candidate) {
        const updated = TransferCandidateSchema.parse({
          ...candidate,
          state: "invalidated",
          invalidated_at: new Date().toISOString(),
        });
        candidates.set(candidate.candidate_id, updated);
      }
    }
  } catch {
    // non-fatal: trust update failure should not block effectiveness record
  }

  return record;
}

// ─── Reporting Accessors ───

export function getEffectivenessRecords(
  effectivenessRecords: Map<string, TransferEffectivenessRecord>
): TransferEffectivenessRecord[] {
  return Array.from(effectivenessRecords.values());
}

export function getAppliedTransferCount(
  candidates: Map<string, TransferCandidate>
): number {
  return Array.from(candidates.values()).filter((c) => c.state === "applied").length;
}

export function getTransferSuccessRate(
  effectivenessRecords: Map<string, TransferEffectivenessRecord>
): { total: number; positive: number; negative: number; neutral: number; rate: number } {
  const records = getEffectivenessRecords(effectivenessRecords);
  const total = records.length;
  if (total === 0) return { total: 0, positive: 0, negative: 0, neutral: 0, rate: 0 };
  const positive = records.filter((r) => r.effectiveness === "positive").length;
  const negative = records.filter((r) => r.effectiveness === "negative").length;
  const neutral = records.filter((r) => r.effectiveness === "neutral").length;
  return { total, positive, negative, neutral, rate: positive / total };
}
