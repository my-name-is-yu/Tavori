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

describe("TaskLifecycle — persistence", () => {
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

  it("verification result saved to correct path", async () => {
    const llm = createMockLLMClient([LLM_REVIEW_PASS]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({ id: "task-persist-test" });
    const result: import("../task/task-lifecycle.js").AgentResult = {
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

    for (let i = 1; i <= 2; i++) {
      const task = makeTask({ id: `task-${i}` });
      const vr: import("../../../base/types/task.js").VerificationResult = {
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
    const vr: import("../../../base/types/task.js").VerificationResult = {
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
    const vr: import("../../../base/types/task.js").VerificationResult = {
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
    const llm = createSpyLLMClient([]);
    const lifecycle = createLifecycle(llm);
    let statusDuringExecution = "";
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        const raw = await stateManager.readRaw("tasks/goal-1/task-1.json") as Record<string, unknown>;
        statusDuringExecution = raw?.status as string;
        return {
          success: true,
          output: "ok",
          error: null,
          exit_code: 0,
          elapsed_ms: 10,
          stopped_reason: "completed" as const,
        };
      },
    };
    const task = makeTask();

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    await lifecycle.executeTask(task, adapter);

    expect(statusDuringExecution).toBe("running");
  });
});
