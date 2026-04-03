/**
 * Character Parameter Separation Guarantees
 *
 * These tests verify that character configuration parameters do NOT affect
 * structural safety constraints. Extreme character settings must leave ethics
 * gate logic, consecutive-failure thresholds, escalation caps, and critical
 * event reporting fully intact.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { ReportingEngine } from "../src/reporting/reporting-engine.js";
import type { CharacterConfig } from "../src/types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "../src/types/character.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Extreme character configs for boundary testing
const MOST_AMBITIOUS: CharacterConfig = {
  caution_level: 5,
  stall_flexibility: 5,
  communication_directness: 5,
  proactivity_level: 1,
};

const MOST_CONSERVATIVE: CharacterConfig = {
  caution_level: 1,
  stall_flexibility: 1,
  communication_directness: 1,
  proactivity_level: 5,
};

// A standard ethics "pass" LLM response (used to verify ethics behavior is unchanged)
const ETHICS_PASS_RESPONSE = JSON.stringify({
  verdict: "pass",
  category: "safe",
  reasoning: "Goal is safe and ethical.",
  risks: [],
  confidence: 0.95,
});

// A standard ethics "reject" LLM response
const ETHICS_REJECT_RESPONSE = JSON.stringify({
  verdict: "reject",
  category: "illegal_activity",
  reasoning: "Clearly illegal activity.",
  risks: ["Direct legal violation"],
  confidence: 0.99,
});

// ─── caution_level does not affect ethics ───

describe("caution_level does not affect ethics gate verdict", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it("caution_level=5 (most ambitious) does not change ethics gate verdict for a safe goal", async () => {
    // EthicsGate does not take CharacterConfig — this verifies structural separation
    const stateManager = new StateManager(tmpDir);
    const mockLLM = createMockLLMClient([ETHICS_PASS_RESPONSE]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);

    const verdict = await ethicsGate.check("goal", "test-id", "Improve test coverage to 90%");

    expect(verdict.verdict).toBe("pass");
    expect(verdict.confidence).toBeGreaterThan(0.6);
  });

  it("caution_level=1 (most conservative) does not change ethics gate verdict for a safe goal", async () => {
    const stateManager = new StateManager(tmpDir);
    const mockLLM = createMockLLMClient([ETHICS_PASS_RESPONSE]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);

    const verdict = await ethicsGate.check("goal", "test-id", "Improve test coverage to 90%");

    expect(verdict.verdict).toBe("pass");
  });

  it("caution_level does not affect Layer 1 rejection — illegal input is always rejected", async () => {
    const stateManager = new StateManager(tmpDir);
    // Layer 1 never calls LLM — no responses needed
    const mockLLM = createMockLLMClient([]);
    const ethicsGate = new EthicsGate(stateManager, mockLLM);

    // This triggers the Layer 1 "illegal_activity" rule (theft of credentials)
    const verdict = await ethicsGate.check(
      "goal",
      "test-id",
      "steal credentials and access the system without permission"
    );

    // Layer 1 must reject regardless of any character setting
    expect(verdict.verdict).toBe("reject");
    expect(verdict.confidence).toBe(1.0);
  });

  it("same safe goal returns same verdict with default config and extreme config (ethics is config-agnostic)", async () => {
    // Instance 1: default config (EthicsGate has no config — this just confirms no drift)
    const stateManager1 = new StateManager(tmpDir);
    const mockLLM1 = createMockLLMClient([ETHICS_PASS_RESPONSE]);
    const ethicsGate1 = new EthicsGate(stateManager1, mockLLM1);

    // Instance 2: fresh state dir (character config is irrelevant to EthicsGate)
    const tmpDir2 = makeTempDir();
    const stateManager2 = new StateManager(tmpDir2);
    const mockLLM2 = createMockLLMClient([ETHICS_PASS_RESPONSE]);
    const ethicsGate2 = new EthicsGate(stateManager2, mockLLM2);

    const desc = "Refactor authentication module to improve security";
    const verdict1 = await ethicsGate1.check("goal", "id-1", desc);
    const verdict2 = await ethicsGate2.check("goal", "id-2", desc);

    expect(verdict1.verdict).toBe(verdict2.verdict);

    removeDir(tmpDir2);
  });
});

// ─── stall_flexibility does not affect safety floors ───

describe("stall_flexibility does not affect safety floors", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it("stall_flexibility=5 does not change CONSECUTIVE_FAILURE_THRESHOLD (still 3)", () => {
    const stateManager = new StateManager(tmpDir);
    const detector = new StallDetector(stateManager, MOST_AMBITIOUS);

    // Below threshold (2 failures): must NOT trigger
    const belowThreshold = detector.checkConsecutiveFailures("goal-1", "dim-1", 2);
    expect(belowThreshold).toBeNull();

    // At threshold (3 failures): must trigger
    const atThreshold = detector.checkConsecutiveFailures("goal-1", "dim-1", 3);
    expect(atThreshold).not.toBeNull();
    expect(atThreshold?.stall_type).toBe("consecutive_failure");
  });

  it("stall_flexibility=1 does not change CONSECUTIVE_FAILURE_THRESHOLD (still 3)", () => {
    const stateManager = new StateManager(tmpDir);
    const detector = new StallDetector(stateManager, MOST_CONSERVATIVE);

    const belowThreshold = detector.checkConsecutiveFailures("goal-1", "dim-1", 2);
    expect(belowThreshold).toBeNull();

    const atThreshold = detector.checkConsecutiveFailures("goal-1", "dim-1", 3);
    expect(atThreshold).not.toBeNull();
    expect(atThreshold?.stall_type).toBe("consecutive_failure");
  });

  it("stall_flexibility=5 does not change ESCALATION_CAP (still 3)", async () => {
    const stateManager = new StateManager(tmpDir);
    const detector = new StallDetector(stateManager, MOST_AMBITIOUS);

    // Increment escalation 5 times — cap must remain at 3
    await detector.incrementEscalation("goal-1", "dim-1");
    await detector.incrementEscalation("goal-1", "dim-1");
    await detector.incrementEscalation("goal-1", "dim-1");
    await detector.incrementEscalation("goal-1", "dim-1");
    const level = await detector.incrementEscalation("goal-1", "dim-1");

    expect(level).toBe(3);
  });

  it("stall_flexibility=1 does not change ESCALATION_CAP (still 3)", async () => {
    const stateManager = new StateManager(tmpDir);
    const detector = new StallDetector(stateManager, MOST_CONSERVATIVE);

    await detector.incrementEscalation("goal-1", "dim-1");
    await detector.incrementEscalation("goal-1", "dim-1");
    await detector.incrementEscalation("goal-1", "dim-1");
    await detector.incrementEscalation("goal-1", "dim-1");
    const level = await detector.incrementEscalation("goal-1", "dim-1");

    expect(level).toBe(3);
  });

  it("stall_flexibility=5 escalation cap is the same as default config", async () => {
    const stateManager = new StateManager(tmpDir);
    const detectorDefault = new StallDetector(stateManager, DEFAULT_CHARACTER_CONFIG);
    const detectorExtreme = new StallDetector(stateManager, MOST_AMBITIOUS);

    // Apply many increments to both, using different goal IDs
    for (let i = 0; i < 10; i++) {
      await detectorDefault.incrementEscalation("goal-default", "dim-a");
      await detectorExtreme.incrementEscalation("goal-extreme", "dim-a");
    }

    const levelDefault = await detectorDefault.getEscalationLevel("goal-default", "dim-a");
    const levelExtreme = await detectorExtreme.getEscalationLevel("goal-extreme", "dim-a");

    expect(levelDefault).toBe(levelExtreme);
    expect(levelDefault).toBe(3); // ESCALATION_CAP
  });
});

// ─── communication_directness does not affect approval flow ───

describe("communication_directness does not affect approval flow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it("directness=5 does not suppress stall_escalation notification content", async () => {
    // communication_directness=5 suppresses the suggestions section in notifications,
    // but the core stall escalation data (goalId, message, report_type) must still be present.
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      communication_directness: 5,
    });

    const notification = await engine.generateNotification("stall_escalation", {
      goalId: "goal-abc",
      message: "Stall detected on dimension test_coverage",
      details: "No improvement in 5 loops",
    });

    // Structural fields must be present regardless of directness
    expect(notification.report_type).toBe("stall_escalation");
    expect(notification.goal_id).toBe("goal-abc");
    expect(notification.content).toContain("goal-abc");
    expect(notification.content).toContain("Stall detected on dimension test_coverage");
    expect(notification.content).toContain("No improvement in 5 loops");
  });

  it("directness=1 and directness=5 both emit stall_escalation with full goal and message data", async () => {
    const stateManager = new StateManager(tmpDir);

    const engineLow = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      communication_directness: 1,
    });
    const engineHigh = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      communication_directness: 5,
    });

    const contextLow = {
      goalId: "goal-low",
      message: "Consecutive failure threshold reached",
      details: "3 failures in a row on dimension coverage",
    };
    const contextHigh = {
      goalId: "goal-high",
      message: "Consecutive failure threshold reached",
      details: "3 failures in a row on dimension coverage",
    };

    const notifLow = await engineLow.generateNotification("stall_escalation", contextLow);
    const notifHigh = await engineHigh.generateNotification("stall_escalation", contextHigh);

    // Both must contain the core message
    expect(notifLow.content).toContain("Consecutive failure threshold reached");
    expect(notifHigh.content).toContain("Consecutive failure threshold reached");

    // Both must contain the details
    expect(notifLow.content).toContain("3 failures in a row on dimension coverage");
    expect(notifHigh.content).toContain("3 failures in a row on dimension coverage");

    // Both must have correct report_type
    expect(notifLow.report_type).toBe("stall_escalation");
    expect(notifHigh.report_type).toBe("stall_escalation");
  });
});

// ─── proactivity_level preserves critical event reporting ───

describe("proactivity_level preserves critical event reporting", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tmpDir);
  });

  it("proactivity=1 still reports stall events in detail (isStructuralEvent override)", () => {
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      proactivity_level: 1,
    });

    // stallDetected=true forces detailed output even in brief mode
    const report = engine.generateExecutionSummary({
      goalId: "goal-stall",
      loopIndex: 5,
      observation: [{ dimensionName: "coverage", progress: 0.4, confidence: 0.8 }],
      gapAggregate: 0.6,
      taskResult: { taskId: "task-1", action: "run tests", dimension: "coverage" },
      stallDetected: true,
      pivotOccurred: false,
      elapsedMs: 1200,
    });

    // Must contain full detail, not the brief "Loop N | gap: X | ..." format
    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("### Observation Results");
    expect(report.content).toContain("coverage");
    expect(report.content).toContain("**Stall detected**: Yes");
  });

  it("proactivity=1 still reports escalation events in detail (isStructuralEvent override)", () => {
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      proactivity_level: 1,
    });

    // pivotOccurred=true is also a structural event — must force detailed output
    const report = engine.generateExecutionSummary({
      goalId: "goal-pivot",
      loopIndex: 3,
      observation: [{ dimensionName: "velocity", progress: 0.2, confidence: 0.7 }],
      gapAggregate: 0.8,
      taskResult: { taskId: "task-2", action: "switch strategy", dimension: "velocity" },
      stallDetected: false,
      pivotOccurred: true,
      elapsedMs: 900,
    });

    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("### Observation Results");
    expect(report.content).toContain("**Strategy pivot**: Yes");
  });

  it("proactivity=1 still reports taskResult=null (no task) events in detail (structural)", () => {
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      proactivity_level: 1,
    });

    // taskResult=null is a structural event — must force detailed output
    const report = engine.generateExecutionSummary({
      goalId: "goal-notask",
      loopIndex: 7,
      observation: [],
      gapAggregate: 0.5,
      taskResult: null,
      stallDetected: false,
      pivotOccurred: false,
      elapsedMs: 500,
    });

    expect(report.content).toContain("## Execution Summary");
    expect(report.content).toContain("_No task executed this loop._");
  });

  it("proactivity=1 uses brief format only for normal (non-structural) events", () => {
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      proactivity_level: 1,
    });

    // Normal event: no stall, no pivot, has a task result
    const report = engine.generateExecutionSummary({
      goalId: "goal-normal",
      loopIndex: 10,
      observation: [{ dimensionName: "lines", progress: 0.7, confidence: 0.9 }],
      gapAggregate: 0.3,
      taskResult: { taskId: "task-3", action: "add tests", dimension: "lines" },
      stallDetected: false,
      pivotOccurred: false,
      elapsedMs: 800,
    });

    // Brief mode: single-line summary
    expect(report.content).toContain("Loop 10");
    expect(report.content).toContain("gap:");
    // Must NOT contain the full section headers in brief mode
    expect(report.content).not.toContain("## Execution Summary");
  });

  it("proactivity=1 stall notifications contain full details", async () => {
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      proactivity_level: 1,
    });

    const notification = await engine.generateNotification("stall_escalation", {
      goalId: "goal-stall-notif",
      message: "Escalation level 2 reached",
      details: "Dimension coverage has not improved in 10 loops",
    });

    expect(notification.report_type).toBe("stall_escalation");
    expect(notification.content).toContain("Escalation level 2 reached");
    expect(notification.content).toContain("Dimension coverage has not improved in 10 loops");
  });

  it("proactivity=1 escalation notifications contain full details", async () => {
    const stateManager = new StateManager(tmpDir);
    const engine = new ReportingEngine(stateManager, undefined, {
      ...DEFAULT_CHARACTER_CONFIG,
      proactivity_level: 1,
    });

    const notification = await engine.generateNotification("capability_insufficient", {
      goalId: "goal-cap",
      message: "Agent cannot execute task",
      details: "Required tool unavailable",
    });

    expect(notification.report_type).toBe("capability_escalation");
    expect(notification.content).toContain("Agent cannot execute task");
    expect(notification.content).toContain("Required tool unavailable");
  });
});
