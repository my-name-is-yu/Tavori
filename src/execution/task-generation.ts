import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../runtime/logger.js";
import { buildTaskGenerationPrompt } from "./task-prompt-builder.js";
import type { ILLMClient } from "../llm/llm-client.js";
import { StateManager } from "../state-manager.js";
import { StrategyManager } from "../strategy/strategy-manager.js";
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";

// ─── Schema for LLM-generated task fields ───

export const LLMGeneratedTaskSchema = z.object({
  work_description: z.string(),
  rationale: z.string(),
  approach: z.string(),
  success_criteria: z.array(
    z.object({
      description: z.string(),
      verification_method: z.string(),
      is_blocking: z.boolean().default(true),
    })
  ),
  scope_boundary: z.object({
    in_scope: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    blast_radius: z.string(),
  }),
  constraints: z.array(z.string()),
  reversibility: z.enum(["reversible", "irreversible", "unknown"]).default("reversible"),
  estimated_duration: z
    .object({
      value: z.number(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
    })
    .nullable()
    .default(null),
});

// ─── Deps interface ───

export interface TaskGenerationDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  strategyManager: StrategyManager;
  logger?: Logger;
}

// ─── generateTask ───

/**
 * Generate a task for the given goal and target dimension via LLM.
 *
 * @param deps - dependencies (stateManager, llmClient, strategyManager, logger)
 * @param goalId - the goal this task belongs to
 * @param targetDimension - the dimension this task should improve
 * @param strategyId - optional override; if not provided, uses active strategy
 * @returns the generated and persisted Task
 */
export async function generateTask(
  deps: TaskGenerationDeps,
  goalId: string,
  targetDimension: string,
  strategyId?: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string
): Promise<Task> {
  const prompt = await buildTaskGenerationPrompt(
    deps.stateManager,
    goalId,
    targetDimension,
    knowledgeContext,
    adapterType,
    existingTasks,
    workspaceContext
  );

  const response = await deps.llmClient.sendMessage(
    [{ role: "user", content: prompt }],
    {
      system:
        "You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task. Respond with a JSON object inside a markdown code block.",
      max_tokens: 2048,
    }
  );

  let generated: ReturnType<typeof LLMGeneratedTaskSchema.parse>;
  try {
    generated = deps.llmClient.parseJSON(response.content, LLMGeneratedTaskSchema) as ReturnType<typeof LLMGeneratedTaskSchema.parse>;
  } catch (err) {
    deps.logger?.error(
      "Task generation failed: LLM response did not match expected schema.",
      { rawResponse: response.content.substring(0, 500) }
    );
    throw err;
  }

  // Resolve strategy_id
  const activeStrategy = await deps.strategyManager.getActiveStrategy(goalId);
  const resolvedStrategyId = strategyId ?? activeStrategy?.id ?? null;

  const taskId = randomUUID();
  const now = new Date().toISOString();

  const task = TaskSchema.parse({
    id: taskId,
    goal_id: goalId,
    strategy_id: resolvedStrategyId,
    target_dimensions: [targetDimension],
    primary_dimension: targetDimension,
    work_description: generated.work_description,
    rationale: generated.rationale,
    approach: generated.approach,
    success_criteria: generated.success_criteria,
    scope_boundary: generated.scope_boundary,
    constraints: generated.constraints,
    reversibility: generated.reversibility,
    estimated_duration: generated.estimated_duration,
    status: "pending",
    created_at: now,
  });

  // Persist
  await deps.stateManager.writeRaw(`tasks/${goalId}/${taskId}.json`, task);

  return task;
}
