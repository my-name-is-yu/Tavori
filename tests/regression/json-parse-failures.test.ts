import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StateManager } from "../../src/state/state-manager.js";
import { DriveSystem } from "../../src/drive/drive-system.js";
import { observeWithLLM } from "../../src/observation/observation-llm.js";
import { verifyTask, type VerifierDeps } from "../../src/execution/task/task-verifier.js";
import { SessionManager } from "../../src/execution/session-manager.js";
import { TrustManager } from "../../src/traits/trust-manager.js";
import { StallDetector } from "../../src/drive/stall-detector.js";
import type { Logger } from "../../src/runtime/logger.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeGoal } from "../helpers/fixtures.js";
import type { Task } from "../../src/types/task.js";
import type { PulSeedEvent } from "../../src/types/drive.js";

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function makeEvent(overrides: Partial<PulSeedEvent> = {}): PulSeedEvent {
  return {
    type: "external",
    source: "regression-test",
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "verify malformed JSON handling",
    rationale: "regression",
    approach: "regression",
    success_criteria: [{ description: "criterion", verification_method: "manual", is_blocking: true }],
    scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "none" },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
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

describe("json parse failure regressions", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drive-system watcher skips malformed JSON and still delivers later valid events", async () => {
    const logger = makeLogger();
    const driveSystem = new DriveSystem(stateManager, { baseDir: tmpDir, logger });
    const received: PulSeedEvent[] = [];
    driveSystem.startWatcher((event) => {
      received.push(event);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const eventsDir = path.join(tmpDir, "events");
    fs.writeFileSync(path.join(eventsDir, "bad.json"), "{ not valid json", "utf-8");
    fs.writeFileSync(path.join(eventsDir, "good.json"), JSON.stringify(makeEvent()), "utf-8");

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(received).toHaveLength(1);
    expect(received[0]?.source).toBe("regression-test");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("DriveSystem"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("bad.json"));
  });

  it("observation-llm keeps processing when threshold JSON is malformed", async () => {
    const logger = makeLogger();
    const llmClient = createMockLLMClient([
      JSON.stringify({ score: 0.72, reason: "valid observation" }),
      JSON.stringify({ score: 0.72, reason: "valid observation" }),
    ]);

    const malformedEntry = await observeWithLLM(
      "goal-1",
      "dim-1",
      "Improve quality",
      "Quality",
      "{ not valid json",
      llmClient,
      { gitContextFetcher: vi.fn().mockReturnValue("") },
      vi.fn(),
      undefined,
      null,
      true,
      logger
    );

    const validEntry = await observeWithLLM(
      "goal-1",
      "dim-1",
      "Improve quality",
      "Quality",
      JSON.stringify({ type: "min", value: 10 }),
      llmClient,
      { gitContextFetcher: vi.fn().mockReturnValue("") },
      vi.fn(),
      undefined,
      null,
      true,
      logger
    );

    expect(malformedEntry.extracted_value).toBe(0.72);
    expect(validEntry.extracted_value).toBeCloseTo(7.2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ObservationEngine")
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("goal=goal-1")
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dimension=dim-1")
    );
  });

  it("task-verifier logs malformed JSON, returns fail, and succeeds on a later valid response", async () => {
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const stallDetector = new StallDetector(stateManager);
    const logger = makeLogger();
    const llmClient = createMockLLMClient([
      "not-json{{{bad",
      JSON.stringify({ verdict: "pass", reasoning: "recovered", criteria_met: 1, criteria_total: 1 }),
    ]);

    await stateManager.saveGoal(
      makeGoal({
        id: "goal-1",
        dimensions: [
          {
            name: "dim",
            label: "dim",
            current_value: 0,
            threshold: { type: "min", value: 1 },
            confidence: 0.5,
            observation_method: {
              type: "mechanical",
              source: "test",
              schedule: null,
              endpoint: null,
              confidence_tier: "mechanical",
            },
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1,
            uncertainty_weight: null,
            state_integrity: "ok",
            dimension_mapping: null,
          },
        ],
      })
    );

    const deps: VerifierDeps = {
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      stallDetector,
      logger,
      durationToMs: (d) => d.value * 60_000,
    };

    const firstResult = await verifyTask(deps, makeTask(), {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      stopped_reason: "end_turn",
      session_id: "session-1",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      tokens_used: 0,
    });

    const secondResult = await verifyTask(deps, makeTask({ id: "task-2" }), {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      stopped_reason: "end_turn",
      session_id: "session-2",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      tokens_used: 0,
    });

    expect(firstResult.verdict).toBe("fail");
    expect(secondResult.verdict).toBe("pass");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("completion_judger"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("task task-1"));
  });
});
