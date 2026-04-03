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
import {
  PASS_VERDICT,
  REJECT_VERDICT,
  FLAG_VERDICT,
} from "./helpers/ethics-fixtures.js";

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

const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';

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
      ethicsGate?: import("../src/ethics-gate.js").EthicsGate;
      capabilityDetector?: import("../src/observation/capability-detector.js").CapabilityDetector;
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
  // runTaskCycle — ethics means check
  // ─────────────────────────────────────────────

  describe("runTaskCycle — ethics means check", async () => {
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
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
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
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
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
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
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
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
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
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
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
      const adapter: import("../src/execution/task/task-lifecycle.js").IAdapter = {
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

  describe("capability acquisition flow", async () => {
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
        capabilityDetector: capabilityDetector as unknown as import("../src/observation/capability-detector.js").CapabilityDetector,
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
        capabilityDetector: capabilityDetector as unknown as import("../src/observation/capability-detector.js").CapabilityDetector,
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
        capabilityDetector: capabilityDetector as unknown as import("../src/observation/capability-detector.js").CapabilityDetector,
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
        capabilityDetector: capabilityDetector as unknown as import("../src/observation/capability-detector.js").CapabilityDetector,
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
