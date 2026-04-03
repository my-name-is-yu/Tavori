import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  CoreLoop,
  type LoopConfig,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../src/loop/core-loop.js";
import { StateManager } from "../src/state/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../src/execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import type { StallDetector } from "../src/drive/stall-detector.js";
import type { StrategyManager } from "../src/strategy/strategy-manager.js";
import type { DriveSystem } from "../src/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../src/execution/adapter-layer.js";
import type { CapabilityDetector } from "../src/observation/capability-detector.js";
import type { GapVector } from "../src/types/gap.js";
import type { CompletionJudgment } from "../src/types/satisficing.js";
import type { DriveScore } from "../src/types/drive.js";
import type { CapabilityAcquisitionTask } from "../src/types/capability.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "dim1",
        raw_gap: 5,
        normalized_gap: 0.5,
        normalized_weighted_gap: 0.5,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "dim1",
      dissatisfaction: 0.5,
      deadline: 0,
      opportunity: 0,
      final_score: 0.5,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAcquisitionTask(overrides: Partial<CapabilityAcquisitionTask> = {}): CapabilityAcquisitionTask {
  return {
    gap: {
      missing_capability: { name: "docker", type: "tool" },
      reason: "Need Docker for container builds",
      alternatives: ["podman"],
      impact_description: "Cannot build containers without Docker",
      related_task_id: "task-1",
    },
    method: "tool_creation",
    task_description: "Install and configure Docker",
    success_criteria: ["capability registered in registry", "docker is operational and accessible"],
    verification_attempts: 0,
    max_verification_attempts: 3,
    ...overrides,
  };
}

function makeCapabilityAcquiringResult(
  acquisitionTask: CapabilityAcquisitionTask = makeAcquisitionTask()
): TaskCycleResult {
  return {
    task: {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["dim1"],
      primary_dimension: "dim1",
      work_description: "Install Docker",
      rationale: "Need Docker",
      approach: "apt-get install docker",
      success_criteria: [
        {
          description: "Docker installed",
          verification_method: "manual check",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["docker"],
        out_of_scope: [],
        blast_radius: "none",
      },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "capability_acquisition",
      status: "pending",
      started_at: new Date().toISOString(),
      completed_at: null,
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: "task-1",
      verdict: "inconclusive",
      confidence: 0.5,
      evidence: [],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action: "capability_acquiring",
    acquisition_task: acquisitionTask,
  };
}

// ─── Mock Factories ───

function createMockAdapter(): IAdapter {
  return {
    adapterType: "openai_codex_cli",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "Docker installed successfully",
      error: null,
      exit_code: 0,
      elapsed_ms: 5000,
      stopped_reason: "completed",
    }),
  };
}

function createMockCapabilityDetector() {
  return {
    detectDeficiency: vi.fn(),
    detectGoalCapabilityGap: vi.fn(),
    planAcquisition: vi.fn(),
    verifyAcquiredCapability: vi.fn().mockResolvedValue("pass"),
    registerCapability: vi.fn().mockResolvedValue(undefined),
    setCapabilityStatus: vi.fn().mockResolvedValue(undefined),
    escalateToUser: vi.fn().mockResolvedValue(undefined),
    loadRegistry: vi.fn(),
    saveRegistry: vi.fn(),
    confirmDeficiency: vi.fn(),
    findCapabilityByName: vi.fn(),
    getAcquisitionHistory: vi.fn(),
    removeCapability: vi.fn(),
  };
}

function createMockDeps(tmpDir: string) {
  const stateManager = new StateManager(tmpDir);
  const adapter = createMockAdapter();

  const observationEngine = {
    observe: vi.fn(),
    applyObservation: vi.fn(),
    createObservationEntry: vi.fn(),
    getObservationLog: vi.fn(),
    saveObservationLog: vi.fn(),
    applyProgressCeiling: vi.fn(),
    getConfidenceTier: vi.fn(),
    resolveContradiction: vi.fn(),
    needsVerificationTask: vi.fn(),
  };

  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.5),
  };

  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) =>
      [...scores].sort((a, b) => b.final_score - a.final_score)
    ),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue(makeCapabilityAcquiringResult()),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
  };

  const stallDetector = {
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
  };

  const strategyManager = {
    onStallDetected: vi.fn().mockResolvedValue(null),
    getActiveStrategy: vi.fn().mockReturnValue(null),
    getPortfolio: vi.fn(),
    generateCandidates: vi.fn(),
    activateBestCandidate: vi.fn(),
    updateState: vi.fn(),
    getStrategyHistory: vi.fn(),
  };

  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
    saveReport: vi.fn(),
  };

  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
    processEvents: vi.fn().mockReturnValue([]),
    readEventQueue: vi.fn().mockReturnValue([]),
    archiveEvent: vi.fn(),
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    isScheduleDue: vi.fn(),
    createDefaultSchedule: vi.fn(),
    prioritizeGoals: vi.fn(),
  };

  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue(adapter),
    register: vi.fn(),
    listAdapters: vi.fn().mockReturnValue(["openai_codex_cli"]),
  };

  const capabilityDetector = createMockCapabilityDetector();

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as unknown as ObservationEngine,
    gapCalculator: gapCalculator as unknown as GapCalculatorModule,
    driveScorer: driveScorer as unknown as DriveScorerModule,
    taskLifecycle: taskLifecycle as unknown as TaskLifecycle,
    satisficingJudge: satisficingJudge as unknown as SatisficingJudge,
    stallDetector: stallDetector as unknown as StallDetector,
    strategyManager: strategyManager as unknown as StrategyManager,
    reportingEngine: reportingEngine as unknown as ReportingEngine,
    driveSystem: driveSystem as unknown as DriveSystem,
    adapterRegistry: adapterRegistry as unknown as AdapterRegistry,
    capabilityDetector: capabilityDetector as unknown as CapabilityDetector,
  };

  return {
    deps,
    mocks: {
      stateManager,
      observationEngine,
      gapCalculator,
      driveScorer,
      taskLifecycle,
      satisficingJudge,
      stallDetector,
      strategyManager,
      reportingEngine,
      driveSystem,
      adapterRegistry,
      adapter,
      capabilityDetector,
    },
  };
}

// ─── Tests ───

describe("CoreLoop — capability_acquiring handler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("successful acquire -> verify(pass) -> register cycle", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    const goal = makeGoal();
    await mocks.stateManager.saveGoal(goal);

    // capabilityDetector.verifyAcquiredCapability returns "pass"
    mocks.capabilityDetector.verifyAcquiredCapability.mockResolvedValue("pass");

    const loop = new CoreLoop(deps, { maxIterations: 1 });
    const result = await loop.run("goal-1");

    expect(result.totalIterations).toBe(1);

    // Verify adapter.execute was called with a prompt containing the capability info
    expect(mocks.adapter.execute).toHaveBeenCalled();
    const executeCall = (mocks.adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(executeCall.prompt).toContain("docker");
    expect(executeCall.prompt).toContain("tool_creation");

    // Verify verifyAcquiredCapability was called
    expect(mocks.capabilityDetector.verifyAcquiredCapability).toHaveBeenCalledTimes(1);
    const verifyCall = mocks.capabilityDetector.verifyAcquiredCapability.mock.calls[0];
    expect(verifyCall[0].name).toBe("docker");
    expect(verifyCall[0].type).toBe("tool");

    // Verify registerCapability was called with the capability and context
    expect(mocks.capabilityDetector.registerCapability).toHaveBeenCalledTimes(1);
    const registerCall = mocks.capabilityDetector.registerCapability.mock.calls[0];
    expect(registerCall[0].name).toBe("docker");
    expect(registerCall[1].goal_id).toBe("goal-1");

    // Verify setCapabilityStatus was called with "available"
    expect(mocks.capabilityDetector.setCapabilityStatus).toHaveBeenCalledWith(
      "docker",
      "tool",
      "available"
    );

    // escalateToUser should NOT have been called
    expect(mocks.capabilityDetector.escalateToUser).not.toHaveBeenCalled();
  });

  it("verify failure retries up to 3 times then escalates", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    const goal = makeGoal();
    await mocks.stateManager.saveGoal(goal);

    // verifyAcquiredCapability returns "fail" every time
    mocks.capabilityDetector.verifyAcquiredCapability.mockResolvedValue("fail");

    // Run 3 iterations (each returning capability_acquiring with fail verification)
    const loop = new CoreLoop(deps, { maxIterations: 3 });

    // After the loop completes (completing judgment stays false, iterations max out)
    const result = await loop.run("goal-1");

    expect(result.totalIterations).toBe(3);

    // verifyAcquiredCapability should have been called 3 times
    expect(mocks.capabilityDetector.verifyAcquiredCapability).toHaveBeenCalledTimes(3);

    // registerCapability should NOT have been called (all failures)
    expect(mocks.capabilityDetector.registerCapability).not.toHaveBeenCalled();

    // escalateToUser should have been called on the 3rd failure
    expect(mocks.capabilityDetector.escalateToUser).toHaveBeenCalledTimes(1);
    expect(mocks.capabilityDetector.escalateToUser).toHaveBeenCalledWith(
      expect.objectContaining({
        missing_capability: { name: "docker", type: "tool" },
      }),
      "goal-1"
    );

    // setCapabilityStatus should have been called with "verification_failed"
    expect(mocks.capabilityDetector.setCapabilityStatus).toHaveBeenCalledWith(
      "docker",
      "tool",
      "verification_failed"
    );
  });

  it("immediate escalation when verify returns 'escalate'", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    const goal = makeGoal();
    await mocks.stateManager.saveGoal(goal);

    // verifyAcquiredCapability returns "escalate" (max verification attempts in verifier)
    mocks.capabilityDetector.verifyAcquiredCapability.mockResolvedValue("escalate");

    const loop = new CoreLoop(deps, { maxIterations: 1 });
    const result = await loop.run("goal-1");

    expect(result.totalIterations).toBe(1);

    // escalateToUser should be called immediately
    expect(mocks.capabilityDetector.escalateToUser).toHaveBeenCalledTimes(1);
    expect(mocks.capabilityDetector.setCapabilityStatus).toHaveBeenCalledWith(
      "docker",
      "tool",
      "verification_failed"
    );

    // registerCapability should NOT have been called
    expect(mocks.capabilityDetector.registerCapability).not.toHaveBeenCalled();
  });

  it("missing capabilityDetector gracefully skips (no crash)", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    const goal = makeGoal();
    await mocks.stateManager.saveGoal(goal);

    // Remove capabilityDetector from deps
    delete (deps as Partial<CoreLoopDeps>).capabilityDetector;

    const loop = new CoreLoop(deps, { maxIterations: 1 });

    // Should not throw
    const result = await loop.run("goal-1");

    expect(result.totalIterations).toBe(1);
    // The loop ran without crashing — that's the assertion
    expect(result.finalStatus).not.toBe("error");
  });

  it("adapter execution failure records failure and escalates after 3", async () => {
    const { deps, mocks } = createMockDeps(tmpDir);
    const goal = makeGoal();
    await mocks.stateManager.saveGoal(goal);

    // adapter.execute throws an error
    (mocks.adapter.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));

    const loop = new CoreLoop(deps, { maxIterations: 3 });
    const result = await loop.run("goal-1");

    expect(result.totalIterations).toBe(3);

    // verifyAcquiredCapability should NOT have been called (adapter failed before verification)
    expect(mocks.capabilityDetector.verifyAcquiredCapability).not.toHaveBeenCalled();

    // escalateToUser should have been called after 3 adapter failures
    expect(mocks.capabilityDetector.escalateToUser).toHaveBeenCalledTimes(1);
  });
});
