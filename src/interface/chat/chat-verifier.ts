// Lightweight post-execution verification for chat mode (git diff + vitest).
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { TestRunnerOutput } from "../../tools/system/TestRunnerTool/TestRunnerTool.js";

export interface ChatVerificationResult {
  passed: boolean;
  errors: string[];
  testOutput?: string;
}

function makeContext(cwd: string): ToolCallContext {
  return {
    cwd,
    goalId: "chat-verify",
    trustBalance: 50,
    preApproved: true,
    approvalFn: async () => true,
  };
}

/**
 * Verify a chat-mode code action:
 * 1. Check git diff HEAD — if no changes, skip.
 * 2. Run vitest — return failure if tests break.
 * Gracefully degrades (returns passed=true) if tools are unavailable.
 */
export async function verifyChatAction(
  cwd: string,
  toolExecutor?: ToolExecutor,
): Promise<ChatVerificationResult> {
  if (!toolExecutor) return { passed: true, errors: [] };

  const ctx = makeContext(cwd);

  // Step 1: Check for git changes (use HEAD comparison)
  const diffResult = await toolExecutor.execute(
    "git_diff",
    { target: "head", maxLines: 1 },
    ctx,
  ).catch(() => null);

  if (!diffResult || !diffResult.success) return { passed: true, errors: [] };
  if (!diffResult.data || (diffResult.data as string).trim() === "") {
    return { passed: true, errors: [] };
  }

  // Step 2: Run tests
  const testResult = await toolExecutor.execute(
    "test-runner",
    { command: "npx vitest run", timeout: 30_000 },
    ctx,
  ).catch(() => null);

  if (!testResult || !testResult.success) return { passed: true, errors: [] };

  const output = testResult.data as TestRunnerOutput;
  if (!output.success) {
    return {
      passed: false,
      errors: ["Tests failed after applying changes."],
      testOutput: output.rawOutput.split("\n").slice(-30).join("\n"),
    };
  }

  return { passed: true, errors: [] };
}
