/**
 * Milestone 2 D-2: E2E loop test automation goal
 *
 * Verifies that FileExistence DataSource + LLM observation work together
 * in one CoreLoop iteration. Tests the three-dimensional goal:
 *   1. e2e_test_file_exists  — FileExistenceDataSource (mechanical)
 *   2. e2e_test_passing      — LLM observation (self_report, no DataSource)
 *   3. approval_loop_fixed   — LLM observation (self_report, no DataSource)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Real implementations ───
import { StateManager } from "../../src/state/state-manager.js";
import { ObservationEngine } from "../../src/observation/observation-engine.js";
import { TaskLifecycle } from "../../src/execution/task/task-lifecycle.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { ReportingEngine } from "../../src/reporting/reporting-engine.js";
import { DriveSystem } from "../../src/drive/drive-system.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { CoreLoop } from "../../src/loop/core-loop.js";
import { AdapterRegistry } from "../../src/execution/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";
import { FileExistenceDataSourceAdapter } from "../../src/adapters/datasources/file-existence-datasource.js";

// ─── Pure function modules ───
import * as GapCalculator from "../../src/drive/gap-calculator.js";
import * as DriveScorer from "../../src/drive/drive-scorer.js";

// ─── Mock utilities ───
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Types ───
import type { Goal } from "../../src/types/goal.js";
import type { DataSourceConfig } from "../../src/types/data-source.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";
import type { IDataSourceAdapter } from "../../src/observation/data-source-adapter.js";

// ─── MockAdapter ───

class MockAdapter implements IAdapter {
  readonly adapterType = "claude_api";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "Task completed successfully. E2E loop verified.",
      error: null,
      exit_code: null,
      elapsed_ms: 10,
      stopped_reason: "completed",
    };
  }
}

// ─── Helpers ───

/** Fake workspace context so the no-evidence guard does not zero out LLM scores */
const fakeGitContextFetcher = () => "File: tests/e2e-test.ts\n// e2e test passing with full coverage";

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeFileExistenceConfig(
  id: string,
  baseDir: string,
  dimensionMapping: Record<string, string>
): DataSourceConfig {
  return {
    id,
    name: "E2E File Existence Source",
    type: "file_existence",
    connection: { path: baseDir },
    enabled: true,
    created_at: new Date().toISOString(),
    dimension_mapping: dimensionMapping,
  };
}

function makeE2EGoal(id: string, tempDir: string): Goal {
  const now = new Date().toISOString();
  // The e2e_test_file_exists dimension uses the test file name as its observation expression.
  // ObservationEngine will resolve this via the DataSource dimension_mapping.
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "Automate E2E loop testing",
    description:
      "Verify that FileExistence DataSource and LLM observation work together in one CoreLoop iteration",
    status: "active",
    dimensions: [
      {
        name: "e2e_test_file_exists",
        label: "E2E Test File Exists",
        current_value: 0,
        threshold: { type: "present", value: true },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "file_existence",
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
      {
        name: "e2e_test_passing",
        label: "E2E Test Passing",
        current_value: 0.5,
        threshold: { type: "min", value: 0.8 },
        confidence: 0.6,
        observation_method: {
          type: "llm_review",
          source: "llm",
          schedule: null,
          endpoint: null,
          confidence_tier: "independent_review",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
      {
        name: "approval_loop_fixed",
        label: "Approval Loop Fixed",
        current_value: false,
        threshold: { type: "present", value: true },
        confidence: 0.6,
        observation_method: {
          type: "llm_review",
          source: "llm",
          schedule: null,
          endpoint: null,
          confidence_tier: "independent_review",
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
    created_at: now,
    updated_at: now,
  };
}

// LLM response fixtures for task generation and review
function makeTaskGenerationResponse(): string {
  return JSON.stringify({
    work_description: "Verify E2E test loop is properly automated with file existence checks",
    rationale: "The e2e_test_passing and approval_loop_fixed dimensions need to be verified",
    approach: "Check that the E2E test file exists and the approval flow works correctly",
    success_criteria: [
      {
        description: "e2e_test_passing value exceeds 0.8",
        verification_method: "LLM review of test output",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["e2e_test_passing", "approval_loop_fixed"],
      out_of_scope: ["unrelated modules"],
      blast_radius: "minimal — only affects E2E test dimensions",
    },
    constraints: ["must not break existing tests"],
    reversibility: "reversible",
    estimated_duration: { value: 15, unit: "minutes" },
  });
}

function makeLLMReviewResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning: "The E2E loop is working correctly with file existence checks and LLM observation",
    criteria_met: 1,
    criteria_total: 1,
  });
}

// ─── Tests ───

describe("Milestone 2 D-2: E2E loop test automation goal", () => {
  let tempDir: string;
  let stateDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    testFilePath = path.join(tempDir, "e2e-test.ts");
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ─── Test 1: FileExistenceDataSource returns mechanical observation ───

  it("FileExistenceDataSource returns mechanical confidence for e2e_test_file_exists", async () => {
    // Create the test file so FileExistence returns 1 (exists)
    fs.writeFileSync(testFilePath, "// e2e test file\n");

    const config = makeFileExistenceConfig("fe-ds-1", tempDir, {
      e2e_test_file_exists: "e2e-test.ts",
    });
    const fileExistenceDs = new FileExistenceDataSourceAdapter(config);

    // Verify adapter reports the correct supported dimensions
    expect(fileExistenceDs.getSupportedDimensions()).toContain("e2e_test_file_exists");

    // healthCheck should pass
    const healthy = await fileExistenceDs.healthCheck();
    expect(healthy).toBe(true);

    // Query returns 1 (file exists) with mechanical confidence
    const result = await fileExistenceDs.query({
      dimension_name: "e2e_test_file_exists",
      timeout_ms: 5000,
    });

    expect(result.value).toBe(1);
    expect(result.source_id).toBe("fe-ds-1");
    expect((result.raw as { exists: boolean }).exists).toBe(true);

    // Verify with ObservationEngine using a single-dimension goal so the
    // engine only processes e2e_test_file_exists (observe() iterates all dims).
    const stateManager = new StateManager(stateDir);
    const engine = new ObservationEngine(stateManager, [fileExistenceDs]);

    const goalId = "d2-test1-goal";
    const fullGoal = makeE2EGoal(goalId, tempDir);
    // Use only the first dimension to isolate the FileExistence observation
    const singleDimGoal = {
      ...fullGoal,
      dimensions: [fullGoal.dimensions[0]!],
    };
    await stateManager.saveGoal(singleDimGoal);

    await engine.observe(goalId, [singleDimGoal.dimensions[0]!.observation_method]);

    const log = await engine.getObservationLog(goalId);
    expect(log.entries.length).toBeGreaterThan(0);

    // Find the entry for e2e_test_file_exists specifically
    const feEntry = log.entries.find((e) => e.dimension_name === "e2e_test_file_exists");
    expect(feEntry).toBeDefined();
    expect(feEntry!.layer).toBe("mechanical");
    expect(feEntry!.dimension_name).toBe("e2e_test_file_exists");
  });

  // ─── Test 2: LLM observation returns self_report (no DataSource available) ───

  it("LLM observation returns self_report for e2e_test_passing (no DataSource)", async () => {
    const stateManager = new StateManager(stateDir);

    // Mock LLM returns score 0.85 for e2e_test_passing
    const mockLLMClient = createMockLLMClient([
      JSON.stringify({ score: 0.85, reason: "E2E tests are running and passing consistently" }),
    ]);

    // No DataSource for e2e_test_passing — should fall back to LLM
    const engine = new ObservationEngine(stateManager, [], mockLLMClient, undefined, { gitContextFetcher: fakeGitContextFetcher });

    const goalId = "d2-test2-goal";
    const fullGoal = makeE2EGoal(goalId, tempDir);
    // Use only the e2e_test_passing dimension (index 1) to limit LLM calls to 1
    const singleDimGoal = {
      ...fullGoal,
      dimensions: [fullGoal.dimensions[1]!],
    };
    await stateManager.saveGoal(singleDimGoal);

    const llmMethod = singleDimGoal.dimensions[0]!.observation_method;
    await engine.observe(goalId, [llmMethod]);

    expect(mockLLMClient.callCount).toBeGreaterThanOrEqual(1);

    const log = await engine.getObservationLog(goalId);
    expect(log.entries.length).toBeGreaterThan(0);

    // Find the entry for e2e_test_passing specifically
    const testPassingEntry = log.entries.find((e) => e.dimension_name === "e2e_test_passing");
    expect(testPassingEntry).toBeDefined();
    // fakeGitContextFetcher provides workspace context, so even without a DataSource
    // the tier is upgraded to independent_review (not self_report).
    expect(testPassingEntry!.layer).toBe("independent_review");
    expect(testPassingEntry!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(testPassingEntry!.method.type).toBe("llm_review");
  });

  // ─── Test 3: Combined FileExistence + LLM observation in one full loop iteration ───

  it("Combined FileExistence + LLM observation completes one full loop iteration", async () => {
    // Create the test file so FileExistence dimension is satisfied
    fs.writeFileSync(testFilePath, "// e2e test file exists\n");

    const stateManager = new StateManager(stateDir);

    // FileExistenceDataSource for e2e_test_file_exists
    const feConfig = makeFileExistenceConfig("fe-ds-combined", tempDir, {
      e2e_test_file_exists: "e2e-test.ts",
    });
    const fileExistenceDs = new FileExistenceDataSourceAdapter(feConfig);

    // MockLLMClient: observation calls + task generation + LLM review
    const mockLLMClient = createMockLLMClient([
      // LLM observation for e2e_test_passing
      JSON.stringify({ score: 0.82, reason: "E2E tests are passing" }),
      // LLM observation for approval_loop_fixed
      JSON.stringify({ score: 0.9, reason: "Approval loop is working correctly" }),
      // Task generation
      "```json\n" + makeTaskGenerationResponse() + "\n```",
      // LLM review
      makeLLMReviewResponse(),
    ]);

    const observationEngine = new ObservationEngine(stateManager, [fileExistenceDs], mockLLMClient, undefined, { gitContextFetcher: fakeGitContextFetcher });
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const reportingEngine = new ReportingEngine(stateManager);
    const driveSystem = new DriveSystem(stateManager);
    const strategyManager = new StrategyManager(stateManager, mockLLMClient);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      mockLLMClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true }
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
      {
        maxIterations: 1,
        delayBetweenLoopsMs: 0,
      }
    );

    const goalId = "d2-test3-goal";
    const goal = makeE2EGoal(goalId, tempDir);
    await stateManager.saveGoal(goal);

    // Run one iteration
    const result = await coreLoop.run(goalId);

    // Verify LoopResult structure
    expect(result).toBeDefined();
    expect(result.goalId).toBe(goalId);
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);
    expect(["max_iterations", "completed", "stalled", "stopped", "error"]).toContain(
      result.finalStatus
    );
    expect(Array.isArray(result.iterations)).toBe(true);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();

    // Verify iteration structure
    const iteration = result.iterations[0];
    expect(iteration).toBeDefined();
    expect(iteration!.loopIndex).toBe(0);
    expect(iteration!.goalId).toBe(goalId);
    expect(typeof iteration!.gapAggregate).toBe("number");
    expect(Array.isArray(iteration!.driveScores)).toBe(true);
    expect(iteration!.completionJudgment).toBeDefined();

    // Verify gap was calculated (via iteration result, since archiveGoal
    // may move gap-history files when the loop completes successfully)
    expect(typeof iteration!.gapAggregate).toBe("number");
    expect(iteration!.gapAggregate).toBeGreaterThanOrEqual(0);
  });

  // ─── Test 4: DataSource observation takes priority over LLM when available ───

  it("DataSource observation takes priority over LLM when available", async () => {
    // Create the test file
    fs.writeFileSync(testFilePath, "// e2e test file\n");

    const stateManager = new StateManager(stateDir);

    // FileExistenceDataSource supports e2e_test_file_exists
    const feConfig = makeFileExistenceConfig("fe-ds-priority", tempDir, {
      e2e_test_file_exists: "e2e-test.ts",
    });
    const fileExistenceDs = new FileExistenceDataSourceAdapter(feConfig);

    // Spy on query to verify it is called
    const querySpy = vi.spyOn(fileExistenceDs, "query");

    // LLM mock — should NOT be called for e2e_test_file_exists
    const mockLLMClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({ score: 0.5, reason: "LLM fallback" }),
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: "end_turn",
      }),
      parseJSON: vi.fn().mockReturnValue({ score: 0.5, reason: "LLM fallback" }),
    } satisfies ILLMClient;

    const engine = new ObservationEngine(stateManager, [fileExistenceDs], mockLLMClient);

    const goalId = "d2-test4-goal";
    const goal = makeE2EGoal(goalId, tempDir);
    await stateManager.saveGoal(goal);

    // Observe e2e_test_file_exists dimension (index 0)
    const mechanicalMethod = goal.dimensions[0]!.observation_method;
    await engine.observe(goalId, [mechanicalMethod]);

    // DataSource query was called
    expect(querySpy).toHaveBeenCalled();

    // LLM sendMessage was NOT called for this dimension
    expect(mockLLMClient.sendMessage).not.toHaveBeenCalled();

    // Observation layer is mechanical (DataSource, not LLM)
    const log = await engine.getObservationLog(goalId);
    const lastEntry = log.entries[log.entries.length - 1]!;
    expect(lastEntry.layer).toBe("mechanical");

    // The observed value should be 1 (file exists)
    const updatedGoal = await stateManager.loadGoal(goalId);
    expect(updatedGoal).not.toBeNull();
    const dim = updatedGoal!.dimensions.find((d) => d.name === "e2e_test_file_exists");
    expect(dim).not.toBeNull();
    expect(dim!.current_value).toBe(1);
  });
});
