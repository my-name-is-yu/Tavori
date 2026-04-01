/**
 * R3-2 E2E: Adapter execution via TaskLifecycle.runTaskCycle()
 *
 * Verifies the task generation → adapter execution → verification pipeline
 * works end-to-end with mock components.
 *
 * Test 1: runTaskCycle generates task, executes via adapter, verifies (pass)
 * Test 2: runTaskCycle handles adapter execution failure → fail verdict
 * Test 3: runTaskCycle passes existingTasks for dedup to LLM prompt
 * Test 4: Full pipeline with CoreLoop mock — task results update goal state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { TaskLifecycle } from "../../src/execution/task-lifecycle.js";
import { StateManager } from "../../src/state-manager.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { CoreLoop, type CoreLoopDeps } from "../../src/core-loop.js";
import { AdapterRegistry } from "../../src/execution/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";
import type { Goal } from "../../src/types/goal.js";
import type { GapVector } from "../../src/types/gap.js";
import type { DriveContext } from "../../src/types/drive.js";
import type { DriveScore } from "../../src/types/drive.js";
import type { CompletionJudgment } from "../../src/types/satisficing.js";
import type { TaskCycleResult } from "../../src/execution/task-lifecycle.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Helpers ───

function makeUnsatisfiedGoal(id = "goal-r3-adapter-e2e"): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "Improve documentation quality",
    description: "Improve README and API docs to publishable quality",
    status: "active",
    dimensions: [
      {
        name: "quality",
        label: "Documentation Quality",
        current_value: 0.2,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
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
    created_at: now,
    updated_at: now,
  };
}

function makeGapVector(goalId: string): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "quality",
        raw_gap: 0.6,
        normalized_gap: 0.6,
        normalized_weighted_gap: 0.6,
        confidence: 0.9,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveContext(_goalId: string): DriveContext {
  return {
    time_since_last_attempt: { quality: 0 },
    deadlines: { quality: null },
    opportunities: {},
  };
}

/** LLM response for task generation (valid JSON in code block) */
function makeTaskGenerationResponse(): string {
  return (
    "```json\n" +
    JSON.stringify({
      work_description: "Add comprehensive API usage examples to README.md",
      rationale: "The quality dimension is below threshold due to missing API documentation",
      approach:
        "Write 3 real-world usage examples covering core PulSeed APIs and add them to README",
      success_criteria: [
        {
          description: "README.md contains at least 3 API usage examples",
          verification_method: "grep -c 'example' README.md",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["README.md", "API examples"],
        out_of_scope: ["source code changes"],
        blast_radius: "documentation only",
      },
      constraints: ["must not break existing sections"],
      reversibility: "reversible",
      estimated_duration: { value: 30, unit: "minutes" },
    }) +
    "\n```"
  );
}

/** LLM response for verification review (pass) */
function makeVerificationPassResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning:
      "All success criteria met. README now contains comprehensive API examples.",
    criteria_met: 1,
    criteria_total: 1,
  });
}

/** LLM response for verification review (fail) */
function makeVerificationFailResponse(): string {
  return JSON.stringify({
    verdict: "fail",
    reasoning: "Adapter execution failed, no meaningful output produced.",
    criteria_met: 0,
    criteria_total: 1,
  });
}

// ─── TrackingMockAdapter ───

class TrackingMockAdapter implements IAdapter {
  readonly adapterType = "openai_codex_cli";
  private readonly _shouldSucceed: boolean;
  public executeCalls: AgentTask[] = [];

  constructor(shouldSucceed = true) {
    this._shouldSucceed = shouldSucceed;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.executeCalls.push(task);
    if (this._shouldSucceed) {
      return {
        success: true,
        output: "Task completed successfully. API examples added to README.",
        error: null,
        exit_code: 0,
        elapsed_ms: 10,
        stopped_reason: "completed",
      };
    }
    return {
      success: false,
      output: "",
      error: "Adapter execution failed: network timeout",
      exit_code: 1,
      elapsed_ms: 10,
      stopped_reason: "error",
    };
  }
}

// ─── Setup ───

let tmpDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tmpDir = makeTempDir();
  stateManager = new StateManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Test 1: successful pipeline ───

describe("R3: runTaskCycle generates task, executes via adapter, and verifies", () => {
  it("generates a task, calls adapter.execute, and returns pass verdict with dimension_updates", async () => {
    const goal = makeUnsatisfiedGoal();
    await stateManager.saveGoal(goal);

    // LLM: task generation + LLM review (2 calls total; L1 mechanical check skips on "grep" prefix so L2 runs)
    // Actually with "grep -c" verification_method, L1 is applicable (passes mechanically),
    // then L2 review is called once → total 2 LLM calls.
    const mockLLM = createMockLLMClient([
      makeTaskGenerationResponse(),   // call 0: generateTask
      makeVerificationPassResponse(), // call 1: runLLMReview
    ]);

    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, mockLLM);
    const stallDetector = new StallDetector(stateManager);

    const adapter = new TrackingMockAdapter(true);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      mockLLM,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true, healthCheckEnabled: false }
    );

    const gapVector = makeGapVector(goal.id);
    const driveContext = makeDriveContext(goal.id);

    const result = await taskLifecycle.runTaskCycle(
      goal.id,
      gapVector,
      driveContext,
      adapter
    );

    // A task was generated
    expect(result.task).toBeDefined();
    expect(result.task.goal_id).toBe(goal.id);
    expect(result.task.primary_dimension).toBe("quality");
    expect(result.task.work_description).toContain("README");

    // adapter.execute() was called with work_description content
    expect(adapter.executeCalls).toHaveLength(1);
    expect(adapter.executeCalls[0]!.prompt).toContain("README");

    // Verification returned pass
    expect(result.verificationResult).toBeDefined();
    expect(result.verificationResult.verdict).toBe("pass");

    // dimension_updates are present (pass verdict generates updates)
    expect(result.verificationResult.dimension_updates.length).toBeGreaterThan(0);
    expect(result.verificationResult.dimension_updates[0]!.dimension_name).toBe("quality");
    expect(typeof result.verificationResult.dimension_updates[0]!.new_value).toBe("number");

    // Action is completed
    expect(result.action).toBe("completed");
  });
});

// ─── Test 2: adapter execution failure ───

describe("R3: runTaskCycle handles adapter execution failure", () => {
  it("returns fail verdict and no dimension_updates when adapter fails", async () => {
    const goal = makeUnsatisfiedGoal("goal-r3-fail");
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([
      makeTaskGenerationResponse(),   // call 0: generateTask
      makeVerificationFailResponse(), // call 1: runLLMReview
    ]);

    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, mockLLM);
    const stallDetector = new StallDetector(stateManager);

    // Adapter that returns failure
    const adapter = new TrackingMockAdapter(false);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      mockLLM,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true, healthCheckEnabled: false }
    );

    const gapVector = makeGapVector(goal.id);
    const driveContext = makeDriveContext(goal.id);

    const result = await taskLifecycle.runTaskCycle(
      goal.id,
      gapVector,
      driveContext,
      adapter
    );

    // adapter.execute() was still called
    expect(adapter.executeCalls).toHaveLength(1);

    // Verification returned fail
    expect(result.verificationResult.verdict).toBe("fail");

    // No dimension_updates on fail
    expect(result.verificationResult.dimension_updates).toHaveLength(0);

    // Action is not "completed"
    expect(result.action).not.toBe("completed");
  });
});

// ─── Test 3: existingTasks dedup ───

describe("R3: runTaskCycle passes existingTasks for dedup", () => {
  it("includes existingTasks in LLM prompt when provided", async () => {
    const goal = makeUnsatisfiedGoal("goal-r3-dedup");
    await stateManager.saveGoal(goal);

    let capturedPromptContent = "";
    const mockLLM = {
      sendMessage: vi.fn().mockImplementation(
        async (messages: Array<{ role: string; content: string }>) => {
          // Capture the prompt sent for task generation
          capturedPromptContent = messages[0]?.content ?? "";
          return {
            content: makeTaskGenerationResponse(),
            usage: { input_tokens: 100, output_tokens: 200 },
            stop_reason: "end_turn",
          };
        }
      ),
      parseJSON: createMockLLMClient([makeTaskGenerationResponse()]).parseJSON.bind(
        createMockLLMClient([makeTaskGenerationResponse()])
      ),
    };

    // Also stub out verifyTask calls (second LLM call)
    let callIndex = 0;
    mockLLM.sendMessage = vi.fn().mockImplementation(
      async (messages: Array<{ role: string; content: string }>) => {
        const responses = [
          makeTaskGenerationResponse(), // generateTask
          makeVerificationPassResponse(), // runLLMReview
        ];
        const content = responses[callIndex] ?? makeVerificationPassResponse();
        if (callIndex === 0) {
          capturedPromptContent = messages[0]?.content ?? "";
        }
        callIndex++;
        return {
          content,
          usage: { input_tokens: 10, output_tokens: content.length },
          stop_reason: "end_turn",
        };
      }
    );

    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, mockLLM as Parameters<typeof StrategyManager>[1]);
    const stallDetector = new StallDetector(stateManager);
    const adapter = new TrackingMockAdapter(true);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      mockLLM as Parameters<typeof TaskLifecycle>[1],
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true, healthCheckEnabled: false }
    );

    const existingTasks = [
      "Update changelog with recent improvements",
      "Fix typo in contributing guide",
    ];

    const gapVector = makeGapVector(goal.id);
    const driveContext = makeDriveContext(goal.id);

    await taskLifecycle.runTaskCycle(
      goal.id,
      gapVector,
      driveContext,
      adapter,
      undefined, // knowledgeContext
      existingTasks
    );

    // Verify that the LLM prompt included the existing tasks
    // The prompt section header is "Previously Generated Tasks (avoid duplication)"
    expect(capturedPromptContent).toContain("Update changelog with recent improvements");
    expect(capturedPromptContent).toContain("Fix typo in contributing guide");
    // Prompt instructs LLM to address a DIFFERENT aspect
    expect(capturedPromptContent).toContain("DIFFERENT aspect");
  });
});

// ─── Test 4: Full pipeline with CoreLoop mock — task results update goal state ───

describe("R3: full pipeline with CoreLoop — task results update goal state", () => {
  it("goal dimension current_value is updated after runTaskCycle completes with pass", async () => {
    const goal = makeUnsatisfiedGoal("goal-r3-state-update");
    await stateManager.saveGoal(goal);

    const initialGoal = await stateManager.loadGoal(goal.id);
    expect(initialGoal).not.toBeNull();
    const initialValue = initialGoal!.dimensions[0]!.current_value as number;
    expect(initialValue).toBe(0.2);

    const mockLLM = createMockLLMClient([
      makeTaskGenerationResponse(),   // generateTask
      makeVerificationPassResponse(), // runLLMReview
    ]);

    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, mockLLM);
    const stallDetector = new StallDetector(stateManager);
    const adapter = new TrackingMockAdapter(true);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      mockLLM,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true, healthCheckEnabled: false }
    );

    const gapVector = makeGapVector(goal.id);
    const driveContext = makeDriveContext(goal.id);

    const result = await taskLifecycle.runTaskCycle(
      goal.id,
      gapVector,
      driveContext,
      adapter
    );

    // Verify the task cycle completed successfully
    expect(result.action).toBe("completed");
    expect(result.verificationResult.verdict).toBe("pass");

    // Verify goal state was updated on disk: handleVerdict(pass) writes dimension_updates back
    const updatedGoal = await stateManager.loadGoal(goal.id);
    expect(updatedGoal).not.toBeNull();
    const updatedDim = updatedGoal!.dimensions.find((d) => d.name === "quality");
    expect(updatedDim).toBeDefined();
    // Pass verdict uses progressDelta=0.2, scaled by threshold.value=0.8: scaledDelta=0.16
    // new_value = 0.2 + 0.16 = 0.36
    expect(updatedDim!.current_value as number).toBeGreaterThan(initialValue);
    expect(updatedDim!.current_value as number).toBeCloseTo(0.36, 5);
  });

  it("CoreLoop with real TaskLifecycle runs one iteration and task cycle executes", async () => {
    const goal = makeUnsatisfiedGoal("goal-r3-coreloop");
    await stateManager.saveGoal(goal);

    const mockLLM = createMockLLMClient([
      makeTaskGenerationResponse(),   // generateTask
      makeVerificationPassResponse(), // runLLMReview
    ]);

    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, mockLLM);
    const stallDetector = new StallDetector(stateManager);
    const adapter = new TrackingMockAdapter(true);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      mockLLM,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true, healthCheckEnabled: false }
    );

    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(adapter);

    // Use mocks for the non-TaskLifecycle CoreLoop deps
    const goalId = goal.id;
    const gapVector = makeGapVector(goalId);

    const driveScores: DriveScore[] = [
      {
        dimension_name: "quality",
        dissatisfaction: 0.6,
        deadline: 0,
        opportunity: 0,
        final_score: 0.6,
        dominant_drive: "dissatisfaction",
      },
    ];

    const completionJudgment: CompletionJudgment = {
      is_complete: false,
      blocking_dimensions: ["quality"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
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
        calculateGapVector: vi.fn().mockReturnValue(gapVector),
        aggregateGaps: vi.fn().mockReturnValue(0.6),
      } as unknown as CoreLoopDeps["gapCalculator"],
      driveScorer: {
        scoreAllDimensions: vi.fn().mockReturnValue(driveScores),
        rankDimensions: vi.fn().mockImplementation((s: DriveScore[]) => [...s]),
      } as unknown as CoreLoopDeps["driveScorer"],
      taskLifecycle,
      satisficingJudge: {
        isGoalComplete: vi.fn().mockReturnValue(completionJudgment),
        isDimensionSatisfied: vi.fn(),
        applyProgressCeiling: vi.fn(),
        selectDimensionsForIteration: vi.fn(),
        detectThresholdAdjustmentNeeded: vi.fn(),
        propagateSubgoalCompletion: vi.fn(),
        judgeTreeCompletion: vi.fn(),
      } as unknown as CoreLoopDeps["satisficingJudge"],
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
      adapterRegistry,
    };

    const coreLoop = new CoreLoop(deps, { maxIterations: 1, delayBetweenLoopsMs: 0 });
    const loopResult = await coreLoop.run(goalId);

    // Loop ran at least one iteration
    expect(loopResult.totalIterations).toBeGreaterThanOrEqual(1);
    expect(["max_iterations", "completed"]).toContain(loopResult.finalStatus);

    // adapter.execute() was called through the real TaskLifecycle
    expect(adapter.executeCalls).toHaveLength(1);

    // Goal dimension was updated after the pass verdict
    const updatedGoal = await stateManager.loadGoal(goalId);
    expect(updatedGoal).not.toBeNull();
    const dim = updatedGoal!.dimensions.find((d) => d.name === "quality");
    expect(dim).toBeDefined();
    expect(dim!.current_value as number).toBeGreaterThan(0.2);
  });
});
