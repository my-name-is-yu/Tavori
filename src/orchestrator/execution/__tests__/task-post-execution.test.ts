import { describe, expect, it, vi } from "vitest";
import { finalizeSuccessfulExecution } from "../task/task-post-execution.js";
import type { AgentResult } from "../task/task-lifecycle.js";

function makeExecutionResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    output: "Task completed successfully",
    error: null,
    exit_code: 0,
    elapsed_ms: 100,
    stopped_reason: "completed",
    ...overrides,
  };
}

describe("finalizeSuccessfulExecution", () => {
  it("marks execution as failed when the health check fails and skips git diff verification", async () => {
    const verifyWithGitDiff = vi.fn();
    const executionResult = makeExecutionResult();

    const result = await finalizeSuccessfulExecution({
      executionResult,
      goalId: "goal-1",
      healthCheck: {
        enabled: true,
        run: vi.fn().mockResolvedValue({ healthy: false, output: "Build failed" }),
      },
      successVerification: {
        toolExecutor: {} as never,
        verifyWithGitDiff,
      },
    });

    expect(result.success).toBe(false);
    expect(String(result.output)).toContain("[Health Check Failed]");
    expect(verifyWithGitDiff).not.toHaveBeenCalled();
  });

  it("runs git diff verification after a successful health check", async () => {
    const verifyWithGitDiff = vi.fn().mockResolvedValue({
      verified: true,
      diffSummary: "1 file changed",
    });

    await finalizeSuccessfulExecution({
      executionResult: makeExecutionResult(),
      goalId: "goal-2",
      healthCheck: {
        enabled: true,
        run: vi.fn().mockResolvedValue({ healthy: true, output: "ok" }),
      },
      successVerification: {
        toolExecutor: {} as never,
        verifyWithGitDiff,
      },
    });

    expect(verifyWithGitDiff).toHaveBeenCalledWith(expect.anything(), "goal-2");
  });
});
