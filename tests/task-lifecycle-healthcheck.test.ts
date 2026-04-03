import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "../src/state/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { TaskLifecycle } from "../src/execution/task/task-lifecycle.js";
import type { Task } from "../src/types/task.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm/llm-client.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Minimal mock LLM ───

function createMockLLMClient(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

// ─── Fixtures ───

function makeMinimalTask(goalId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: "task-hc-001",
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: "Add unit tests",
    rationale: "Improve coverage",
    approach: "Write vitest tests",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["tests/"],
      out_of_scope: ["src/"],
      blast_radius: "tests only",
    },
    constraints: [],
    reversibility: "reversible",
    estimated_duration: null,
    status: "pending",
    created_at: new Date().toISOString(),
    task_category: "code",
    consecutive_failure_count: 0,
    ...overrides,
  };
}

function makeMockAdapter(): import("../src/execution/task/task-lifecycle.js").IAdapter {
  return {
    adapterType: "mock",
    async execute(): Promise<import("../src/execution/task/task-lifecycle.js").AgentResult> {
      return {
        success: true,
        output: "Task completed successfully",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
      };
    },
  };
}

// ─── Test Suite ───

describe("TaskLifecycle — post-execution health check", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Default mock execFileSyncFn: simulates a changed file so the post-execution
  // scope check does not force success=false when no real git repo is available.
  const mockExecFileSync = (_cmd: string, _args: string[], _opts: { cwd: string; encoding: "utf-8" }): string => "some-file.ts";

  function createLifecycle(options?: {
    healthCheckEnabled?: boolean;
    approvalFn?: (task: Task) => Promise<boolean>;
  }): TaskLifecycle {
    const llm = createMockLLMClient([]);
    strategyManager = new StrategyManager(stateManager, llm);
    stallDetector = new StallDetector(stateManager);
    return new TaskLifecycle(
      stateManager,
      llm,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { execFileSyncFn: mockExecFileSync, ...options }
    );
  }

  // ─────────────────────────────────────────────
  // 1. Health check is skipped when disabled (default)
  // ─────────────────────────────────────────────

  it("health check is skipped by default (healthCheckEnabled=false)", async () => {
    const lifecycle = createLifecycle(); // no healthCheckEnabled → defaults to false
    const adapter = makeMockAdapter();
    const task = makeMinimalTask("goal-1");

    // Spy on runPostExecutionHealthCheck — it must NOT be called
    const healthCheckSpy = vi.spyOn(lifecycle, "runPostExecutionHealthCheck");

    // We mock runShellCommand just in case it is somehow invoked
    vi.spyOn(lifecycle, "runShellCommand").mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
    });

    // Write a minimal goal so executeTask/verifyTask don't crash on state reads
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Test Goal",
      dimensions: [
        {
          name: "coverage",
          current_value: 0.5,
          threshold: { type: "min", value: 0.8 },
        },
      ],
    });
    await stateManager.writeRaw("goals/goal-1/strategy.json", null);

    await lifecycle.executeTask(task, adapter);

    expect(healthCheckSpy).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  // 2. Health check runs when enabled and execution succeeds
  // ─────────────────────────────────────────────

  it("health check runs when healthCheckEnabled=true and execution succeeds (via runTaskCycle)", async () => {
    // LLM responses: 1) task generation, 2) L2 review
    const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Add tests",
  "rationale": "Improve coverage",
  "approach": "Write vitest tests",
  "success_criteria": [
    {
      "description": "Tests pass",
      "verification_method": "integration test",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["tests/"],
    "out_of_scope": ["src/"],
    "blast_radius": "tests only"
  },
  "constraints": [],
  "reversibility": "reversible",
  "estimated_duration": null
}
\`\`\``;
    const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';

    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    strategyManager = new StrategyManager(stateManager, llm);
    stallDetector = new StallDetector(stateManager);
    const lifecycle = new TaskLifecycle(
      stateManager,
      llm,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      {
        healthCheckEnabled: true,
        approvalFn: async () => true,
        execFileSyncFn: mockExecFileSync,
      }
    );

    const healthCheckSpy = vi
      .spyOn(lifecycle, "runPostExecutionHealthCheck")
      .mockResolvedValue({ healthy: true, output: "Build and tests passed" });

    const now = new Date().toISOString();
    await stateManager.writeRaw("goals/goal-2/goal.json", {
      id: "goal-2",
      title: "Test Goal 2",
      status: "active",
      dimensions: [
        {
          name: "coverage",
          label: "Coverage",
          current_value: 0.5,
          threshold: { type: "min", value: 0.8 },
          confidence: 0.8,
          observation_method: { type: "mechanical", source: "test", schedule: null, endpoint: null, confidence_tier: "mechanical" },
          last_updated: now,
          history: [],
          weight: 1.0,
        },
      ],
      gap_aggregation: "max",
      constraints: [],
      children_ids: [],
      created_at: now,
      updated_at: now,
    });

    const gapVector = {
      goal_id: "goal-2",
      gaps: [
        {
          dimension_name: "coverage",
          raw_gap: 0.5,
          normalized_gap: 0.5,
          normalized_weighted_gap: 0.5,
          confidence: 0.8,
          uncertainty_weight: 1.0,
        },
      ],
      timestamp: new Date().toISOString(),
    };
    const driveContext = {
      time_since_last_attempt: { coverage: 24 },
      deadlines: { coverage: null },
      opportunities: {},
    };
    const adapter = makeMockAdapter();

    const result = await lifecycle.runTaskCycle("goal-2", gapVector, driveContext, adapter);

    // Health check was invoked because execution succeeded
    expect(healthCheckSpy).toHaveBeenCalledOnce();
    // The cycle completed successfully
    expect(result.action).toBe("completed");
  });

  // ─────────────────────────────────────────────
  // 3. Build failure marks task as failed
  // ─────────────────────────────────────────────

  it("build failure causes executionResult.success=false", async () => {
    const lifecycle = createLifecycle({ healthCheckEnabled: true });

    // Mock runShellCommand: first call (build) fails
    vi.spyOn(lifecycle, "runShellCommand").mockResolvedValueOnce({
      success: false,
      stdout: "src/index.ts(10,1): error TS2322",
      stderr: "",
    });

    const result = await lifecycle.runPostExecutionHealthCheck(
      makeMockAdapter(),
      makeMinimalTask("goal-3")
    );

    expect(result.healthy).toBe(false);
    expect(result.output).toContain("Build failed");
  });

  // ─────────────────────────────────────────────
  // 4. Test failure marks task as failed
  // ─────────────────────────────────────────────

  it("test failure causes healthy=false when build passes but tests fail", async () => {
    const lifecycle = createLifecycle({ healthCheckEnabled: true });

    // First call (build) succeeds, second call (tests) fails
    const shellMock = vi
      .spyOn(lifecycle, "runShellCommand")
      .mockResolvedValueOnce({ success: true, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        success: false,
        stdout: "",
        stderr: "FAIL src/gap-calculator.test.ts — 2 tests failed",
      });

    const result = await lifecycle.runPostExecutionHealthCheck(
      makeMockAdapter(),
      makeMinimalTask("goal-4")
    );

    expect(result.healthy).toBe(false);
    expect(result.output).toContain("Tests failed");
    // Both build and test commands were called
    expect(shellMock).toHaveBeenCalledTimes(2);
  });

  // ─────────────────────────────────────────────
  // 5. Health check is skipped when execution already failed
  // ─────────────────────────────────────────────

  it("health check does NOT run when adapter execution fails", async () => {
    const lifecycle = createLifecycle({ healthCheckEnabled: true });

    const failingAdapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute(): Promise<import("../src/execution/task/task-lifecycle.js").AgentResult> {
        return {
          success: false,
          output: "",
          error: "adapter failed",
          exit_code: 1,
          elapsed_ms: 50,
          stopped_reason: "error",
        };
      },
    };

    const healthCheckSpy = vi.spyOn(lifecycle, "runPostExecutionHealthCheck");

    await stateManager.writeRaw("goals/goal-5/goal.json", {
      id: "goal-5",
      title: "Test Goal 5",
      dimensions: [
        {
          name: "coverage",
          current_value: 0.5,
          threshold: { type: "min", value: 0.8 },
        },
      ],
    });

    const result = await lifecycle.executeTask(
      makeMinimalTask("goal-5"),
      failingAdapter
    );

    // Health check must NOT have been called since execution already failed
    expect(healthCheckSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  // ─────────────────────────────────────────────
  // 6. Health check timeout is handled gracefully
  // ─────────────────────────────────────────────

  it("health check returns healthy=false when runShellCommand throws (timeout/error)", async () => {
    const lifecycle = createLifecycle({ healthCheckEnabled: true });

    vi.spyOn(lifecycle, "runShellCommand").mockRejectedValue(
      new Error("ETIMEDOUT: command timed out")
    );

    const result = await lifecycle.runPostExecutionHealthCheck(
      makeMockAdapter(),
      makeMinimalTask("goal-6")
    );

    expect(result.healthy).toBe(false);
    expect(result.output).toContain("Build check error");
  });

  // ─────────────────────────────────────────────
  // 7. runShellCommand returns success for passing commands
  // ─────────────────────────────────────────────

  it("runShellCommand returns success=true when command exits 0", async () => {
    const lifecycle = createLifecycle();

    // Use a simple command guaranteed to succeed on any platform
    const result = await lifecycle.runShellCommand(["node", "--version"], {
      timeout: 10000,
      cwd: process.cwd(),
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
  });

  // ─────────────────────────────────────────────
  // 8. runShellCommand returns failure for failing commands
  // ─────────────────────────────────────────────

  it("runShellCommand returns success=false when command exits non-zero", async () => {
    const lifecycle = createLifecycle();

    // node --eval with process.exit(1) causes exit 1
    const result = await lifecycle.runShellCommand(
      ["node", "--eval", "process.exit(1)"],
      { timeout: 10000, cwd: process.cwd() }
    );

    expect(result.success).toBe(false);
  });
});
