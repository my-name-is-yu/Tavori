import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { ReportingEngine } from "../src/reporting-engine.js";
import { CapabilityDetector } from "../src/observation/capability-detector.js";
import type {
  Capability,
  CapabilityGap,
  CapabilityAcquisitionTask,
  AcquisitionContext,
} from "../src/types/capability.js";
import type { AgentResult } from "../src/execution/adapter-layer.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "cap-001",
    name: "Stripe API",
    description: "Access to Stripe payment API",
    type: "service",
    status: "available",
    ...overrides,
  };
}

function makeGap(overrides: Partial<CapabilityGap> = {}): CapabilityGap {
  return {
    missing_capability: { name: "Stripe API", type: "service" },
    reason: "Task requires Stripe payment data",
    alternatives: ["Use cached data", "Request CSV export"],
    impact_description: "Cannot fetch live payment data",
    related_task_id: "task-001",
    ...overrides,
  };
}

function makeAcquisitionTask(overrides: Partial<CapabilityAcquisitionTask> = {}): CapabilityAcquisitionTask {
  return {
    gap: makeGap(),
    method: "service_setup",
    task_description: "Set up the Stripe API service",
    success_criteria: ["capability registered in registry", "Stripe API is operational and accessible"],
    verification_attempts: 0,
    max_verification_attempts: 3,
    ...overrides,
  };
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    output: "Service configured successfully. Health check passed.",
    error: null,
    exit_code: 0,
    elapsed_ms: 1234,
    stopped_reason: "completed",
    ...overrides,
  };
}

const VERIFY_PASS_RESPONSE = JSON.stringify({ verdict: "pass", reason: "All checks passed successfully." });
const VERIFY_FAIL_RESPONSE = JSON.stringify({ verdict: "fail", reason: "Service did not respond to health check." });

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;
let reportingEngine: ReportingEngine;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-capability-test-"));
  stateManager = new StateManager(tempDir);
  reportingEngine = new ReportingEngine(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── verifyAcquiredCapability ───

describe("verifyAcquiredCapability", () => {
  it("returns 'pass' when LLM says verdict is pass", async () => {
    const llm = createMockLLMClient([VERIFY_PASS_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      makeAcquisitionTask(),
      makeAgentResult()
    );

    expect(result).toBe("pass");
  });

  it("returns 'fail' when LLM says fail and attempts < max", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 0, max_verification_attempts: 3 });
    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(result).toBe("fail");
  });

  it("returns 'escalate' when verification_attempts reaches max_verification_attempts after fail", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // At 2 attempts with max 3: after this fail it will be 3 which equals max → escalate
    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 2, max_verification_attempts: 3 });
    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(result).toBe("escalate");
  });

  it("returns 'escalate' when verification_attempts already exceeds max on fail", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 5, max_verification_attempts: 3 });
    const result = await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(result).toBe("escalate");
  });

  it("calls LLM exactly once per verifyAcquiredCapability call", async () => {
    const llm = createMockLLMClient([VERIFY_PASS_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.verifyAcquiredCapability(
      makeCapability(),
      makeAcquisitionTask(),
      makeAgentResult()
    );

    expect(llm.callCount).toBe(1);
  });

  it("increments verification_attempts on fail", async () => {
    const llm = createMockLLMClient([VERIFY_FAIL_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 0, max_verification_attempts: 3 });
    await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(acquisitionTask.verification_attempts).toBe(1);
  });

  it("does not increment verification_attempts on pass", async () => {
    const llm = createMockLLMClient([VERIFY_PASS_RESPONSE]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const acquisitionTask = makeAcquisitionTask({ verification_attempts: 0 });
    await detector.verifyAcquiredCapability(
      makeCapability(),
      acquisitionTask,
      makeAgentResult()
    );

    expect(acquisitionTask.verification_attempts).toBe(0);
  });
});

// ─── removeCapability ───

describe("removeCapability", () => {
  it("removes a capability from the registry by id", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-remove", name: "ToRemove" }));
    await detector.removeCapability("cap-remove");

    const registry = await detector.loadRegistry();
    expect(registry.capabilities.find((c) => c.id === "cap-remove")).toBeUndefined();
  });

  it("throws for a non-existent id", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await expect(detector.removeCapability("nonexistent-cap-id")).rejects.toThrow(
      'Capability with id "nonexistent-cap-id" not found'
    );
  });

  it("does not remove other capabilities when removing by id", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-a", name: "Cap A" }));
    await detector.registerCapability(makeCapability({ id: "cap-b", name: "Cap B" }));
    await detector.removeCapability("cap-a");

    const registry = await detector.loadRegistry();
    expect(registry.capabilities).toHaveLength(1);
    expect(registry.capabilities[0]!.id).toBe("cap-b");
  });

  it("persists the registry after removal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-persist", name: "Persistent Cap" }));
    await detector.removeCapability("cap-persist");

    // Reload registry from disk via a new detector instance sharing same stateManager
    const detector2 = new CapabilityDetector(stateManager, llm, reportingEngine);
    const registry = await detector2.loadRegistry();
    expect(registry.capabilities.find((c) => c.id === "cap-persist")).toBeUndefined();
  });
});

// ─── findCapabilityByName ───

describe("findCapabilityByName", () => {
  it("finds a capability by exact name", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-find", name: "Stripe API" }));
    const found = await detector.findCapabilityByName("Stripe API");

    expect(found).not.toBeNull();
    expect(found!.id).toBe("cap-find");
  });

  it("finds a capability case-insensitively (uppercase input)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-ci", name: "stripe api" }));
    const found = await detector.findCapabilityByName("STRIPE API");

    expect(found).not.toBeNull();
    expect(found!.id).toBe("cap-ci");
  });

  it("finds a capability case-insensitively (mixed case input)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-mixed", name: "GitHub API" }));
    const found = await detector.findCapabilityByName("github api");

    expect(found).not.toBeNull();
    expect(found!.id).toBe("cap-mixed");
  });

  it("returns null when no capability matches the name", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const found = await detector.findCapabilityByName("NonExistent Capability");
    expect(found).toBeNull();
  });

  it("returns null on empty registry", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const found = await detector.findCapabilityByName("anything");
    expect(found).toBeNull();
  });

  it("returns the first match when multiple capabilities share the same name (case-insensitively)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    await detector.registerCapability(makeCapability({ id: "cap-first", name: "Duplicate" }));
    await detector.registerCapability(makeCapability({ id: "cap-second", name: "duplicate" }));

    const found = await detector.findCapabilityByName("DUPLICATE");
    expect(found).not.toBeNull();
    // Should return the first registered match
    expect(found!.id).toBe("cap-first");
  });
});

// ─── registerCapability with context ───

describe("registerCapability with context", () => {
  const makeAcquisitionContext = (overrides: Partial<AcquisitionContext> = {}): AcquisitionContext => ({
    goal_id: "goal-001",
    originating_task_id: "task-001",
    acquired_at: "2026-03-15T00:00:00.000Z",
    notes: "Acquired during capability gap resolution",
    ...overrides,
  });

  it("works without context (backward compatible)", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-no-ctx", name: "No Context Cap" });
    await expect(detector.registerCapability(cap)).resolves.toBeUndefined();

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquisition_context).toBeUndefined();
    expect(registry.capabilities[0]!.acquired_at).toBeUndefined();
  });

  it("sets acquired_at on the capability when context is provided", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-ctx", name: "Context Cap" });
    const ctx = makeAcquisitionContext({ acquired_at: "2026-03-15T00:00:00.000Z" });
    await detector.registerCapability(cap, ctx);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquired_at).toBe("2026-03-15T00:00:00.000Z");
  });

  it("sets acquisition_context on the capability when context is provided", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-ctx2", name: "Context Cap 2" });
    const ctx = makeAcquisitionContext({ goal_id: "goal-ctx" });
    await detector.registerCapability(cap, ctx);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquisition_context).toEqual(ctx);
  });

  it("acquisition_context.goal_id is preserved correctly", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const cap = makeCapability({ id: "cap-goalid", name: "Goal ID Cap" });
    const ctx = makeAcquisitionContext({ goal_id: "goal-special-xyz" });
    await detector.registerCapability(cap, ctx);

    const registry = await detector.loadRegistry();
    expect(registry.capabilities[0]!.acquisition_context!.goal_id).toBe("goal-special-xyz");
  });
});

// ─── getAcquisitionHistory ───

describe("getAcquisitionHistory", () => {
  const makeAcquisitionContext = (goalId: string, overrides: Partial<AcquisitionContext> = {}): AcquisitionContext => ({
    goal_id: goalId,
    originating_task_id: "task-001",
    acquired_at: new Date().toISOString(),
    ...overrides,
  });

  it("returns contexts for capabilities acquired for the given goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const ctx = makeAcquisitionContext("goal-history");
    await detector.registerCapability(makeCapability({ id: "cap-h1", name: "History Cap 1" }), ctx);

    const history = await detector.getAcquisitionHistory("goal-history");
    expect(history).toHaveLength(1);
    expect(history[0]!.goal_id).toBe("goal-history");
  });

  it("returns multiple contexts when multiple capabilities share the same goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const ctx1 = makeAcquisitionContext("goal-multi");
    const ctx2 = makeAcquisitionContext("goal-multi");
    await detector.registerCapability(makeCapability({ id: "cap-m1", name: "Multi Cap 1" }), ctx1);
    await detector.registerCapability(makeCapability({ id: "cap-m2", name: "Multi Cap 2" }), ctx2);

    const history = await detector.getAcquisitionHistory("goal-multi");
    expect(history).toHaveLength(2);
  });

  it("returns empty array when no capabilities match the given goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const history = await detector.getAcquisitionHistory("goal-nonexistent");
    expect(history).toHaveLength(0);
  });

  it("returns empty array when registry is empty", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const history = await detector.getAcquisitionHistory("goal-any");
    expect(history).toEqual([]);
  });

  it("does not return contexts belonging to a different goal", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    const ctxA = makeAcquisitionContext("goal-a");
    const ctxB = makeAcquisitionContext("goal-b");
    await detector.registerCapability(makeCapability({ id: "cap-a", name: "Cap A" }), ctxA);
    await detector.registerCapability(makeCapability({ id: "cap-b", name: "Cap B" }), ctxB);

    const historyA = await detector.getAcquisitionHistory("goal-a");
    expect(historyA).toHaveLength(1);
    expect(historyA[0]!.goal_id).toBe("goal-a");
  });

  it("excludes capabilities that have no acquisition_context", async () => {
    const llm = createMockLLMClient([]);
    const detector = new CapabilityDetector(stateManager, llm, reportingEngine);

    // Register one without context, one with context for goal-x
    await detector.registerCapability(makeCapability({ id: "cap-no-ctx", name: "No Ctx" }));
    const ctx = makeAcquisitionContext("goal-x");
    await detector.registerCapability(makeCapability({ id: "cap-with-ctx", name: "With Ctx" }), ctx);

    // goal-x should only return the one with context
    const history = await detector.getAcquisitionHistory("goal-x");
    expect(history).toHaveLength(1);
    expect(history[0]!.goal_id).toBe("goal-x");
  });
});
