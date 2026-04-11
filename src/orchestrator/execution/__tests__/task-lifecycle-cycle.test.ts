import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Spy LLM Client ───

function createSpyLLMClient(responses: string[]): ILLMClient & { calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> } {
  let callIndex = 0;
  const calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  return {
    calls,
    async sendMessage(
      messages: LLMMessage[],
      options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      calls.push({ messages, options });
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [
        null,
        content,
      ];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

// ─── Fixtures ───

const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Write unit tests for the authentication module",
  "rationale": "Improve test coverage to catch regressions early",
  "approach": "Use vitest to write tests for login, logout, and token refresh flows",
  "success_criteria": [
    {
      "description": "All auth flows have at least one test",
      "verification_method": "Run vitest and check test count",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["auth module tests"],
    "out_of_scope": ["auth module implementation changes"],
    "blast_radius": "tests/ directory only"
  },
  "constraints": ["Must not modify production code"],
  "reversibility": "reversible",
  "estimated_duration": { "value": 2, "unit": "hours" }
}
\`\`\``;

const IRREVERSIBLE_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Delete deprecated database tables",
  "rationale": "Clean up schema after migration",
  "approach": "Run DROP TABLE statements for deprecated tables",
  "success_criteria": [
    {
      "description": "Tables no longer exist",
      "verification_method": "Query information_schema",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["deprecated tables"],
    "out_of_scope": ["active tables"],
    "blast_radius": "database schema"
  },
  "constraints": ["Must backup before dropping"],
  "reversibility": "irreversible",
  "estimated_duration": { "value": 30, "unit": "minutes" }
}
\`\`\``;

const UNKNOWN_REVERSIBILITY_RESPONSE = `\`\`\`json
{
  "work_description": "Refactor config loading",
  "rationale": "Simplify configuration management",
  "approach": "Consolidate config files",
  "success_criteria": [
    {
      "description": "Config loads correctly",
      "verification_method": "Integration test",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["config loading"],
    "out_of_scope": ["feature flags"],
    "blast_radius": "startup flow"
  },
  "constraints": [],
  "reversibility": "unknown",
  "estimated_duration": null
}
\`\`\``;

const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';
const LLM_REVIEW_FAIL = '{"verdict": "fail", "reasoning": "Criteria not met", "criteria_met": 0, "criteria_total": 1}';
const LLM_REVIEW_PARTIAL = '{"verdict": "partial", "reasoning": "Some criteria met", "criteria_met": 1, "criteria_total": 2}';
const REVERT_SUCCESS = '```json\n{"success": true, "reason": "Changes have been reverted successfully"}\n```';

function makeGapVector(
  goalId: string,
  dimensions: Array<{ name: string; gap: number }>
): GapVector {
  return {
    goal_id: goalId,
    gaps: dimensions.map((d) => ({
      dimension_name: d.name,
      raw_gap: d.gap,
      normalized_gap: d.gap,
      normalized_weighted_gap: d.gap,
      confidence: 0.8,
      uncertainty_weight: 1.0,
    })),
    timestamp: new Date().toISOString(),
  };
}

function makeDriveContext(
  dimensionNames: string[]
): DriveContext {
  const time_since_last_attempt: Record<string, number> = {};
  const deadlines: Record<string, number | null> = {};
  const opportunities: Record<string, { value: number; detected_at: string }> = {};

  for (const name of dimensionNames) {
    time_since_last_attempt[name] = 24;
    deadlines[name] = null;
  }

  return { time_since_last_attempt, deadlines, opportunities, pacing: {} };
}

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
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
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

function createMockAdapter(
  results: Array<Partial<import("../task/task-lifecycle.js").AgentResult>>
): import("../task/task-lifecycle.js").IAdapter {
  let callIndex = 0;
  return {
    adapterType: "mock",
    async execute(
      _task: import("../task/task-lifecycle.js").AgentTask
    ): Promise<import("../task/task-lifecycle.js").AgentResult> {
      const r = results[callIndex++] ?? {};
      return {
        success: true,
        output: "Task completed successfully",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
        ...r,
      };
    },
  };
}

// ─── Test Suite ───

describe("TaskLifecycle", async () => {
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
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  function createLifecycle(
    llmClient: ILLMClient,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      logger?: import("../../../runtime/logger.js").Logger;
      adapterRegistry?: import("../task/task-lifecycle.js").AdapterRegistry;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
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
      { healthCheckEnabled: false, ...options }
    );
  }

  // ─────────────────────────────────────────────
  // runTaskCycle
  // ─────────────────────────────────────────────

  describe("runTaskCycle", async () => {
    it("happy path: select -> generate -> approve -> execute -> verify pass -> completed", async () => {
      // LLM responses: 1) task generation, 2) L2 review (L1 no longer uses LLM)
      const llm = createMockLLMClient([
        VALID_TASK_RESPONSE,
        LLM_REVIEW_PASS,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([{ success: true, output: "Tests added" }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("completed");
      expect(result.verificationResult.verdict).toBe("pass");
      expect(result.task).toBeDefined();
      expect(result.task.goal_id).toBe("goal-1");
    });

    it("approval denied returns early with approval_denied", async () => {
      const llm = createMockLLMClient([IRREVERSIBLE_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "schema", gap: 0.5 }]);
      const context = makeDriveContext(["schema"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("approval_denied");
    });

    it("execution fails -> verify -> handleFailure", async () => {
      // LLM: 1) task gen, 2) L1 skip (no mechanical criteria for this task), 3) L2 fail
      const llm = createMockLLMClient([
        UNKNOWN_REVERSIBILITY_RESPONSE,
        LLM_REVIEW_FAIL,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "config", gap: 0.5 }]);
      const context = makeDriveContext(["config"]);
      const adapter = createMockAdapter([{
        success: false,
        output: "",
        error: "Failed to execute",
        stopped_reason: "error",
      }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      // Unknown reversibility + wrong direction → escalate
      expect(result.action).toBe("escalate");
      expect(result.verificationResult.verdict).toBe("fail");
    });

    it("full cycle with partial keep", async () => {
      // Task with "Integration test" verification method — no mechanical prefix → L1 skip
      // LLM responses: 1) task gen, 2) L2 partial (L1 no longer uses LLM)
      const llm = createMockLLMClient([
        UNKNOWN_REVERSIBILITY_RESPONSE, // task gen
        LLM_REVIEW_PARTIAL,             // L2 review
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "config", gap: 0.5 }]);
      const context = makeDriveContext(["config"]);
      const adapter = createMockAdapter([{
        success: true,
        output: "Partially done",
      }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      // L1 pass + L2 partial → partial verdict (L2 partial overrides when L1 pass)
      expect(["keep", "discard", "escalate"]).toContain(result.action);
      expect(result.verificationResult.verdict).toBe("partial");
    });

    it("returns TaskCycleResult with all required fields", async () => {
      const llm = createMockLLMClient([
        VALID_TASK_RESPONSE,
        LLM_REVIEW_PASS,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result).toHaveProperty("task");
      expect(result).toHaveProperty("verificationResult");
      expect(result).toHaveProperty("action");
      expect(result.task.id).toBeDefined();
      expect(result.verificationResult.task_id).toBeDefined();
    });

    it("selects highest gap dimension", async () => {
      const llm = createMockLLMClient([
        VALID_TASK_RESPONSE,
        LLM_REVIEW_PASS,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [
        { name: "low_gap", gap: 0.1 },
        { name: "high_gap", gap: 0.9 },
      ]);
      const context = makeDriveContext(["low_gap", "high_gap"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.task.primary_dimension).toBe("high_gap");
    });

    it("backs off a recently failed dimension and selects the next best gap", async () => {
      await stateManager.writeRaw("tasks/goal-1/task-history.json", [
        {
          task_id: "failed-task",
          work_description: "Old failed runtime task",
          status: "error",
          primary_dimension: "high_gap",
          consecutive_failure_count: 1,
          verification_verdict: "fail",
          completed_at: new Date().toISOString(),
        },
      ]);
      const llm = createMockLLMClient([
        VALID_TASK_RESPONSE,
        LLM_REVIEW_PASS,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [
        { name: "next_gap", gap: 0.7 },
        { name: "high_gap", gap: 0.9 },
      ]);
      const context = makeDriveContext(["next_gap", "high_gap"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.task.primary_dimension).toBe("next_gap");
    });

    it("does not back off dimensions with recent completed pass history", async () => {
      await stateManager.writeRaw("tasks/goal-1/task-history.json", [
        {
          task_id: "passed-task",
          work_description: "Old passing runtime task",
          status: "completed",
          primary_dimension: "high_gap",
          consecutive_failure_count: 0,
          verification_verdict: "pass",
          completed_at: new Date().toISOString(),
        },
      ]);
      const llm = createMockLLMClient([
        VALID_TASK_RESPONSE,
        LLM_REVIEW_PASS,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      const gapVector = makeGapVector("goal-1", [
        { name: "next_gap", gap: 0.7 },
        { name: "high_gap", gap: 0.9 },
      ]);
      const context = makeDriveContext(["next_gap", "high_gap"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.task.primary_dimension).toBe("high_gap");
    });
  });

});
