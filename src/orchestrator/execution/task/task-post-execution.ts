import type { Logger } from "../../../runtime/logger.js";
import type { AgentResult } from "../adapter-layer.js";
import type { ToolExecutor } from "../../../tools/executor.js";

interface HealthCheckHooks {
  enabled: boolean;
  run: () => Promise<{ healthy: boolean; output: string }>;
}

interface SuccessVerificationHooks {
  toolExecutor?: ToolExecutor;
  verifyWithGitDiff: (
    toolExecutor: ToolExecutor | undefined,
    goalId: string
  ) => Promise<{ verified: boolean; diffSummary: string }>;
}

interface FinalizeSuccessfulExecutionParams {
  executionResult: AgentResult;
  goalId: string;
  healthCheck: HealthCheckHooks;
  successVerification: SuccessVerificationHooks;
  logger?: Logger;
}

export async function finalizeSuccessfulExecution(
  params: FinalizeSuccessfulExecutionParams
): Promise<AgentResult> {
  const {
    executionResult,
    goalId,
    healthCheck,
    successVerification,
    logger,
  } = params;

  if (!executionResult.success) return executionResult;

  if (healthCheck.enabled) {
    const result = await healthCheck.run();
    if (!result.healthy) {
      logger?.warn(`[TaskLifecycle] Post-execution health check FAILED: ${result.output}`);
      executionResult.success = false;
      executionResult.output = (executionResult.output || "") +
        `\n\n[Health Check Failed]\n${result.output}`;
      return executionResult;
    }
  }

  if (successVerification.toolExecutor) {
    const diffCheck = await successVerification.verifyWithGitDiff(
      successVerification.toolExecutor,
      goalId
    );
    logger?.info(
      `[TaskLifecycle] Git diff verification: ${diffCheck.diffSummary || "no changes"}`,
      { verified: diffCheck.verified }
    );
    if (!diffCheck.verified) {
      logger?.warn(
        "[TaskLifecycle] Git diff found no file changes after successful task execution",
        { diffSummary: diffCheck.diffSummary }
      );
    }
  }

  return executionResult;
}
