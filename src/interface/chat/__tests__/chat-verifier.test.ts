import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyChatAction } from "../chat-verifier.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { TestRunnerOutput } from "../../../tools/system/test-runner.js";

// Helper to build a mock ToolExecutor
function makeMockExecutor(
  diffResult: { success: boolean; data: unknown } | null,
  testResult: { success: boolean; data: TestRunnerOutput } | null,
): ToolExecutor {
  const execute = vi.fn();
  if (diffResult !== null) {
    execute.mockResolvedValueOnce({ success: diffResult.success, data: diffResult.data, summary: "", durationMs: 0 });
  }
  if (testResult !== null) {
    execute.mockResolvedValueOnce({ success: testResult.success, data: testResult.data, summary: "", durationMs: 0 });
  }
  return { execute } as unknown as ToolExecutor;
}

function passedTestOutput(): TestRunnerOutput {
  return { passed: 42, failed: 0, skipped: 0, total: 42, success: true, rawOutput: "42 tests passed" };
}

function failedTestOutput(): TestRunnerOutput {
  return {
    passed: 0,
    failed: 3,
    skipped: 0,
    total: 3,
    success: false,
    rawOutput: "FAIL src/foo.test.ts\n3 failed | 0 passed",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyChatAction", () => {
  it("returns passed=true when no toolExecutor provided (graceful degradation)", async () => {
    const result = await verifyChatAction("/fake/cwd");
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=true when tests pass after changes", async () => {
    const executor = makeMockExecutor(
      { success: true, data: "diff --git a/src/foo.ts b/src/foo.ts\n1 file changed" },
      { success: true, data: passedTestOutput() },
    );
    const result = await verifyChatAction("/fake/cwd", executor);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=false with testOutput when tests fail", async () => {
    const executor = makeMockExecutor(
      { success: true, data: "diff --git a/src/foo.ts b/src/foo.ts\n1 file changed" },
      { success: true, data: failedTestOutput() },
    );
    const result = await verifyChatAction("/fake/cwd", executor);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.testOutput).toBeTruthy();
  });

  it("returns passed=true when git diff tool fails (graceful degradation)", async () => {
    const executor = makeMockExecutor({ success: false, data: null }, null);
    const result = await verifyChatAction("/fake/cwd", executor);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=true when test runner tool fails (graceful degradation)", async () => {
    const executor = makeMockExecutor(
      { success: true, data: "1 file changed" },
      { success: false, data: { passed: 0, failed: 0, skipped: 0, total: 0, success: false, rawOutput: "" } },
    );
    const result = await verifyChatAction("/fake/cwd", executor);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=true when there are no git changes", async () => {
    const executor = makeMockExecutor({ success: true, data: "" }, null);
    const result = await verifyChatAction("/fake/cwd", executor);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns passed=true when git diff throws (graceful degradation)", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("git: command not found"));
    const executor = { execute } as unknown as ToolExecutor;
    const result = await verifyChatAction("/fake/cwd", executor);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
