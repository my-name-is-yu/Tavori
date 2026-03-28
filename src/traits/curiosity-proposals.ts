import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { Logger } from "../runtime/logger.js";
import type { VectorIndex } from "../knowledge/vector-index.js";
import type { KnowledgeTransfer } from "../knowledge/knowledge-transfer.js";
import {
  CuriosityTriggerSchema,
  CuriosityProposalSchema,
  CuriosityConfigSchema,
} from "../types/curiosity.js";
import type {
  CuriosityTrigger,
  CuriosityProposal,
  CuriosityConfig,
  CuriosityState,
  LearningRecord,
} from "../types/curiosity.js";
import type { Goal } from "../types/goal.js";

// ─── LLM Proposal Schema (for parsing LLM output) ───

const LLMProposalItemSchema = z.object({
  description: z.string(),
  rationale: z.string(),
  suggested_dimensions: z
    .array(
      z.object({
        name: z.string(),
        threshold_type: z.string(),
        target: z.number(),
      })
    )
    .default([]),
  scope_domain: z.string(),
  detection_method: z
    .enum([
      "observation_log",
      "stall_pattern",
      "cross_goal_transfer",
      "llm_heuristic",
      "periodic_review",
      "embedding_similarity",
    ])
    .default("llm_heuristic"),
});

const LLMProposalsResponseSchema = z.union([
  z.array(LLMProposalItemSchema),
  z
    .object({ proposals: z.array(LLMProposalItemSchema) })
    .transform((o) => o.proposals),
]);

type LLMProposalItem = z.infer<typeof LLMProposalItemSchema>;

// ─── Deps for standalone functions ───

export interface ProposalGenerationDeps {
  llmClient: ILLMClient;
  ethicsGate: EthicsGate;
  vectorIndex?: VectorIndex;
  knowledgeTransfer?: KnowledgeTransfer;
  config: CuriosityConfig;
  logger?: Logger;
  gateway?: IPromptGateway;
}

// ─── Prompt Builder ───

export function buildProposalPrompt(
  trigger: CuriosityTrigger,
  goals: Goal[],
  learningRecords: LearningRecord[]
): string {
  const activeGoalsSummary = goals
    .filter((g) => g.status === "active" || g.status === "waiting")
    .map((g) => {
      const dimNames = g.dimensions.map((d) => d.name).join(", ");
      return `- Goal "${g.id}" (${g.title}): dimensions=[${dimNames}], origin=${g.origin ?? "user"}`;
    })
    .join("\n");

  const recentLearning = learningRecords
    .slice(-10) // last 10 records
    .map(
      (r) =>
        `- Goal ${r.goal_id}, dim "${r.dimension_name}", approach "${r.approach}": ${r.outcome} (improvement_ratio=${r.improvement_ratio.toFixed(2)})`
    )
    .join("\n");

  return `You are PulSeed, an AI agent orchestrator analyzing curiosity triggers to propose new exploration goals.

## Current Trigger
Type: ${trigger.type}
Details: ${trigger.details}
Severity: ${trigger.severity}
${trigger.source_goal_id ? `Source goal: ${trigger.source_goal_id}` : ""}

## Active Goals
${activeGoalsSummary || "(none)"}

## Recent Learning Records
${recentLearning || "(none)"}

## Task
Based on the trigger and learning history, propose 1-3 curiosity goals that:
1. Are grounded in the trigger and learning evidence (not generic advice)
2. Are directly related to the user's current goal domains or 1-step adjacent
3. Have clear rationale based on observed patterns

Return a JSON array of proposal objects. Each object must have:
- description: string — what to explore (specific, actionable)
- rationale: string — why this is worth exploring (cite the trigger/learning evidence)
- suggested_dimensions: array of { name: string, threshold_type: string, target: number }
- scope_domain: string — domain this exploration belongs to
- detection_method: one of "observation_log" | "stall_pattern" | "cross_goal_transfer" | "llm_heuristic" | "periodic_review"

Return only valid JSON array, no markdown, no explanation outside the JSON.`;
}

// ─── Proposal Hash Utilities ───

/**
 * Compute a simple hash for a proposal description to track rejected proposals.
 * Uses a normalized lowercase version of the first 100 chars.
 */
export function computeProposalHash(description: string): string {
  const normalized = description.toLowerCase().trim().slice(0, 100);
  // Simple djb2-style hash as a hex string
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 33) ^ normalized.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Check if a proposal description is currently in rejection cooldown.
 */
export function isInRejectionCooldown(
  description: string,
  rejectedHashes: string[]
): boolean {
  const hash = computeProposalHash(description);
  return rejectedHashes.includes(hash);
}

// ─── Core Proposal Generation ───

/**
 * Generate curiosity proposals using the LLM, filtered by ethics gate.
 *
 * - Respects max_active_proposals limit (skips generation if at capacity)
 * - Skips proposals in rejection cooldown
 * - Runs ethics check on each proposal before adding
 * - Updates last_exploration_at on any periodic_exploration trigger
 * - Mutates state.proposals and state.last_exploration_at in place
 */
export async function generateProposals(
  triggers: CuriosityTrigger[],
  goals: Goal[],
  state: CuriosityState,
  activeProposalCount: number,
  deps: ProposalGenerationDeps
): Promise<CuriosityProposal[]> {
  const config: CuriosityConfig = CuriosityConfigSchema.parse(deps.config);

  if (!config.enabled || triggers.length === 0) return [];
  if (activeProposalCount >= config.max_active_proposals) return [];

  const newProposals: CuriosityProposal[] = [];
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.proposal_expiry_hours * 60 * 60 * 1000
  );

  // Update last_exploration_at for periodic triggers
  const hasPeriodicTrigger = triggers.some(
    (t) => t.type === "periodic_exploration"
  );
  if (hasPeriodicTrigger) {
    state.last_exploration_at = now.toISOString();
  }

  // Process each trigger (stop when at capacity)
  for (const trigger of triggers) {
    if (
      activeProposalCount + newProposals.length >=
      config.max_active_proposals
    ) {
      break;
    }

    let llmItems: LLMProposalItem[] = [];

    try {
      const prompt = buildProposalPrompt(trigger, goals, state.learning_records);
      if (deps.gateway) {
        llmItems = await deps.gateway.execute({
          purpose: "curiosity_propose",
          additionalContext: { proposal_prompt: prompt },
          responseSchema: LLMProposalsResponseSchema,
          temperature: 0.3,
        }) as LLMProposalItem[];
      } else {
        const response = await deps.llmClient.sendMessage(
          [{ role: "user", content: prompt }],
          { temperature: 0.3, model_tier: 'light' }
        );
        llmItems = deps.llmClient.parseJSON(
          response.content,
          LLMProposalsResponseSchema
        ) as LLMProposalItem[];
      }
    } catch (err) {
      // Don't throw on LLM failure — return what we have so far
      deps.logger?.warn(
        `CuriosityEngine: LLM proposal generation failed for trigger "${trigger.type}": ${err}`
      );
      continue;
    }

    for (const item of llmItems) {
      if (
        activeProposalCount + newProposals.length >=
        config.max_active_proposals
      ) {
        break;
      }

      // Skip if in rejection cooldown
      if (isInRejectionCooldown(item.description, state.rejected_proposal_hashes)) {
        continue;
      }

      // Run ethics check
      const proposalId = randomUUID();
      let ethicsVerdict: { verdict: string } = { verdict: "pass" };
      try {
        ethicsVerdict = await deps.ethicsGate.check(
          "goal",
          proposalId,
          item.description,
          `Curiosity proposal triggered by: ${trigger.type}`
        );
      } catch (err) {
        // On ethics check failure, skip this proposal (conservative)
        deps.logger?.warn(
          `CuriosityEngine: ethics check failed for proposal "${item.description.slice(0, 60)}": ${err}`
        );
        continue;
      }

      if (ethicsVerdict.verdict === "reject") {
        continue;
      }

      // Phase 2: use embedding_similarity detection method when vectorIndex
      // is available and the trigger is undefined_problem
      const detectionMethod =
        deps.vectorIndex && trigger.type === "undefined_problem"
          ? "embedding_similarity"
          : item.detection_method;

      const proposal = CuriosityProposalSchema.parse({
        id: proposalId,
        trigger,
        proposed_goal: {
          description: item.description,
          rationale: item.rationale,
          suggested_dimensions: item.suggested_dimensions,
          scope_domain: item.scope_domain,
          detection_method: detectionMethod,
        },
        status: "pending",
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        reviewed_at: null,
        rejection_cooldown_until: null,
        loop_count: 0,
        goal_id: null,
      });

      newProposals.push(proposal);
      state.proposals.push(proposal);
    }
  }

  // ─── Stage 14F: Transfer-based curiosity proposals ───
  // If knowledgeTransfer is available, detect cross-goal transfer opportunities
  // and add them as curiosity proposals (suggestion-only, Phase 1).
  if (deps.knowledgeTransfer && goals.length > 0) {
    const activeGoals = goals.filter((g) => g.status === "active");
    for (const goal of activeGoals) {
      if (
        activeProposalCount + newProposals.length >=
        config.max_active_proposals
      ) {
        break;
      }

      try {
        const transferCandidates =
          await deps.knowledgeTransfer.detectTransferOpportunities(goal.id);

        for (const candidate of transferCandidates) {
          if (
            activeProposalCount + newProposals.length >=
            config.max_active_proposals
          ) {
            break;
          }

          const description = `Apply pattern from goal ${candidate.source_goal_id} to goal ${candidate.target_goal_id}: ${candidate.estimated_benefit}`;

          // Skip if in rejection cooldown
          if (isInRejectionCooldown(description, state.rejected_proposal_hashes)) {
            continue;
          }

          // Create a synthetic trigger for the transfer-based proposal.
          // Uses "periodic_exploration" type as the closest match for
          // cross-goal opportunity discovery (no dedicated transfer type exists).
          const transferTrigger = CuriosityTriggerSchema.parse({
            type: "periodic_exploration",
            detected_at: now.toISOString(),
            source_goal_id: candidate.source_goal_id,
            details: `Cross-goal transfer candidate (similarity=${candidate.similarity_score.toFixed(2)}): ${candidate.estimated_benefit}`,
            severity: candidate.similarity_score,
          });

          const proposalId = randomUUID();
          const proposal = CuriosityProposalSchema.parse({
            id: proposalId,
            trigger: transferTrigger,
            proposed_goal: {
              description,
              rationale: `Cross-goal knowledge transfer opportunity detected (similarity=${candidate.similarity_score.toFixed(2)}). ${candidate.estimated_benefit}`,
              suggested_dimensions: [],
              scope_domain: goal.id,
              detection_method: "cross_goal_transfer",
            },
            status: "pending",
            created_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
            reviewed_at: null,
            rejection_cooldown_until: null,
            loop_count: 0,
            goal_id: null,
          });

          newProposals.push(proposal);
          state.proposals.push(proposal);
        }
      } catch {
        // Non-fatal: transfer detection failure should not block curiosity generation
      }
    }
  }

  return newProposals;
}
