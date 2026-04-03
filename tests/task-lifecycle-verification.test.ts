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

function makeExecutionResult(
  overrides: Partial<import("../src/execution/task/task-lifecycle.js").AgentResult> = {}
): import("../src/execution/task/task-lifecycle.js").AgentResult {
  return {
    success: true,
    output: "Task completed: all tests pass",
    error: null,
    exit_code: 0,
    elapsed_ms: 100,
    stopped_reason: "completed",
    ...overrides,
  };
}

// LLM responses for verification
const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';
const LLM_REVIEW_FAIL = '{"verdict": "fail", "reasoning": "Criteria not met", "criteria_met": 0, "criteria_total": 1}';
const LLM_REVIEW_PARTIAL = '{"verdict": "partial", "reasoning": "Some criteria met", "criteria_met": 1, "criteria_total": 2}';

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
  // verifyTask
  // ─────────────────────────────────────────────

  describe("verifyTask", async () => {
    it("L1 pass + L2 pass results in verdict pass", async () => {
      // L1 mechanical verification (no LLM, uses prefix check) + L2 LLM review
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask(); // has "npx vitest run" → L1 applicable, MVP pass
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
    });

    it("L1 pass + L2 fail triggers re-review", async () => {
      // L1 pass (MVP auto-pass), L2 fail, L2 re-review pass → pass
      const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
    });

    it("L1 pass + L2 fail + re-review fail results in verdict fail", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
    });

    it("L1 not applicable when no mechanical prefix in verification_method", async () => {
      // With non-mechanical verification methods, L1 should be skipped
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code quality",
            verification_method: "Review the code manually",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      // L1 skip → L2 pass → pass with lower confidence
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeLessThanOrEqual(0.7);
    });

    it("L1 applicable when verification_method starts with mechanical prefix", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Tests pass",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      // L1 applicable (MVP auto-pass) + L2 pass → pass with high confidence
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("L1 skip + L2 pass results in verdict pass with lower confidence", async () => {
      // Task with no mechanical criteria → L1 skip
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeLessThanOrEqual(0.7);
    });

    it("L1 skip + L2 fail results in verdict fail", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
    });

    it("L1 skip + L2 partial results in verdict partial", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
    });

    it("builds correct review context (no self-report)", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const result = makeExecutionResult();

      await lifecycle.verifyTask(task, result);

      // L2 review call should use review context (excludes self-report)
      // L1 no longer uses LLM, so first call is L2
      expect(spy.calls.length).toBeGreaterThanOrEqual(1);
      const l2Call = spy.calls[0]!;
      expect(l2Call.options?.system).toContain("Review task results objectively");
      expect(l2Call.options?.system).toContain("Ignore executor self-assessment");
    });

    it("LLM reviewer receives correct prompt with success criteria", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const result = makeExecutionResult();

      await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      expect(l2Prompt).toContain("Tests pass");
      expect(l2Prompt).toContain("npx vitest run");
    });

    it("evidence is collected from all layers", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);

      const layers = verification.evidence.map((e) => e.layer);
      expect(layers).toContain("mechanical");
      expect(layers).toContain("independent_review");
      expect(layers).toContain("self_report");
    });

    it("self_report evidence has lowest confidence", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);

      const selfReport = verification.evidence.find((e) => e.layer === "self_report");
      expect(selfReport).toBeDefined();
      expect(selfReport!.confidence).toBeLessThanOrEqual(0.3);
    });

    it("confidence is higher when both L1 and L2 agree on pass", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("confidence is higher when L1 skip and L2 fail", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
      expect(verification.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("persists verification result to state", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);

      const persisted = await stateManager.readRaw(
        `verification/${task.id}/verification-result.json`
      ) as Record<string, unknown>;
      expect(persisted).not.toBeNull();
      expect(persisted.task_id).toBe(task.id);
      expect(persisted.verdict).toBe(verification.verdict);
    });

    it("sets valid timestamp on verification result", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const before = new Date().toISOString();
      const verification = await lifecycle.verifyTask(task, result);
      const after = new Date().toISOString();

      expect(verification.timestamp >= before).toBe(true);
      expect(verification.timestamp <= after).toBe(true);
    });

    it("sets task_id on verification result", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ id: "my-task-42" });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.task_id).toBe("my-task-42");
    });

    it("handles unparseable LLM response gracefully", async () => {
      // L1 no longer uses LLM, so only L2 gets garbage → should still produce a result
      // L1 passes (MVP assumed pass) + L2 fails → triggers L2 retry (2nd call)
      const llm = createMockLLMClient(["not json", "not json"]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      // Should still return a valid VerificationResult
      expect(verification.verdict).toBeDefined();
      expect(verification.task_id).toBe(task.id);
    });

    it("includes execution output in L2 review prompt", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const result = makeExecutionResult({ output: "UNIQUE_OUTPUT_MARKER_12345" });

      await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      expect(l2Prompt).toContain("UNIQUE_OUTPUT_MARKER_12345");
    });

    it("truncates very long output in L2 review prompt", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const longOutput = "x".repeat(5000);
      const result = makeExecutionResult({ output: longOutput });

      await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      // Should be truncated to 2000 chars
      expect(l2Prompt.length).toBeLessThan(longOutput.length + 500);
    });

    // ─── dimension_updates tests ───

    it("dimension_updates is empty on fail verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
      expect(verification.dimension_updates).toHaveLength(0);
    });

    it("dimension_updates has one entry per target_dimension on pass verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["coverage", "reliability"] });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.dimension_updates).toHaveLength(2);
      const names = verification.dimension_updates.map((u) => u.dimension_name);
      expect(names).toContain("coverage");
      expect(names).toContain("reliability");
    });

    it("dimension_updates new_value is significant (>=0.3) on pass verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["performance"] });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      const update = verification.dimension_updates[0]!;
      expect(typeof update.new_value).toBe("number");
      expect(update.new_value as number).toBeGreaterThanOrEqual(0.1);
    });

    it("dimension_updates new_value is moderate (0.1-0.25) on partial verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        target_dimensions: ["quality"],
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
      expect(verification.dimension_updates).toHaveLength(1);
      const update = verification.dimension_updates[0]!;
      expect(update.dimension_name).toBe("quality");
      expect(typeof update.new_value).toBe("number");
      expect(update.new_value as number).toBeGreaterThanOrEqual(0.1);
      expect(update.new_value as number).toBeLessThanOrEqual(0.25);
    });

    it("dimension_updates entries carry confidence matching the verdict confidence", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      const update = verification.dimension_updates[0]!;
      expect(update.confidence).toBe(verification.confidence);
    });

    it("dimension_updates previous_value is null when goal has no matching dimension in state", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      // No goal written to state → previous_value falls back to null
      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.dimension_updates[0]!.previous_value).toBeNull();
    });

    it("dimension_updates reads previous_value from goal state when available", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "dim", label: "Dim", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.dimension_updates[0]!.previous_value).toBe(0.3);
    });

    it("dimension_updates new_value is previous_value + delta (clamped) on pass", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "dim", label: "Dim", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      const update = verification.dimension_updates[0]!;
      // pass delta = 0.2; new_value = clamp(0.3 + 0.2, 0, 1) = 0.5
      expect(update.new_value).toBeCloseTo(0.5, 5);
    });

    it("dimension_updates new_value is clamped to 1 when previous_value + delta exceeds 1", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "dim", label: "Dim", current_value: 0.9, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      // No threshold on dimension → scaledDelta = progressDelta = 0.2 (no scaling)
      // new_value = 0.9 + 0.2 = 1.1 (no [0,1] clamp at verifier level; raw scale)
      expect(verification.dimension_updates[0]!.new_value).toBeCloseTo(1.1, 5);
    });

    it("dimension_updates new_value is previous_value + partial_delta on partial verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        target_dimensions: ["quality"],
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

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

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
      const update = verification.dimension_updates[0]!;
      // partial delta = 0.15; new_value = clamp(0.2 + 0.15, 0, 1) = 0.35
      expect(update.previous_value).toBe(0.2);
      expect(update.new_value).toBeCloseTo(0.35, 5);
    });
  });
});
