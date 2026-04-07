/**
 * Focused coverage for executeTask guardrail behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { Task } from "../../../base/types/task.js";
import type { IGuardrailHook } from "../../../base/types/guardrail.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      { description: "Tests pass", verification_method: "npx vitest run", is_blocking: true },
    ],
    scope_boundary: { in_scope: ["module A"], out_of_scope: ["module B"], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAdapter(output = "done", elapsed_ms = 100): import("../task/task-lifecycle.js").IAdapter {
  return {
    adapterType: "mock",
    async execute(): Promise<import("../task/task-lifecycle.js").AgentResult> {
      return {
        success: true,
        output,
        error: null,
        exit_code: 0,
        elapsed_ms,
        stopped_reason: "completed",
      };
    },
  };
}

describe("TaskLifecycle — executeTask guardrail behavior", () => {
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
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function createLifecycle(
    llmClient: ReturnType<typeof createMockLLMClient>,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      guardrailRunner?: GuardrailRunner;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { healthCheckEnabled: false, execFileSyncFn: () => "some-file.ts", ...options }
    );
  }

  it("blocks execution when the before_tool guardrail denies the call", async () => {
    const guardrailRunner = new GuardrailRunner();
    const blockingHook: IGuardrailHook = {
      name: "block-all",
      checkpoint: "before_tool",
      priority: 1,
      async execute() {
        return {
          hook_name: "block-all",
          checkpoint: "before_tool",
          allowed: false,
          severity: "critical",
          reason: "Blocked by policy",
        };
      },
    };
    guardrailRunner.register(blockingHook);

    const lifecycle = createLifecycle(createMockLLMClient([]), { guardrailRunner });
    const adapter = createMockAdapter();
    const task = makeTask();

    const result = await lifecycle.executeTask(task, adapter);

    expect(result.success).toBe(false);
    expect(result.error).toBe("guardrail_rejected");
    expect(result.output).toContain("Blocked by policy");
    expect(result.elapsed_ms).toBe(0);
  });

  it("lets execution pass through when the after_tool guardrail allows the result", async () => {
    const guardrailRunner = new GuardrailRunner();
    const allowingHook: IGuardrailHook = {
      name: "allow-after",
      checkpoint: "after_tool",
      priority: 1,
      async execute() {
        return { hook_name: "allow-after", checkpoint: "after_tool", allowed: true, severity: "info" };
      },
    };
    guardrailRunner.register(allowingHook);

    const lifecycle = createLifecycle(createMockLLMClient([]), { guardrailRunner });
    const adapter = createMockAdapter("all good");

    const result = await lifecycle.executeTask(makeTask(), adapter);

    expect(result.success).toBe(true);
    expect(result.output).toBe("all good");
  });

  it("preserves elapsed_ms when the after_tool guardrail rejects", async () => {
    const guardrailRunner = new GuardrailRunner();
    const afterHook: IGuardrailHook = {
      name: "block-after",
      checkpoint: "after_tool",
      priority: 1,
      async execute() {
        return {
          hook_name: "block-after",
          checkpoint: "after_tool",
          allowed: false,
          severity: "critical",
          reason: "Rejected after execution",
        };
      },
    };
    guardrailRunner.register(afterHook);

    const lifecycle = createLifecycle(createMockLLMClient([]), { guardrailRunner });
    const adapter = createMockAdapter("done", 250);

    const result = await lifecycle.executeTask(makeTask(), adapter);

    expect(result.success).toBe(false);
    expect(result.error).toBe("guardrail_rejected");
    expect(result.output).toContain("Rejected after execution");
    expect(result.elapsed_ms).toBe(250);
  });
});
