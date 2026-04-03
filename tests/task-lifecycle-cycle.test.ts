import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../src/state/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { TaskLifecycle } from "../src/execution/task/task-lifecycle.js";
import type { Task } from "../src/types/task.js";
import type { GapVector } from "../src/types/gap.js";
import type { DriveContext } from "../src/types/drive.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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

  return { time_since_last_attempt, deadlines, opportunities };
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
  results: Array<Partial<import("../src/execution/task/task-lifecycle.js").AgentResult>>
): import("../src/execution/task/task-lifecycle.js").IAdapter {
  let callIndex = 0;
  return {
    adapterType: "mock",
    async execute(
      _task: import("../src/execution/task/task-lifecycle.js").AgentTask
    ): Promise<import("../src/execution/task/task-lifecycle.js").AgentResult> {
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLifecycle(
    llmClient: ILLMClient,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      logger?: import("../src/runtime/logger.js").Logger;
      adapterRegistry?: import("../src/execution/task/task-lifecycle.js").AdapterRegistry;
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
  });

  // ─────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────

  describe("persistence", async () => {
    it("verification result saved to correct path", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ id: "task-persist-test" });
      const result: import("../src/execution/task/task-lifecycle.js").AgentResult = {
        success: true,
        output: "done",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
      };

      await lifecycle.verifyTask(task, result);

      const saved = await stateManager.readRaw("verification/task-persist-test/verification-result.json");
      expect(saved).not.toBeNull();
      expect((saved as Record<string, unknown>).task_id).toBe("task-persist-test");
    });

    it("task history accumulates entries", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      // Simulate two pass verdicts
      for (let i = 1; i <= 2; i++) {
        const task = makeTask({ id: `task-${i}` });
        const vr: import("../src/types/task.js").VerificationResult = {
          task_id: `task-${i}`,
          verdict: "pass",
          confidence: 0.9,
          evidence: [
            { layer: "independent_review", description: "OK", confidence: 0.8 },
          ],
          dimension_updates: [],
          timestamp: new Date().toISOString(),
        };

        await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
        await lifecycle.handleVerdict(task, vr);
      }

      const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
      expect(history.length).toBe(2);
      expect(history[0]!.task_id).toBe("task-1");
      expect(history[1]!.task_id).toBe("task-2");
    });

    it("task history records primary_dimension", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage" });
      const vr: import("../src/types/task.js").VerificationResult = {
        task_id: "task-1",
        verdict: "pass",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "OK", confidence: 0.8 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);

      const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
      expect(history[0]!.primary_dimension).toBe("coverage");
    });

    it("task history records consecutive_failure_count on failure", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 1 });
      const vr: import("../src/types/task.js").VerificationResult = {
        task_id: "task-1",
        verdict: "fail",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "Direction OK", confidence: 0.8 },
          { layer: "self_report", description: "Tried", confidence: 0.3 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
      expect(history[0]!.consecutive_failure_count).toBe(2);
    });

    it("executeTask persists running state before execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let statusDuringExecution = "";
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          // Check status during execution
          const raw = await stateManager.readRaw("tasks/goal-1/task-1.json") as Record<string, unknown>;
          statusDuringExecution = raw?.status as string;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      expect(statusDuringExecution).toBe("running");
    });
  });

  // ─────────────────────────────────────────────
  // failure handling paths
  // ─────────────────────────────────────────────

  describe("failure handling paths", async () => {
    // ── Test 1: L1 mechanical verification ─────────────────────────────────

    it("L1 mechanical criteria detected: evidence includes mechanical layer", async () => {
      // Task has a shell-command verification method → L1 applicable (assumed pass).
      // L2 returns "pass" → overall verdict is "pass".
      const llm = createMockLLMClient([
        LLM_REVIEW_PASS, // L2 review
      ]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        id: "task-l1-mech",
        success_criteria: [
          {
            description: "Tests pass",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.verifyTask(task, {
        success: true,
        output: "All tests passed",
        error: null,
        exit_code: 0,
        elapsed_ms: 50,
        stopped_reason: "completed",
      });

      // Evidence should include the mechanical layer
      const layers = result.evidence.map((e) => e.layer);
      expect(layers).toContain("mechanical");
      expect(layers).toContain("independent_review");
      // L1 assumed pass + L2 pass → "pass"
      expect(result.verdict).toBe("pass");
    });

    it("L1 mechanical criteria detected + L2 fail → re-review → overall fail", async () => {
      // L1 assumed pass + L2 fail → triggers re-review; if re-review also fails → "fail"
      const llm = createMockLLMClient([
        LLM_REVIEW_FAIL, // first L2 review
        LLM_REVIEW_FAIL, // re-review
      ]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        id: "task-l1-mech-fail",
        success_criteria: [
          {
            description: "Build succeeds",
            verification_method: "npx tsc --noEmit",
            is_blocking: true,
          },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.verifyTask(task, {
        success: false,
        output: "TypeScript errors found",
        error: "Compilation failed",
        exit_code: 1,
        elapsed_ms: 30,
        stopped_reason: "error",
      });

      expect(result.verdict).toBe("fail");
    });

    it("L1 not applicable (no shell command): evidence has no mechanical layer, confidence 0.6 on pass", async () => {
      const llm = createMockLLMClient([
        LLM_REVIEW_PASS, // L2 returns pass
      ]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        id: "task-l1-skip",
        success_criteria: [
          {
            description: "Peer review approved",
            verification_method: "Manual code review",
            is_blocking: true,
          },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.verifyTask(task, {
        success: true,
        output: "Review done",
        error: null,
        exit_code: 0,
        elapsed_ms: 20,
        stopped_reason: "completed",
      });

      // L1 skipped → pass with lower confidence (0.6)
      expect(result.verdict).toBe("pass");
      expect(result.confidence).toBe(0.6);
      const layers = result.evidence.map((e) => e.layer);
      expect(layers).not.toContain("mechanical");
    });

    // ── Test 2: keep / discard / escalate paths ─────────────────────────────

    it("partial verdict with direction correct (partial = direction correct) → action is keep", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ id: "task-keep" });

      const vr: import("../src/types/task.js").VerificationResult = {
        task_id: "task-keep",
        verdict: "partial",
        confidence: 0.5,
        evidence: [
          { layer: "independent_review", description: "Partial progress", confidence: 0.6 },
        ],
        dimension_updates: [
          { dimension_name: "dim", previous_value: 0.5, new_value: 0.65, confidence: 0.5 },
        ],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      // Save a goal so dimension updates can be applied
      await stateManager.writeRaw("goals/goal-1.json", {
        id: "goal-1",
        dimensions: [{ name: "dim", current_value: 0.5 }],
      });

      const result = await lifecycle.handleVerdict(task, vr);
      expect(result.action).toBe("keep");
    });

    it("fail verdict with reversible task → revert succeeds → action is discard", async () => {
      // handleFailure: fail verdict → direction wrong (verdict="fail"), reversible →
      // attemptRevert → revert succeeds → discard.
      const llm = createMockLLMClient([
        REVERT_SUCCESS, // attemptRevert calls llm.sendMessage
      ]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        id: "task-discard",
        reversibility: "reversible",
        consecutive_failure_count: 0,
      });

      const vr: import("../src/types/task.js").VerificationResult = {
        task_id: "task-discard",
        verdict: "fail",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "Nothing worked", confidence: 0.8 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);
      expect(result.action).toBe("discard");
    });

    it("consecutive_failure_count reaches 3 → action is escalate", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      // Already at 2; handleFailure will increment to 3 → escalate before direction check
      const task = makeTask({
        id: "task-escalate",
        consecutive_failure_count: 2,
        reversibility: "reversible",
      });

      const vr: import("../src/types/task.js").VerificationResult = {
        task_id: "task-escalate",
        verdict: "fail",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "Repeated failures", confidence: 0.8 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);
      expect(result.action).toBe("escalate");
      expect(result.task.consecutive_failure_count).toBe(3);
    });

    it("fail verdict with irreversible task and direction wrong → action is escalate without revert", async () => {
      // No LLM response needed — irreversible goes straight to escalate
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        id: "task-irreversible-fail",
        reversibility: "irreversible",
        consecutive_failure_count: 0,
      });

      const vr: import("../src/types/task.js").VerificationResult = {
        task_id: "task-irreversible-fail",
        verdict: "fail",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "Did not meet criteria", confidence: 0.8 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);
      expect(result.action).toBe("escalate");
    });

    // ── Test 3: Adapter timeout ─────────────────────────────────────────────

    it("adapter that rejects with an Error → executeTask catches and returns error result", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const timeoutAdapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
        adapterType: "mock-timeout",
        async execute() {
          throw new Error("Adapter execution timed out after 30000ms");
        },
      };

      const task = makeTask({ id: "task-timeout" });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTask(task, timeoutAdapter);

      // executeTask catches the error and returns a graceful failure result
      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("timed out");
    });

    it("adapter timeout followed by verifyTask produces a fail verdict", async () => {
      // When adapter throws, execution result is {success: false}.
      // verifyTask then calls LLM review with this failed output.
      const llm = createMockLLMClient([
        LLM_REVIEW_FAIL, // L2 review for the failed execution
      ]);
      const lifecycle = createLifecycle(llm);

      const timeoutAdapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
        adapterType: "mock-timeout",
        async execute() {
          throw new Error("Connection timeout");
        },
      };

      const task = makeTask({
        id: "task-timeout-verify",
        success_criteria: [
          {
            description: "Deployment successful",
            verification_method: "Check deployment status manually",
            is_blocking: true,
          },
        ],
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const executionResult = await lifecycle.executeTask(task, timeoutAdapter);
      expect(executionResult.success).toBe(false);

      const verificationResult = await lifecycle.verifyTask(task, executionResult);
      expect(verificationResult.verdict).toBe("fail");
    });

    it("adapter that throws a non-Error value is handled gracefully", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const badAdapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
        adapterType: "mock-bad",
        async execute() {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "string error value";
        },
      };

      const task = makeTask({ id: "task-bad-throw" });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTask(task, badAdapter);

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(typeof result.error).toBe("string");
    });
  });
});
