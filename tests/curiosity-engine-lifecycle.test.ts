import { describe, it, expect, vi, beforeEach } from "vitest";
import { CuriosityEngine } from "../src/traits/curiosity-engine.js";
import type { CuriosityEngineDeps } from "../src/traits/curiosity-engine.js";
import type { CuriosityProposal } from "../src/types/curiosity.js";
import type { StallState } from "../src/types/stall.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Helper Factories ───

function createProposal(overrides: Partial<CuriosityProposal> = {}): CuriosityProposal {
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  return {
    id: "proposal-1",
    trigger: {
      type: "periodic_exploration",
      detected_at: now.toISOString(),
      source_goal_id: null,
      details: "Test trigger",
      severity: 0.3,
    },
    proposed_goal: {
      description: "Explore test domain",
      rationale: "Because reasons",
      suggested_dimensions: [],
      scope_domain: "test",
      detection_method: "llm_heuristic",
    },
    status: "pending",
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    reviewed_at: null,
    rejection_cooldown_until: null,
    loop_count: 0,
    goal_id: null,
    ...overrides,
  };
}

function makeStallState(overrides: Partial<StallState> = {}): StallState {
  return {
    goal_id: "goal-1",
    dimension_escalation: {},
    global_escalation: 0,
    decay_factors: {},
    recovery_loops: {},
    ...overrides,
  };
}

const DEFAULT_RESOURCE_BUDGET = {
  active_user_goals_max_percent: 20,
  waiting_user_goals_max_percent: 50,
};

const DEFAULT_CONFIG = {
  enabled: true,
  max_active_proposals: 3,
  proposal_expiry_hours: 12,
  rejection_cooldown_hours: 168,
  unproductive_loop_limit: 3,
  periodic_exploration_hours: 72,
  resource_budget: DEFAULT_RESOURCE_BUDGET,
  unexpected_observation_threshold: 2.0,
};

function createMockDeps(overrides: Partial<CuriosityEngineDeps> = {}): CuriosityEngineDeps {
  const stateManager = {
    readRaw: vi.fn().mockResolvedValue(null),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    loadGoal: vi.fn().mockResolvedValue(null),
    saveGoal: vi.fn().mockResolvedValue(undefined),
  } as any;

  const llmClient = {
    sendMessage: vi.fn().mockResolvedValue({ content: "[]" }),
    parseJSON: vi.fn().mockReturnValue([]),
  } as any;

  const ethicsGate = {
    check: vi.fn().mockResolvedValue({ verdict: "pass" }),
  } as any;

  const satisficingJudge = {
    judgeCompletion: vi.fn(),
  } as any;

  const stallDetector = {
    getStallState: vi.fn().mockResolvedValue(makeStallState()),
  } as any;

  const observationEngine = {
    observe: vi.fn(),
  } as any;

  const driveSystem = {
    schedule: vi.fn(),
  } as any;

  const { config: configOverride, ...restOverrides } = overrides;
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...(configOverride ?? {}),
    resource_budget: {
      ...DEFAULT_RESOURCE_BUDGET,
      ...((configOverride as any)?.resource_budget ?? {}),
    },
  };

  return {
    stateManager,
    llmClient,
    ethicsGate,
    satisficingJudge,
    stallDetector,
    observationEngine,
    driveSystem,
    config: mergedConfig,
    ...restOverrides,
  };
}

// ─── Auto-Expiration ───

describe("CuriosityEngine — auto-expiration", () => {
  it("expires pending proposals past expires_at", async () => {
    const deps = createMockDeps();
    const pastDate = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    const expiredProposal = createProposal({
      status: "pending",
      expires_at: pastDate,
    });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [expiredProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    const changed = engine.checkAutoExpiration();
    expect(changed).toHaveLength(1);
    expect(changed[0]!.status).toBe("expired");
  });

  it("auto-closes approved proposals at or past unproductive_loop_limit", async () => {
    const deps = createMockDeps({
      config: { unproductive_loop_limit: 3 },
    });
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const approvedProposal = createProposal({
      status: "approved",
      expires_at: futureDate,
      loop_count: 3, // equals limit
    });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [approvedProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    const changed = engine.checkAutoExpiration();
    expect(changed).toHaveLength(1);
    expect(changed[0]!.status).toBe("auto_closed");
  });

  it("does NOT expire recently created proposals", async () => {
    const deps = createMockDeps();
    const futureDate = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const freshProposal = createProposal({
      status: "pending",
      expires_at: futureDate,
    });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [freshProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    const changed = engine.checkAutoExpiration();
    expect(changed).toHaveLength(0);
  });

  it("does NOT close productive approved proposals below the loop limit", async () => {
    const deps = createMockDeps({
      config: { unproductive_loop_limit: 5 },
    });
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const productiveProposal = createProposal({
      status: "approved",
      expires_at: futureDate,
      loop_count: 2, // below limit of 5
    });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [productiveProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    const changed = engine.checkAutoExpiration();
    expect(changed).toHaveLength(0);
  });

  it("saves state when proposals were changed", async () => {
    const deps = createMockDeps();
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const expiredProposal = createProposal({ status: "pending", expires_at: pastDate });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [expiredProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    const writeCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.checkAutoExpiration();
    const writeCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writeCountAfter).toBeGreaterThan(writeCountBefore);
  });

  it("does NOT save state when no proposals were changed", async () => {
    const deps = createMockDeps();
    // No proposals at all
    const engine = new CuriosityEngine(deps);
    const writeCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.checkAutoExpiration();
    const writeCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writeCountAfter).toBe(writeCountBefore);
  });

  it("returns list of all changed proposals", async () => {
    const deps = createMockDeps({ config: { unproductive_loop_limit: 2 } });
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [
        createProposal({ id: "p1", status: "pending", expires_at: pastDate }),
        createProposal({ id: "p2", status: "approved", expires_at: futureDate, loop_count: 2 }),
        createProposal({ id: "p3", status: "pending", expires_at: futureDate }),
      ],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    const changed = engine.checkAutoExpiration();
    expect(changed).toHaveLength(2);
    const changedIds = changed.map((p) => p.id);
    expect(changedIds).toContain("p1");
    expect(changedIds).toContain("p2");
  });
});

// ─── incrementLoopCount ───

describe("CuriosityEngine — incrementLoopCount", () => {
  it("increments loop count for matching approved proposal by goal_id", async () => {
    const deps = createMockDeps();
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const approvedProposal = createProposal({
      id: "p1",
      status: "approved",
      expires_at: futureDate,
      loop_count: 0,
      goal_id: "g-curiosity-1",
    });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [approvedProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    engine.incrementLoopCount("g-curiosity-1");

    const active = engine.getActiveProposals();
    const updated = active.find((p) => p.id === "p1");
    expect(updated?.loop_count).toBe(1);
  });

  it("does nothing for non-matching goal_id", async () => {
    const deps = createMockDeps();
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const approvedProposal = createProposal({
      id: "p1",
      status: "approved",
      expires_at: futureDate,
      loop_count: 0,
      goal_id: "g-curiosity-1",
    });
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [approvedProposal],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    engine.incrementLoopCount("g-other");

    const active = engine.getActiveProposals();
    const updated = active.find((p) => p.id === "p1");
    expect(updated?.loop_count).toBe(0);
  });

  it("does not save state when no proposal was changed", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps); // no proposals loaded
    const writeCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.incrementLoopCount("nonexistent-goal");
    const writeCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writeCountAfter).toBe(writeCountBefore);
  });

  it("saves state after incrementing", async () => {
    const deps = createMockDeps();
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [
        createProposal({
          id: "p1",
          status: "approved",
          expires_at: futureDate,
          goal_id: "g-target",
          loop_count: 0,
        }),
      ],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    const writeCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.incrementLoopCount("g-target");
    const writeCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writeCountAfter).toBeGreaterThan(writeCountBefore);
  });

  it("only increments proposals with status approved (not pending)", async () => {
    const deps = createMockDeps();
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [
        createProposal({
          id: "p1",
          status: "pending",
          expires_at: futureDate,
          goal_id: "g-target",
          loop_count: 0,
        }),
      ],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    engine.incrementLoopCount("g-target");

    // Pending proposals should not have loop count modified
    const active = engine.getActiveProposals();
    const pendingProposal = active.find((p) => p.id === "p1");
    expect(pendingProposal?.loop_count).toBe(0);
  });
});

// ─── recordLearning ───

describe("CuriosityEngine — recordLearning", () => {
  it("adds a learning record with timestamp", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);

    const before = Date.now();
    engine.recordLearning({
      goal_id: "g1",
      dimension_name: "test_coverage",
      approach: "unit tests",
      outcome: "success",
      improvement_ratio: 0.8,
    });
    const after = Date.now();

    // We can't directly read state, but we can verify saveState was called
    expect(deps.stateManager.writeRaw).toHaveBeenCalled();
    const writtenState = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as any;
    expect(writtenState.learning_records).toHaveLength(1);
    const record = writtenState.learning_records[0];
    expect(record.goal_id).toBe("g1");
    expect(record.dimension_name).toBe("test_coverage");
    expect(record.approach).toBe("unit tests");
    expect(record.outcome).toBe("success");
    expect(record.improvement_ratio).toBe(0.8);
    const recordedTime = new Date(record.recorded_at).getTime();
    expect(recordedTime).toBeGreaterThanOrEqual(before);
    expect(recordedTime).toBeLessThanOrEqual(after);
  });

  it("saves state after recording", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    const writeCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.recordLearning({
      goal_id: "g1",
      dimension_name: "dim",
      approach: "approach",
      outcome: "failure",
      improvement_ratio: -0.2,
    });
    const writeCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writeCountAfter).toBeGreaterThan(writeCountBefore);
  });

  it("accumulates multiple learning records", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);

    engine.recordLearning({ goal_id: "g1", dimension_name: "d1", approach: "a1", outcome: "success", improvement_ratio: 0.5 });
    engine.recordLearning({ goal_id: "g2", dimension_name: "d2", approach: "a2", outcome: "failure", improvement_ratio: -0.1 });

    const writtenState = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as any;
    expect(writtenState.learning_records).toHaveLength(2);
  });

  it("accepts all valid outcome values", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);

    expect(() =>
      engine.recordLearning({ goal_id: "g", dimension_name: "d", approach: "a", outcome: "partial", improvement_ratio: 0.3 })
    ).not.toThrow();
  });

  it("automatically sets recorded_at (does not use caller-supplied value)", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    const before = Date.now();
    engine.recordLearning({ goal_id: "g", dimension_name: "d", approach: "a", outcome: "success", improvement_ratio: 1.0 });
    const after = Date.now();

    const writtenState = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as any;
    const record = writtenState.learning_records[0];
    const recordedTime = new Date(record.recorded_at).getTime();
    expect(recordedTime).toBeGreaterThanOrEqual(before);
    expect(recordedTime).toBeLessThanOrEqual(after);
  });
});
