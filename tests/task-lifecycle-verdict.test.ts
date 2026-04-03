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

// LLM responses for revert
const REVERT_SUCCESS = '```json\n{"success": true, "reason": "Changes have been reverted successfully"}\n```';
const REVERT_FAILURE = '```json\n{"success": false, "reason": "Unable to undo changes. Files are corrupted."}\n```';

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
      options
    );
  }

  // ─────────────────────────────────────────────
  // handleVerdict
  // ─────────────────────────────────────────────

  describe("handleVerdict", async () => {
    function makeVerificationResult(
      overrides: Partial<import("../src/types/task.js").VerificationResult> = {}
    ): import("../src/types/task.js").VerificationResult {
      return {
        task_id: "task-1",
        verdict: "pass",
        confidence: 0.9,
        evidence: [
          { layer: "mechanical", description: "Tests pass", confidence: 0.9 },
          { layer: "independent_review", description: "Criteria met", confidence: 0.8 },
          { layer: "self_report", description: "Completed", confidence: 0.3 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
        ...overrides,
      };
    }

    it("pass records success with TrustManager", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({ verdict: "pass" });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.action).toBe("completed");
      // Trust should have increased
      const balance = await trustManager.getBalance("normal");
      expect(balance.balance).toBe(3); // +3 for success
    });

    it("pass resets consecutive_failure_count to 0", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 2 });
      const vr = makeVerificationResult({ verdict: "pass" });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.task.consecutive_failure_count).toBe(0);
    });

    it("pass sets task status to completed", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ status: "running" as const });
      const vr = makeVerificationResult({ verdict: "pass" });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.task.status).toBe("completed");
    });

    it("pass persists updated task", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({ verdict: "pass" });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.consecutive_failure_count).toBe(0);
      expect(persisted.status).toBe("completed");
    });

    it("partial with correct direction returns keep", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({
        verdict: "partial",
        evidence: [
          { layer: "independent_review", description: "Partial progress", confidence: 0.7 },
          { layer: "self_report", description: "Some done", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.action).toBe("keep");
    });

    it("partial with wrong direction delegates to handleFailure", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]); // for potential revert
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({
        verdict: "partial",
        evidence: [
          { layer: "independent_review", description: "Wrong direction", confidence: 0.3 },
          { layer: "self_report", description: "Tried", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      // Should delegate to handleFailure (direction wrong)
      expect(["keep", "discard", "escalate"]).toContain(result.action);
    });

    it("fail delegates to handleFailure", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]); // for potential revert
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({
        verdict: "fail",
        evidence: [
          { layer: "independent_review", description: "Failed", confidence: 0.3 },
          { layer: "self_report", description: "Could not complete", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      // Should delegate to handleFailure
      expect(["keep", "discard", "escalate"]).toContain(result.action);
      expect(result.task.consecutive_failure_count).toBe(1);
    });

    it("pass updates task history", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({ verdict: "pass" });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);

      const history = await stateManager.readRaw(`tasks/goal-1/task-history.json`) as Array<Record<string, unknown>>;
      expect(history).not.toBeNull();
      expect(history.length).toBe(1);
      expect(history[0]!.task_id).toBe("task-1");
    });

    it("pass sets completed_at timestamp", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({ verdict: "pass" });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.task.completed_at).toBeDefined();
      expect(typeof result.task.completed_at).toBe("string");
    });

    it("pass updates last_updated on matching goal dimension", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage" });
      const vr = makeVerificationResult({ verdict: "pass" });

      // Write goal with a dimension whose last_updated is null
      const oldTimestamp = null;
      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: oldTimestamp },
          { name: "performance", label: "Performance", current_value: 0.8, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const before = new Date().toISOString();
      await lifecycle.handleVerdict(task, vr);
      const after = new Date().toISOString();

      const goal = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");
      const performanceDim = dims.find((d) => d.name === "performance");

      expect(coverageDim).toBeDefined();
      expect(typeof coverageDim!.last_updated).toBe("string");
      expect(coverageDim!.last_updated as string >= before).toBe(true);
      expect(coverageDim!.last_updated as string <= after).toBe(true);

      // Unrelated dimension should remain untouched
      expect(performanceDim!.last_updated).toBeNull();
    });

    it("pass updates last_updated even when dimension already had a timestamp", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage" });
      const vr = makeVerificationResult({ verdict: "pass" });

      const oldTimestamp = "2020-01-01T00:00:00.000Z";
      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: oldTimestamp },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      expect(coverageDim!.last_updated).not.toBe(oldTimestamp);
      expect(coverageDim!.last_updated as string > oldTimestamp).toBe(true);
    });

    it("pass does not modify goal when goal does not exist in state", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage" });
      const vr = makeVerificationResult({ verdict: "pass" });

      // No goal written to state — should complete without throwing
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.action).toBe("completed");
    });

    it("fail verdict does NOT update goal dimension last_updated", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage" });
      const vr = makeVerificationResult({
        verdict: "fail",
        evidence: [
          { layer: "independent_review", description: "Failed", confidence: 0.8 },
          { layer: "self_report", description: "Could not complete", confidence: 0.3 },
        ],
      });

      const oldTimestamp = "2020-01-01T00:00:00.000Z";
      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: oldTimestamp },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      // Fail path should not touch the goal dimension
      expect(coverageDim!.last_updated).toBe(oldTimestamp);
    });

    // ─── dimension_updates applied to goal state ───

    it("pass verdict applies dimension_updates.new_value to goal current_value", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage", target_dimensions: ["coverage"] });

      // dimension_updates with an explicit new_value
      const vr = makeVerificationResult({
        verdict: "pass",
        dimension_updates: [
          { dimension_name: "coverage", previous_value: 0.3, new_value: 0.7, confidence: 0.9 },
        ],
      });

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      // current_value reflects new_value clamped by Guard 1 (max delta ±0.3):
      // current=0.3, proposed=0.7, delta=0.4 → clamped to 0.3+0.3=0.6
      expect(coverageDim!.current_value).toBeCloseTo(0.6, 10);
    });

    it("pass verdict does not change current_value when dimension_updates has no numeric new_value", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage", target_dimensions: ["coverage"] });

      // dimension_updates for an unrelated dimension
      const vr = makeVerificationResult({
        verdict: "pass",
        dimension_updates: [
          { dimension_name: "other_dim", previous_value: 0.1, new_value: 0.5, confidence: 0.9 },
        ],
      });

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      // coverage was not in dimension_updates, so current_value unchanged
      expect(coverageDim!.current_value).toBe(0.3);
    });

    it("partial verdict with correct direction applies dimension_updates to goal current_value", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "quality", target_dimensions: ["quality"] });

      // direction = correct (partial verdict)
      const vr = makeVerificationResult({
        verdict: "partial",
        evidence: [
          { layer: "independent_review", description: "Some progress made", confidence: 0.6 },
          { layer: "self_report", description: "Partially done", confidence: 0.3 },
        ],
        dimension_updates: [
          { dimension_name: "quality", previous_value: 0.2, new_value: 0.35, confidence: 0.6 },
        ],
      });

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "quality", label: "Quality", current_value: 0.2, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.handleVerdict(task, vr);
      expect(result.action).toBe("keep");

      const goal = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const qualityDim = dims.find((d) => d.name === "quality");

      // current_value must advance
      expect(qualityDim!.current_value).toBe(0.35);
    });

    it("fail verdict does NOT modify goal dimension current_value", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ primary_dimension: "coverage", target_dimensions: ["coverage"] });

      const vr = makeVerificationResult({
        verdict: "fail",
        evidence: [
          { layer: "independent_review", description: "Failed", confidence: 0.8 },
          { layer: "self_report", description: "Could not complete", confidence: 0.3 },
        ],
        dimension_updates: [],
      });

      await stateManager.writeRaw("goals/goal-1.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = await stateManager.readRaw("goals/goal-1.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      // Fail path should leave current_value unchanged
      expect(coverageDim!.current_value).toBe(0.5);
    });
  });

  // ─────────────────────────────────────────────
  // handleFailure
  // ─────────────────────────────────────────────

  describe("handleFailure", async () => {
    function makeVerificationResult(
      overrides: Partial<import("../src/types/task.js").VerificationResult> = {}
    ): import("../src/types/task.js").VerificationResult {
      return {
        task_id: "task-1",
        verdict: "fail",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "Failed", confidence: 0.8 },
          { layer: "self_report", description: "Could not complete", confidence: 0.3 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
        ...overrides,
      };
    }

    it("increments consecutive_failure_count", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 0 });
      const vr = makeVerificationResult();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.task.consecutive_failure_count).toBe(1);
    });

    it("records failure with TrustManager", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const balance = await trustManager.getBalance("normal");
      expect(balance.balance).toBe(-10); // -10 for failure
    });

    it("persists updated task", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 0 });
      const vr = makeVerificationResult();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.consecutive_failure_count).toBe(1);
    });

    it("count >= 3 calls StallDetector and returns escalate", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 2 }); // will become 3
      const vr = makeVerificationResult();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("escalate");
      expect(result.task.consecutive_failure_count).toBe(3);
    });

    it("count >= 3 returns escalate even with correct direction", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 4 }); // will become 5
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Direction correct", confidence: 0.8 },
          { layer: "self_report", description: "Some progress", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("escalate");
    });

    it("count < 3 with correct direction returns keep", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 0 });
      const vr = makeVerificationResult({
        verdict: "partial",
        evidence: [
          { layer: "independent_review", description: "Direction correct", confidence: 0.6 },
          { layer: "self_report", description: "Partial progress", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("keep");
    });

    it("count < 3 with wrong direction and reversible attempts revert", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        consecutive_failure_count: 0,
        reversibility: "reversible",
      });
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Wrong direction", confidence: 0.3 },
          { layer: "self_report", description: "Bad result", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("discard");
    });

    it("revert succeeds returns discard", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        consecutive_failure_count: 0,
        reversibility: "reversible",
      });
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Wrong", confidence: 0.3 },
          { layer: "self_report", description: "Failed", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("discard");
    });

    it("revert fails sets state_integrity uncertain and returns escalate", async () => {
      const llm = createMockLLMClient([REVERT_FAILURE]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        consecutive_failure_count: 0,
        reversibility: "reversible",
      });
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Wrong", confidence: 0.3 },
          { layer: "self_report", description: "Failed", confidence: 0.3 },
        ],
      });

      // Set up a goal with dimensions for state_integrity update
      await stateManager.writeRaw(`goals/goal-1/goal.json`, {
        id: "goal-1",
        title: "Test goal",
        dimensions: [{ name: "dim", state_integrity: "ok" }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("escalate");

      // Verify state_integrity was set to uncertain
      const goal = await stateManager.readRaw(`goals/goal-1/goal.json`) as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      expect(dims[0]!.state_integrity).toBe("uncertain");
    });

    it("direction wrong with irreversible returns escalate", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        consecutive_failure_count: 0,
        reversibility: "irreversible",
      });
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Wrong direction", confidence: 0.3 },
          { layer: "self_report", description: "Bad", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("escalate");
    });

    it("direction wrong with unknown reversibility returns escalate", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        consecutive_failure_count: 0,
        reversibility: "unknown",
      });
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Wrong", confidence: 0.3 },
          { layer: "self_report", description: "Failed", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("escalate");
    });

    it("increments from 1 to 2 correctly", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 1 });
      const vr = makeVerificationResult({
        verdict: "partial",
        evidence: [
          { layer: "independent_review", description: "Some progress", confidence: 0.6 },
          { layer: "self_report", description: "Progress", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.task.consecutive_failure_count).toBe(2);
      expect(result.action).toBe("keep"); // partial verdict = direction correct
    });

    it("multiple failures increment trust correctly", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      for (let i = 0; i < 2; i++) {
        const task = makeTask({ consecutive_failure_count: i });
        const vr = makeVerificationResult({
          evidence: [
            { layer: "independent_review", description: "Correct direction", confidence: 0.8 },
            { layer: "self_report", description: "Progress", confidence: 0.3 },
          ],
        });
        await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
        await lifecycle.handleFailure(task, vr);
      }

      const balance = await trustManager.getBalance("normal");
      expect(balance.balance).toBe(-20); // -10 * 2
    });

    it("appends to task history on failure", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 0 });
      const vr = makeVerificationResult({
        evidence: [
          { layer: "independent_review", description: "Direction OK", confidence: 0.8 },
          { layer: "self_report", description: "Tried", confidence: 0.3 },
        ],
      });

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const history = await stateManager.readRaw(`tasks/goal-1/task-history.json`) as Array<Record<string, unknown>>;
      expect(history).not.toBeNull();
      expect(history.length).toBe(1);
    });
  });
});
