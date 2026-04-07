import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { z } from "zod";

function createSpyLLMClient(responses: string[]): ILLMClient {
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

const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';
const LLM_REVIEW_FAIL = '{"verdict": "fail", "reasoning": "Criteria not met", "criteria_met": 0, "criteria_total": 1}';
const LLM_REVIEW_PARTIAL = '{"verdict": "partial", "reasoning": "Some criteria met", "criteria_met": 1, "criteria_total": 2}';
const REVERT_SUCCESS = '```json\n{"success": true, "reason": "Changes have been reverted successfully"}\n```';

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

describe("TaskLifecycle — failure handling", () => {
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

  function createLifecycle(llmClient: ILLMClient): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { healthCheckEnabled: false }
    );
  }

  it("L1 mechanical criteria detected: evidence includes mechanical layer", async () => {
    const llm = createMockLLMClient([LLM_REVIEW_PASS]);
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

    const layers = result.evidence.map((e) => e.layer);
    expect(layers).toContain("mechanical");
    expect(layers).toContain("independent_review");
    expect(result.verdict).toBe("pass");
  });

  it("L1 mechanical criteria detected + L2 fail → re-review → overall fail", async () => {
    const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_FAIL]);
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
    const llm = createMockLLMClient([LLM_REVIEW_PASS]);
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

    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBe(0.6);
    const layers = result.evidence.map((e) => e.layer);
    expect(layers).not.toContain("mechanical");
  });

  it("partial verdict with direction correct (partial = direction correct) → action is keep", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({ id: "task-keep" });

    const vr: import("../../../base/types/task.js").VerificationResult = {
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
    await stateManager.writeRaw("goals/goal-1.json", {
      id: "goal-1",
      dimensions: [{ name: "dim", current_value: 0.5 }],
    });

    const result = await lifecycle.handleVerdict(task, vr);
    expect(result.action).toBe("keep");
  });

  it("fail verdict with reversible task → revert succeeds → action is discard", async () => {
    const llm = createMockLLMClient([REVERT_SUCCESS]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({
      id: "task-discard",
      reversibility: "reversible",
      consecutive_failure_count: 0,
    });

    const vr: import("../../../base/types/task.js").VerificationResult = {
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
    const task = makeTask({
      id: "task-escalate",
      consecutive_failure_count: 2,
      reversibility: "reversible",
    });

    const vr: import("../../../base/types/task.js").VerificationResult = {
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
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({
      id: "task-irreversible-fail",
      reversibility: "irreversible",
      consecutive_failure_count: 0,
    });

    const vr: import("../../../base/types/task.js").VerificationResult = {
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

  it("adapter that rejects with an Error → executeTask catches and returns error result", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);

    const timeoutAdapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock-timeout",
      async execute() {
        throw new Error("Adapter execution timed out after 30000ms");
      },
    };

    const task = makeTask({ id: "task-timeout" });
    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

    const result = await lifecycle.executeTask(task, timeoutAdapter);
    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.error).toContain("timed out");
  });

  it("adapter timeout followed by verifyTask produces a fail verdict", async () => {
    const llm = createMockLLMClient([LLM_REVIEW_FAIL]);
    const lifecycle = createLifecycle(llm);

    const timeoutAdapter: import("../task/task-lifecycle.js").IAdapter = {
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

    const badAdapter: import("../task/task-lifecycle.js").IAdapter = {
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
