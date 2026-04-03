import { randomUUID } from "node:crypto";
import type { ILLMClient } from "../../llm/llm-client.js";
import { extractJSON } from "../../llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import type { LearningPipeline } from "../learning/learning-pipeline.js";
import type { EthicsGate } from "../../traits/ethics-gate.js";
import type { StateManager } from "../../state/state-manager.js";
import { TransferCandidateSchema, TransferResultSchema } from "../../types/cross-portfolio.js";
import type { TransferCandidate, TransferResult } from "../../types/cross-portfolio.js";
import type { TransferTrustManager } from "./transfer-trust.js";
import {
  AdaptationResponseSchema,
  buildAdaptationPrompt,
} from "./knowledge-transfer-prompts.js";
import type { TransferContext } from "./knowledge-transfer-types.js";
import { estimateCurrentGap } from "./knowledge-transfer-types.js";
import { detectTransferOpportunities } from "./knowledge-transfer-detect.js";
import type { DetectDeps } from "./knowledge-transfer-detect.js";
import type { PatternEffectivenessTracker } from "./knowledge-transfer-types.js";

// ─── Deps ───

export interface ApplyDeps {
  llmClient: ILLMClient;
  learningPipeline: LearningPipeline;
  ethicsGate: EthicsGate;
  stateManager: StateManager;
  transferTrust: TransferTrustManager;
  gateway?: IPromptGateway;
}

// ─── applyTransfer ───

/**
 * Apply a transfer candidate to the target goal.
 *
 * Phase 1: Should only be called after explicit user approval.
 *
 * Steps:
 * 1. Look up candidate
 * 2. Ethics gate check
 * 3. LLM adaptation of source pattern to target context
 * 4. Record and return TransferResult
 */
export async function applyTransfer(
  candidateId: string,
  targetGoalId: string,
  deps: ApplyDeps,
  candidates: Map<string, TransferCandidate>,
  results: Map<string, TransferResult>,
  applyContexts: Map<string, TransferContext>
): Promise<TransferResult> {
  const candidate = candidates.get(candidateId);
  if (!candidate) {
    const failResult = TransferResultSchema.parse({
      transfer_id: `tr_${randomUUID()}`,
      candidate_id: candidateId,
      applied_at: new Date().toISOString(),
      adaptation_description: "Candidate not found",
      success: false,
    });
    results.set(failResult.transfer_id, failResult);
    return failResult;
  }

  // Ethics gate check
  const ethicsDescription = `Transfer pattern "${candidate.source_item_id}" from goal "${candidate.source_goal_id}" to goal "${targetGoalId}". Estimated benefit: ${candidate.estimated_benefit}`;

  let ethicsVerdict: Awaited<ReturnType<EthicsGate["check"]>>;
  try {
    ethicsVerdict = await deps.ethicsGate.check(
      "task",
      candidateId,
      ethicsDescription
    );
  } catch {
    const failResult = TransferResultSchema.parse({
      transfer_id: `tr_${randomUUID()}`,
      candidate_id: candidateId,
      applied_at: new Date().toISOString(),
      adaptation_description: "Ethics gate check failed",
      success: false,
    });
    results.set(failResult.transfer_id, failResult);
    return failResult;
  }

  if (ethicsVerdict.verdict === "reject") {
    const failResult = TransferResultSchema.parse({
      transfer_id: `tr_${randomUUID()}`,
      candidate_id: candidateId,
      applied_at: new Date().toISOString(),
      adaptation_description: `Ethics gate rejected: ${ethicsVerdict.reasoning}`,
      success: false,
    });
    results.set(failResult.transfer_id, failResult);
    return failResult;
  }

  // Find the source pattern
  const sourceGoalId = candidate.source_goal_id;
  const allSourcePatterns =
    await deps.learningPipeline.getPatterns(sourceGoalId);
  const sourcePattern =
    allSourcePatterns.find((p) => p.pattern_id === candidate.source_item_id) ??
    null;

  // Capture gap at apply time for later effectiveness evaluation
  const gapAtApply = await estimateCurrentGap(targetGoalId, deps.stateManager);

  // LLM adaptation
  let adaptationDescription = candidate.estimated_benefit;
  let adaptationSuccess = true;

  if (sourcePattern !== null) {
    try {
      const adaptationPrompt = buildAdaptationPrompt(
        sourcePattern,
        sourceGoalId,
        targetGoalId
      );
      let adaptationParsed: { adaptation_description: string; success: boolean };
      if (deps.gateway) {
        adaptationParsed = await deps.gateway.execute({
          purpose: "knowledge_transfer_adapt",
          goalId: targetGoalId,
          additionalContext: { adaptation_prompt: adaptationPrompt },
          responseSchema: AdaptationResponseSchema,
          maxTokens: 1024,
        });
      } else {
        const adaptationResponse = await deps.llmClient.sendMessage(
          [{ role: "user", content: adaptationPrompt }],
          { max_tokens: 1024 }
        );
        const adaptationJson = extractJSON(adaptationResponse.content);
        const adaptationRaw = JSON.parse(adaptationJson) as unknown;
        adaptationParsed = AdaptationResponseSchema.parse(adaptationRaw);
      }
      adaptationDescription = adaptationParsed.adaptation_description;
      adaptationSuccess = adaptationParsed.success;
    } catch {
      // non-fatal: fall back to estimated_benefit
      adaptationSuccess = true; // assume it can be applied
    }
  }

  const transferId = `tr_${randomUUID()}`;
  const result = TransferResultSchema.parse({
    transfer_id: transferId,
    candidate_id: candidateId,
    applied_at: new Date().toISOString(),
    adaptation_description: adaptationDescription,
    success: adaptationSuccess,
  });

  results.set(result.transfer_id, result);

  // Store context for effectiveness evaluation
  applyContexts.set(result.transfer_id, {
    candidate,
    gap_at_apply: gapAtApply,
    source_pattern: sourcePattern,
  });

  return result;
}

// ─── autoApplyHighConfidenceTransfers ───

/**
 * Phase 2: Automatically apply high-confidence transfer candidates.
 *
 * Candidates with confidence >= 0.85 AND trust_score >= 0.7 are applied
 * automatically (after ethics-gate check). Others remain as proposals.
 */
export async function autoApplyHighConfidenceTransfers(
  goalId: string,
  deps: ApplyDeps,
  detectDeps: DetectDeps,
  candidates: Map<string, TransferCandidate>,
  results: Map<string, TransferResult>,
  applyContexts: Map<string, TransferContext>,
  patternTrackers: Map<string, PatternEffectivenessTracker>
): Promise<TransferCandidate[]> {
  const detectedCandidates = await detectTransferOpportunities(
    goalId,
    detectDeps,
    candidates,
    patternTrackers
  );
  const processed: TransferCandidate[] = [];

  for (const candidate of detectedCandidates) {
    // Get trust score for the candidate's domain pair
    let sourcePattern = null;
    try {
      const patterns = await deps.learningPipeline.getPatterns(candidate.source_goal_id);
      sourcePattern = patterns.find((p) => p.pattern_id === candidate.source_item_id) ?? null;
    } catch {
      // non-fatal
    }

    const domainPair =
      sourcePattern && sourcePattern.applicable_domains.length > 0
        ? [...sourcePattern.applicable_domains].sort().join("::")
        : `${candidate.source_goal_id}::${candidate.target_goal_id}`;

    let trustScore = 0.5;
    try {
      const trustRecord = await deps.transferTrust.getTrustScore(domainPair);
      trustScore = trustRecord.trust_score;
    } catch {
      // non-fatal: use default
    }

    const confidence = sourcePattern?.confidence ?? 0;

    if (confidence >= 0.85 && trustScore >= 0.7) {
      // Auto-apply path: ethics gate check first
      const description = `Auto-apply transfer of pattern "${candidate.source_item_id}" to goal "${goalId}". ${candidate.estimated_benefit}`;
      let verdict: Awaited<ReturnType<EthicsGate["check"]>>;
      try {
        verdict = await deps.ethicsGate.check("task", candidate.candidate_id, description);
      } catch {
        const rejected = TransferCandidateSchema.parse({ ...candidate, state: "rejected" });
        candidates.set(candidate.candidate_id, rejected);
        processed.push(rejected);
        continue;
      }

      if (verdict.verdict === "reject" || verdict.verdict === "flag") {
        const rejected = TransferCandidateSchema.parse({ ...candidate, state: "rejected" });
        candidates.set(candidate.candidate_id, rejected);
        processed.push(rejected);
      } else {
        // Apply the transfer
        try {
          await applyTransfer(candidate.candidate_id, goalId, deps, candidates, results, applyContexts);
          const applied = TransferCandidateSchema.parse({
            ...candidate,
            state: "applied",
            applied_at: new Date().toISOString(),
          });
          candidates.set(candidate.candidate_id, applied);
          processed.push(applied);
        } catch {
          // non-fatal: fall back to proposed
          const proposed = TransferCandidateSchema.parse({
            ...candidate,
            state: "proposed",
            proposed_at: new Date().toISOString(),
          });
          candidates.set(candidate.candidate_id, proposed);
          processed.push(proposed);
        }
      }
    } else {
      // Below threshold: keep as proposed
      const proposed = TransferCandidateSchema.parse({
        ...candidate,
        state: "proposed",
        proposed_at: new Date().toISOString(),
      });
      candidates.set(candidate.candidate_id, proposed);
      processed.push(proposed);
    }
  }

  return processed;
}

// ─── detectCandidatesRealtime ───

/**
 * Phase 2: Realtime detection of transfer candidates for task generation.
 *
 * Returns high-score candidates and their adapted_content as contextSnippets
 * for injection into task generation context.
 */
export async function detectCandidatesRealtime(
  goalId: string,
  detectDeps: DetectDeps,
  candidates: Map<string, TransferCandidate>,
  patternTrackers: Map<string, PatternEffectivenessTracker>
): Promise<{ candidates: TransferCandidate[]; contextSnippets: string[] }> {
  const detectedCandidates = await detectTransferOpportunities(
    goalId,
    detectDeps,
    candidates,
    patternTrackers
  );
  const contextSnippets: string[] = [];

  for (const candidate of detectedCandidates) {
    if (candidate.similarity_score >= 0.7 && candidate.adapted_content !== null) {
      contextSnippets.push(candidate.adapted_content);
    } else if (candidate.similarity_score >= 0.7) {
      contextSnippets.push(candidate.estimated_benefit);
    }
  }

  return { candidates: detectedCandidates, contextSnippets };
}
