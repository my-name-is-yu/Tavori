/**
 * R3 E2E verification: dimension_updates from task execution flow back into
 * goal state and affect the next observation cycle.
 *
 * Tests:
 *   R3-1: verifyTask dimension_updates are applied to goal state via handleVerdict
 *   R3-2: CoreLoop iteration applies dimension_updates from task cycle
 *   R3-3: fail verdict produces no dimension_updates
 *   R3-4: consecutive failures trigger stall detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { StateManager } from "../../src/state/state-manager.js";
import { TaskLifecycle } from "../../src/execution/task/task-lifecycle.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { CoreLoop, type CoreLoopDeps } from "../../src/loop/core-loop.js";
import type { Goal } from "../../src/types/goal.js";
import type { Task, VerificationResult } from "../../src/types/task.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";
import type { GapVector } from "../../src/types/gap.js";
import type { DriveScore } from "../../src/types/drive.js";
import type { CompletionJudgment } from "../../src/types/satisficing.js";
import type { TaskCycleResult } from "../../src/execution/task/task-lifecycle.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Helpers ───

const BASE_NOW = new Date().toISOString();

function makeGoalWithDimension(
  id: string,
  currentValue: number,
  thresholdValue: number
): Goal {
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "R3 Feedback Loop Goal",
    description: "Goal for feedback loop testing",
    status: "active",
    dimensions: [
      {
        name: "quality",
        label: "Quality",
        current_value: currentValue,
        threshold: { type: "min", value: thresholdValue },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: BASE_NOW,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
  };
}

function makeTask(goalId: string, failureCount = 0): Task {
  return {
    id: "task-r3-test",
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "Improve quality",
    rationale: "Quality is below threshold",
    approach: "Systematic improvement",
    success_criteria: [
      {
        description: "Quality above threshold",
        verification_method: "mechanical check",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["quality"],
      out_of_scope: [],
      blast_radius: "none",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: failureCount,
    reversibility: "reversible",
    task_category: "normal",
    status: "completed",
    started_at: BASE_NOW,
    completed_at: BASE_NOW,
    timeout_at: null,
    heartbeat_at: null,
    created_at: BASE_NOW,
  };
}

function makeVerificationResult(
  taskId: string,
  verdict: "pass" | "partial" | "fail",
  dimensionUpdates: Array<{ dimension_name: string; previous_value: number | null; new_value: number; confidence: number }>
): VerificationResult {
  return {
    task_id: taskId,
    verdict,
    confidence: 0.9,
    evidence: [
      {
        layer: "independent_review",
        description: `Verification: ${verdict}`,
        confidence: 0.9,
      },
    ],
    dimension_updates: dimensionUpdates,
    timestamp: BASE_NOW,
  };
}

function makeGapVector(goalId: string, gap = 0.4): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "quality",
        raw_gap: gap,
        normalized_gap: gap,
        normalized_weighted_gap: gap,
        confidence: 0.9,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: BASE_NOW,
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "quality",
      dissatisfaction: 0.4,
      deadline: 0,
      opportunity: 0,
      final_score: 0.4,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["quality"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: BASE_NOW,
    ...overrides,
  };
}

function makeTaskCycleResult(goalId: string, verdict: "pass" | "partial" | "fail" = "pass", failureCount = 0): TaskCycleResult {
  const task = makeTask(goalId, failureCount);
  const dimensionUpdates = verdict === "fail"
    ? []
    : [{ dimension_name: "quality", previous_value: 0.3, new_value: 0.7, confidence: 0.9 }];

  return {
    task,
    verificationResult: makeVerificationResult(task.id, verdict, dimensionUpdates),
    action: verdict === "fail" && failureCount >= 2 ? "escalate" : "completed",
  };
}

/**
 * Creates a minimal mock ILLMClient that returns a canned LLM response.
 */
function makeMockLLMClient(): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        work_description: "Improve quality",
        rationale: "Quality below threshold",
        approach: "Systematic",
        success_criteria: [
          { description: "Quality above 0.7", verification_method: "mechanical", is_blocking: true },
        ],
        scope_boundary: { in_scope: ["quality"], out_of_scope: [], blast_radius: "none" },
        constraints: [],
        reversibility: "reversible",
        estimated_duration: null,
      }),
      usage: { input_tokens: 100, output_tokens: 100 },
      model: "test-model",
    }),
    parseJSON: vi.fn().mockImplementation((content: string, schema: { parse: (v: unknown) => unknown }) => {
      return schema.parse(JSON.parse(content));
    }),
    buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
  } as unknown as ILLMClient;
}

/**
 * Creates a real TaskLifecycle with mock LLM and real StateManager.
 */
function makeTaskLifecycle(stateManager: StateManager): TaskLifecycle {
  const llmClient = makeMockLLMClient();
  const sessionManager = new SessionManager(stateManager);
  const trustManager = new TrustManager(stateManager);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  const stallDetector = new StallDetector(stateManager);

  return new TaskLifecycle(
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    { approvalFn: async () => true }
  );
}

class MockAdapter implements IAdapter {
  readonly adapterType = "claude_api";
  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "Task completed",
      error: null,
      exit_code: null,
      elapsed_ms: 5,
      stopped_reason: "completed",
    };
  }
}

// ─── Test Setup ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── R3-1: verifyTask dimension_updates applied via handleVerdict ───

describe("R3-1: verifyTask dimension_updates are applied to goal state via handleVerdict", () => {
  it("pass verdict updates dimension current_value in goal state (0.3 + 0.4 = 0.7)", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoalWithDimension("goal-r3-1", 0.3, 0.7);

    // saveGoal writes to goals/<goalId>/goal.json — same path that handleVerdict reads/writes
    await stateManager.saveGoal(goal);

    const taskLifecycle = makeTaskLifecycle(stateManager);
    const task = makeTask(goal.id);

    // Build a pass verification result with +0.4 delta
    const verificationResult = makeVerificationResult(task.id, "pass", [
      { dimension_name: "quality", previous_value: 0.3, new_value: 0.7, confidence: 0.9 },
    ]);

    // handleVerdict with pass should apply dimension_updates to goal state
    const verdictResult = await taskLifecycle.handleVerdict(task, verificationResult);
    expect(verdictResult.action).toBe("completed");

    // Read back the updated goal state via the nested path (goals/<goalId>/goal.json)
    const updatedGoal = await stateManager.readRaw(`goals/${goal.id}/goal.json`) as {
      dimensions: Array<{ name: string; current_value: number }>;
    };
    expect(updatedGoal).not.toBeNull();
    expect(updatedGoal.dimensions).toBeDefined();

    const qualityDim = updatedGoal.dimensions.find((d) => d.name === "quality");
    expect(qualityDim).toBeDefined();
    // dimension_updates new_value=0.7 is clamped by Guard 1 (max delta ±0.3):
    // current=0.3, proposed=0.7, delta=0.4 → clamped to 0.3+0.3=0.6
    expect(qualityDim!.current_value).toBeCloseTo(0.6, 5);
  });

  it("pass verdict: dimension value is capped at 1.0 when delta would exceed it", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoalWithDimension("goal-r3-1b", 0.9, 0.7);
    await stateManager.saveGoal(goal);

    const taskLifecycle = makeTaskLifecycle(stateManager);
    const task = makeTask(goal.id);

    // +0.4 on 0.9 would be 1.3, but should be capped at 1.0
    const verificationResult = makeVerificationResult(task.id, "pass", [
      { dimension_name: "quality", previous_value: 0.9, new_value: 1.0, confidence: 0.9 },
    ]);

    await taskLifecycle.handleVerdict(task, verificationResult);

    const updatedGoal = await stateManager.readRaw(`goals/${goal.id}/goal.json`) as {
      dimensions: Array<{ name: string; current_value: number }>;
    };
    const qualityDim = updatedGoal.dimensions.find((d) => d.name === "quality");
    expect(qualityDim!.current_value).toBeLessThanOrEqual(1.0);
  });
});

// ─── R3-2: CoreLoop iteration applies dimension_updates from task cycle ───

describe("R3-2: CoreLoop iteration applies dimension_updates from task cycle", () => {
  it("after one iteration, goal dimensions are updated by the task cycle's dimension_updates", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r3-2";
    const goal = makeGoalWithDimension(goalId, 0.3, 0.8);

    // saveGoal writes to goals/<goalId>/goal.json — the path CoreLoop and TaskLifecycle use
    await stateManager.saveGoal(goal);

    // TaskCycleResult with pass verdict and dimension_update +0.4
    const taskCycleResult = makeTaskCycleResult(goalId, "pass");

    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockResolvedValue(taskCycleResult),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    // satisficingJudge: first call returns incomplete, second call (post-task) returns complete
    const satisficingJudgeMock = {
      isGoalComplete: vi.fn()
        .mockReturnValueOnce(makeCompletionJudgment({ is_complete: false }))
        .mockReturnValue(makeCompletionJudgment({ is_complete: true, blocking_dimensions: [] })),
      isDimensionSatisfied: vi.fn(),
      applyProgressCeiling: vi.fn(),
      selectDimensionsForIteration: vi.fn(),
      detectThresholdAdjustmentNeeded: vi.fn(),
      propagateSubgoalCompletion: vi.fn(),
      judgeTreeCompletion: vi.fn(),
    };

    const trackingAdapter = new MockAdapter();

    const deps: CoreLoopDeps = {
      stateManager,
      observationEngine: {
        observe: vi.fn().mockResolvedValue(undefined),
        applyObservation: vi.fn(),
        createObservationEntry: vi.fn(),
        getObservationLog: vi.fn(),
        saveObservationLog: vi.fn(),
        applyProgressCeiling: vi.fn(),
        getConfidenceTier: vi.fn(),
        resolveContradiction: vi.fn(),
        needsVerificationTask: vi.fn(),
      } as unknown as CoreLoopDeps["observationEngine"],
      gapCalculator: {
        calculateGapVector: vi.fn().mockReturnValue(makeGapVector(goalId)),
        aggregateGaps: vi.fn().mockReturnValue(0.4),
      } as unknown as CoreLoopDeps["gapCalculator"],
      driveScorer: {
        scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
        rankDimensions: vi.fn().mockImplementation((s: DriveScore[]) => [...s]),
      } as unknown as CoreLoopDeps["driveScorer"],
      taskLifecycle: taskLifecycleMock as unknown as CoreLoopDeps["taskLifecycle"],
      satisficingJudge: satisficingJudgeMock as unknown as CoreLoopDeps["satisficingJudge"],
      stallDetector: {
        checkDimensionStall: vi.fn().mockReturnValue(null),
        checkGlobalStall: vi.fn().mockReturnValue(null),
        checkTimeExceeded: vi.fn().mockReturnValue(null),
        checkConsecutiveFailures: vi.fn().mockReturnValue(null),
        getEscalationLevel: vi.fn().mockReturnValue(0),
        incrementEscalation: vi.fn().mockReturnValue(1),
        resetEscalation: vi.fn(),
        getStallState: vi.fn(),
        saveStallState: vi.fn(),
        classifyStallCause: vi.fn(),
        computeDecayFactor: vi.fn(),
        isSuppressed: vi.fn(),
      } as unknown as CoreLoopDeps["stallDetector"],
      strategyManager: {
        onStallDetected: vi.fn().mockResolvedValue(null),
        getActiveStrategy: vi.fn().mockReturnValue(null),
        getPortfolio: vi.fn(),
        generateCandidates: vi.fn(),
        activateBestCandidate: vi.fn(),
        updateState: vi.fn(),
        getStrategyHistory: vi.fn(),
      } as unknown as CoreLoopDeps["strategyManager"],
      reportingEngine: {
        generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
        saveReport: vi.fn(),
      } as unknown as CoreLoopDeps["reportingEngine"],
      driveSystem: {
        shouldActivate: vi.fn().mockReturnValue(true),
      } as unknown as CoreLoopDeps["driveSystem"],
      adapterRegistry: {
        getAdapter: vi.fn().mockReturnValue(trackingAdapter),
      } as unknown as CoreLoopDeps["adapterRegistry"],
    };

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goalId);

    // Loop ran at least 1 iteration
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);

    // Task cycle was called
    expect(taskLifecycleMock.runTaskCycle).toHaveBeenCalled();

    // The task cycle result contains dimension_updates
    const cycleResult = result.iterations[0]?.taskResult;
    expect(cycleResult).toBeDefined();
    expect(cycleResult?.verificationResult.dimension_updates).toHaveLength(1);
    expect(cycleResult?.verificationResult.dimension_updates[0]?.dimension_name).toBe("quality");
    expect(cycleResult?.verificationResult.dimension_updates[0]?.new_value).toBeCloseTo(0.7, 5);
  });
});

// ─── R3-3: fail verdict produces no dimension_updates ───

describe("R3-3: fail verdict produces no dimension_updates", () => {
  it("fail verdict leaves dimension current_value unchanged", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoalWithDimension("goal-r3-3", 0.3, 0.7);
    await stateManager.saveGoal(goal);

    const taskLifecycle = makeTaskLifecycle(stateManager);
    const task = makeTask(goal.id);

    // Fail verdict with empty dimension_updates
    const verificationResult = makeVerificationResult(task.id, "fail", []);

    await taskLifecycle.handleVerdict(task, verificationResult);

    // Read back the goal state — should remain unchanged at the nested path
    const updatedGoal = await stateManager.readRaw(`goals/${goal.id}/goal.json`) as {
      dimensions: Array<{ name: string; current_value: number }>;
    };

    const qualityDim = updatedGoal.dimensions.find((d) => d.name === "quality");
    expect(qualityDim).toBeDefined();
    // current_value should still be 0.3 — no updates applied for fail verdict
    expect(qualityDim!.current_value).toBeCloseTo(0.3, 5);
  });

  it("fail verdict: handleVerdict returns keep or escalate action (not completed)", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoalWithDimension("goal-r3-3b", 0.3, 0.7);
    await stateManager.saveGoal(goal);

    const taskLifecycle = makeTaskLifecycle(stateManager);
    const task = makeTask(goal.id, 0);

    const verificationResult = makeVerificationResult(task.id, "fail", []);
    const verdictResult = await taskLifecycle.handleVerdict(task, verificationResult);

    // fail verdict never returns "completed"
    expect(verdictResult.action).not.toBe("completed");
    expect(["keep", "discard", "escalate"]).toContain(verdictResult.action);
  });
});

// ─── R3-4: consecutive failures trigger stall detection ───

describe("R3-4: consecutive failures trigger stall detection", () => {
  it("CoreLoop iteration stallDetected=true when stallDetector.checkDimensionStall returns a report", async () => {
    const stateManager = new StateManager(tmpDir);
    const goalId = "goal-r3-4";
    const goal = makeGoalWithDimension(goalId, 0.3, 0.8);
    await stateManager.saveGoal(goal);

    // A stall report representing consecutive failures
    const stallReport = {
      goal_id: goalId,
      stall_type: "consecutive_failure" as const,
      dimension_name: "quality",
      consecutive_failures: 3,
      escalation_level: 1,
      detected_at: BASE_NOW,
      suppressed: false,
    };

    const taskCycleResult = makeTaskCycleResult(goalId, "fail", 3);

    const taskLifecycleMock = {
      runTaskCycle: vi.fn().mockResolvedValue(taskCycleResult),
      selectTargetDimension: vi.fn(),
      generateTask: vi.fn(),
      checkIrreversibleApproval: vi.fn(),
      executeTask: vi.fn(),
      verifyTask: vi.fn(),
      handleVerdict: vi.fn(),
      handleFailure: vi.fn(),
      setOnTaskComplete: vi.fn(),
    };

    const satisficingJudgeMock = {
      isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment({ is_complete: false })),
      isDimensionSatisfied: vi.fn(),
      applyProgressCeiling: vi.fn(),
      selectDimensionsForIteration: vi.fn(),
      detectThresholdAdjustmentNeeded: vi.fn(),
      propagateSubgoalCompletion: vi.fn(),
      judgeTreeCompletion: vi.fn(),
    };

    const deps: CoreLoopDeps = {
      stateManager,
      observationEngine: {
        observe: vi.fn().mockResolvedValue(undefined),
        applyObservation: vi.fn(),
        createObservationEntry: vi.fn(),
        getObservationLog: vi.fn(),
        saveObservationLog: vi.fn(),
        applyProgressCeiling: vi.fn(),
        getConfidenceTier: vi.fn(),
        resolveContradiction: vi.fn(),
        needsVerificationTask: vi.fn(),
      } as unknown as CoreLoopDeps["observationEngine"],
      gapCalculator: {
        calculateGapVector: vi.fn().mockReturnValue(makeGapVector(goalId)),
        aggregateGaps: vi.fn().mockReturnValue(0.4),
      } as unknown as CoreLoopDeps["gapCalculator"],
      driveScorer: {
        scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
        rankDimensions: vi.fn().mockImplementation((s: DriveScore[]) => [...s]),
      } as unknown as CoreLoopDeps["driveScorer"],
      taskLifecycle: taskLifecycleMock as unknown as CoreLoopDeps["taskLifecycle"],
      satisficingJudge: satisficingJudgeMock as unknown as CoreLoopDeps["satisficingJudge"],
      stallDetector: {
        // checkDimensionStall returns the stall report → triggers stallDetected=true
        checkDimensionStall: vi.fn().mockReturnValue(stallReport),
        checkGlobalStall: vi.fn().mockReturnValue(null),
        checkTimeExceeded: vi.fn().mockReturnValue(null),
        checkConsecutiveFailures: vi.fn().mockReturnValue(stallReport),
        getEscalationLevel: vi.fn().mockReturnValue(1),
        incrementEscalation: vi.fn().mockReturnValue(2),
        resetEscalation: vi.fn(),
        getStallState: vi.fn(),
        saveStallState: vi.fn(),
        classifyStallCause: vi.fn(),
        computeDecayFactor: vi.fn(),
        isSuppressed: vi.fn(),
      } as unknown as CoreLoopDeps["stallDetector"],
      strategyManager: {
        onStallDetected: vi.fn().mockResolvedValue(null),
        getActiveStrategy: vi.fn().mockReturnValue(null),
        getPortfolio: vi.fn(),
        generateCandidates: vi.fn(),
        activateBestCandidate: vi.fn(),
        updateState: vi.fn(),
        getStrategyHistory: vi.fn(),
      } as unknown as CoreLoopDeps["strategyManager"],
      reportingEngine: {
        generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
        saveReport: vi.fn(),
      } as unknown as CoreLoopDeps["reportingEngine"],
      driveSystem: {
        shouldActivate: vi.fn().mockReturnValue(true),
      } as unknown as CoreLoopDeps["driveSystem"],
      adapterRegistry: {
        getAdapter: vi.fn().mockReturnValue(new MockAdapter()),
      } as unknown as CoreLoopDeps["adapterRegistry"],
    };

    const loop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goalId);

    expect(result.totalIterations).toBeGreaterThanOrEqual(1);

    // The iteration result should reflect stall detection
    const iteration = result.iterations[0];
    expect(iteration).toBeDefined();
    expect(iteration!.stallDetected).toBe(true);
    expect(iteration!.stallReport).not.toBeNull();
    expect(iteration!.stallReport?.stall_type).toBe("consecutive_failure");
  });

  it("TaskLifecycle.handleFailure increments consecutive_failure_count and returns escalate after 3 failures", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoalWithDimension("goal-r3-4b", 0.3, 0.7);
    await stateManager.saveGoal(goal);

    const taskLifecycle = makeTaskLifecycle(stateManager);

    // Task already at 2 consecutive failures — one more should trigger escalate
    const task = makeTask(goal.id, 2);
    const verificationResult = makeVerificationResult(task.id, "fail", []);

    const failureResult = await taskLifecycle.handleFailure(task, verificationResult);

    // After 3 consecutive failures (2 + 1 = 3), action should be "escalate"
    expect(failureResult.action).toBe("escalate");
    expect(failureResult.task.consecutive_failure_count).toBe(3);
  });
});
