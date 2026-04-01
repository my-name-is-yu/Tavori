/**
 * R7 E2E verification: iterative improvement
 *
 * Tests that PulSeed's CoreLoop correctly handles multi-iteration improvement:
 *
 *   R7-1: 3-iteration progressive improvement — goal with 2 dimensions converges
 *          after LLM reports score increases across iterations.
 *
 *   R7-2: StallDetector triggers strategy pivot — when checkDimensionStall returns
 *          a stall report, stallDetected=true and pivotOccurred=true are recorded.
 *
 *   R7-3: LLM observation min-type scaling accuracy — LLM score below threshold
 *          triggers task, score above threshold causes completion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Real implementations ───
import { StateManager } from "../../src/state-manager.js";
import { ObservationEngine } from "../../src/observation/observation-engine.js";
import { TaskLifecycle } from "../../src/execution/task-lifecycle.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { ReportingEngine } from "../../src/reporting-engine.js";
import { DriveSystem } from "../../src/drive/drive-system.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { CoreLoop, type CoreLoopDeps } from "../../src/core-loop.js";
import { AdapterRegistry } from "../../src/execution/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";

// ─── Pure function modules ───
import * as GapCalculator from "../../src/drive/gap-calculator.js";
import * as DriveScorer from "../../src/drive/drive-scorer.js";

// ─── Types ───
import type { Goal } from "../../src/types/goal.js";
import type { ObservationMethod } from "../../src/types/core.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/llm/llm-client.js";
import type { ZodSchema } from "zod";
import type { CompletionJudgment } from "../../src/types/satisficing.js";
import type { GapVector } from "../../src/types/gap.js";
import type { DriveScore } from "../../src/types/drive.js";
import type { TaskCycleResult } from "../../src/execution/task-lifecycle.js";
import type { IDataSourceAdapter } from "../../src/observation/data-source-adapter.js";
import type { DataSourceConfig, DataSourceResult, DataSourceQuery } from "../../src/types/data-source.js";
import { makeTempDir } from "../helpers/temp-dir.js";

vi.setConfig({ testTimeout: 15000 });

// ─── Helpers ───

/** Fake workspace context so the no-evidence guard does not zero out LLM scores */
const fakeGitContextFetcher = () => "File: src/main.ts\nconst quality = 0.85; // measured";

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Mock DataSource (marks dimensions as observable so LLM gets independent_review confidence) ───

class MockAllDimensionDataSource implements IDataSourceAdapter {
  readonly sourceId = "mock-all-dims";
  readonly sourceType = "file" as const;
  readonly config: DataSourceConfig = { id: "mock-all-dims", type: "file", path: "/dev/null" };
  async connect() {}
  async query(_params: DataSourceQuery): Promise<DataSourceResult> {
    return { value: null, raw: "", timestamp: new Date().toISOString() };
  }
  async disconnect() {}
  async healthCheck() { return true; }
  getSupportedDimensions() { return ["code_quality", "test_coverage", "documentation_coverage", "readme_quality"]; }
}

// ─── Observation method configs ───

const llmObservationMethod: ObservationMethod = {
  type: "llm_review",
  source: "r7-quality-observer",
  schedule: null,
  endpoint: null,
  confidence_tier: "independent_review",
};

// ─── Goal factories ───

function makeTwoDimGoal(id: string): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "Improve code quality and test coverage",
    description: "Ensure code_quality >= 0.8 and test_coverage >= 0.7",
    status: "active",
    dimensions: [
      {
        name: "code_quality",
        label: "Code Quality",
        current_value: 0.2,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.3,
        observation_method: llmObservationMethod,
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
      {
        name: "test_coverage",
        label: "Test Coverage",
        current_value: 0.1,
        threshold: { type: "min", value: 0.7 },
        confidence: 0.3,
        observation_method: llmObservationMethod,
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

function makeOneDimGoal(id: string, dimensionName: string, minThreshold: number): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Improve ${dimensionName}`,
    description: `Ensure ${dimensionName} >= ${minThreshold}`,
    status: "active",
    dimensions: [
      {
        name: dimensionName,
        label: dimensionName,
        current_value: 0.3,
        threshold: { type: "min", value: minThreshold },
        confidence: 0.3,
        observation_method: llmObservationMethod,
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

// ─── LLM response factories ───

function makeTaskGenerationResponse(primaryDimension = "code_quality"): string {
  return JSON.stringify({
    work_description: `Improve the ${primaryDimension} through targeted refactoring and testing`,
    rationale: `The ${primaryDimension} dimension is below the required threshold`,
    approach: "Systematic improvement via code review and test addition",
    success_criteria: [
      {
        description: `${primaryDimension} meets the required threshold`,
        verification_method: "LLM review of codebase",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["source code", "tests"],
      out_of_scope: ["documentation", "deployment"],
      blast_radius: "minimal — only affects specified dimension",
    },
    constraints: ["must not break existing functionality"],
    reversibility: "reversible",
    estimated_duration: { value: 20, unit: "minutes" },
  });
}

function makeLLMReviewResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning: "Improvements satisfy all required criteria",
    criteria_met: 1,
    criteria_total: 1,
  });
}

// ─── MockAdapter ───

class MockAdapter implements IAdapter {
  readonly adapterType = "openai_codex_cli";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "Task completed successfully.",
      error: null,
      exit_code: null,
      elapsed_ms: 10,
      stopped_reason: "completed",
    };
  }
}

// ─── createSequentialMockLLMClient ───

function extractJSON(text: string): string {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) return jsonBlock[1]!.trim();
  const genericBlock = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) return genericBlock[1]!.trim();
  return text.trim();
}

function createSequentialMockLLMClient(responses: string[]): ILLMClient & { callCount: number } {
  let callCount = 0;
  const client = {
    get callCount() {
      return callCount;
    },
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      const index = callCount;
      callCount++;
      if (index >= responses.length) {
        throw new Error(
          `MockLLMClient: no response at index ${index} (only ${responses.length} responses configured)`
        );
      }
      const content = responses[index]!;
      return {
        content,
        usage: { input_tokens: 10, output_tokens: content.length },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      const jsonText = extractJSON(content);
      let raw: unknown;
      try {
        raw = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(
          `MockLLMClient.parseJSON: failed to parse JSON — ${String(err)}\nContent: ${content}`
        );
      }
      return schema.parse(raw);
    },
  };
  return client;
}

// ─── buildCoreLoop ───

function buildCoreLoop(
  stateManager: StateManager,
  llmClient: ILLMClient,
  maxIterations: number,
  observationEngine?: ObservationEngine
): CoreLoop {
  const obsEngine = observationEngine ?? new ObservationEngine(stateManager, [new MockAllDimensionDataSource()], llmClient, undefined, { gitContextFetcher: fakeGitContextFetcher });
  const sessionManager = new SessionManager(stateManager);
  const trustManager = new TrustManager(stateManager);
  const stallDetector = new StallDetector(stateManager);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const reportingEngine = new ReportingEngine(stateManager);
  const driveSystem = new DriveSystem(stateManager);
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

  return new CoreLoop(
    {
      stateManager,
      observationEngine: obsEngine,
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
    { maxIterations, delayBetweenLoopsMs: 0 }
  );
}

// ─── R7-1: 3-iteration progressive improvement ───

describe("R7-1: 3-iteration progressive improvement", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("2-dimension goal converges after 3+ iterations with progressive LLM scores", async () => {
    const stateManager = new StateManager(tempDir);
    const goalId = "r7-1-progressive";

    /**
     * LLM call sequence for 3-iteration convergence:
     *
     * Iteration 1 (dim1=code_quality, dim2=test_coverage — below threshold):
     *   Call 0: code_quality observation → 0.3 (below 0.8)
     *   Call 1: test_coverage observation → 0.2 (below 0.7)
     *   Call 2: task generation
     *   Call 3: LLM review
     *
     * Iteration 2 (still below threshold):
     *   Call 4: code_quality observation → 0.55 (below 0.8)
     *   Call 5: test_coverage observation → 0.45 (below 0.7)
     *   Call 6: task generation
     *   Call 7: LLM review
     *
     * Iteration 3 (meets threshold):
     *   Call 8: code_quality observation → 0.85 (above 0.8)
     *   Call 9: test_coverage observation → 0.75 (above 0.7)
     *   [task generation may not run if judge says complete]
     *
     * Guard responses (extra calls in case loop continues):
     *   Call 10: task generation
     *   Call 11: LLM review
     *   Call 12: observation guard
     *   Call 13: observation guard
     *   Call 14: task generation
     *   Call 15: LLM review
     */
    const llmClient = createSequentialMockLLMClient([
      // Iteration 1 — observations below threshold
      JSON.stringify({ score: 0.3, reason: "Code quality is poor" }),
      JSON.stringify({ score: 0.2, reason: "Test coverage is low" }),
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
      // Iteration 2 — observations improving but still below threshold
      JSON.stringify({ score: 0.55, reason: "Code quality is improving" }),
      JSON.stringify({ score: 0.45, reason: "Test coverage is increasing" }),
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
      // Iteration 3 — meets threshold
      JSON.stringify({ score: 0.85, reason: "Code quality now meets requirements" }),
      JSON.stringify({ score: 0.75, reason: "Test coverage exceeds minimum" }),
      // Guard responses
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
      JSON.stringify({ score: 0.85, reason: "Still meeting requirements" }),
      JSON.stringify({ score: 0.75, reason: "Still meeting coverage" }),
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
    ]);

    const coreLoop = buildCoreLoop(stateManager, llmClient, 5);

    const goal = makeTwoDimGoal(goalId);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    expect(result).toBeDefined();
    expect(result.goalId).toBe(goalId);
    expect(result.totalIterations).toBeGreaterThanOrEqual(3);
    expect(result.finalStatus).toBe("completed");
    expect(result.iterations.length).toBeGreaterThanOrEqual(3);

    // First iteration should have high gap (both dimensions below threshold)
    const firstIter = result.iterations[0]!;
    expect(firstIter.gapAggregate).toBeGreaterThan(0);

    // Last iteration should have zero or near-zero gap
    const lastIter = result.iterations[result.iterations.length - 1]!;
    expect(lastIter.completionJudgment.is_complete).toBe(true);
  });
});

// ─── R7-2: StallDetector triggers strategy pivot ───

describe("R7-2: StallDetector triggers strategy pivot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("stallDetected=true and pivotOccurred=true when checkDimensionStall returns report", async () => {
    const stateManager = new StateManager(tempDir);
    const goalId = "r7-2-stall";
    const now = new Date().toISOString();

    // Stall report to return on iteration 3+
    const stallReport = {
      stall_type: "dimension_stall" as const,
      dimension_name: "code_quality",
      description: "No improvement detected in code_quality over multiple iterations",
      gap_history_summary: {
        first: 0.8,
        latest: 0.8,
        delta: 0.0,
        n_entries: 4,
      },
      detected_at: now,
    };

    // Strategy returned by onStallDetected
    const newStrategy = {
      id: "stall-pivot-strategy",
      goal_id: goalId,
      type: "pivot" as const,
      description: "Switch to a different improvement approach",
      parameters: {},
      created_at: now,
      activated_at: now,
      status: "active" as const,
    };

    // Mock stall detector: null for first 2 calls, stall report for 3rd+
    const stallDetectorMock = {
      checkDimensionStall: vi.fn()
        .mockReturnValueOnce(null)    // iteration 1: no stall
        .mockReturnValueOnce(null)    // iteration 2: no stall
        .mockReturnValue(stallReport), // iteration 3+: stall detected
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
      isSuppressed: vi.fn().mockReturnValue(false),
    };

    // Mock strategy manager: onStallDetected returns new strategy
    const strategyManagerMock = {
      onStallDetected: vi.fn().mockResolvedValue(newStrategy),
      getActiveStrategy: vi.fn().mockReturnValue(null),
      getPortfolio: vi.fn().mockReturnValue(null),
      generateCandidates: vi.fn().mockResolvedValue([]),
      activateBestCandidate: vi.fn().mockResolvedValue(null),
      updateState: vi.fn(),
      getStrategyHistory: vi.fn().mockReturnValue([]),
    };

    // Task cycle result
    const taskCycleResult: TaskCycleResult = {
      task: {
        id: "r7-2-task",
        goal_id: goalId,
        strategy_id: null,
        target_dimensions: ["code_quality"],
        primary_dimension: "code_quality",
        work_description: "Improve code quality",
        rationale: "Below threshold",
        approach: "Refactoring",
        success_criteria: [
          {
            description: "code_quality >= 0.8",
            verification_method: "LLM review",
            is_blocking: true,
          },
        ],
        scope_boundary: {
          in_scope: ["code"],
          out_of_scope: [],
          blast_radius: "minimal",
        },
        constraints: [],
        plateau_until: null,
        estimated_duration: null,
        consecutive_failure_count: 0,
        reversibility: "reversible",
        task_category: "normal",
        status: "completed",
        started_at: now,
        completed_at: now,
        timeout_at: null,
        heartbeat_at: null,
        created_at: now,
      },
      verificationResult: {
        task_id: "r7-2-task",
        verdict: "pass",
        confidence: 0.8,
        evidence: [{ layer: "mechanical", description: "Improved", confidence: 0.8 }],
        dimension_updates: [],
        timestamp: now,
      },
      action: "completed",
    };

    const gapVector: GapVector = {
      goal_id: goalId,
      gaps: [
        {
          dimension_name: "code_quality",
          raw_gap: 0.8,
          normalized_gap: 0.8,
          normalized_weighted_gap: 0.8,
          confidence: 0.9,
          uncertainty_weight: 1.0,
        },
      ],
      timestamp: now,
    };

    const driveScores: DriveScore[] = [
      {
        dimension_name: "code_quality",
        dissatisfaction: 0.8,
        deadline: 0,
        opportunity: 0,
        final_score: 0.8,
        dominant_drive: "dissatisfaction",
      },
    ];

    const completionJudgment: CompletionJudgment = {
      is_complete: false,
      blocking_dimensions: ["code_quality"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: now,
    };

    const deps: CoreLoopDeps = {
      stateManager,
      observationEngine: {
        observe: vi.fn().mockResolvedValue(undefined),
        applyObservation: vi.fn(),
        createObservationEntry: vi.fn(),
        getObservationLog: vi.fn().mockReturnValue({ entries: [] }),
        saveObservationLog: vi.fn(),
        applyProgressCeiling: vi.fn(),
        getConfidenceTier: vi.fn(),
        resolveContradiction: vi.fn(),
        needsVerificationTask: vi.fn().mockReturnValue(false),
      } as unknown as CoreLoopDeps["observationEngine"],
      gapCalculator: {
        calculateGapVector: vi.fn().mockReturnValue(gapVector),
        aggregateGaps: vi.fn().mockReturnValue(0.8),
      } as unknown as CoreLoopDeps["gapCalculator"],
      driveScorer: {
        scoreAllDimensions: vi.fn().mockReturnValue(driveScores),
        rankDimensions: vi.fn().mockImplementation((s: DriveScore[]) => [...s]),
      } as unknown as CoreLoopDeps["driveScorer"],
      taskLifecycle: {
        runTaskCycle: vi.fn().mockResolvedValue(taskCycleResult),
        selectTargetDimension: vi.fn(),
        generateTask: vi.fn(),
        checkIrreversibleApproval: vi.fn(),
        executeTask: vi.fn(),
        verifyTask: vi.fn(),
        handleVerdict: vi.fn(),
        handleFailure: vi.fn(),
      } as unknown as CoreLoopDeps["taskLifecycle"],
      satisficingJudge: {
        isGoalComplete: vi.fn().mockReturnValue(completionJudgment),
        isDimensionSatisfied: vi.fn(),
        applyProgressCeiling: vi.fn(),
        selectDimensionsForIteration: vi.fn(),
        detectThresholdAdjustmentNeeded: vi.fn(),
        propagateSubgoalCompletion: vi.fn(),
        judgeTreeCompletion: vi.fn(),
      } as unknown as CoreLoopDeps["satisficingJudge"],
      stallDetector: stallDetectorMock as unknown as CoreLoopDeps["stallDetector"],
      strategyManager: strategyManagerMock as unknown as CoreLoopDeps["strategyManager"],
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

    // Save the goal for StateManager to load
    const goal = makeOneDimGoal(goalId, "code_quality", 0.8);
    await stateManager.saveGoal(goal);

    const loop = new CoreLoop(deps, { maxIterations: 5, delayBetweenLoopsMs: 0 });
    const result = await loop.run(goalId);

    // The loop should have run multiple iterations
    expect(result.totalIterations).toBeGreaterThanOrEqual(3);

    // Find the first iteration where stall was detected
    const stalledIter = result.iterations.find((i) => i.stallDetected);
    expect(stalledIter).toBeDefined();
    expect(stalledIter!.stallDetected).toBe(true);
    expect(stalledIter!.stallReport).not.toBeNull();
    expect(stalledIter!.stallReport!.stall_type).toBe("dimension_stall");

    // pivotOccurred should be true because onStallDetected returned a new strategy
    expect(stalledIter!.pivotOccurred).toBe(true);

    // strategyManager.onStallDetected was called
    expect(strategyManagerMock.onStallDetected).toHaveBeenCalled();
  });
});

// ─── R7-3: LLM observation min-type scaling accuracy ───

describe("R7-3: LLM observation min-type scaling accuracy", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it("LLM score below threshold triggers task; score above threshold causes completion", async () => {
    const stateManager = new StateManager(tempDir);
    const goalId = "r7-3-scaling";

    /**
     * LLM call sequence for 3-iteration convergence:
     *
     * SatisficingJudge requires double-confirmation (2 consecutive cycles where
     * all dimensions meet threshold) before declaring is_complete=true (§4.4).
     *
     * Iteration 1 (code_quality=0.55, below threshold 0.8):
     *   Call 0: code_quality observation → 0.55
     *   Call 1: task generation
     *   Call 2: LLM review
     *
     * Iteration 2 (code_quality=0.90, above threshold 0.8, streak=1):
     *   Call 3: code_quality observation → 0.90
     *   gap=0 → skipTaskGeneration, Phase 5 sets streak=1 → is_complete=false
     *
     * Iteration 3 (code_quality=0.90, still above threshold, streak=2):
     *   Call 4: code_quality observation → 0.90
     *   gap=0 → skipTaskGeneration, Phase 5 sets streak=2 → is_complete=true
     *
     * Guard responses:
     *   Call 5+: unused guards
     */
    // Use score=0.55 for iter1 (below threshold 0.8). The verifier's +0.2 bump brings
    // current_value to 0.75 (still below threshold), so the post-task satisficing check
    // does NOT advance the streak in iter1. iter2 and iter3 observe 0.90 which exceeds
    // threshold. The jump from 0.55 to 0.90 is delta=0.35, within the §3.3 jump-suppression
    // limit (±0.4). previousScore now comes from dim.history (not current_value) so
    // verifier's bump no longer bridges the suppression gap — hence the score must already
    // be within 0.4 of the prior observed value.
    const llmClient = createSequentialMockLLMClient([
      // Iteration 1 — below threshold (0.55 < 0.8), task runs; 0.55+0.2=0.75 still < 0.8
      JSON.stringify({ score: 0.55, reason: "Code quality needs significant improvement" }),
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
      // Iteration 2 — above threshold (streak=1, not yet complete)
      JSON.stringify({ score: 0.90, reason: "Code quality now meets the 0.8 requirement" }),
      // Iteration 3 — above threshold again (streak=2, complete)
      JSON.stringify({ score: 0.90, reason: "Still meeting requirements" }),
      // Guard responses
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
    ]);

    const coreLoop = buildCoreLoop(stateManager, llmClient, 5);

    const goal = makeOneDimGoal(goalId, "code_quality", 0.8);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    // Should complete in exactly 3 iterations due to double-confirmation requirement (§4.4):
    //   iter1: below threshold → task runs
    //   iter2: above threshold → streak=1, not complete yet
    //   iter3: above threshold again → streak=2, complete
    expect(result.finalStatus).toBe("completed");
    expect(result.totalIterations).toBe(3);

    // Iteration 1: gap should be > 0 (score 0.55 < threshold 0.8)
    const iter1 = result.iterations[0]!;
    expect(iter1.gapAggregate).toBeGreaterThan(0);

    // Iteration 2: gap=0 but not yet complete (first confirmation)
    const iter2 = result.iterations[1]!;
    expect(iter2.gapAggregate).toBe(0);
    expect(iter2.completionJudgment.is_complete).toBe(false);

    // Iteration 3: gap=0 and now complete (second confirmation)
    const iter3 = result.iterations[2]!;
    expect(iter3.completionJudgment.is_complete).toBe(true);

    // Final goal state should have code_quality updated to 0.90 (approx)
    const finalGoal = await stateManager.loadGoal(goalId);
    if (finalGoal !== null) {
      const dim = finalGoal.dimensions.find((d) => d.name === "code_quality");
      if (dim !== undefined) {
        expect(dim.current_value).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it("LLM observation confidence is in medium tier (independent_review: 0.5-0.84) with DataSource", async () => {
    const stateManager = new StateManager(tempDir);
    const goalId = "r7-3-confidence-tier";

    // Single observation call to check confidence tier
    const llmClient = createSequentialMockLLMClient([
      JSON.stringify({ score: 0.75, reason: "Code quality at 0.75" }),
      // Guard responses for task lifecycle
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
      JSON.stringify({ score: 0.90, reason: "Above threshold" }),
      "```json\n" + makeTaskGenerationResponse("code_quality") + "\n```",
      makeLLMReviewResponse(),
    ]);

    const obsEngine = new ObservationEngine(stateManager, [new MockAllDimensionDataSource()], llmClient, undefined, { gitContextFetcher: fakeGitContextFetcher });
    const coreLoop = buildCoreLoop(stateManager, llmClient, 3, obsEngine);

    const goal = makeOneDimGoal(goalId, "code_quality", 0.8);
    await stateManager.saveGoal(goal);

    await coreLoop.run(goalId);

    // Verify confidence tier from observation log (independent_review with DataSource)
    const log = await obsEngine.getObservationLog(goalId);
    const llmEntries = log.entries.filter((e) => e.layer === "independent_review");

    expect(llmEntries.length).toBeGreaterThanOrEqual(1);

    for (const entry of llmEntries) {
      expect(entry.method.confidence_tier).toBe("independent_review");
      expect(entry.confidence).toBeGreaterThanOrEqual(0.5);
      expect(entry.confidence).toBeLessThanOrEqual(0.84);
    }
  });
});
