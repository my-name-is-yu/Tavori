import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { buildTaskGenerationPrompt } from "../src/execution/task/task-prompt-builder.js";
import { handleVerdict } from "../src/execution/task/task-verifier.js";
import type { VerifierDeps } from "../src/execution/task/task-verifier.js";
import type { Task, VerificationResult } from "../src/types/task.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

// ─── failure-context injection tests (§4.7) ───

describe("buildTaskGenerationPrompt — failure context injection (§4.7)", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not include failure context when no last-failure-context.json exists", async () => {
    const prompt = await buildTaskGenerationPrompt(
      stateManager,
      "goal-1",
      "test_coverage"
    );

    expect(prompt).not.toContain("前回のタスク");
    expect(prompt).not.toContain("この失敗を踏まえて");
  });

  it("injects failure context into the prompt when last-failure-context.json exists", async () => {
    await stateManager.writeRaw("tasks/goal-1/last-failure-context.json", {
      prev_task_description: "Write tests for the auth module",
      verdict: "failed",
      reasoning: "Tests could not run due to missing dependency",
      criteria_met: 0,
      criteria_total: 3,
    });

    const prompt = await buildTaskGenerationPrompt(
      stateManager,
      "goal-1",
      "test_coverage"
    );

    expect(prompt).toContain("前回のタスク「Write tests for the auth module」");
    expect(prompt).toContain("failedと判定された");
    expect(prompt).toContain("Tests could not run due to missing dependency");
    expect(prompt).toContain("達成基準: 0/3");
    expect(prompt).toContain("この失敗を踏まえて、異なるアプローチのタスクを生成すること。");
  });

  it("uses the verdict from the failure context in the injected text", async () => {
    await stateManager.writeRaw("tasks/goal-1/last-failure-context.json", {
      prev_task_description: "Deploy to production",
      verdict: "incomplete",
      reasoning: "Deployment timed out",
      criteria_met: 1,
      criteria_total: 4,
    });

    const prompt = await buildTaskGenerationPrompt(
      stateManager,
      "goal-1",
      "deployment"
    );

    expect(prompt).toContain("incompleteと判定された");
    expect(prompt).toContain("達成基準: 1/4");
  });

  it("falls back to 'failed' verdict when verdict field is missing", async () => {
    await stateManager.writeRaw("tasks/goal-1/last-failure-context.json", {
      prev_task_description: "Fix the login bug",
      reasoning: "Session expired during execution",
      criteria_met: 2,
      criteria_total: 5,
    });

    const prompt = await buildTaskGenerationPrompt(
      stateManager,
      "goal-1",
      "reliability"
    );

    expect(prompt).toContain("failedと判定された");
  });

  it("skips injection when prev_task_description is missing", async () => {
    await stateManager.writeRaw("tasks/goal-1/last-failure-context.json", {
      verdict: "failed",
      reasoning: "No description available",
      criteria_met: 0,
      criteria_total: 1,
    });

    const prompt = await buildTaskGenerationPrompt(
      stateManager,
      "goal-1",
      "test_coverage"
    );

    expect(prompt).not.toContain("前回のタスク");
    expect(prompt).not.toContain("この失敗を踏まえて");
  });

  it("failure context appears before the Requirements section", async () => {
    await stateManager.writeRaw("tasks/goal-1/last-failure-context.json", {
      prev_task_description: "Add linting configuration",
      verdict: "failed",
      reasoning: "ESLint not installed",
      criteria_met: 0,
      criteria_total: 2,
    });

    const prompt = await buildTaskGenerationPrompt(
      stateManager,
      "goal-1",
      "code_quality"
    );

    const failureIdx = prompt.indexOf("前回のタスク");
    const requirementsIdx = prompt.indexOf("Requirements:");
    expect(failureIdx).toBeGreaterThan(-1);
    expect(requirementsIdx).toBeGreaterThan(-1);
    expect(failureIdx).toBeLessThan(requirementsIdx);
  });
});

// ─── Round-trip test: writer (handleVerdict) → reader (buildTaskGenerationPrompt) ───

describe("§4.7 round-trip: handleVerdict writes, buildTaskGenerationPrompt reads", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-rt-1",
      goal_id: "goal-rt-1",
      strategy_id: null,
      target_dimensions: ["dim"],
      primary_dimension: "dim",
      work_description: "Round-trip task description",
      rationale: "test",
      approach: "test",
      success_criteria: [
        { description: "Manual check", verification_method: "Manual review", is_blocking: true },
      ],
      scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
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

  function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
    return {
      task_id: "task-rt-1",
      verdict: "fail",
      confidence: 0.8,
      evidence: [{ layer: "independent_review", description: "Round-trip reasoning", confidence: 0.8 }],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it("field written by handleVerdict (prev_task_description) is read correctly by buildTaskGenerationPrompt", async () => {
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const llmClient = createMockLLMClient([]);

    // Write the verification result with criteria (simulates verifyTask output)
    await stateManager.writeRaw("verification/task-rt-1/verification-result.json", {
      task_id: "task-rt-1",
      verdict: "fail",
      confidence: 0.8,
      evidence: [],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
      criteria_met: 2,
      criteria_total: 5,
    });

    // Write goal state required by handleVerdict (use full schema-compliant fixture)
    await stateManager.writeRaw("goals/goal-rt-1/goal.json",
      makeGoal({ id: "goal-rt-1", dimensions: [makeDimension({ name: "dim", current_value: 0.5, threshold: { type: "min", value: 1.0 } })] })
    );

    const deps: VerifierDeps = {
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };

    const task = makeTask();
    const vr = makeVerificationResult({ verdict: "fail" });

    // handleVerdict is the writer — it should save prev_task_description
    await handleVerdict(deps, task, vr);

    // Verify the written field name is prev_task_description (not task_description)
    const raw = await stateManager.readRaw("tasks/goal-rt-1/last-failure-context.json") as Record<string, unknown>;
    expect(raw).not.toBeNull();
    expect(raw.prev_task_description).toBe("Round-trip task description");
    expect(raw).not.toHaveProperty("task_description");

    // Now verify the reader (buildTaskGenerationPrompt) picks it up correctly
    const prompt = await buildTaskGenerationPrompt(stateManager, "goal-rt-1", "dim");
    expect(prompt).toContain("前回のタスク「Round-trip task description」");
    expect(prompt).toContain("failと判定された");
    expect(prompt).toContain("Round-trip reasoning");
    expect(prompt).toContain("達成基準: 2/5");
    expect(prompt).toContain("この失敗を踏まえて、異なるアプローチのタスクを生成すること。");
  });

  it("criteria_met and criteria_total from the verification result appear in the injected prompt", async () => {
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const llmClient = createMockLLMClient([]);

    // Write verification result with criteria fields (as verifyTask would persist them)
    await stateManager.writeRaw("verification/task-rt-1/verification-result.json", {
      task_id: "task-rt-1",
      verdict: "partial",
      confidence: 0.6,
      evidence: [{ layer: "independent_review", description: "Partial completion", confidence: 0.6 }],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
      criteria_met: 3,
      criteria_total: 4,
    });

    await stateManager.writeRaw("goals/goal-rt-1/goal.json",
      makeGoal({ id: "goal-rt-1", dimensions: [makeDimension({ name: "dim", current_value: 0.5, threshold: { type: "min", value: 1.0 } })] })
    );

    const deps: VerifierDeps = {
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };

    const task = makeTask({ success_criteria: [{ description: "Check", verification_method: "Manual review", is_blocking: true }] });
    // partial verdict with direction correct (isDirectionCorrect = true for partial) → keep
    const vr = makeVerificationResult({
      verdict: "partial",
      dimension_updates: [{ dimension_name: "dim", previous_value: 0.5, new_value: 0.65, confidence: 0.6 }],
    });

    await handleVerdict(deps, task, vr);

    // Verify criteria fields are wired through
    const raw = await stateManager.readRaw("tasks/goal-rt-1/last-failure-context.json") as Record<string, unknown>;
    expect(raw.criteria_met).toBe(3);
    expect(raw.criteria_total).toBe(4);

    // Verify the prompt shows correct criteria counts
    const prompt = await buildTaskGenerationPrompt(stateManager, "goal-rt-1", "dim");
    expect(prompt).toContain("達成基準: 3/4");
  });
});
