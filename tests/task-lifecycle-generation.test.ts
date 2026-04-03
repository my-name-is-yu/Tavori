import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  // generateTask
  // ─────────────────────────────────────────────

  describe("generateTask", async () => {
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

      const persisted = await stateManager.readRaw(`tasks/goal-1/${task.id}.json`);
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
      const lifecycle = createLifecycle(llm, { logger: mockLogger as unknown as import("../src/runtime/logger.js").Logger });

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
      const raw = await stateManager.readRaw(`tasks/goal-1/${task.id}.json`) as Record<string, unknown>;

      expect(raw.work_description).toBe(task.work_description);
      expect(raw.status).toBe("pending");
      expect(raw.goal_id).toBe("goal-1");
      expect(raw.strategy_id).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // checkIrreversibleApproval
  // ─────────────────────────────────────────────

  describe("checkIrreversibleApproval", async () => {
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
      await trustManager.setOverride("normal", 30, "test");

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

      await trustManager.addPermanentGate("normal", "normal");
      await trustManager.setOverride("normal", 50, "test"); // high trust

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
      await trustManager.setOverride("verification", 50, "test");

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
      await trustManager.setOverride("normal", 20, "test");

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
});
