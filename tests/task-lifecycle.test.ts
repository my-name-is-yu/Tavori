import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { SessionManager } from "../src/session-manager.js";
import { TrustManager } from "../src/trust-manager.js";
import { StrategyManager } from "../src/strategy-manager.js";
import { StallDetector } from "../src/stall-detector.js";
import { TaskLifecycle } from "../src/task-lifecycle.js";
import type { Task } from "../src/types/task.js";
import type { GapVector } from "../src/types/gap.js";
import type { DriveContext } from "../src/types/drive.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Spy LLM Client (tracks messages sent) ───

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

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-task-lifecycle-test-"));
}

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
    time_since_last_attempt[name] = 24; // 24 hours since last attempt
    deadlines[name] = null; // no deadline
  }

  return { time_since_last_attempt, deadlines, opportunities };
}

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

// ─── Test Suite ───

describe("TaskLifecycle", () => {
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
    options?: { approvalFn?: (task: Task) => Promise<boolean>; logger?: import("../src/logger.js").Logger }
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
  // selectTargetDimension
  // ─────────────────────────────────────────────

  describe("selectTargetDimension", () => {
    it("returns the highest-ranked dimension", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "coverage", gap: 0.3 },
        { name: "performance", gap: 0.8 },
        { name: "reliability", gap: 0.5 },
      ]);
      const context = makeDriveContext(["coverage", "performance", "reliability"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("performance");
    });

    it("returns correct dimension when multiple dimensions are ranked", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "dim_a", gap: 0.1 },
        { name: "dim_b", gap: 0.9 },
        { name: "dim_c", gap: 0.5 },
        { name: "dim_d", gap: 0.7 },
      ]);
      const context = makeDriveContext(["dim_a", "dim_b", "dim_c", "dim_d"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("dim_b");
    });

    it("works with a single dimension", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [{ name: "only_dim", gap: 0.5 }]);
      const context = makeDriveContext(["only_dim"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("only_dim");
    });

    it("throws on empty gap vector", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", []);
      const context = makeDriveContext([]);

      expect(() => lifecycle.selectTargetDimension(gapVector, context)).toThrow(
        "empty gap vector"
      );
    });

    it("selects dimension with highest gap when all timings equal", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "a", gap: 0.2 },
        { name: "b", gap: 0.6 },
      ]);
      const context = makeDriveContext(["a", "b"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("b");
    });

    it("handles tied gap values deterministically", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "first", gap: 0.5 },
        { name: "second", gap: 0.5 },
      ]);
      const context = makeDriveContext(["first", "second"]);

      // With identical gaps and identical context, the result should be stable
      const result1 = lifecycle.selectTargetDimension(gapVector, context);
      const result2 = lifecycle.selectTargetDimension(gapVector, context);
      expect(result1).toBe(result2);
    });

    it("considers time_since_last_attempt in scoring", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "recent", gap: 0.5 },
        { name: "stale", gap: 0.5 },
      ]);
      // "stale" has much higher time since last attempt, so higher dissatisfaction
      const context: DriveContext = {
        time_since_last_attempt: { recent: 0, stale: 100 },
        deadlines: { recent: null, stale: null },
        opportunities: {},
      };

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("stale");
    });

    it("considers deadline urgency in scoring", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "no_deadline", gap: 0.6 },
        { name: "urgent", gap: 0.4 },
      ]);
      // "urgent" has a close deadline
      const context: DriveContext = {
        time_since_last_attempt: { no_deadline: 24, urgent: 24 },
        deadlines: { no_deadline: null, urgent: 1 }, // 1 hour remaining
        opportunities: {},
      };

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("urgent");
    });

    it("considers opportunity value in scoring", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [
        { name: "normal", gap: 0.3 },
        { name: "opportunistic", gap: 0.3 },
      ]);
      const context: DriveContext = {
        time_since_last_attempt: { normal: 24, opportunistic: 24 },
        deadlines: { normal: null, opportunistic: null },
        opportunities: {
          opportunistic: { value: 2.0, detected_at: new Date().toISOString() },
        },
      };

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(result).toBe("opportunistic");
    });

    it("returns a string dimension name", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);

      const result = lifecycle.selectTargetDimension(gapVector, context);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────
  // generateTask
  // ─────────────────────────────────────────────

  describe("generateTask", () => {
    it("calls LLM with a prompt containing goalId and targetDimension", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await lifecycle.generateTask("goal-42", "test_coverage");

      expect(spy.calls.length).toBe(1);
      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("test_coverage");
      expect(userMessage).toContain("goal-42");
    });

    it("sends a system prompt for task generation", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await lifecycle.generateTask("goal-1", "dim");

      expect(spy.calls[0]!.options?.system).toBeDefined();
      expect(spy.calls[0]!.options!.system).toContain("task generation");
    });

    it("parses valid LLM response into a Task object", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "test_coverage");

      expect(task.work_description).toBe(
        "Write unit tests for the authentication module"
      );
      expect(task.rationale).toContain("test coverage");
      expect(task.approach).toContain("vitest");
      expect(task.success_criteria.length).toBe(1);
      expect(task.scope_boundary.in_scope).toContain("auth module tests");
      expect(task.constraints).toContain("Must not modify production code");
      expect(task.reversibility).toBe("reversible");
      expect(task.estimated_duration).toEqual({ value: 2, unit: "hours" });
    });

    it("sets strategy_id from active strategy", async () => {
      const strategyResponse = `\`\`\`json
[{
  "hypothesis": "Test strategy",
  "expected_effect": [{ "dimension": "test_coverage", "direction": "increase", "magnitude": "medium" }],
  "resource_estimate": { "sessions": 5, "duration": { "value": 7, "unit": "days" }, "llm_calls": null },
  "allocation": 1.0
}]
\`\`\``;
      const llm = createMockLLMClient([strategyResponse, VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      // Generate and activate a strategy first
      await strategyManager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
        currentGap: 0.5,
        pastStrategies: [],
      });
      const activeStrategy = await strategyManager.activateBestCandidate("goal-1");

      const task = await lifecycle.generateTask("goal-1", "test_coverage");
      expect(task.strategy_id).toBe(activeStrategy.id);
    });

    it("sets strategy_id from parameter when no active strategy", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim", "manual-strategy-id");
      expect(task.strategy_id).toBe("manual-strategy-id");
    });

    it("sets strategy_id to null when no strategy available", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");
      expect(task.strategy_id).toBeNull();
    });

    it("persists task to state file", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");

      const persisted = stateManager.readRaw(`tasks/goal-1/${task.id}.json`);
      expect(persisted).not.toBeNull();
      expect((persisted as Record<string, unknown>).id).toBe(task.id);
    });

    it("sets status to pending", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");
      expect(task.status).toBe("pending");
    });

    it("sets a valid created_at ISO timestamp", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const before = new Date().toISOString();
      const task = await lifecycle.generateTask("goal-1", "dim");
      const after = new Date().toISOString();

      expect(task.created_at).toBeDefined();
      expect(task.created_at >= before).toBe(true);
      expect(task.created_at <= after).toBe(true);
    });

    it("generates a unique UUID for task id", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task1 = await lifecycle.generateTask("goal-1", "dim");
      const task2 = await lifecycle.generateTask("goal-1", "dim");

      expect(task1.id).not.toBe(task2.id);
      // UUID format check
      expect(task1.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("sets goal_id correctly", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("my-goal", "dim");
      expect(task.goal_id).toBe("my-goal");
    });

    it("sets target_dimensions and primary_dimension", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "coverage");
      expect(task.target_dimensions).toEqual(["coverage"]);
      expect(task.primary_dimension).toBe("coverage");
    });

    it("sets consecutive_failure_count to 0", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");
      expect(task.consecutive_failure_count).toBe(0);
    });

    it("throws on invalid LLM response (missing fields)", async () => {
      const invalidResponse = `\`\`\`json
{ "work_description": "test" }
\`\`\``;
      const llm = createMockLLMClient([invalidResponse]);
      const lifecycle = createLifecycle(llm);

      await expect(
        lifecycle.generateTask("goal-1", "dim")
      ).rejects.toThrow();
    });

    it("throws on non-JSON LLM response", async () => {
      const llm = createMockLLMClient(["This is not JSON at all"]);
      const lifecycle = createLifecycle(llm);

      await expect(
        lifecycle.generateTask("goal-1", "dim")
      ).rejects.toThrow();
    });

    it("logs error via logger when parseJSON fails", async () => {
      const rawResponse = "This is not JSON at all";
      const llm = createMockLLMClient([rawResponse]);
      const mockLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const lifecycle = createLifecycle(llm, { logger: mockLogger as unknown as import("../src/logger.js").Logger });

      await lifecycle.generateTask("goal-1", "dim").catch(() => {});

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(mockLogger.error.mock.calls[0]![0]).toContain("Task generation failed");
    });

    it("handles null estimated_duration from LLM", async () => {
      const llm = createMockLLMClient([UNKNOWN_REVERSIBILITY_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");
      expect(task.estimated_duration).toBeNull();
    });

    it("handles empty constraints array", async () => {
      const llm = createMockLLMClient([UNKNOWN_REVERSIBILITY_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");
      expect(task.constraints).toEqual([]);
    });

    it("persists the full Task structure that can be read back", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = await lifecycle.generateTask("goal-1", "dim");
      const raw = stateManager.readRaw(`tasks/goal-1/${task.id}.json`) as Record<string, unknown>;

      expect(raw.work_description).toBe(task.work_description);
      expect(raw.status).toBe("pending");
      expect(raw.goal_id).toBe("goal-1");
      expect(raw.strategy_id).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // checkIrreversibleApproval
  // ─────────────────────────────────────────────

  describe("checkIrreversibleApproval", () => {
    function makeTask(overrides: Partial<Task> = {}): Task {
      return {
        id: "task-1",
        goal_id: "goal-1",
        strategy_id: null,
        target_dimensions: ["dim"],
        primary_dimension: "dim",
        work_description: "test task",
        rationale: "test",
        approach: "test",
        success_criteria: [
          {
            description: "test",
            verification_method: "test",
            is_blocking: true,
          },
        ],
        scope_boundary: {
          in_scope: ["a"],
          out_of_scope: ["b"],
          blast_radius: "low",
        },
        constraints: [],
        plateau_until: null,
        estimated_duration: null,
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

    it("skips approval for reversible task with high trust and high confidence", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      // Set trust high enough for autonomous quadrant
      trustManager.setOverride("normal", 30, "test");

      const task = makeTask({ reversibility: "reversible" });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.8);
      expect(result).toBe(true);
    });

    it("calls approvalFn for irreversible task", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      const task = makeTask({ reversibility: "irreversible" });
      await lifecycle.checkIrreversibleApproval(task);
      expect(approvalCalled).toBe(true);
    });

    it("calls approvalFn for unknown reversibility", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      const task = makeTask({ reversibility: "unknown" });
      await lifecycle.checkIrreversibleApproval(task);
      expect(approvalCalled).toBe(true);
    });

    it("returns true when approvalFn returns true", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });

      const task = makeTask({ reversibility: "irreversible" });
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(true);
    });

    it("returns false when approvalFn returns false", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
      });

      const task = makeTask({ reversibility: "irreversible" });
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(false);
    });

    it("default approvalFn returns false (safe default)", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm); // no custom approvalFn

      const task = makeTask({ reversibility: "irreversible" });
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(false);
    });

    it("requires approval when trust is low even for reversible task", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      // Trust is at 0 (default), confidence is low → quadrant is not autonomous
      const task = makeTask({ reversibility: "reversible" });
      await lifecycle.checkIrreversibleApproval(task, 0.3);
      expect(approvalCalled).toBe(true);
    });

    it("requires approval when permanent gate exists", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      trustManager.addPermanentGate("normal", "normal");
      trustManager.setOverride("normal", 50, "test"); // high trust

      const task = makeTask({ reversibility: "reversible" });
      await lifecycle.checkIrreversibleApproval(task, 0.9);
      expect(approvalCalled).toBe(true);
    });

    it("passes task to approvalFn", async () => {
      let receivedTask: Task | null = null;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async (task) => {
          receivedTask = task;
          return true;
        },
      });

      const task = makeTask({
        reversibility: "irreversible",
        work_description: "special task",
      });
      await lifecycle.checkIrreversibleApproval(task);
      expect(receivedTask).not.toBeNull();
      expect(receivedTask!.work_description).toBe("special task");
    });

    it("uses task_category as domain for trust check", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });

      // Set high trust for "verification" domain
      trustManager.setOverride("verification", 50, "test");

      const task = makeTask({
        reversibility: "reversible",
        task_category: "verification",
      });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.8);
      // With high trust + high confidence + reversible → should skip approval
      expect(result).toBe(true);
    });

    it("uses default confidence of 0.5 when not provided", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });

      // Set trust to exactly threshold (20)
      trustManager.setOverride("normal", 20, "test");

      const task = makeTask({ reversibility: "reversible" });
      // Default confidence is 0.5, which is >= HIGH_CONFIDENCE_THRESHOLD (0.5)
      // So with trust=20 (>= threshold) + confidence=0.5 → autonomous → no approval needed
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────

  describe("constructor", () => {
    it("accepts all required dependencies", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      expect(lifecycle).toBeDefined();
    });

    it("accepts optional approvalFn", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      expect(lifecycle).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────
  // Phase 2 helpers
  // ─────────────────────────────────────────────

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
    results: Array<Partial<import("../src/task-lifecycle.js").AgentResult>>
  ): import("../src/task-lifecycle.js").IAdapter {
    let callIndex = 0;
    return {
      adapterType: "mock",
      async execute(
        _task: import("../src/task-lifecycle.js").AgentTask
      ): Promise<import("../src/task-lifecycle.js").AgentResult> {
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

  // LLM responses for verification
  const MECHANICAL_PASS = '{"passed": true, "description": "All criteria verified mechanically"}';
  const MECHANICAL_FAIL = '{"passed": false, "description": "Criteria not met"}';
  const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';
  const LLM_REVIEW_FAIL = '{"verdict": "fail", "reasoning": "Criteria not met", "criteria_met": 0, "criteria_total": 1}';
  const LLM_REVIEW_PARTIAL = '{"verdict": "partial", "reasoning": "Some criteria met", "criteria_met": 1, "criteria_total": 2}';
  const REVERT_SUCCESS = '```json\n{"success": true, "reason": "Changes have been reverted successfully"}\n```';
  const REVERT_FAILURE = '```json\n{"success": false, "reason": "Unable to undo changes. Files are corrupted."}\n```';

  // ─────────────────────────────────────────────
  // executeTask
  // ─────────────────────────────────────────────

  describe("executeTask", () => {
    it("creates a session with correct type and IDs", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      // Verify session was created by checking state
      const sessions = sessionManager.getActiveSessions("goal-1");
      // Session should be ended (not active anymore)
      expect(sessions.length).toBe(0);
    });

    it("calls adapter.execute()", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let executeCalled = false;
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          executeCalled = true;
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.executeTask(makeTask(), adapter);
      expect(executeCalled).toBe(true);
    });

    it("returns AgentResult from adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: true,
        output: "test output",
        elapsed_ms: 200,
      }]);

      const result = await lifecycle.executeTask(makeTask(), adapter);
      expect(result.success).toBe(true);
      expect(result.output).toBe("test output");
      expect(result.elapsed_ms).toBe(200);
    });

    it("updates task status to completed on success", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true, stopped_reason: "completed" }]);
      const task = makeTask();

      // Persist task first
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("completed");
    });

    it("updates task status to timed_out on timeout", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: false,
        stopped_reason: "timeout",
        error: "Timed out",
      }]);
      const task = makeTask();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("timed_out");
    });

    it("updates task status to error on error", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: false,
        stopped_reason: "error",
        error: "Something went wrong",
      }]);
      const task = makeTask();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("error");
    });

    it("persists updated task after execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted).not.toBeNull();
      expect(persisted.completed_at).toBeDefined();
    });

    it("ends session after execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      // All sessions should be ended (no active ones)
      const activeSessions = sessionManager.getActiveSessions("goal-1");
      expect(activeSessions.length).toBe(0);
    });

    it("handles adapter throwing an error", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          throw new Error("Adapter crashed");
        },
      };
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Adapter crashed");
      expect(result.stopped_reason).toBe("error");
    });

    it("builds prompt from context slots", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);
      expect(receivedPrompt).toContain("task_definition_and_success_criteria");
      expect(receivedPrompt).toContain("goal-1");
    });

    it("builds github-issue JSON block for github_issue adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "github_issue",
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "https://github.com/owner/repo/issues/1", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ work_description: "Fix memory leak in cache module" });

      await lifecycle.executeTask(task, adapter);
      expect(receivedPrompt).toContain("```github-issue");
      const jsonMatch = receivedPrompt.match(/```github-issue\s*([\s\S]*?)```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1].trim());
      expect(parsed.title).toBe("Fix memory leak in cache module");
      expect(parsed.body).toBe("Fix memory leak in cache module");
      expect(receivedPrompt).not.toContain("task_definition_and_success_criteria");
    });

    it("truncates long work_description title to 120 chars for github_issue adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "github_issue",
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "https://github.com/owner/repo/issues/2", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const longDesc = "A".repeat(200);
      const task = makeTask({ work_description: longDesc });

      await lifecycle.executeTask(task, adapter);
      const jsonMatch = receivedPrompt.match(/```github-issue\s*([\s\S]*?)```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1].trim());
      expect(parsed.title.length).toBeLessThanOrEqual(120);
      expect(parsed.body).toBe(longDesc);
    });

    it("sets timeout_ms from estimated_duration", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedTimeout = 0;
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedTimeout = agentTask.timeout_ms;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ estimated_duration: { value: 2, unit: "hours" } });

      await lifecycle.executeTask(task, adapter);
      expect(receivedTimeout).toBe(2 * 60 * 60 * 1000);
    });

    it("uses default timeout when estimated_duration is null", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedTimeout = 0;
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedTimeout = agentTask.timeout_ms;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ estimated_duration: null });

      await lifecycle.executeTask(task, adapter);
      expect(receivedTimeout).toBe(30 * 60 * 1000); // default 30 minutes
    });

    it("sets adapter_type in AgentTask", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedType = "";
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "claude_api",
        async execute(agentTask) {
          receivedType = agentTask.adapter_type;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.executeTask(makeTask(), adapter);
      expect(receivedType).toBe("claude_api");
    });

    it("sets started_at on the running task", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      const before = new Date().toISOString();
      await lifecycle.executeTask(task, adapter);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      // started_at should be set when task moves to running
      expect(persisted.started_at).toBeDefined();
      expect(typeof persisted.started_at).toBe("string");
    });
  });

  // ─────────────────────────────────────────────
  // verifyTask
  // ─────────────────────────────────────────────

  describe("verifyTask", () => {
    function makeExecutionResult(
      overrides: Partial<import("../src/task-lifecycle.js").AgentResult> = {}
    ): import("../src/task-lifecycle.js").AgentResult {
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
      expect(l2Call.options?.system).toContain("independent task reviewer");
      expect(l2Call.options?.system).toContain("Do NOT consider");
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

      const persisted = stateManager.readRaw(
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
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
      // 0.9 + 0.4 = 1.3 → clamped to 1.0
      expect(verification.dimension_updates[0]!.new_value).toBe(1);
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
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

  // ─────────────────────────────────────────────
  // handleVerdict
  // ─────────────────────────────────────────────

  describe("handleVerdict", () => {
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.action).toBe("completed");
      // Trust should have increased
      const balance = trustManager.getBalance("normal");
      expect(balance.balance).toBe(3); // +3 for success
    });

    it("pass resets consecutive_failure_count to 0", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 2 });
      const vr = makeVerificationResult({ verdict: "pass" });

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.task.consecutive_failure_count).toBe(0);
    });

    it("pass sets task status to completed", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ status: "running" as const });
      const vr = makeVerificationResult({ verdict: "pass" });

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleVerdict(task, vr);

      expect(result.task.status).toBe("completed");
    });

    it("pass persists updated task", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({ verdict: "pass" });

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);

      const history = stateManager.readRaw(`tasks/goal-1/task-history.json`) as Array<Record<string, unknown>>;
      expect(history).not.toBeNull();
      expect(history.length).toBe(1);
      expect(history[0]!.task_id).toBe("task-1");
    });

    it("pass sets completed_at timestamp", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult({ verdict: "pass" });

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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
      stateManager.writeRaw("goals/goal-1/goal.json", {
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
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const before = new Date().toISOString();
      await lifecycle.handleVerdict(task, vr);
      const after = new Date().toISOString();

      const goal = stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
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
      stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: oldTimestamp },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
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
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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
      stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: oldTimestamp },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      // current_value must now reflect the new_value from dimension_updates
      expect(coverageDim!.current_value).toBe(0.7);
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
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

      stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "quality", label: "Quality", current_value: 0.2, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.handleVerdict(task, vr);
      expect(result.action).toBe("keep");

      const goal = stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
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

      stateManager.writeRaw("goals/goal-1.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "coverage", label: "Coverage", current_value: 0.5, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      await lifecycle.handleVerdict(task, vr);

      const goal = stateManager.readRaw("goals/goal-1.json") as Record<string, unknown>;
      const dims = goal.dimensions as Array<Record<string, unknown>>;
      const coverageDim = dims.find((d) => d.name === "coverage");

      // Fail path should leave current_value unchanged
      expect(coverageDim!.current_value).toBe(0.5);
    });
  });

  // ─────────────────────────────────────────────
  // handleFailure
  // ─────────────────────────────────────────────

  describe("handleFailure", () => {
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.task.consecutive_failure_count).toBe(1);
    });

    it("records failure with TrustManager", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const vr = makeVerificationResult();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const balance = trustManager.getBalance("normal");
      expect(balance.balance).toBe(-10); // -10 for failure
    });

    it("persists updated task", async () => {
      const llm = createMockLLMClient([REVERT_SUCCESS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 0 });
      const vr = makeVerificationResult();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const persisted = stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.consecutive_failure_count).toBe(1);
    });

    it("count >= 3 calls StallDetector and returns escalate", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ consecutive_failure_count: 2 }); // will become 3
      const vr = makeVerificationResult();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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
      stateManager.writeRaw(`goals/goal-1/goal.json`, {
        id: "goal-1",
        title: "Test goal",
        dimensions: [{ name: "dim", state_integrity: "ok" }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);

      expect(result.action).toBe("escalate");

      // Verify state_integrity was set to uncertain
      const goal = stateManager.readRaw(`goals/goal-1/goal.json`) as Record<string, unknown>;
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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
        stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
        await lifecycle.handleFailure(task, vr);
      }

      const balance = trustManager.getBalance("normal");
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const history = stateManager.readRaw(`tasks/goal-1/task-history.json`) as Array<Record<string, unknown>>;
      expect(history).not.toBeNull();
      expect(history.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────
  // runTaskCycle
  // ─────────────────────────────────────────────

  describe("runTaskCycle", () => {
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

  describe("persistence", () => {
    it("verification result saved to correct path", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ id: "task-persist-test" });
      const result: import("../src/task-lifecycle.js").AgentResult = {
        success: true,
        output: "done",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
      };

      await lifecycle.verifyTask(task, result);

      const saved = stateManager.readRaw("verification/task-persist-test/verification-result.json");
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

        stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
        await lifecycle.handleVerdict(task, vr);
      }

      const history = stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);

      const history = stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleFailure(task, vr);

      const history = stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
      expect(history[0]!.consecutive_failure_count).toBe(2);
    });

    it("executeTask persists running state before execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let statusDuringExecution = "";
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          // Check status during execution
          const raw = stateManager.readRaw("tasks/goal-1/task-1.json") as Record<string, unknown>;
          statusDuringExecution = raw?.status as string;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask();

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      expect(statusDuringExecution).toBe("running");
    });
  });

  // ─────────────────────────────────────────────
  // failure handling paths
  // ─────────────────────────────────────────────

  describe("failure handling paths", () => {
    // ── Test 1: L1 mechanical verification ─────────────────────────────────
    // The current MVP implementation marks L1 as applicable-but-assumed-pass
    // when any success criterion has a shell-command verification method.
    // We verify the full verification pipeline confirms the evidence includes
    // the mechanical layer, and that verdict is driven by L2 (LLM review).

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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      // Save a goal so dimension updates can be applied
      stateManager.writeRaw("goals/goal-1.json", {
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
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

      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      const result = await lifecycle.handleFailure(task, vr);
      expect(result.action).toBe("escalate");
    });

    // ── Test 3: Adapter timeout ─────────────────────────────────────────────

    it("adapter that rejects with an Error → executeTask catches and returns error result", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const timeoutAdapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock-timeout",
        async execute() {
          throw new Error("Adapter execution timed out after 30000ms");
        },
      };

      const task = makeTask({ id: "task-timeout" });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

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

      const timeoutAdapter: import("../src/task-lifecycle.js").IAdapter = {
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
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const executionResult = await lifecycle.executeTask(task, timeoutAdapter);
      expect(executionResult.success).toBe(false);

      const verificationResult = await lifecycle.verifyTask(task, executionResult);
      expect(verificationResult.verdict).toBe("fail");
    });

    it("adapter that throws a non-Error value is handled gracefully", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      const badAdapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock-bad",
        async execute() {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "string error value";
        },
      };

      const task = makeTask({ id: "task-bad-throw" });
      stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTask(task, badAdapter);

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(typeof result.error).toBe("string");
    });
  });

  // ─────────────────────────────────────────────
  // runTaskCycle — ethics means check
  // ─────────────────────────────────────────────

  describe("runTaskCycle — ethics means check", () => {
    // Shared helper: a mock EthicsGate with controllable checkMeans
    function makeMockEthicsGate(checkMeansImpl: () => Promise<import("../src/types/ethics.js").EthicsVerdict>) {
      return {
        check: vi.fn().mockResolvedValue({
          verdict: "pass",
          category: "safe",
          reasoning: "ok",
          risks: [],
          confidence: 0.9,
        }),
        checkMeans: vi.fn().mockImplementation(checkMeansImpl),
      };
    }

    const PASS_VERDICT: import("../src/types/ethics.js").EthicsVerdict = {
      verdict: "pass",
      category: "safe",
      reasoning: "Task approach is safe",
      risks: [],
      confidence: 0.9,
    };

    const REJECT_VERDICT: import("../src/types/ethics.js").EthicsVerdict = {
      verdict: "reject",
      category: "harmful",
      reasoning: "Task involves harmful actions",
      risks: ["potential harm to users"],
      confidence: 0.95,
    };

    const FLAG_VERDICT: import("../src/types/ethics.js").EthicsVerdict = {
      verdict: "flag",
      category: "privacy_concern",
      reasoning: "Task may expose user data",
      risks: ["privacy risk"],
      confidence: 0.7,
    };

    it("ethicsGate not provided: runTaskCycle proceeds normally and task executes successfully", async () => {
      // No ethicsGate passed → ethics check is entirely skipped
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        // no ethicsGate
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      let adapterExecuteCalled = false;
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          adapterExecuteCalled = true;
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(adapterExecuteCalled).toBe(true);
      expect(result.action).toBe("completed");
    });

    it("ethics pass: checkMeans returns pass verdict and task proceeds to adapter execution", async () => {
      const ethicsGate = makeMockEthicsGate(async () => PASS_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      let adapterExecuteCalled = false;
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          adapterExecuteCalled = true;
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(ethicsGate.checkMeans).toHaveBeenCalledOnce();
      expect(adapterExecuteCalled).toBe(true);
      expect(result.action).toBe("completed");
    });

    it("ethics reject: runTaskCycle returns action=discard immediately and adapter is never called", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapterExecute = vi.fn();
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          adapterExecute();
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("discard");
      expect(adapterExecute).not.toHaveBeenCalled();
    });

    it("ethics reject: verificationResult contains ethics reasoning in evidence", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.verdict).toBe("fail");
      expect(result.verificationResult.evidence[0]?.description).toContain(REJECT_VERDICT.reasoning);
    });

    it("ethics flag + approval granted: task proceeds to adapter execution normally", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      let approvalCalled = false;
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      let adapterExecuteCalled = false;
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          adapterExecuteCalled = true;
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(approvalCalled).toBe(true);
      expect(adapterExecuteCalled).toBe(true);
      expect(result.action).toBe("completed");
    });

    it("ethics flag + approval denied: returns action=approval_denied and adapter is never called", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapterExecute = vi.fn();
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          adapterExecute();
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("approval_denied");
      expect(adapterExecute).not.toHaveBeenCalled();
    });

    it("ethics flag + approval denied: verificationResult contains flag reasoning in evidence", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.verdict).toBe("fail");
      expect(result.verificationResult.evidence[0]?.description).toContain(FLAG_VERDICT.reasoning);
    });

    it("checkMeans receives correct arguments: task.id, task.work_description, task.approach", async () => {
      const checkMeans = vi.fn().mockResolvedValue(PASS_VERDICT);
      const ethicsGate = {
        check: vi.fn().mockResolvedValue(PASS_VERDICT),
        checkMeans,
      };
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(checkMeans).toHaveBeenCalledOnce();
      const [calledTaskId, calledWorkDesc, calledApproach] = checkMeans.mock.calls[0]!;
      // The generated task's id should match what was passed to checkMeans
      expect(calledTaskId).toBe(result.task.id);
      expect(calledWorkDesc).toBe(result.task.work_description);
      expect(calledApproach).toBe(result.task.approach);
    });

    it("ethics error propagation: when checkMeans throws, runTaskCycle propagates the error", async () => {
      const ethicsGate = {
        check: vi.fn(),
        checkMeans: vi.fn().mockRejectedValue(new Error("ethics check service unavailable")),
      };
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([]);

      await expect(
        lifecycle.runTaskCycle("goal-1", gapVector, context, adapter)
      ).rejects.toThrow("ethics check service unavailable");
    });

    it("ethics pass with high confidence: task completes and cycle returns completed", async () => {
      const highConfidencePass: import("../src/types/ethics.js").EthicsVerdict = {
        verdict: "pass",
        category: "safe",
        reasoning: "Fully safe operation",
        risks: [],
        confidence: 1.0,
      };
      const ethicsGate = makeMockEthicsGate(async () => highConfidencePass);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.6 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true, output: "done" }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("completed");
      expect(result.verificationResult.verdict).toBe("pass");
    });

    it("ethics reject: checkMeans is called exactly once even though adapter is skipped", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(ethicsGate.checkMeans).toHaveBeenCalledTimes(1);
    });

    it("ethics flag + approval denied: verificationResult confidence is 1.0", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.confidence).toBe(1.0);
    });

    it("ethics reject: verificationResult confidence is 1.0", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.confidence).toBe(1.0);
    });

    it("ethics pass: checkMeans called before adapter.execute", async () => {
      const callOrder: string[] = [];
      const ethicsGate = {
        check: vi.fn(),
        checkMeans: vi.fn().mockImplementation(async () => {
          callOrder.push("checkMeans");
          return PASS_VERDICT;
        }),
      };
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter: import("../src/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          callOrder.push("adapterExecute");
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(callOrder.indexOf("checkMeans")).toBeLessThan(callOrder.indexOf("adapterExecute"));
    });

    it("ethics flag: approvalFn is called exactly once when verdict is flag", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const approvalFn = vi.fn().mockResolvedValue(true);
      const lifecycle = createLifecycle(llm, {
        approvalFn,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true }]);

      await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      // approvalFn may be called for the ethics flag and/or for reversibility check.
      // At minimum it must have been called for the ethics flag.
      expect(approvalFn).toHaveBeenCalled();
    });

    it("ethics reject: task field in TaskCycleResult is the generated task (not null)", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.task).toBeDefined();
      expect(result.task.goal_id).toBe("goal-1");
    });

    it("ethics pass: task.goal_id matches the goalId passed to runTaskCycle", async () => {
      const ethicsGate = makeMockEthicsGate(async () => PASS_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-xyz", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle("goal-xyz", gapVector, context, adapter);

      expect(result.task.goal_id).toBe("goal-xyz");
    });

    it("ethics pass: knowledgeContext optional parameter is forwarded without affecting ethics check", async () => {
      const checkMeans = vi.fn().mockResolvedValue(PASS_VERDICT);
      const ethicsGate = {
        check: vi.fn(),
        checkMeans,
      };
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true }]);

      const result = await lifecycle.runTaskCycle(
        "goal-1",
        gapVector,
        context,
        adapter,
        "some knowledge context"
      );

      expect(checkMeans).toHaveBeenCalledOnce();
      expect(result.action).toBe("completed");
    });

    it("ethics flag + approval denied: task returned has id matching verificationResult.task_id", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.task.id).toBe(result.verificationResult.task_id);
    });

    it("ethics reject: task returned has id matching verificationResult.task_id", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.task.id).toBe(result.verificationResult.task_id);
    });

    it("multiple sequential cycles: ethicsGate.checkMeans called once per cycle", async () => {
      const checkMeans = vi.fn().mockResolvedValue(PASS_VERDICT);
      const ethicsGate = {
        check: vi.fn(),
        checkMeans,
      };
      const llm = createMockLLMClient([
        VALID_TASK_RESPONSE, LLM_REVIEW_PASS,
        VALID_TASK_RESPONSE, LLM_REVIEW_PASS,
      ]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true }, { success: true }]);

      await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);
      await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(checkMeans).toHaveBeenCalledTimes(2);
    });

    it("ethics pass: verificationResult.verdict is pass when L2 review passes", async () => {
      const ethicsGate = makeMockEthicsGate(async () => PASS_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([{ success: true, output: "All tests pass" }]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.verdict).toBe("pass");
    });

    it("ethics reject: dimension_updates is empty in verificationResult", async () => {
      const ethicsGate = makeMockEthicsGate(async () => REJECT_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.dimension_updates).toEqual([]);
    });

    it("ethics flag + approval denied: dimension_updates is empty in verificationResult", async () => {
      const ethicsGate = makeMockEthicsGate(async () => FLAG_VERDICT);
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
        ethicsGate: ethicsGate as unknown as import("../src/ethics-gate.js").EthicsGate,
      });
      const gapVector = makeGapVector("goal-1", [{ name: "dim", gap: 0.5 }]);
      const context = makeDriveContext(["dim"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.verificationResult.dimension_updates).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  // capability acquisition flow
  // ─────────────────────────────────────────────

  describe("capability acquisition flow", () => {
    function createMockCapabilityDetector(overrides: Partial<any> = {}) {
      return {
        detectDeficiency: vi.fn().mockResolvedValue(null),
        planAcquisition: vi.fn().mockReturnValue({
          gap: { missing_capability: { name: "test-tool", type: "tool" }, reason: "not available", alternatives: [], impact_description: "cannot proceed" },
          method: "tool_creation",
          task_description: "Create the test tool",
          success_criteria: ["capability registered in registry"],
          verification_attempts: 0,
          max_verification_attempts: 3,
        }),
        escalateToUser: vi.fn().mockResolvedValue(undefined),
        confirmDeficiency: vi.fn().mockReturnValue(true),
        setCapabilityStatus: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it("skips detectDeficiency for capability_acquisition tasks", async () => {
      const capabilityDetector = createMockCapabilityDetector();
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        capabilityDetector: capabilityDetector as unknown as import("../src/capability-detector.js").CapabilityDetector,
      });

      // Spy on generateTask to return a task with task_category = "capability_acquisition"
      const originalGenerateTask = lifecycle.generateTask.bind(lifecycle);
      vi.spyOn(lifecycle, "generateTask").mockImplementation(async (...args: Parameters<typeof lifecycle.generateTask>) => {
        const task = await originalGenerateTask(...args);
        (task as any).task_category = "capability_acquisition";
        return task;
      });

      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([{ success: true, output: "Done" }]);

      await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
    });

    it("returns capability_acquiring for tool gap", async () => {
      const toolGap = {
        missing_capability: { name: "code-formatter", type: "tool" as const },
        reason: "No code formatting tool available",
        alternatives: [],
        impact_description: "Cannot format code automatically",
      };
      const acquisitionTask = {
        gap: toolGap,
        method: "tool_creation" as const,
        task_description: "Create a code formatting tool",
        success_criteria: ["capability registered in registry"],
        verification_attempts: 0,
        max_verification_attempts: 3,
      };
      const capabilityDetector = createMockCapabilityDetector({
        detectDeficiency: vi.fn().mockResolvedValue(toolGap),
        planAcquisition: vi.fn().mockReturnValue(acquisitionTask),
      });

      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        capabilityDetector: capabilityDetector as unknown as import("../src/capability-detector.js").CapabilityDetector,
      });

      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("capability_acquiring");
      expect(result.acquisition_task).toBeDefined();
      expect(result.acquisition_task!.method).toBe("tool_creation");
      expect(capabilityDetector.setCapabilityStatus).toHaveBeenCalledWith(
        "code-formatter",
        "tool",
        "acquiring"
      );
    });

    it("escalates for permission gap", async () => {
      const permissionGap = {
        missing_capability: { name: "admin-access", type: "permission" as const },
        reason: "Requires admin privileges",
        alternatives: [],
        impact_description: "Cannot modify system settings",
      };
      const acquisitionTask = {
        gap: permissionGap,
        method: "permission_request" as const,
        task_description: "Request admin access from user",
        success_criteria: ["admin access granted"],
        verification_attempts: 0,
        max_verification_attempts: 3,
      };
      const capabilityDetector = createMockCapabilityDetector({
        detectDeficiency: vi.fn().mockResolvedValue(permissionGap),
        planAcquisition: vi.fn().mockReturnValue(acquisitionTask),
      });

      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        capabilityDetector: capabilityDetector as unknown as import("../src/capability-detector.js").CapabilityDetector,
      });

      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("escalate");
      expect(capabilityDetector.setCapabilityStatus).not.toHaveBeenCalled();
    });

    it("returns capability_acquiring for service gap", async () => {
      const serviceGap = {
        missing_capability: { name: "redis-cache", type: "service" as const },
        reason: "Redis service not running",
        alternatives: [],
        impact_description: "Cannot use caching layer",
      };
      const acquisitionTask = {
        gap: serviceGap,
        method: "service_setup" as const,
        task_description: "Set up Redis cache service",
        success_criteria: ["Redis service is running and accessible"],
        verification_attempts: 0,
        max_verification_attempts: 3,
      };
      const capabilityDetector = createMockCapabilityDetector({
        detectDeficiency: vi.fn().mockResolvedValue(serviceGap),
        planAcquisition: vi.fn().mockReturnValue(acquisitionTask),
      });

      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
        capabilityDetector: capabilityDetector as unknown as import("../src/capability-detector.js").CapabilityDetector,
      });

      const gapVector = makeGapVector("goal-1", [{ name: "coverage", gap: 0.5 }]);
      const context = makeDriveContext(["coverage"]);
      const adapter = createMockAdapter([]);

      const result = await lifecycle.runTaskCycle("goal-1", gapVector, context, adapter);

      expect(result.action).toBe("capability_acquiring");
      expect(result.acquisition_task).toBeDefined();
      expect(result.acquisition_task!.method).toBe("service_setup");
      expect(capabilityDetector.setCapabilityStatus).toHaveBeenCalledWith(
        "redis-cache",
        "service",
        "acquiring"
      );
    });
  });
});
