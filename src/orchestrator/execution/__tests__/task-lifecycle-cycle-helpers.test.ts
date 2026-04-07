/**
 * Focused coverage for runTaskCycle helper branches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Write unit tests for the auth module",
  "rationale": "Improve test coverage",
  "approach": "Use vitest",
  "success_criteria": [
    {
      "description": "All auth flows have at least one test",
      "verification_method": "Run vitest",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["tests/"],
    "out_of_scope": ["src/"],
    "blast_radius": "tests/ directory only"
  },
  "constraints": [],
  "reversibility": "reversible",
  "estimated_duration": { "value": 1, "unit": "hours" }
}
\`\`\``;

const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';

function makeGapVector(goalId: string, dimensions: Array<{ name: string; gap: number }>): GapVector {
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

function makeDriveContext(dimensionNames: string[]): DriveContext {
  const time_since_last_attempt: Record<string, number> = {};
  const deadlines: Record<string, number | null> = {};
  for (const name of dimensionNames) {
    time_since_last_attempt[name] = 24;
    deadlines[name] = null;
  }
  return { time_since_last_attempt, deadlines, opportunities: {}, pacing: {} };
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
      { description: "Tests pass", verification_method: "npx vitest run", is_blocking: true },
    ],
    scope_boundary: { in_scope: ["module A"], out_of_scope: ["module B"], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
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

function createMockAdapter(): import("../task/task-lifecycle.js").IAdapter {
  return {
    adapterType: "mock",
    async execute(): Promise<import("../task/task-lifecycle.js").AgentResult> {
      return {
        success: true,
        output: "Task completed",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
      };
    },
  };
}

describe("TaskLifecycle — runTaskCycle helper branches", () => {
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

  function createLifecycle(
    llmClient: ReturnType<typeof createMockLLMClient>,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      knowledgeTransfer?: import("../../knowledge/transfer/knowledge-transfer.js").KnowledgeTransfer;
      knowledgeManager?: import("../../knowledge/knowledge-manager.js").KnowledgeManager;
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
      { healthCheckEnabled: false, execFileSyncFn: () => "some-file.ts", ...options }
    );
  }

  it("returns skipped result when task generation hits the duplicate guard", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const lifecycle = createLifecycle(llm, { approvalFn: async () => true });

    const completedTask = makeTask({
      id: "task-prev-1",
      work_description: "Write unit tests for the auth module",
      status: "completed",
    });
    await stateManager.writeRaw(`tasks/goal-dup/task-prev-1.json`, completedTask);
    await stateManager.writeRaw(`tasks/goal-dup/task-history.json`, [
      {
        id: "task-prev-1",
        work_description: "Write unit tests for the auth module",
        status: "completed",
      },
    ]);

    const result = await lifecycle.runTaskCycle(
      "goal-dup",
      makeGapVector("goal-dup", [{ name: "dim", gap: 0.5 }]),
      makeDriveContext(["dim"]),
      createMockAdapter()
    );

    expect(result.action).toBe("discard");
    expect(result.task.work_description).toContain("skipped");
  });

  it("enriches knowledge context when realtime transfer returns snippets", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    const knowledgeTransfer = {
      detectCandidatesRealtime: vi.fn().mockResolvedValue({
        contextSnippets: ["Snippet A", "Snippet B"],
        candidates: [],
      }),
    };

    const lifecycle = createLifecycle(llm, {
      approvalFn: async () => true,
      knowledgeTransfer: knowledgeTransfer as unknown as import("../../knowledge/transfer/knowledge-transfer.js").KnowledgeTransfer,
    });

    const result = await lifecycle.runTaskCycle(
      "goal-kt",
      makeGapVector("goal-kt", [{ name: "coverage", gap: 0.5 }]),
      makeDriveContext(["coverage"]),
      createMockAdapter()
    );

    expect(knowledgeTransfer.detectCandidatesRealtime).toHaveBeenCalledWith("goal-kt");
    expect(result.task).toBeDefined();
  });

  it("proceeds without enrichment when realtime transfer throws", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    const knowledgeTransfer = {
      detectCandidatesRealtime: vi.fn().mockRejectedValue(new Error("Network error")),
    };

    const lifecycle = createLifecycle(llm, {
      approvalFn: async () => true,
      knowledgeTransfer: knowledgeTransfer as unknown as import("../../knowledge/transfer/knowledge-transfer.js").KnowledgeTransfer,
    });

    const result = await lifecycle.runTaskCycle(
      "goal-kt3",
      makeGapVector("goal-kt3", [{ name: "dim", gap: 0.5 }]),
      makeDriveContext(["dim"]),
      createMockAdapter()
    );

    expect(result.task).toBeDefined();
  });

  it("falls back when goal loading fails", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    const lifecycle = createLifecycle(llm, { approvalFn: async () => true });

    fs.mkdirSync(tmpDir + "/goals", { recursive: true });
    fs.writeFileSync(tmpDir + "/goals/goal-fail.json", "NOT VALID JSON {{{");

    const result = await lifecycle.runTaskCycle(
      "goal-fail",
      makeGapVector("goal-fail", [{ name: "dim", gap: 0.5 }]),
      makeDriveContext(["dim"]),
      createMockAdapter()
    );

    expect(result.task).toBeDefined();
  });

  it("proceeds when knowledgeManager load fails or returns empty data", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    const knowledgeManager = {
      loadKnowledge: vi.fn().mockRejectedValue(new Error("KM unavailable")),
      addEntry: vi.fn().mockResolvedValue(undefined),
    };

    const lifecycle = createLifecycle(llm, {
      approvalFn: async () => true,
      knowledgeManager: knowledgeManager as unknown as import("../../knowledge/knowledge-manager.js").KnowledgeManager,
    });

    const result = await lifecycle.runTaskCycle(
      "goal-km3",
      makeGapVector("goal-km3", [{ name: "dim", gap: 0.5 }]),
      makeDriveContext(["dim"]),
      createMockAdapter()
    );

    expect(result.task).toBeDefined();
  });
});
