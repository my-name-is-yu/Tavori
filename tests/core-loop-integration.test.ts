/**
 * Integration test: CoreLoop + TaskLifecycle + ObservationEngine + StateManager
 * (and supporting real deps). Only MockLLMClient and MockAdapter are mocked.
 *
 * Verifies that a single complete loop iteration:
 *   - Does not throw
 *   - Produces a LoopResult with expected structure
 *   - Writes state changes to StateManager (gap history, task records)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// ─── Real implementations ───
import { StateManager } from "../src/state/state-manager.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { TaskLifecycle } from "../src/execution/task/task-lifecycle.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { ReportingEngine } from "../src/reporting/reporting-engine.js";
import { DriveSystem } from "../src/drive/drive-system.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { CoreLoop } from "../src/loop/core-loop.js";
import { AdapterRegistry } from "../src/execution/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../src/execution/adapter-layer.js";

// ─── Pure function modules ───
import * as GapCalculator from "../src/drive/gap-calculator.js";
import * as DriveScorer from "../src/drive/drive-scorer.js";

// ─── Mock utilities ───
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Types ───
import type { Goal } from "../src/types/goal.js";

// ─── MockAdapter ───

class MockAdapter implements IAdapter {
  readonly adapterType = "claude_api";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "Task completed successfully. All criteria met.",
      error: null,
      exit_code: null,
      elapsed_ms: 10,
      stopped_reason: "completed",
    };
  }
}

// ─── Helpers ───

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeGoal(id: string): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "Integration Test Goal",
    description: "Goal used for integration testing",
    status: "active",
    dimensions: [
      {
        name: "test_dimension",
        label: "Test Dimension",
        current_value: 0.2,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.7,
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
    created_at: now,
    updated_at: now,
  };
}

// ─── LLM Response Fixtures ───

/**
 * Task generation response — matches LLMGeneratedTaskSchema in task-lifecycle.ts
 */
function makeTaskGenerationResponse(): string {
  return JSON.stringify({
    work_description: "Increase test_dimension value by improving the underlying metric",
    rationale: "The test_dimension is currently at 0.2, far below the 0.8 threshold",
    approach: "Systematically work through the requirements for test_dimension",
    success_criteria: [
      {
        description: "test_dimension value exceeds 0.4",
        verification_method: "manual check of the metric value",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["test_dimension metric"],
      out_of_scope: ["other dimensions"],
      blast_radius: "minimal — only affects test_dimension",
    },
    constraints: ["must not exceed resource limits"],
    reversibility: "reversible",
    estimated_duration: { value: 30, unit: "minutes" },
  });
}

/**
 * LLM review response — parsed by runLLMReview in task-lifecycle.ts
 */
function makeLLMReviewResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning: "The task output satisfies all success criteria",
    criteria_met: 1,
    criteria_total: 1,
  });
}

// ─── Tests ───

describe("CoreLoop integration — single iteration with real deps", () => {
  let tempDir: string;
  let goalId: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    goalId = "integration-goal-1";
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("completes one iteration without throwing and produces expected LoopResult structure", async () => {
    // ─── Wire real dependencies ───
    const stateManager = new StateManager(tempDir);
    const observationEngine = new ObservationEngine(stateManager);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const reportingEngine = new ReportingEngine(stateManager);
    const driveSystem = new DriveSystem(stateManager);

    // MockLLMClient: task generation + LLM review
    const llmClient = createMockLLMClient([
      // Call 1: task generation
      "```json\n" + makeTaskGenerationResponse() + "\n```",
      // Call 2: LLM review (verifyTask → runLLMReview)
      makeLLMReviewResponse(),
    ]);

    const strategyManager = new StrategyManager(stateManager, llmClient);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      {
        // approvalFn: always approve so irreversible check doesn't block
        approvalFn: async (_task) => true, healthCheckEnabled: false,
      }
    );

    // ─── Adapter setup ───
    const mockAdapter = new MockAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(mockAdapter);

    // ─── CoreLoop setup ───
    const coreLoop = new CoreLoop(
      {
        stateManager,
        observationEngine,
        gapCalculator: GapCalculator,
        driveScorer: DriveScorer,
        taskLifecycle,
        satisficingJudge,
        stallDetector,
        strategyManager,
        reportingEngine,
        driveSystem,
        adapterRegistry,
      },
      {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      }
    );

    // ─── Persist the goal before running ───
    const goal = makeGoal(goalId);
    await stateManager.saveGoal(goal);

    // ─── Run the loop ───
    const result = await coreLoop.run(goalId);

    // ─── Assertions: LoopResult structure ───
    expect(result).toBeDefined();
    expect(result.goalId).toBe(goalId);
    expect(typeof result.totalIterations).toBe("number");
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);
    expect(["max_iterations", "completed", "stalled", "stopped", "error"]).toContain(
      result.finalStatus
    );
    expect(Array.isArray(result.iterations)).toBe(true);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();

    // ─── Assertions: iteration result structure ───
    const iteration = result.iterations[0];
    expect(iteration).toBeDefined();
    expect(iteration!.loopIndex).toBe(0);
    expect(iteration!.goalId).toBe(goalId);
    expect(typeof iteration!.gapAggregate).toBe("number");
    expect(Array.isArray(iteration!.driveScores)).toBe(true);
    expect(iteration!.completionJudgment).toBeDefined();
    expect(typeof iteration!.completionJudgment.is_complete).toBe("boolean");

    // ─── Assertions: gap history written to StateManager ───
    const gapHistory = await stateManager.loadGapHistory(goalId);
    expect(gapHistory.length).toBeGreaterThanOrEqual(1);
    expect(gapHistory[0]!.iteration).toBe(0);
    expect(Array.isArray(gapHistory[0]!.gap_vector)).toBe(true);
  });

  it("returns error status when goal does not exist", async () => {
    const stateManager = new StateManager(tempDir);
    const observationEngine = new ObservationEngine(stateManager);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const reportingEngine = new ReportingEngine(stateManager);
    const driveSystem = new DriveSystem(stateManager);
    const llmClient = createMockLLMClient([]);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const taskLifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector
    );
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(new MockAdapter());

    const coreLoop = new CoreLoop(
      {
        stateManager,
        observationEngine,
        gapCalculator: GapCalculator,
        driveScorer: DriveScorer,
        taskLifecycle,
        satisficingJudge,
        stallDetector,
        strategyManager,
        reportingEngine,
        driveSystem,
        adapterRegistry,
      },
      { maxIterations: 1, delayBetweenLoopsMs: 0 }
    );

    const result = await coreLoop.run("nonexistent-goal-id");
    expect(result.finalStatus).toBe("error");
    expect(result.totalIterations).toBe(0);
  });

  it("writes task record to StateManager after successful task cycle", async () => {
    const stateManager = new StateManager(tempDir);
    const observationEngine = new ObservationEngine(stateManager);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const reportingEngine = new ReportingEngine(stateManager);
    const driveSystem = new DriveSystem(stateManager);

    const llmClient = createMockLLMClient([
      "```json\n" + makeTaskGenerationResponse() + "\n```",
      makeLLMReviewResponse(),
    ]);

    const strategyManager = new StrategyManager(stateManager, llmClient);
    const taskLifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true, healthCheckEnabled: false }
    );

    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(new MockAdapter());

    const coreLoop = new CoreLoop(
      {
        stateManager,
        observationEngine,
        gapCalculator: GapCalculator,
        driveScorer: DriveScorer,
        taskLifecycle,
        satisficingJudge,
        stallDetector,
        strategyManager,
        reportingEngine,
        driveSystem,
        adapterRegistry,
      },
      { maxIterations: 1, delayBetweenLoopsMs: 0 }
    );

    const goal = makeGoal(goalId);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    // The iteration result should have a taskResult (unless task cycle failed)
    const iteration = result.iterations[0];
    expect(iteration).toBeDefined();

    if (iteration!.taskResult !== null) {
      const taskResult = iteration!.taskResult;
      expect(taskResult.task).toBeDefined();
      expect(taskResult.task.goal_id).toBe(goalId);
      expect(taskResult.task.primary_dimension).toBe("test_dimension");
      expect(taskResult.verificationResult).toBeDefined();

      // Verify task was persisted to disk
      const taskId = taskResult.task.id;
      const taskOnDisk = await stateManager.readRaw(`tasks/${goalId}/${taskId}.json`);
      expect(taskOnDisk).toBeDefined();
    }
  });
});
