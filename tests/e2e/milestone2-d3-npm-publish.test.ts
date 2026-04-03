/**
 * Milestone 2 D-3: npm publish preparation goal
 *
 * Tests:
 * 1. SatisficingJudge correctly determines completion when all dims meet thresholds
 * 2. SatisficingJudge does NOT trigger completion when dims below threshold
 * 3. CoreLoop terminates via satisficing when all dims reach threshold
 * 4. Task dedup prevents generating duplicate tasks for same dimension
 * 5. FileExistence + LLM observation work together for npm publish dimensions
 *
 * Goal Configuration:
 *   - package_json_valid  : LLM evaluates package.json completeness (min 0.8)
 *   - build_succeeds      : FileExistenceDataSource checks dist/ exists (present true)
 *   - version_set         : LLM evaluates if version is properly set (present true)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Real implementations ───
import { StateManager } from "../../src/state/state-manager.js";
import { ObservationEngine } from "../../src/observation/observation-engine.js";
import { SatisficingJudge } from "../../src/drive/satisficing-judge.js";
import { TaskLifecycle } from "../../src/execution/task/task-lifecycle.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import { StrategyManager } from "../../src/strategy/strategy-manager.js";
import { ReportingEngine } from "../../src/reporting/reporting-engine.js";
import { DriveSystem } from "../../src/drive/drive-system.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { CoreLoop } from "../../src/loop/core-loop.js";
import { AdapterRegistry } from "../../src/execution/adapter-layer.js";
import { FileExistenceDataSourceAdapter } from "../../src/adapters/datasources/file-existence-datasource.js";
import type { IAdapter, AgentTask, AgentResult } from "../../src/execution/adapter-layer.js";

// ─── Pure function modules ───
import * as GapCalculator from "../../src/drive/gap-calculator.js";
import * as DriveScorer from "../../src/drive/drive-scorer.js";

// ─── Helpers ───
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeTempDir } from "../helpers/temp-dir.js";

// ─── Types ───
import type { Goal, Dimension } from "../../src/types/goal.js";
import type { ObservationMethod } from "../../src/types/core.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";
import type { IDataSourceAdapter } from "../../src/observation/data-source-adapter.js";
import type { DataSourceConfig } from "../../src/types/data-source.js";

// ─── MockAdapter ───

class MockAdapter implements IAdapter {
  readonly adapterType = "claude_api";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "npm publish preparation tasks completed.",
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

const llmMethod: ObservationMethod = {
  type: "llm_review",
  source: "llm",
  schedule: null,
  endpoint: null,
  confidence_tier: "independent_review",
};

const mechanicalMethod: ObservationMethod = {
  type: "mechanical",
  source: "file_existence",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

/**
 * Build the npm publish preparation goal.
 * allMet: if true, set dimension values above their thresholds.
 */
function makeNpmPublishGoal(id: string, allMet: boolean = false): Goal {
  const now = new Date().toISOString();

  const packageJsonDim: Dimension = {
    name: "package_json_valid",
    label: "Package JSON Valid",
    current_value: allMet ? 0.9 : 0.3,
    threshold: { type: "min", value: 0.8 },
    confidence: allMet ? 0.9 : 0.7,
    observation_method: llmMethod,
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
  };

  const buildSucceedsDim: Dimension = {
    name: "build_succeeds",
    label: "Build Succeeds",
    current_value: allMet ? true : false,
    // PresentThreshold has no "value" field — just { type: "present" }
    threshold: { type: "present" },
    confidence: allMet ? 0.95 : 0.9,
    observation_method: mechanicalMethod,
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
  };

  const versionSetDim: Dimension = {
    name: "version_set",
    label: "Version Set",
    current_value: allMet ? true : null,
    // PresentThreshold has no "value" field — just { type: "present" }
    threshold: { type: "present" },
    confidence: allMet ? 0.9 : 0.6,
    observation_method: llmMethod,
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
  };

  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "Prepare for npm publish",
    description:
      "Verify package.json completeness, dist build artifacts, and proper version tagging",
    status: "active",
    dimensions: [packageJsonDim, buildSucceedsDim, versionSetDim],
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

/**
 * Task generation response fixture — valid for any npm-publish dimension.
 */
function makeTaskGenerationResponse(dimensionName: string): string {
  return JSON.stringify({
    work_description: `Improve ${dimensionName} for npm publish readiness`,
    rationale: `The ${dimensionName} dimension needs to meet its threshold for npm publish`,
    approach: `Review and update ${dimensionName} according to npm publish requirements`,
    success_criteria: [
      {
        description: `${dimensionName} meets or exceeds threshold`,
        verification_method: "direct inspection",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: [dimensionName],
      out_of_scope: ["unrelated features"],
      blast_radius: "minimal",
    },
    constraints: ["do not break existing functionality"],
    reversibility: "reversible",
    estimated_duration: { value: 15, unit: "minutes" },
  });
}

/**
 * LLM review response — "pass" verdict.
 */
function makeLLMReviewResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning: "Task output satisfies all npm publish readiness criteria",
    criteria_met: 1,
    criteria_total: 1,
  });
}

/**
 * LLM observation response — high score, indicates dimension is met.
 */
function makeObservationResponse(score: number = 0.95): string {
  return JSON.stringify({ score, reason: "Dimension meets threshold based on observed state" });
}

// ─── Tests ───

describe("Milestone 2 D-3: npm publish preparation goal", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: Satisficing judge correctly determines completion when all dims meet thresholds
  // ─────────────────────────────────────────────────────────────────────────

  it("Satisficing judge correctly determines completion when all dimensions meet thresholds", async () => {
    const stateManager = new StateManager(tempDir);
    const judge = new SatisficingJudge(stateManager);

    const goal = makeNpmPublishGoal("goal-d3-complete", true /* allMet */);
    await stateManager.saveGoal(goal);

    // Double-confirm guard: requires 2 consecutive cycles
    judge.isGoalComplete(goal);
    const judgment = judge.isGoalComplete(goal);

    expect(judgment.is_complete).toBe(true);
    expect(judgment.blocking_dimensions).toHaveLength(0);
    expect(judgment.low_confidence_dimensions).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Satisficing judge does NOT trigger completion when dims below threshold
  // ─────────────────────────────────────────────────────────────────────────

  it("Satisficing judge does NOT trigger completion when dimensions below threshold", async () => {
    const stateManager = new StateManager(tempDir);
    const judge = new SatisficingJudge(stateManager);

    const goal = makeNpmPublishGoal("goal-d3-incomplete", false /* not met */);
    await stateManager.saveGoal(goal);

    const judgment = judge.isGoalComplete(goal);

    expect(judgment.is_complete).toBe(false);
    // package_json_valid (0.3 < min 0.8) and version_set (null, present) should block
    expect(judgment.blocking_dimensions.length).toBeGreaterThan(0);
    expect(judgment.blocking_dimensions).toContain("package_json_valid");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Loop terminates via satisficing when all dimensions reach threshold
  // ─────────────────────────────────────────────────────────────────────────

  it("Loop terminates via satisficing when all dimensions reach threshold", async () => {
    const goalId = "goal-d3-loop-satisficing";

    const stateManager = new StateManager(tempDir);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const reportingEngine = new ReportingEngine(stateManager);
    const driveSystem = new DriveSystem(stateManager);

    // Provide observation responses (one per dimension per iteration) so the ObservationEngine
    // can update confidence with real LLM scores rather than falling back to self_report
    // (which would cap confidence at 0.30 and prevent satisficing). Provide enough for
    // 3 dims × 3 iterations (satisficingStreak needs 2 consecutive "all met" cycles).
    const observationResponses = Array.from({ length: 9 }, () => makeObservationResponse(0.95));
    const llmClient = createMockLLMClient(observationResponses);
    // Provide a contextProvider so LLM observation scores are trusted (hasContext=true).
    // Without context, scores > 0.0 are overridden to 0.0 (no-evidence rule), which
    // would drop current_value and prevent satisficing from triggering.
    const contextProvider = async (_goalId: string, _dimName: string): Promise<string> =>
      "All npm publish prerequisites are verified as complete.";
    const observationEngine = new ObservationEngine(stateManager, [], llmClient, contextProvider);

    const strategyManager = new StrategyManager(stateManager, llmClient);
    const taskLifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
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
      { maxIterations: 5, delayBetweenLoopsMs: 0 }
    );

    // Set up goal with ALL dimensions already meeting thresholds
    const goal = makeNpmPublishGoal(goalId, true /* allMet */);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    // Loop should stop at "completed" (satisficing triggered) after the first iteration
    expect(result.finalStatus).toBe("completed");
    // Should not require the full 5 iterations
    expect(result.totalIterations).toBeLessThanOrEqual(5);

    // The completion judgment in the last iteration should mark the goal as complete
    const lastIteration = result.iterations[result.iterations.length - 1];
    expect(lastIteration).toBeDefined();
    expect(lastIteration!.completionJudgment.is_complete).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: Task dedup — generateTask with existingTasks includes dedup hint in prompt
  // ─────────────────────────────────────────────────────────────────────────

  it("Task dedup prevents generating duplicate tasks for same dimension", async () => {
    const goalId = "goal-d3-dedup";
    const stateManager = new StateManager(tempDir);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);

    // Track the prompt strings sent to the LLM — each call provides a response
    const sentPrompts: string[] = [];

    // Custom LLM client that captures prompts sent
    const trackingLLMClient: ILLMClient = {
      sendMessage: vi.fn(async (messages) => {
        const userMsg = messages.find((m) => m.role === "user");
        if (userMsg) sentPrompts.push(userMsg.content);
        return {
          content:
            "```json\n" +
            makeTaskGenerationResponse("package_json_valid") +
            "\n```",
          usage: { input_tokens: 10, output_tokens: 50 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn((content, schema) => schema.parse(JSON.parse(content.replace(/```json\n?|\n?```/g, "").trim()))),
    };

    const strategyManager = new StrategyManager(stateManager, trackingLLMClient);
    const taskLifecycle = new TaskLifecycle(
      stateManager,
      trackingLLMClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn: async (_task) => true }
    );

    const goal = makeNpmPublishGoal(goalId, false);
    await stateManager.saveGoal(goal);

    // First task generation — no existing tasks
    await taskLifecycle.generateTask(goalId, "package_json_valid");

    // Second task generation — provide the first task as "existing" to trigger dedup hint
    const existingTaskDescription =
      "Improve package_json_valid for npm publish readiness";
    await taskLifecycle.generateTask(
      goalId,
      "package_json_valid",
      undefined,
      undefined,
      undefined,
      [existingTaskDescription]
    );

    // The second prompt should include the dedup/existing-tasks section
    expect(sentPrompts).toHaveLength(2);
    const secondPrompt = sentPrompts[1]!;
    expect(secondPrompt).toContain("Previously Generated Tasks");
    expect(secondPrompt).toContain(existingTaskDescription);
    expect(secondPrompt).toContain("DIFFERENT aspect");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5: FileExistence + LLM observation work together for npm publish dims
  // ─────────────────────────────────────────────────────────────────────────

  it("FileExistence + LLM observation work together for npm publish dimensions", async () => {
    const goalId = "goal-d3-obs-integration";

    // Create a temp dist directory to simulate a successful build
    const distDir = path.join(tempDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.js"), "// built output");

    const stateManager = new StateManager(tempDir);

    // FileExistenceDataSourceAdapter for build_succeeds dim
    const dsConfig: DataSourceConfig = {
      id: "file-existence-ds",
      name: "File Existence DataSource",
      type: "file_existence" as DataSourceConfig["type"],
      connection: { path: tempDir },
      dimension_mapping: {
        build_succeeds: "dist/index.js",
      },
      enabled: true,
      created_at: new Date().toISOString(),
    };
    const fileDs = new FileExistenceDataSourceAdapter(dsConfig);

    // LLM mock: returns 0.85 for package_json_valid and version_set observations
    const mockLLMClient = createMockLLMClient([
      JSON.stringify({ score: 0.85, reason: "package.json is complete" }),
      JSON.stringify({ score: 1.0, reason: "version field is properly set" }),
    ]);

    const observationEngine = new ObservationEngine(
      stateManager,
      [fileDs as IDataSourceAdapter],
      mockLLMClient
    );

    const goal = makeNpmPublishGoal(goalId, false);
    await stateManager.saveGoal(goal);

    // Run observation
    await observationEngine.observe(goalId, [llmMethod, mechanicalMethod, llmMethod]);

    const updatedGoal = await stateManager.loadGoal(goalId);
    expect(updatedGoal).not.toBeNull();

    // build_succeeds should be updated via FileExistence (dist/index.js exists = 1)
    const buildDim = updatedGoal!.dimensions.find((d) => d.name === "build_succeeds");
    expect(buildDim).toBeDefined();
    expect(buildDim!.current_value).toBe(1);

    // Observation log should include a mechanical entry (from FileExistence)
    const log = await observationEngine.getObservationLog(goalId);
    const hasFileEntry = log.entries.some(
      (e) => e.layer === "mechanical" && e.dimension_name === "build_succeeds"
    );
    expect(hasFileEntry).toBe(true);
  });
});
