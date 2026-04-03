import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../src/state/state-manager.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { verifyTask } from "../../src/execution/task/task-verifier.js";
import type { VerifierDeps } from "../../src/execution/task/task-verifier.js";
import type { Task } from "../../src/types/task.js";
import type { Logger } from "../../src/runtime/logger.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeTempDir } from "../helpers/temp-dir.js";

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
    success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }],
    scope_boundary: { in_scope: ["module A"], out_of_scope: ["module B"], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
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

describe("Task verifier malformed JSON regression", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logs malformed JSON, falls back to fail, and continues with a later valid response", async () => {
    const llmClient = createMockLLMClient([
      "not-json{{{bad",
      JSON.stringify({ verdict: "pass", reasoning: "recovered", criteria_met: 1, criteria_total: 1 }),
    ]);
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Test",
      status: "active",
      dimensions: [
        {
          name: "dim",
          label: "dim",
          current_value: 0.5,
          threshold: { type: "min", value: 1.0 },
          last_updated: null,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const deps: VerifierDeps = {
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      stallDetector,
      logger: mockLogger,
      durationToMs: (d) => d.value * 3600000,
    };

    const task = makeTask();
    const failedResult = await verifyTask(deps, task, {
      success: false,
      output: "",
      error: null,
      exit_code: 1,
      stopped_reason: "end_turn",
      session_id: "s1",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      tokens_used: 0,
    });

    expect(failedResult.verdict).toBe("fail");
    expect(failedResult.confidence).toBeGreaterThan(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("JSON.parse failed"));

    const passedResult = await verifyTask(deps, task, {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      stopped_reason: "end_turn",
      session_id: "s2",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      tokens_used: 0,
    });

    expect(passedResult.verdict).toBe("pass");
  });
});
