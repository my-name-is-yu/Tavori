import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { CoreLoop, type CoreLoopDeps } from "../core-loop.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../../../platform/drive/satisficing-judge.js";
import type { StallDetector } from "../../../platform/drive/stall-detector.js";
import type { StrategyManager } from "../../strategy/strategy-manager.js";
import type { DriveSystem } from "../../../platform/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../../execution/adapter-layer.js";
import type { GapCalculatorModule, DriveScorerModule, ReportingEngine } from "../core-loop.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { CompletionJudgment } from "../../../base/types/satisficing.js";
import type { DriveScore } from "../../../base/types/drive.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StaticCorePhasePolicyRegistry } from "../core-loop/phase-policy.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [{
      dimension_name: "dim1",
      raw_gap: 4,
      normalized_gap: 0.4,
      normalized_weighted_gap: 0.4,
      confidence: 0.8,
      uncertainty_weight: 1,
    }],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [{
    dimension_name: "dim1",
    dissatisfaction: 0.4,
    deadline: 0,
    opportunity: 0,
    final_score: 0.4,
    dominant_drive: "dissatisfaction",
  }];
}

function makeCompletionJudgment(overrides: Partial<CompletionJudgment> = {}): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskCycleResult(): TaskCycleResult {
  return {
    task: {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["dim1"],
      primary_dimension: "dim1",
      work_description: "Implement the change",
      rationale: "Need progress",
      approach: "Edit and verify",
      success_criteria: [{ description: "Tests pass", verification_method: "run tests", is_blocking: true }],
      scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "normal",
      status: "completed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: "task-1",
      verdict: "pass",
      confidence: 0.9,
      evidence: [],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action: "completed",
  };
}

function makeAdapter(): IAdapter {
  return {
    adapterType: "openai_codex_cli",
    execute: vi.fn(),
  };
}

function createDeps(tmpDir: string, options?: { stall?: boolean }) {
  const stateManager = new StateManager(tmpDir);
  const adapter = makeAdapter();
  const observationEngine = {
    getDataSources: vi.fn().mockReturnValue([]),
    observe: vi.fn().mockResolvedValue(undefined),
  };
  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.4),
  };
  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) => scores),
  };
  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult()),
    setOnTaskComplete: vi.fn(),
  };
  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
  };
  const stallDetector = {
    checkDimensionStall: vi.fn().mockReturnValue(options?.stall
      ? {
          stall_type: "dimension_stall",
          goal_id: "goal-1",
          dimension_name: "dim1",
          task_id: null,
          detected_at: new Date().toISOString(),
          escalation_level: 0,
          suggested_cause: "approach_failure",
          decay_factor: 0.5,
        }
      : null),
    checkGlobalStall: vi.fn().mockReturnValue(null),
    getEscalationLevel: vi.fn().mockResolvedValue(0),
    incrementEscalation: vi.fn().mockResolvedValue(1),
    resetEscalation: vi.fn().mockResolvedValue(undefined),
    isSuppressed: vi.fn().mockReturnValue(false),
  };
  const strategyManager = {
    getActiveStrategy: vi.fn().mockResolvedValue(null),
    getPortfolio: vi.fn().mockResolvedValue(null),
  };
  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ ok: true }),
    saveReport: vi.fn(),
  };
  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
  };
  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue(adapter),
  };
  const corePhaseRunner = {
    run: vi.fn().mockImplementation(async (spec: { phase: string }) => {
      const outputs: Record<string, unknown> = {
        observe_evidence: { summary: "observe-summary", evidence: ["git clean"], missing_info: [], confidence: 0.8 },
        knowledge_refresh: {
          summary: "knowledge-summary",
          required_knowledge: ["recent architectural note"],
          acquisition_candidates: ["soil lookup"],
          confidence: 0.85,
          worthwhile: true,
        },
        replanning_options: {
          summary: "replan-summary",
          recommended_action: "continue",
          candidates: [{
            title: "Task A",
            rationale: "fast",
            expected_evidence_gain: "medium",
            blast_radius: "low",
            target_dimensions: ["dim1"],
            dependencies: [],
          }],
          confidence: 0.8,
        },
        verification_evidence: {
          summary: "verify-summary",
          supported_claims: ["tests pass"],
          unsupported_claims: [],
          blockers: [],
          confidence: 0.9,
        },
        stall_investigation: {
          summary: "stall-summary",
          suspected_causes: ["approach_failure"],
          recommended_next_evidence: ["inspect files"],
          relevant_actions: ["refine"],
          confidence: 0.7,
        },
      };

      return {
        success: true,
        output: outputs[spec.phase],
        finalText: "",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: `trace-${spec.phase}`,
        sessionId: `session-${spec.phase}`,
        turnId: `turn-${spec.phase}`,
      };
    }),
  };

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as never as ObservationEngine,
    gapCalculator: gapCalculator as never as GapCalculatorModule,
    driveScorer: driveScorer as never as DriveScorerModule,
    taskLifecycle: taskLifecycle as never as TaskLifecycle,
    satisficingJudge: satisficingJudge as never as SatisficingJudge,
    stallDetector: stallDetector as never as StallDetector,
    strategyManager: strategyManager as never as StrategyManager,
    reportingEngine: reportingEngine as never as ReportingEngine,
    driveSystem: driveSystem as never as DriveSystem,
    adapterRegistry: adapterRegistry as never as AdapterRegistry,
    contextProvider: vi.fn().mockResolvedValue("workspace-base"),
    corePhaseRunner: corePhaseRunner as never,
    corePhasePolicyRegistry: new StaticCorePhasePolicyRegistry({
      observe_evidence: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "fallback_deterministic",
      },
      stall_investigation: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "return_low_confidence",
      },
      replanning_options: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "fallback_deterministic",
      },
      verification_evidence: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "fallback_deterministic",
      },
      knowledge_refresh: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "return_low_confidence",
      },
    }),
  };

  return {
    deps,
    mocks: {
      stateManager,
      taskLifecycle,
      corePhaseRunner,
      observationEngine,
    },
  };
}

describe("CoreLoop agentic phase hooks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("feeds observe and replanning summaries into task cycle context and records phase results", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(result.corePhaseResults?.some((phase) => phase.phase === "observe_evidence")).toBe(true);
    expect(result.corePhaseResults?.some((phase) => phase.phase === "knowledge_refresh")).toBe(true);
    expect(result.corePhaseResults?.some((phase) => phase.phase === "replanning_options")).toBe(true);
    expect(result.corePhaseResults?.some((phase) => phase.phase === "verification_evidence")).toBe(true);

    const taskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(taskCycleArgs[4]).toContain("knowledge-summary");
    expect(taskCycleArgs[4]).toContain("replan-summary");
    expect(taskCycleArgs[6]).toContain("observe-summary");
    expect(taskCycleArgs[7]).toEqual(expect.objectContaining({ targetDimensionOverride: "dim1" }));
    expect(taskCycleArgs[7]?.knowledgeContextPrefix).toContain("Replanning directive:");
  });

  it("runs stall investigation when stall is detected", async () => {
    const { deps, mocks } = createDeps(tmpDir, { stall: true });
    await mocks.stateManager.saveGoal(makeGoal());

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.corePhaseResults?.some((phase) => phase.phase === "stall_investigation")).toBe(true);
    expect(mocks.corePhaseRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "stall_investigation" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("auto-acquires knowledge from refresh evidence and skips task cycle", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());

    const knowledgeManager = {
      acquireWithTools: vi.fn().mockResolvedValue([
        {
          entry_id: "k-1",
          question: "Need migration constraints",
          answer: "Run schema diff first",
          sources: [],
          confidence: 0.8,
          acquired_at: new Date().toISOString(),
          acquisition_task_id: "tool_direct",
          superseded_by: null,
          tags: [],
          embedding_id: null,
        },
      ]),
      saveKnowledge: vi.fn().mockResolvedValue(undefined),
      getRelevantKnowledge: vi.fn().mockResolvedValue([]),
      searchKnowledge: vi.fn().mockResolvedValue([]),
      loadKnowledge: vi.fn().mockResolvedValue([]),
    };

    const loop = new CoreLoop(
      {
        ...deps,
        knowledgeManager: knowledgeManager as never,
        toolExecutor: { executeBatch: vi.fn() } as never,
      },
      { delayBetweenLoopsMs: 0 }
    );
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("knowledge_refresh_auto_acquire");
    expect(knowledgeManager.acquireWithTools).toHaveBeenCalledOnce();
    expect(knowledgeManager.saveKnowledge).toHaveBeenCalledOnce();
    expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
  });

  it("carries next-iteration directive forward when later replanning evidence is weak", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());

    let replanningCalls = 0;
    mocks.corePhaseRunner.run.mockImplementation(async (spec: { phase: string }) => {
      if (spec.phase === "replanning_options") {
        replanningCalls += 1;
        return {
          success: true,
          output: replanningCalls === 1
            ? {
                summary: "focus dim1 strongly",
                recommended_action: "pivot",
                candidates: [{
                  title: "Task A",
                  rationale: "fast",
                  expected_evidence_gain: "high",
                  blast_radius: "low",
                  target_dimensions: ["dim1"],
                  dependencies: [],
                }],
                confidence: 0.9,
              }
            : {
                summary: "weak follow-up",
                recommended_action: "continue",
                candidates: [],
                confidence: 0.2,
              },
          finalText: "",
          stopReason: "completed",
          elapsedMs: 1,
          modelTurns: 1,
          toolCalls: 0,
          compactions: 0,
          changedFiles: [],
          commandResults: [],
          traceId: `trace-${spec.phase}-${replanningCalls}`,
          sessionId: `session-${spec.phase}-${replanningCalls}`,
          turnId: `turn-${spec.phase}-${replanningCalls}`,
        };
      }

      return {
        success: true,
        output: ({
          observe_evidence: { summary: "observe-summary", evidence: ["git clean"], missing_info: [], confidence: 0.8 },
          knowledge_refresh: {
            summary: "knowledge-summary",
            required_knowledge: [],
            acquisition_candidates: [],
            confidence: 0.4,
            worthwhile: false,
          },
          verification_evidence: {
            summary: "verify-summary",
            supported_claims: ["tests pass"],
            unsupported_claims: [],
            blockers: [],
            confidence: 0.9,
          },
          stall_investigation: {
            summary: "stall-summary",
            suspected_causes: ["approach_failure"],
            recommended_next_evidence: ["inspect files"],
            relevant_actions: ["refine"],
            confidence: 0.7,
          },
        } as Record<string, unknown>)[spec.phase],
        finalText: "",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: `trace-${spec.phase}`,
        sessionId: `session-${spec.phase}`,
        turnId: `turn-${spec.phase}`,
      };
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const first = await loop.runOneIteration("goal-1", 0);
    const second = await loop.runOneIteration("goal-1", 1);

    expect(first.nextIterationDirective).toEqual(
      expect.objectContaining({
        sourcePhase: "replanning_options",
        focusDimension: "dim1",
      })
    );
    const secondTaskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondTaskCycleArgs[7]).toEqual(expect.objectContaining({ targetDimensionOverride: "dim1" }));
  });
});
