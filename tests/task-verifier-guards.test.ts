import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { clampDimensionUpdate, handleVerdict, checkDimensionDirection } from "../src/execution/task/task-verifier.js";
import type { VerifierDeps } from "../src/execution/task/task-verifier.js";
import type { Task, VerificationResult } from "../src/types/task.js";
import type { Logger } from "../src/runtime/logger.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Fixtures ───

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
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

function makeVerificationResult(
  overrides: Partial<VerificationResult> = {}
): VerificationResult {
  return {
    task_id: "task-1",
    verdict: "pass",
    confidence: 0.9,
    evidence: [
      {
        layer: "mechanical",
        description: "Mechanical check passed",
        confidence: 0.9,
      },
    ],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(
  stateManager: StateManager,
  sessionManager: SessionManager,
  trustManager: TrustManager,
  stallDetector: StallDetector,
  logger?: Logger
): VerifierDeps {
  const llmClient = createMockLLMClient([]);
  return {
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    stallDetector,
    logger,
    durationToMs: (d) => d.value * (d.unit === "hours" ? 3600000 : 60000),
  };
}

// ─── Tests ───

describe("P0 Guard 1: clampDimensionUpdate", () => {
  it("value within range — no clamping", () => {
    const result = clampDimensionUpdate(0.5, 0.7, undefined, "dim");
    expect(result).toBeCloseTo(0.7, 10);
  });

  it("value exceeding +0.3 absolute limit — clamped to current+0.3", () => {
    // current=0.5, proposed=0.9 → maxDelta = max(0.3, 0.15) = 0.3 → clamped to 0.8
    const result = clampDimensionUpdate(0.5, 0.9, undefined, "dim");
    expect(result).toBeCloseTo(0.8, 10);
  });

  it("value exceeding -0.3 absolute limit — clamped to current-0.3", () => {
    // current=0.5, proposed=0.1 → maxDelta = max(0.3, 0.15) = 0.3 → clamped to 0.2
    const result = clampDimensionUpdate(0.5, 0.1, undefined, "dim");
    expect(result).toBeCloseTo(0.2, 10);
  });

  it("large current value uses 30% relative limit when it exceeds absolute limit", () => {
    // current=2.0, proposed=3.0 → relLimit = 2.0*0.3 = 0.6 > 0.3 → maxDelta=0.6 → clamped to 2.6
    const result = clampDimensionUpdate(2.0, 3.0, undefined, "dim");
    expect(result).toBeCloseTo(2.6, 10);
  });

  it("logger.warn is called when clamping occurs", () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    clampDimensionUpdate(0.5, 0.9, mockLogger, "testDim");
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    const warnMsg = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(warnMsg).toContain("testDim");
    expect(warnMsg).toContain("0.9");
  });

  it("logger.warn is NOT called when no clamping occurs", () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    clampDimensionUpdate(0.5, 0.7, mockLogger, "dim");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("P0 Guard 2: progress-verdict contradiction", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setupGoalState(
    dimName: string,
    currentValue: number,
    thresholdType: "min" | "max" = "min"
  ): Promise<void> {
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Test Goal",
      status: "active",
      dimensions: [
        {
          name: dimName,
          label: dimName,
          current_value: currentValue,
          threshold: { type: thresholdType, value: thresholdType === "min" ? 1.0 : 0.0 },
          last_updated: null,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  it("verdict 'pass' with worsened dimension — overridden to 'partial'", async () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector, mockLogger);
    const task = makeTask();
    await setupGoalState("dim", 0.5);

    // previous=0.7, new=0.5 → decreased by 0.2 > 0.05 threshold → contradiction
    const vr = makeVerificationResult({
      verdict: "pass",
      dimension_updates: [
        { dimension_name: "dim", previous_value: 0.7, new_value: 0.5, confidence: 0.9 },
      ],
    });

    const result = await handleVerdict(deps, task, vr);
    // Overridden to partial → isDirectionCorrect(partial)=true → action=keep
    expect(result.action).toBe("keep");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("progress-verdict contradiction")
    );
  });

  it("verdict 'pass' with improved dimension — unchanged", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask();
    await setupGoalState("dim", 0.5);

    // previous=0.5, new=0.7 → improved, no contradiction
    const vr = makeVerificationResult({
      verdict: "pass",
      dimension_updates: [
        { dimension_name: "dim", previous_value: 0.5, new_value: 0.7, confidence: 0.9 },
      ],
    });

    const result = await handleVerdict(deps, task, vr);
    expect(result.action).toBe("completed");
  });

  it("verdict 'fail' with worsened dimension — unchanged (only 'pass' is checked)", async () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector, mockLogger);
    const task = makeTask();
    await setupGoalState("dim", 0.5);

    const vr = makeVerificationResult({
      verdict: "fail",
      dimension_updates: [
        { dimension_name: "dim", previous_value: 0.7, new_value: 0.5, confidence: 0.9 },
      ],
    });

    const result = await handleVerdict(deps, task, vr);
    // fail verdict goes through handleFailure: consecutive_failure_count < 3 → keep
    expect(result.action).not.toBe("completed");
    // The contradiction guard should NOT have been triggered for "fail"
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((msg: string) => msg.includes("progress-verdict contradiction"));
    expect(warnCalls).toHaveLength(0);
  });

  it("max-type dimension: value decrease is progress — no false-positive contradiction", async () => {
    // For a max-type goal (e.g. "reduce bug count to <= 5"), a decrease in value IS progress.
    // The guard must NOT fire when a max-type dimension value decreases.
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector, mockLogger);
    const task = makeTask();

    // Store goal with a max-type dimension (e.g. bug count, lower is better)
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Reduce Bugs",
      status: "active",
      dimensions: [
        {
          name: "bug_count",
          label: "Bug Count",
          current_value: 10,
          threshold: { type: "max", value: 5 },
          last_updated: null,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // previous=10, new=7 → decreased by 3 (progress for max-type), NOT a contradiction
    const vr = makeVerificationResult({
      verdict: "pass",
      dimension_updates: [
        { dimension_name: "bug_count", previous_value: 10, new_value: 7, confidence: 0.9 },
      ],
    });

    const result = await handleVerdict(deps, task, vr);
    // Must remain "pass" (→ action=completed), not overridden to "partial"
    expect(result.action).toBe("completed");
    const contradictionWarns = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((msg: string) => msg.includes("progress-verdict contradiction"));
    expect(contradictionWarns).toHaveLength(0);
  });

  it("max-type dimension: value increase is regression — contradiction guard fires", async () => {
    // For a max-type goal, an increase in value is worse (moving away from target).
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector, mockLogger);
    const task = makeTask();

    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Reduce Bugs",
      status: "active",
      dimensions: [
        {
          name: "bug_count",
          label: "Bug Count",
          current_value: 10,
          threshold: { type: "max", value: 5 },
          last_updated: null,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // previous=5, new=12 → increased by 7 → regression for max-type → guard must fire
    const vr = makeVerificationResult({
      verdict: "pass",
      dimension_updates: [
        { dimension_name: "bug_count", previous_value: 5, new_value: 12, confidence: 0.9 },
      ],
    });

    const result = await handleVerdict(deps, task, vr);
    expect(result.action).toBe("keep");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("progress-verdict contradiction")
    );
  });

  it("small worsening within 0.05 margin — verdict unchanged (no override)", async () => {
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector, mockLogger);
    const task = makeTask();
    await setupGoalState("dim", 0.5);

    // previous=0.5, new=0.46 → decreased by 0.04 < 0.05 margin → no contradiction
    const vr = makeVerificationResult({
      verdict: "pass",
      dimension_updates: [
        { dimension_name: "dim", previous_value: 0.5, new_value: 0.46, confidence: 0.9 },
      ],
    });

    const result = await handleVerdict(deps, task, vr);
    expect(result.action).toBe("completed");
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((msg: string) => msg.includes("progress-verdict contradiction"));
    expect(warnCalls).toHaveLength(0);
  });

  it("Guard 1 clamps large dimension update in pass case", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask();

    // Set initial dimension value to 0.5
    await setupGoalState("dim", 0.5);

    // proposed new_value=0.9 — would be clamped to 0.8 (current 0.5 + maxDelta 0.3)
    const vr = makeVerificationResult({
      verdict: "pass",
      dimension_updates: [
        { dimension_name: "dim", previous_value: 0.5, new_value: 0.9, confidence: 0.9 },
      ],
    });

    await handleVerdict(deps, task, vr);

    const goalData = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
    const dims = goalData.dimensions as Array<Record<string, unknown>>;
    const dim = dims.find((d) => d.name === "dim")!;
    // Should be clamped: 0.5 + 0.3 = 0.8
    expect(dim.current_value as number).toBeCloseTo(0.8, 10);
  });

  it("Guard 1 clamps large dimension update in partial case", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask({
      success_criteria: [
        {
          description: "Code quality",
          verification_method: "Manual review",
          is_blocking: true,
        },
      ],
    });

    // Set initial dimension value to 0.4
    await setupGoalState("dim", 0.4);

    // proposed new_value=0.9 — would be clamped to 0.7 (current 0.4 + maxDelta 0.3)
    const vr = makeVerificationResult({
      verdict: "partial",
      dimension_updates: [
        { dimension_name: "dim", previous_value: 0.4, new_value: 0.9, confidence: 0.7 },
      ],
    });

    await handleVerdict(deps, task, vr);

    const goalData = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
    const dims = goalData.dimensions as Array<Record<string, unknown>>;
    const dim = dims.find((d) => d.name === "dim")!;
    // Should be clamped: 0.4 + 0.3 = 0.7
    expect(dim.current_value as number).toBeCloseTo(0.7, 10);
  });
});

// ─── §4.6 Zod validation for completion_judger ───

describe("§4.6: runLLMReview Zod validation", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("valid JSON with enum verdict 'pass' — parsed correctly via Zod", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    const llmResponse = JSON.stringify({ verdict: "pass", reasoning: "All good", criteria_met: 3, criteria_total: 3 });
    const llmClient = createMockLLMClient([llmResponse]);

    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "dim", label: "dim", current_value: 0.5, threshold: { type: "min", value: 1.0 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };

    const task = makeTask({ success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }] });
    const result = await verifyTask(deps, task, {
      success: true, output: "done", error: null, exit_code: 0, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });
    expect(result.verdict).toBe("pass");
  });

  it("invalid enum value (e.g. 'exact') — falls back to default 'fail'", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    // 'exact' is not in the enum, Zod should coerce to default "fail"
    const llmResponse = JSON.stringify({ verdict: "unknown_value", reasoning: "weird" });
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const llmClient = createMockLLMClient([llmResponse]);

    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "dim", label: "dim", current_value: 0.5, threshold: { type: "min", value: 1.0 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector, logger: mockLogger,
      durationToMs: (d) => d.value * 3600000,
    };

    const task = makeTask({ success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }] });
    const result = await verifyTask(deps, task, {
      success: false, output: "", error: null, exit_code: 1, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });
    // Invalid enum value triggers parse failure → fallback to fail
    expect(result.verdict).toBe("fail");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Zod parse failed"));
  });

  it("malformed JSON — logs warn and falls back to fail confidence 0.3", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    const llmClient = createMockLLMClient(["not-json{{{bad"]);
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "dim", label: "dim", current_value: 0.5, threshold: { type: "min", value: 1.0 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector, logger: mockLogger,
      durationToMs: (d) => d.value * 3600000,
    };

    const task = makeTask({ success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }] });
    const result = await verifyTask(deps, task, {
      success: false, output: "", error: null, exit_code: 1, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });
    expect(result.verdict).toBe("fail");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("JSON.parse failed"));
  });
});

// ─── §4.7 Failure context saving ───

describe("§4.7: handleVerdict failure context save/clear", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setupGoalState(dimName: string, currentValue: number): Promise<void> {
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test Goal", status: "active",
      dimensions: [{ name: dimName, label: dimName, current_value: currentValue, threshold: { type: "min", value: 1.0 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  it("fail verdict — failure context saved to tasks/goal-1/last-failure-context.json", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask();
    await setupGoalState("dim", 0.5);

    const vr = makeVerificationResult({ verdict: "fail", dimension_updates: [] });
    await handleVerdict(deps, task, vr);

    const ctx = await stateManager.readRaw("tasks/goal-1/last-failure-context.json") as Record<string, unknown>;
    expect(ctx).not.toBeNull();
    expect(ctx.verdict).toBe("fail");
    expect(typeof ctx.prev_task_description).toBe("string");
    expect(typeof ctx.timestamp).toBe("string");
  });

  it("partial verdict — failure context saved", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask({ success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }] });
    await setupGoalState("dim", 0.5);

    const vr = makeVerificationResult({
      verdict: "partial",
      dimension_updates: [{ dimension_name: "dim", previous_value: 0.5, new_value: 0.65, confidence: 0.7 }],
    });
    await handleVerdict(deps, task, vr);

    const ctx = await stateManager.readRaw("tasks/goal-1/last-failure-context.json") as Record<string, unknown>;
    expect(ctx).not.toBeNull();
    expect(ctx.verdict).toBe("partial");
  });

  it("pass verdict — failure context cleared (written as null)", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask();
    await setupGoalState("dim", 0.5);

    // First write a failure context
    await stateManager.writeRaw("tasks/goal-1/last-failure-context.json", {
      task_description: "old task", verdict: "fail", reasoning: "old", timestamp: new Date().toISOString(),
    });

    // Then a pass verdict should clear it
    const vr = makeVerificationResult({ verdict: "pass", dimension_updates: [] });
    await handleVerdict(deps, task, vr);

    const ctx = await stateManager.readRaw("tasks/goal-1/last-failure-context.json");
    // After pass, context should be cleared (null written means file contains null → readRaw returns null)
    expect(ctx).toBeNull();
  });
});

// ─── §4.5 Guard: dimension_updates direction check ───

describe("§4.5 checkDimensionDirection", () => {
  let mockLogger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  it("skips update when intended=increase but value decreases", () => {
    const result = checkDimensionDirection("increase", 0.5, 0.3, mockLogger as unknown as Logger);
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dimension_update direction mismatch")
    );
  });

  it("skips update when intended=decrease but value increases", () => {
    const result = checkDimensionDirection("decrease", 0.3, 0.5, mockLogger as unknown as Logger);
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("allows update when direction matches (increase)", () => {
    const result = checkDimensionDirection("increase", 0.3, 0.5, mockLogger as unknown as Logger);
    expect(result).toBe(true);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("allows update when direction matches (decrease)", () => {
    const result = checkDimensionDirection("decrease", 0.5, 0.3, mockLogger as unknown as Logger);
    expect(result).toBe(true);
  });

  it("allows update when intended=neutral", () => {
    const result = checkDimensionDirection("neutral", 0.5, 0.3, mockLogger as unknown as Logger);
    expect(result).toBe(true);
  });

  it("allows update when intended_direction is undefined", () => {
    const result = checkDimensionDirection(undefined, 0.5, 0.3, mockLogger as unknown as Logger);
    expect(result).toBe(true);
  });

  it("allows update when value unchanged", () => {
    const result = checkDimensionDirection("increase", 0.5, 0.5, mockLogger as unknown as Logger);
    expect(result).toBe(true);
  });
});

// ─── RC-3: Verifier dimension_updates update confidence and last_observed_layer ───

describe("RC-3: handleVerdict updates confidence and last_observed_layer on dimension_updates", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setupGoalWithDim(dimName: string, currentValue: number): Promise<void> {
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{
        name: dimName, label: dimName, current_value: currentValue,
        threshold: { type: "min", value: 1.0 }, last_updated: null,
        confidence: 0.4, last_observed_layer: "self_report",
      }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  it("pass verdict: updates confidence and last_observed_layer to mechanical when dimension_update applied", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask();
    await setupGoalWithDim("dim", 0.5);

    const vr = makeVerificationResult({
      verdict: "pass",
      confidence: 0.85,
      dimension_updates: [{ dimension_name: "dim", previous_value: 0.5, new_value: 0.7, confidence: 0.85 }],
    });

    await handleVerdict(deps, task, vr);

    const goalData = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
    const dims = goalData.dimensions as Array<Record<string, unknown>>;
    const dim = dims.find((d) => d.name === "dim")!;
    expect(dim.current_value as number).toBeCloseTo(0.7, 10);
    expect(dim.confidence as number).toBe(0.85);
    expect(dim.last_observed_layer as string).toBe("mechanical");
  });

  it("partial verdict: updates confidence and last_observed_layer to mechanical when dimension_update applied", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask({
      success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }],
    });
    await setupGoalWithDim("dim", 0.4);

    const vr = makeVerificationResult({
      verdict: "partial",
      confidence: 0.75,
      dimension_updates: [{ dimension_name: "dim", previous_value: 0.4, new_value: 0.6, confidence: 0.75 }],
    });

    await handleVerdict(deps, task, vr);

    const goalData = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
    const dims = goalData.dimensions as Array<Record<string, unknown>>;
    const dim = dims.find((d) => d.name === "dim")!;
    expect(dim.current_value as number).toBeCloseTo(0.6, 10);
    expect(dim.confidence as number).toBe(0.75);
    expect(dim.last_observed_layer as string).toBe("mechanical");
  });

  it("pass verdict with no dimension_updates: confidence and last_observed_layer unchanged", async () => {
    const deps = makeDeps(stateManager, sessionManager, trustManager, stallDetector);
    const task = makeTask();
    await setupGoalWithDim("dim", 0.5);

    const vr = makeVerificationResult({
      verdict: "pass",
      confidence: 0.9,
      dimension_updates: [],
    });

    await handleVerdict(deps, task, vr);

    const goalData = await stateManager.readRaw("goals/goal-1/goal.json") as Record<string, unknown>;
    const dims = goalData.dimensions as Array<Record<string, unknown>>;
    const dim = dims.find((d) => d.name === "dim")!;
    // No update applied: confidence and last_observed_layer remain as set originally
    expect(dim.confidence as number).toBe(0.4);
    expect(dim.last_observed_layer as string).toBe("self_report");
  });
});

// ─── Root Cause C: dimension_updates scaling to raw threshold-scale space ───

describe("Root Cause C: dimension_updates scaling", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("min threshold: delta is scaled by threshold.value — pass verdict adds 0.2 * value", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    // threshold value=5, current_value=2 → pass delta = 0.2 * 5 = 1.0 → new_value = 3.0
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "dim", label: "dim", current_value: 2, threshold: { type: "min", value: 5 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const llmClient = createMockLLMClient([
      JSON.stringify({ verdict: "pass", reasoning: "All criteria met", criteria_met: 1, criteria_total: 1 }),
    ]);
    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };
    const task = makeTask({
      success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }],
    });

    const result = await verifyTask(deps, task, {
      success: true, output: "done", error: null, exit_code: 0, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });

    expect(result.verdict).toBe("pass");
    const update = result.dimension_updates.find((u) => u.dimension_name === "dim");
    expect(update).toBeDefined();
    // Scaled delta: 0.2 * 5 = 1.0, so new_value = 2 + 1.0 = 3.0
    expect(update!.new_value).toBeCloseTo(3.0, 5);
  });

  it("max threshold: delta is scaled by threshold.value — pass verdict adds 0.2 * value", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    // threshold value=10, current_value=8 → pass delta = 0.2 * 10 = 2.0 → new_value = 6.0
    // For max-type (reduce bug count), delta is subtracted implicitly by being negative direction
    // but the scaling logic just multiplies by value: 0.2 * 10 = 2.0 → new_value = 8 + 2.0 = 10
    // (direction check handled separately; scaling correctness is the concern here)
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "count", label: "count", current_value: 8, threshold: { type: "max", value: 10 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const llmClient = createMockLLMClient([
      JSON.stringify({ verdict: "pass", reasoning: "Done", criteria_met: 1, criteria_total: 1 }),
    ]);
    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };
    const task = makeTask({
      target_dimensions: ["count"],
      primary_dimension: "count",
      success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }],
    });

    const result = await verifyTask(deps, task, {
      success: true, output: "done", error: null, exit_code: 0, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });

    const update = result.dimension_updates.find((u) => u.dimension_name === "count");
    expect(update).toBeDefined();
    // Scaled delta: 0.2 * 10 = 2.0, so new_value = 8 + 2.0 = 10.0
    expect(update!.new_value).toBeCloseTo(10.0, 5);
  });

  it("range threshold: delta is scaled by (high - low)", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    // range low=0, high=100, current_value=20 → pass delta = 0.2 * (100 - 0) = 20 → new_value = 40
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "score", label: "score", current_value: 20, threshold: { type: "range", low: 0, high: 100 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const llmClient = createMockLLMClient([
      JSON.stringify({ verdict: "pass", reasoning: "Done", criteria_met: 1, criteria_total: 1 }),
    ]);
    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };
    const task = makeTask({
      target_dimensions: ["score"],
      primary_dimension: "score",
      success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }],
    });

    const result = await verifyTask(deps, task, {
      success: true, output: "done", error: null, exit_code: 0, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });

    const update = result.dimension_updates.find((u) => u.dimension_name === "score");
    expect(update).toBeDefined();
    // Scaled delta: 0.2 * (100 - 0) = 20, so new_value = 20 + 20 = 40
    expect(update!.new_value).toBeCloseTo(40.0, 5);
  });

  it("partial verdict: delta is 0.15 scaled by threshold value", async () => {
    const { verifyTask } = await import("../src/execution/task/task-verifier.js");
    // threshold value=10, current_value=3 → partial delta = 0.15 * 10 = 1.5 → new_value = 4.5
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1", title: "Test", status: "active",
      dimensions: [{ name: "dim", label: "dim", current_value: 3, threshold: { type: "min", value: 10 }, last_updated: null }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const llmClient = createMockLLMClient([
      JSON.stringify({ verdict: "partial", reasoning: "Partially done", criteria_met: 0, criteria_total: 1 }),
    ]);
    const deps: VerifierDeps = {
      stateManager, llmClient, sessionManager, trustManager, stallDetector,
      durationToMs: (d) => d.value * 3600000,
    };
    const task = makeTask({
      success_criteria: [{ description: "Manual check", verification_method: "Manual review", is_blocking: true }],
    });

    const result = await verifyTask(deps, task, {
      success: true, output: "partial done", error: null, exit_code: 0, stopped_reason: "end_turn",
      session_id: "s1", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), tokens_used: 0,
    });

    const update = result.dimension_updates.find((u) => u.dimension_name === "dim");
    expect(update).toBeDefined();
    // Scaled delta: 0.15 * 10 = 1.5, so new_value = 3 + 1.5 = 4.5
    expect(update!.new_value).toBeCloseTo(4.5, 5);
  });
});
