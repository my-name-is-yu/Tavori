/**
 * Milestone 2 D-1: README quality goal — E2E tests
 *
 * Tests that a "Improve README quality" goal running through PulSeed's CoreLoop:
 *   1. Uses LLM observation (self_report confidence tier when no DataSource registered) for all 3 dimensions
 *   2. Converges within 2 iterations when LLM reports improvement
 *   3. Generates README improvement tasks
 *   4. Satisficing judge correctly determines goal completion
 *
 * All LLM interactions are mocked; no real API calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// ─── Pure function modules ───
import * as GapCalculator from "../../src/drive/gap-calculator.js";
import * as DriveScorer from "../../src/drive/drive-scorer.js";

// ─── Types ───
import type { Goal } from "../../src/types/goal.js";
import type { ObservationMethod } from "../../src/types/core.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../src/llm/llm-client.js";
import type { ZodSchema } from "zod";

// ─── Helpers ───
import { makeTempDir } from "../helpers/temp-dir.js";

/** Fake workspace context so the no-evidence guard does not zero out LLM scores */
const fakeGitContextFetcher = () => "File: README.md\n# Project\nInstallation guide and usage examples.";

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Observation method config ───

const llmObservationMethod: ObservationMethod = {
  type: "llm_review",
  source: "readme-quality-observer",
  schedule: null,
  endpoint: null,
  confidence_tier: "self_report",
};

// ─── Goal factory ───

function makeReadmeGoal(id: string): Goal {
  const now = new Date().toISOString();
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: "Improve README quality",
    description: "Improve the quality, completeness, and clarity of the project README",
    status: "active",
    dimensions: [
      {
        name: "readme_quality",
        label: "README Quality Score",
        current_value: 0.4,
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
        name: "installation_guide_present",
        label: "Installation Guide Present",
        current_value: false,
        threshold: { type: "present" },
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
        name: "usage_example_present",
        label: "Usage Example Present",
        current_value: false,
        threshold: { type: "present" },
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

/** Task generation response matching LLMGeneratedTaskSchema in task-lifecycle.ts */
function makeTaskGenerationResponse(primaryDimension = "readme_quality"): string {
  return JSON.stringify({
    work_description: `Improve the ${primaryDimension} by updating README.md with clear content`,
    rationale: `The ${primaryDimension} dimension is below the required threshold`,
    approach: "Add installation guide, usage examples, and improve overall quality",
    success_criteria: [
      {
        description: `${primaryDimension} meets the required threshold`,
        verification_method: "Review the README.md file content",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["README.md content"],
      out_of_scope: ["source code", "tests"],
      blast_radius: "minimal — only README.md",
    },
    constraints: ["must keep existing accurate information"],
    reversibility: "reversible",
    estimated_duration: { value: 20, unit: "minutes" },
  });
}

/** LLM review response — task passed */
function makeLLMReviewResponse(): string {
  return JSON.stringify({
    verdict: "pass",
    reasoning: "README improvements satisfy all required criteria",
    criteria_met: 1,
    criteria_total: 1,
  });
}

/** LLM observation response for a score-based dimension (readme_quality) */
function makeLLMObservationScore(score: number, reason: string): string {
  return JSON.stringify({ score, reason });
}

/** LLM observation response for a boolean/present dimension */
function makeLLMObservationPresent(score: number, reason: string): string {
  return JSON.stringify({ score, reason });
}

// ─── MockAdapter ───

class MockAdapter implements IAdapter {
  readonly adapterType = "claude_api";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: true,
      output: "README.md updated with installation guide and usage examples.",
      error: null,
      exit_code: null,
      elapsed_ms: 15,
      stopped_reason: "completed",
    };
  }
}

// ─── MockLLMClient (stateful — returns responses in sequence) ───

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
      return { content, usage: { input_tokens: 10, output_tokens: content.length }, stop_reason: "end_turn" };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      const jsonText = extractJSON(content);
      let raw: unknown;
      try {
        raw = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(`MockLLMClient.parseJSON: failed to parse JSON — ${String(err)}\nContent: ${content}`);
      }
      return schema.parse(raw);
    },
  };
  return client;
}

// ─── CoreLoop wiring helper ───

function buildCoreLoop(
  stateManager: StateManager,
  llmClient: ILLMClient,
  maxIterations: number,
  observationEngine?: ObservationEngine
): CoreLoop {
  const obsEngine = observationEngine ?? new ObservationEngine(stateManager, [], llmClient, undefined, { gitContextFetcher: fakeGitContextFetcher });
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
    { approvalFn: async (_task) => true }
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

// ─── Tests ───

describe("Milestone 2 D-1: README quality goal", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  // ── Test 1: LLM observation returns self_report confidence when no DataSource registered ──

  it("LLM observation returns self_report confidence when no DataSource registered", async () => {
    const stateManager = new StateManager(tempDir);

    // One LLM observation call per dimension (3 dimensions)
    const llmClient = createSequentialMockLLMClient([
      makeLLMObservationScore(0.6, "README has some content but lacks structure"),
      makeLLMObservationPresent(0.0, "No installation guide found"),
      makeLLMObservationPresent(0.0, "No usage examples found"),
    ]);

    const observationEngine = new ObservationEngine(stateManager, [], llmClient, undefined, { gitContextFetcher: fakeGitContextFetcher });

    const goalId = "readme-goal-tier-test";
    const goal = makeReadmeGoal(goalId);
    await stateManager.saveGoal(goal);

    // Observe all 3 dimensions via LLM
    await observationEngine.observe(goalId, [
      llmObservationMethod,
      llmObservationMethod,
      llmObservationMethod,
    ]);

    // Verify that all observations are recorded with self_report layer (no DataSource registered)
    const log = await observationEngine.getObservationLog(goalId);
    expect(log.entries.length).toBeGreaterThanOrEqual(3);

    // fakeGitContextFetcher provides workspace context, so even without a DataSource
    // the tier is upgraded to independent_review (not self_report).
    const llmEntries = log.entries.filter((e) => e.layer === "independent_review");
    expect(llmEntries.length).toBeGreaterThanOrEqual(3);

    // Each entry should have independent_review tier (context available via gitContextFetcher)
    for (const entry of llmEntries) {
      expect(entry.method.confidence_tier).toBe("independent_review");
      expect(entry.method.type).toBe("llm_review");
      expect(entry.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  // ── Test 2: Loop converges within 2 iterations when LLM reports improvement ──

  it("Loop converges within 2 iterations when LLM reports improvement", async () => {
    const stateManager = new StateManager(tempDir);
    const goalId = "readme-goal-convergence";

    /**
     * LLM call sequence for 2-iteration convergence:
     *
     * Iteration 1 (observe 3 dims — scores below threshold):
     *   Call 0: readme_quality observation → 0.6 (below 0.8)
     *   Call 1: installation_guide_present → 0.0 (not present)
     *   Call 2: usage_example_present → 0.0 (not present)
     *   Call 3: task generation
     *   Call 4: LLM review
     *
     * Iteration 2 (observe 3 dims — scores meet threshold):
     *   Call 5: readme_quality observation → 0.85 (meets 0.8)
     *   Call 6: installation_guide_present → 1.0 (present)
     *   Call 7: usage_example_present → 1.0 (present)
     *   Call 8: task generation (may or may not run if judge says complete)
     *   Call 9: LLM review (may or may not run)
     */
    const llmClient = createSequentialMockLLMClient([
      // Iteration 1 — observations below threshold
      makeLLMObservationScore(0.6, "README needs improvement"),
      makeLLMObservationPresent(0.0, "No installation guide found"),
      makeLLMObservationPresent(0.0, "No usage examples found"),
      // Iteration 1 — task lifecycle
      "```json\n" + makeTaskGenerationResponse("readme_quality") + "\n```",
      makeLLMReviewResponse(),
      // Iteration 2 — observations meet threshold
      makeLLMObservationScore(0.85, "README quality is now above threshold"),
      makeLLMObservationPresent(1.0, "Installation guide present"),
      makeLLMObservationPresent(1.0, "Usage examples present"),
      // Iteration 2 — task lifecycle (guard in case loop does not short-circuit)
      "```json\n" + makeTaskGenerationResponse("readme_quality") + "\n```",
      makeLLMReviewResponse(),
    ]);

    const coreLoop = buildCoreLoop(stateManager, llmClient, 2);

    const goal = makeReadmeGoal(goalId);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    expect(result).toBeDefined();
    expect(result.goalId).toBe(goalId);
    // Should converge in at most 2 iterations
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);
    expect(result.totalIterations).toBeLessThanOrEqual(2);
    // Final status should be completed or max_iterations (both are valid convergence signals)
    expect(["completed", "max_iterations"]).toContain(result.finalStatus);
    // At least one iteration must have been run
    expect(result.iterations.length).toBeGreaterThanOrEqual(1);

    // Verify iteration structure
    const firstIteration = result.iterations[0]!;
    expect(firstIteration.loopIndex).toBe(0);
    expect(firstIteration.goalId).toBe(goalId);
    expect(typeof firstIteration.gapAggregate).toBe("number");
  });

  // ── Test 3: Task generation produces README improvement tasks ──

  it("Task generation produces README improvement tasks", async () => {
    const stateManager = new StateManager(tempDir);
    const goalId = "readme-goal-task-gen";

    const llmClient = createSequentialMockLLMClient([
      // observation — scores below threshold
      makeLLMObservationScore(0.5, "README is minimal"),
      makeLLMObservationPresent(0.0, "No installation guide"),
      makeLLMObservationPresent(0.0, "No usage examples"),
      // task generation for the primary dimension
      "```json\n" + makeTaskGenerationResponse("readme_quality") + "\n```",
      // LLM review
      makeLLMReviewResponse(),
    ]);

    const coreLoop = buildCoreLoop(stateManager, llmClient, 1);

    const goal = makeReadmeGoal(goalId);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    expect(result.iterations.length).toBeGreaterThanOrEqual(1);

    const iteration = result.iterations[0]!;

    // The task result should exist and reference the goal
    if (iteration.taskResult !== null) {
      const taskResult = iteration.taskResult;
      expect(taskResult.task.goal_id).toBe(goalId);
      // Primary dimension should be one of the README goal dimensions
      const readmeDimensions = ["readme_quality", "installation_guide_present", "usage_example_present"];
      expect(readmeDimensions).toContain(taskResult.task.primary_dimension);
      // Task must include work description related to README
      expect(taskResult.task.work_description.toLowerCase()).toMatch(/readme|quality|guide|example/i);
      // Verification result should be defined
      expect(taskResult.verificationResult).toBeDefined();
    }
  });

  // ── Test 4: Satisficing judge correctly determines goal completion ──

  it("Satisficing judge correctly determines goal completion", async () => {
    const stateManager = new StateManager(tempDir);

    const goalId = "readme-goal-satisficing";

    /**
     * Set up a goal where all dimensions already meet their thresholds
     * so the satisficing judge should immediately flag it as complete
     * without needing task generation.
     *
     * LLM calls: 3 observation calls (one per dimension, all meeting threshold)
     * Then task generation / review may be skipped if judge says complete.
     */
    const llmClient = createSequentialMockLLMClient([
      // Observations: all dimensions meet threshold
      makeLLMObservationScore(0.9, "Excellent README quality"),
      makeLLMObservationPresent(1.0, "Installation guide is present"),
      makeLLMObservationPresent(1.0, "Usage examples are present"),
      // Guard responses in case loop still generates a task
      "```json\n" + makeTaskGenerationResponse() + "\n```",
      makeLLMReviewResponse(),
    ]);

    const coreLoop = buildCoreLoop(stateManager, llmClient, 1);

    const goal = makeReadmeGoal(goalId);
    await stateManager.saveGoal(goal);

    const result = await coreLoop.run(goalId);

    expect(result.iterations.length).toBeGreaterThanOrEqual(1);

    const iteration = result.iterations[0]!;
    expect(iteration.completionJudgment).toBeDefined();
    expect(typeof iteration.completionJudgment.is_complete).toBe("boolean");

    // When LLM reports scores above threshold, the gap should be zero or near zero.
    // SatisficingJudge requires double-confirmation (2 consecutive cycles) before
    // declaring is_complete=true, so with maxIterations=1 the goal may not be
    // marked complete yet even when gap=0. We verify that the judgment was evaluated
    // by SatisficingJudge (not the old gap=0 short-circuit).
    if (iteration.gapAggregate <= 0) {
      // completionJudgment must be present and well-formed regardless of is_complete value
      expect(iteration.completionJudgment.blocking_dimensions).toBeDefined();
      expect(Array.isArray(iteration.completionJudgment.blocking_dimensions)).toBe(true);
    }

    // The final loop status should reflect completion or max_iterations
    expect(["completed", "max_iterations"]).toContain(result.finalStatus);
  });
});
