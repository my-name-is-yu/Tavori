import type { Logger } from "../../../runtime/logger.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { AgentResult, IAdapter } from "../adapter-layer.js";
import type { SessionManager } from "../session-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import { generateReflection, saveReflectionAsKnowledge } from "../reflection-generator.js";

interface PersistTaskCycleSideEffectsParams {
  goalId: string;
  targetDimension: string;
  task: Task;
  action: string;
  verificationResult: VerificationResult;
  executionResult: AgentResult;
  adapter: IAdapter;
  sessionManager: SessionManager;
  llmClient: ILLMClient;
  knowledgeManager?: KnowledgeManager;
  logger?: Logger;
  gapValue?: number;
}

export async function persistTaskCycleSideEffects(
  params: PersistTaskCycleSideEffectsParams
): Promise<void> {
  const {
    goalId,
    targetDimension,
    task,
    action,
    verificationResult,
    executionResult,
    adapter,
    sessionManager,
    llmClient,
    knowledgeManager,
    logger,
    gapValue,
  } = params;

  const adapterType = adapter?.adapterType ?? "unknown";
  const contextSnapshot = [
    `goal: ${goalId}`,
    `dimension: ${targetDimension}`,
    `strategy: ${task.strategy_id ?? "none"}`,
    `action: ${action}`,
  ].join("\n");
  const intermediateResults: string[] = [];
  if (executionResult?.output) {
    intermediateResults.push(
      typeof executionResult.output === "string"
        ? executionResult.output.slice(0, 2000)
        : JSON.stringify(executionResult.output).slice(0, 2000)
    );
  }

  await sessionManager.saveCheckpoint({
    goalId,
    taskId: task.id,
    agentId: typeof adapterType === "string" ? adapterType : "unknown",
    sessionContextSnapshot: contextSnapshot,
    intermediateResults,
    metadata: { strategy_id: task.strategy_id, gap_value: gapValue },
  }).catch((e) => logger?.warn?.("checkpoint save failed", { error: String(e) }));

  if (!knowledgeManager) return;

  try {
    const reflection = await generateReflection({
      task,
      verificationResult,
      goalId,
      strategyId: task.strategy_id ?? undefined,
      llmClient,
      logger,
    });
    await saveReflectionAsKnowledge(
      knowledgeManager,
      goalId,
      reflection,
      task.work_description,
    );
  } catch (e) {
    logger?.warn?.("Reflection generation failed (non-fatal)", { error: String(e) });
  }
}
