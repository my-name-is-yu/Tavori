import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { DecisionRecordSchema } from "../types/knowledge.js";
import type { DecisionRecord } from "../types/knowledge.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { IPromptGateway } from "../prompt/gateway.js";
import type { StateManager } from "../state-manager.js";
import { writeJsonFileAtomic } from "../utils/json-io.js";

// ─── LLM response schema ───

const EnrichmentSchema = z.object({
  what_worked: z.array(z.string()).default([]),
  what_failed: z.array(z.string()).default([]),
  suggested_next: z.array(z.string()).default([]),
});

// ─── Deps interface ───

export interface DecisionDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  gateway?: IPromptGateway;
}

// ─── Decision History functions ───

/**
 * Save a DecisionRecord to ~/.pulseed/decisions/<goalId>-<timestamp>.json
 * For completed records (outcome !== "pending"), enriches with LLM-extracted
 * what_worked/what_failed/suggested_next before saving.
 */
export async function recordDecision(
  deps: DecisionDeps,
  record: DecisionRecord
): Promise<void> {
  let toSave = DecisionRecordSchema.parse(record);
  if (toSave.outcome !== "pending") {
    toSave = await enrichDecisionRecord(deps, toSave);
  }
  const decisionsDir = path.join(deps.stateManager.getBaseDir(), "decisions");
  const filename = `${toSave.goal_id}-${toSave.timestamp.replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(decisionsDir, filename);
  await writeJsonFileAtomic(filePath, toSave);
}

/**
 * Enrich a completed DecisionRecord by extracting what_worked/what_failed/suggested_next via LLM.
 * Falls back to default empty arrays on LLM failure.
 */
export async function enrichDecisionRecord(
  deps: DecisionDeps,
  record: DecisionRecord
): Promise<DecisionRecord> {
  const prompt = `From the following task decision record, extract:
- what_worked: things that contributed to a positive outcome
- what_failed: things that caused problems or failures
- suggested_next: actions to try next based on this result

Decision: ${record.decision}, Outcome: ${record.outcome}
Strategy: ${record.strategy_id}
Context: ${JSON.stringify(record.context).slice(0, 500)}

Respond with JSON only: { "what_worked": [...], "what_failed": [...], "suggested_next": [...] }`;

  try {
    let enrichedRaw: { what_worked?: string[]; what_failed?: string[]; suggested_next?: string[] };
    if (deps.gateway) {
      enrichedRaw = await deps.gateway.execute({
        purpose: "knowledge_enrichment",
        additionalContext: { enrichment_prompt: prompt },
        responseSchema: EnrichmentSchema,
        maxTokens: 512,
      });
    } else {
      const response = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { max_tokens: 512 }
      );
      enrichedRaw = deps.llmClient.parseJSON(response.content, EnrichmentSchema);
    }
    const enriched = {
      what_worked: enrichedRaw.what_worked ?? [],
      what_failed: enrichedRaw.what_failed ?? [],
      suggested_next: enrichedRaw.suggested_next ?? [],
    };
    return DecisionRecordSchema.parse({ ...record, ...enriched });
  } catch (err) {
    console.error("[KnowledgeManager] enrichDecisionRecord LLM failed:", err);
    return record;
  }
}

/**
 * Load decision records filtered by goal_type, sorted by recency.
 * Applies time-decay scoring (1.0 at day 0, 0.0 at day 30+).
 */
export async function queryDecisions(
  deps: DecisionDeps,
  goalType: string,
  limit: number = 20
): Promise<DecisionRecord[]> {
  const decisionsDir = path.join(deps.stateManager.getBaseDir(), "decisions");
  let files: string[];
  try {
    files = await fsp.readdir(decisionsDir);
  } catch {
    return [];
  }

  const records: DecisionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await fsp.readFile(path.join(decisionsDir, file), "utf-8");
      const raw = JSON.parse(content) as unknown;
      const record = DecisionRecordSchema.parse(raw);
      if (record.goal_type === goalType) {
        records.push(record);
      }
    } catch {
      // Skip invalid files
    }
  }

  // Sort by recency (newest first), with time-decay weight applied
  records.sort((a, b) => {
    const wa = calculateTimeDecayWeight(a.timestamp);
    const wb = calculateTimeDecayWeight(b.timestamp);
    if (wb !== wa) return wb - wa;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return records.slice(0, limit);
}

/**
 * Update the outcome of a DecisionRecord identified by strategy_id.
 * Finds the most recent pending record for the given strategy and rewrites it.
 * No-op when no matching pending record is found.
 */
export async function updateDecisionOutcome(
  deps: DecisionDeps,
  strategyId: string,
  outcome: "success" | "failure"
): Promise<void> {
  const decisionsDir = path.join(deps.stateManager.getBaseDir(), "decisions");
  let files: string[];
  try {
    files = await fsp.readdir(decisionsDir);
  } catch {
    return;
  }

  // Collect all pending records for this strategy_id
  const matches: Array<{ filePath: string; record: DecisionRecord }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(decisionsDir, file);
    try {
      const content = await fsp.readFile(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      const record = DecisionRecordSchema.parse(raw);
      if (record.strategy_id === strategyId && record.outcome === "pending") {
        matches.push({ filePath, record });
      }
    } catch {
      // Skip invalid files
    }
  }

  if (matches.length === 0) return;

  // Update the most recent matching record
  matches.sort(
    (a, b) =>
      new Date(b.record.timestamp).getTime() -
      new Date(a.record.timestamp).getTime()
  );
  const { filePath, record } = matches[0]!;
  const updated = DecisionRecordSchema.parse({ ...record, outcome });
  await writeJsonFileAtomic(filePath, updated);
}

/**
 * Remove decision records older than 90 days.
 * Returns the count of purged records.
 */
export async function purgeOldDecisions(deps: DecisionDeps): Promise<number> {
  const decisionsDir = path.join(deps.stateManager.getBaseDir(), "decisions");
  let files: string[];
  try {
    files = await fsp.readdir(decisionsDir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(decisionsDir, file);
    try {
      const content = await fsp.readFile(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      const record = DecisionRecordSchema.parse(raw);
      if (new Date(record.timestamp).getTime() < cutoff) {
        await fsp.unlink(filePath);
        purged++;
      }
    } catch {
      // Skip invalid files
    }
  }
  return purged;
}

/**
 * Linear decay: 1.0 at day 0, 0.0 at day 30+.
 */
export function calculateTimeDecayWeight(timestamp: string): number {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / 30);
}
