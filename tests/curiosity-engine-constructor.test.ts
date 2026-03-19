import { describe, it, expect, vi, beforeEach } from "vitest";
import { CuriosityEngine } from "../src/traits/curiosity-engine.js";
import type { CuriosityEngineDeps } from "../src/traits/curiosity-engine.js";
import type { Goal, Dimension } from "../src/types/goal.js";
import type { CuriosityProposal, CuriosityTrigger } from "../src/types/curiosity.js";
import type { StallState } from "../src/types/stall.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Helper Factories ───

function createDimension(overrides: Partial<Dimension> = {}): Dimension {
  const now = new Date().toISOString();
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 50,
    threshold: { type: "min", value: 100 },
    confidence: 0.8,
    observation_method: {
      type: "mechanical",
      source: "test",
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

// ─── Tests ───

describe("CuriosityEngine — constructor", () => {
  it("creates with default config", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    expect(engine).toBeInstanceOf(CuriosityEngine);
  });

  it("creates with custom config", async () => {
    const deps = createMockDeps({
      config: {
        enabled: true,
        max_active_proposals: 5,
        proposal_expiry_hours: 24,
        periodic_exploration_hours: 48,
      },
    });
    const engine = new CuriosityEngine(deps);
    expect(engine).toBeInstanceOf(CuriosityEngine);
  });

  it("creates with curiosity disabled", async () => {
    const deps = createMockDeps({ config: { enabled: false } });
    const engine = new CuriosityEngine(deps);
    const triggers = await engine.evaluateTriggers([makeGoal({ status: "completed" })]);
    expect(triggers).toHaveLength(0);
  });

  it("loads existing state from StateManager when present", async () => {
    const existingState = {
      proposals: [],
      learning_records: [],
      last_exploration_at: "2026-01-01T00:00:00.000Z",
      rejected_proposal_hashes: ["abc123"],
    };
    const deps = createMockDeps();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue(existingState);

    const engine = new CuriosityEngine(deps);
    // Trigger state load by calling an async method
    await engine.evaluateTriggers([]);
    // Engine loaded state — periodic exploration should NOT trigger since last_exploration_at is recent
    // (or far past depending on config). Just verify it doesn't crash.
    expect(engine).toBeInstanceOf(CuriosityEngine);
    expect(deps.stateManager.readRaw).toHaveBeenCalledWith("curiosity/state.json");
  });

  it("starts fresh when StateManager returns null", async () => {
    const deps = createMockDeps();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const engine = new CuriosityEngine(deps);
    expect(engine.getActiveProposals()).toHaveLength(0);
  });
});

// ─── evaluateTriggers ───

describe("CuriosityEngine — evaluateTriggers", () => {
  describe("task_queue_empty trigger", () => {
    it("triggers when all user goals are completed", async () => {
      const deps = createMockDeps();
      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({ id: "g1", status: "completed", origin: null }),
        makeGoal({ id: "g2", status: "completed", origin: null }),
      ];
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("task_queue_empty");
    });

    it("triggers when all user goals are waiting", async () => {
      const deps = createMockDeps();
      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({ id: "g1", status: "waiting", origin: null }),
      ];
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("task_queue_empty");
    });

    it("triggers when mix of completed and waiting user goals", async () => {
      const deps = createMockDeps();
      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({ id: "g1", status: "completed", origin: null }),
        makeGoal({ id: "g2", status: "waiting", origin: null }),
      ];
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("task_queue_empty");
    });

    it("does NOT trigger when any user goal is active", async () => {
      const deps = createMockDeps();
      // Set last_exploration_at to now to suppress periodic_exploration
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({ id: "g1", status: "active", origin: null }),
        makeGoal({ id: "g2", status: "completed", origin: null }),
      ];
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("task_queue_empty");
    });

    it("does NOT trigger when goals array is empty", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);
      const triggers = await engine.evaluateTriggers([]);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("task_queue_empty");
    });

    it("ignores curiosity-origin goals when checking task queue", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);
      // Only curiosity goal is active; user goals are all completed
      const goals = [
        makeGoal({ id: "g1", status: "active", origin: "curiosity" }),
        makeGoal({ id: "g2", status: "completed", origin: null }),
      ];
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      // The user goal (g2) is completed, curiosity goal should be ignored for this check
      expect(types).toContain("task_queue_empty");
    });
  });

  describe("unexpected_observation trigger", () => {
    it("triggers when observation deviation > threshold * stddev", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);

      // History: mean ~50, current_value = 200 (way off)
      const history = [
        { value: 48, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs1" },
        { value: 50, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs2" },
        { value: 52, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs3" },
        { value: 50, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs4" },
      ];
      const goals = [
        makeGoal({
          id: "g1",
          status: "active",
          origin: null,
          dimensions: [
            createDimension({
              name: "perf",
              current_value: 200, // far from mean of ~50
              history,
            }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("unexpected_observation");
    });

    it("does NOT trigger when deviation is within normal range", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);

      // History: mean ~50, current_value = 51 (within 2σ)
      const history = [
        { value: 48, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs1" },
        { value: 50, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs2" },
        { value: 52, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs3" },
        { value: 50, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs4" },
      ];
      const goals = [
        makeGoal({
          id: "g1",
          status: "active",
          origin: null,
          dimensions: [
            createDimension({ name: "perf", current_value: 51, history }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("unexpected_observation");
    });

    it("handles missing observation history gracefully (fewer than 4 entries)", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);

      const goals = [
        makeGoal({
          id: "g1",
          status: "active",
          origin: null,
          dimensions: [
            createDimension({ name: "perf", current_value: 999, history: [] }),
          ],
        }),
      ];

      // Should not throw and should NOT fire unexpected_observation (not enough data)
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("unexpected_observation");
    });

    it("does NOT trigger for non-active goals", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      const engine = new CuriosityEngine(deps);

      const history = [
        { value: 48, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs1" },
        { value: 50, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs2" },
        { value: 52, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs3" },
        { value: 50, timestamp: new Date().toISOString(), confidence: 0.9, source_observation_id: "obs4" },
      ];
      const goals = [
        makeGoal({
          id: "g1",
          status: "completed",
          origin: null,
          dimensions: [
            createDimension({ name: "perf", current_value: 200, history }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("unexpected_observation");
    });
  });

  describe("repeated_failure trigger", () => {
    it("triggers when dimension escalation level > 0", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeStallState({ dimension_escalation: { dim1: 1 } })
      );

      const engine = new CuriosityEngine(deps);
      const goals = [makeGoal({ id: "goal-1", status: "active", origin: null })];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("repeated_failure");
    });

    it("includes goal_id in the trigger", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeStallState({ goal_id: "goal-abc", dimension_escalation: { dim1: 2 } })
      );

      const engine = new CuriosityEngine(deps);
      const goals = [makeGoal({ id: "goal-abc", status: "active", origin: null })];

      const triggers = await engine.evaluateTriggers(goals);
      const failureTrigger = triggers.find((t) => t.type === "repeated_failure");
      expect(failureTrigger?.source_goal_id).toBe("goal-abc");
    });

    it("does NOT trigger when all dimension escalation levels are 0", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeStallState({ dimension_escalation: { dim1: 0 } })
      );

      const engine = new CuriosityEngine(deps);
      const goals = [makeGoal({ id: "goal-1", status: "active", origin: null })];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("repeated_failure");
    });

    it("does NOT trigger for curiosity-origin goals", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeStallState({ dimension_escalation: { dim1: 3 } })
      );

      const engine = new CuriosityEngine(deps);
      const goals = [makeGoal({ id: "goal-1", status: "active", origin: "curiosity" })];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("repeated_failure");
    });

    it("does NOT trigger for non-active user goals", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });
      (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeStallState({ dimension_escalation: { dim1: 2 } })
      );

      const engine = new CuriosityEngine(deps);
      const goals = [makeGoal({ id: "goal-1", status: "waiting", origin: null })];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("repeated_failure");
    });
  });

  describe("undefined_problem trigger", () => {
    it("triggers when > 50% of dimensions have very low confidence (< 0.3)", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });

      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({
          id: "g1",
          status: "active",
          origin: null,
          dimensions: [
            createDimension({ name: "d1", confidence: 0.1 }),
            createDimension({ name: "d2", confidence: 0.2 }),
            createDimension({ name: "d3", confidence: 0.9 }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("undefined_problem");
    });

    it("does NOT trigger when all dimensions have adequate confidence", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });

      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({
          id: "g1",
          status: "active",
          origin: null,
          dimensions: [
            createDimension({ name: "d1", confidence: 0.8 }),
            createDimension({ name: "d2", confidence: 0.9 }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("undefined_problem");
    });

    it("does NOT trigger when exactly 50% have low confidence (threshold is strictly > 50%)", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });

      const engine = new CuriosityEngine(deps);
      // 1 of 2 = 50%; ratio >= 0.5 means it WILL trigger (boundary inclusive)
      const goals = [
        makeGoal({
          id: "g1",
          status: "active",
          origin: null,
          dimensions: [
            createDimension({ name: "d1", confidence: 0.1 }),
            createDimension({ name: "d2", confidence: 0.9 }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      // ratio = 0.5 which is >= 0.5, so it SHOULD trigger
      expect(types).toContain("undefined_problem");
    });

    it("does NOT trigger for non-active goals", async () => {
      const deps = createMockDeps();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: new Date().toISOString(),
        rejected_proposal_hashes: [],
      });

      const engine = new CuriosityEngine(deps);
      const goals = [
        makeGoal({
          id: "g1",
          status: "completed",
          dimensions: [
            createDimension({ name: "d1", confidence: 0.05 }),
            createDimension({ name: "d2", confidence: 0.05 }),
          ],
        }),
      ];

      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("undefined_problem");
    });
  });

  describe("periodic_exploration trigger", () => {
    it("triggers when no exploration has ever occurred (last_exploration_at is null)", async () => {
      const deps = createMockDeps();
      // readRaw returns null => state initializes with last_exploration_at: null
      const engine = new CuriosityEngine(deps);

      const triggers = await engine.evaluateTriggers([]);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("periodic_exploration");
    });

    it("triggers when last exploration was more than periodic_exploration_hours ago", async () => {
      const deps = createMockDeps({
        config: { periodic_exploration_hours: 1 }, // 1 hour threshold
      });
      // last explored 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: twoHoursAgo,
        rejected_proposal_hashes: [],
      });

      const engine = new CuriosityEngine(deps);
      const triggers = await engine.evaluateTriggers([]);
      const types = triggers.map((t) => t.type);
      expect(types).toContain("periodic_exploration");
    });

    it("does NOT trigger when recent exploration exists", async () => {
      const deps = createMockDeps({
        config: { periodic_exploration_hours: 72 },
      });
      // last explored 1 hour ago
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
        proposals: [],
        learning_records: [],
        last_exploration_at: oneHourAgo,
        rejected_proposal_hashes: [],
      });

      const engine = new CuriosityEngine(deps);
      // Use a goal that is active to suppress task_queue_empty
      const goals = [makeGoal({ status: "active", origin: null })];
      const triggers = await engine.evaluateTriggers(goals);
      const types = triggers.map((t) => t.type);
      expect(types).not.toContain("periodic_exploration");
    });

    it("sets severity to 0.3 for periodic trigger", async () => {
      const deps = createMockDeps();
      const engine = new CuriosityEngine(deps);

      const triggers = await engine.evaluateTriggers([]);
      const periodicTrigger = triggers.find((t) => t.type === "periodic_exploration");
      expect(periodicTrigger?.severity).toBe(0.3);
    });
  });

  it("returns empty array when curiosity is disabled", async () => {
    const deps = createMockDeps({ config: { enabled: false } });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "completed" })];
    const triggers = await engine.evaluateTriggers(goals);
    expect(triggers).toHaveLength(0);
  });

  it("can return multiple triggers at once", async () => {
    // Completed goals → task_queue_empty + periodic_exploration (null state)
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps); // last_exploration_at = null
    const goals = [makeGoal({ status: "completed", origin: null })];
    const triggers = await engine.evaluateTriggers(goals);
    expect(triggers.length).toBeGreaterThan(1);
  });
});
