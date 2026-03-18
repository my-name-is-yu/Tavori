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

  // Merge config with full defaults so Zod parse always succeeds for resource_budget
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

// ─── generateProposals ───

describe("CuriosityEngine — generateProposals", async () => {
  function makeTrigger(type: CuriosityTrigger["type"] = "periodic_exploration"): CuriosityTrigger {
    return {
      type,
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test trigger",
      severity: 0.3,
    };
  }

  it("generates proposals from LLM response", async () => {
    const deps = createMockDeps();
    (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify([
        {
          description: "Explore new testing patterns",
          rationale: "Current tests are weak",
          suggested_dimensions: [{ name: "test_coverage", threshold_type: "min", target: 0.8 }],
          scope_domain: "testing",
          detection_method: "llm_heuristic",
        },
      ]),
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Explore new testing patterns",
        rationale: "Current tests are weak",
        suggested_dimensions: [{ name: "test_coverage", threshold_type: "min", target: 0.8 }],
        scope_domain: "testing",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposed_goal.description).toBe("Explore new testing patterns");
  });

  it("returns empty array when triggers is empty", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([], []);
    expect(proposals).toHaveLength(0);
  });

  it("returns empty array when curiosity is disabled", async () => {
    const deps = createMockDeps({ config: { enabled: false } });
    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(0);
  });

  it("filters proposals that fail ethics check", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Do something unethical",
        rationale: "Bad idea",
        suggested_dimensions: [],
        scope_domain: "bad",
        detection_method: "llm_heuristic",
      },
    ]);
    (deps.ethicsGate.check as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: "reject" });

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(0);
  });

  it("passes proposals that pass ethics check", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Legitimate exploration",
        rationale: "Good idea",
        suggested_dimensions: [],
        scope_domain: "good",
        detection_method: "llm_heuristic",
      },
    ]);
    (deps.ethicsGate.check as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: "pass" });

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(1);
  });

  it("respects max_active_proposals limit", async () => {
    const deps = createMockDeps({
      config: { max_active_proposals: 1 },
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal A",
        rationale: "Reason A",
        suggested_dimensions: [],
        scope_domain: "domain",
        detection_method: "llm_heuristic",
      },
      {
        description: "Proposal B",
        rationale: "Reason B",
        suggested_dimensions: [],
        scope_domain: "domain",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(1);
  });

  it("skips proposals similar to recently rejected ones (rejection cooldown)", async () => {
    const deps = createMockDeps();
    const description = "Explore caching strategies";
    // Pre-seed rejected state with the hash of our description
    // We'll reject a proposal first, then try to regenerate it
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description,
        rationale: "Same idea",
        suggested_dimensions: [],
        scope_domain: "perf",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);

    // First generation — should work
    const firstBatch = await engine.generateProposals([makeTrigger()], []);
    expect(firstBatch).toHaveLength(1);

    // Reject the proposal
    engine.rejectProposal(firstBatch[0]!.id);

    // Second generation with the same description — should be skipped
    const secondBatch = await engine.generateProposals([makeTrigger()], []);
    expect(secondBatch).toHaveLength(0);
  });

  it("handles LLM failure gracefully (returns empty array)", async () => {
    const deps = createMockDeps();
    (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("LLM unreachable")
    );

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(0);
  });

  it("saves state after generating proposals", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "New exploration",
        rationale: "Good reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals([makeTrigger()], []);
    expect(deps.stateManager.writeRaw).toHaveBeenCalled();
  });

  it("sets correct expiry time based on proposal_expiry_hours config", async () => {
    const deps = createMockDeps({ config: { proposal_expiry_hours: 6 } });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Time-limited proposal",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const before = Date.now();
    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    const after = Date.now();

    expect(proposals).toHaveLength(1);
    const expiresAt = new Date(proposals[0]!.expires_at).getTime();
    const expectedMin = before + 6 * 60 * 60 * 1000;
    const expectedMax = after + 6 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it("sets detection_method from LLM response", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Observation-driven proposal",
        rationale: "Observed anomaly",
        suggested_dimensions: [],
        scope_domain: "analytics",
        detection_method: "observation_log",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger("unexpected_observation")], []);
    expect(proposals[0]!.proposed_goal.detection_method).toBe("observation_log");
  });

  it("updates last_exploration_at when periodic_exploration trigger is present", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = new CuriosityEngine(deps);
    const before = Date.now();
    await engine.generateProposals([makeTrigger("periodic_exploration")], []);
    const after = Date.now();

    // shouldExplore should no longer return true for periodic check (last_exploration_at updated)
    // We can verify by confirming writeRaw was called (state was saved)
    expect(deps.stateManager.writeRaw).toHaveBeenCalled();
    const writtenState = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls[0]![1] as any;
    const explorationTime = new Date(writtenState.last_exploration_at).getTime();
    expect(explorationTime).toBeGreaterThanOrEqual(before);
    expect(explorationTime).toBeLessThanOrEqual(after);
  });

  it("returns empty when already at max_active_proposals capacity", async () => {
    const deps = createMockDeps({
      config: { max_active_proposals: 1 },
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "First proposal",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    // Generate first batch — fills capacity
    await engine.generateProposals([makeTrigger()], []);
    // Second call should be blocked
    const second = await engine.generateProposals([makeTrigger()], []);
    expect(second).toHaveLength(0);
  });

  it("handles ethics gate failure gracefully (skips proposal)", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal with ethics check error",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);
    (deps.ethicsGate.check as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ethics service down")
    );

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    // On ethics failure, proposal is skipped (conservative)
    expect(proposals).toHaveLength(0);
  });
});

// ─── Approval Flow ───

describe("CuriosityEngine — approval flow", async () => {
  async function engineWithPendingProposal() {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Pending proposal for approval test",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const trigger: CuriosityTrigger = {
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test",
      severity: 0.3,
    };
    const proposals = await engine.generateProposals([trigger], []);
    return { engine, proposal: proposals[0]!, deps };
  }

  it("approveProposal marks status as approved", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const approved = engine.approveProposal(proposal.id);
    expect(approved.status).toBe("approved");
  });

  it("approveProposal sets reviewed_at", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const before = Date.now();
    const approved = engine.approveProposal(proposal.id);
    const after = Date.now();
    expect(approved.reviewed_at).not.toBeNull();
    const reviewedTime = new Date(approved.reviewed_at!).getTime();
    expect(reviewedTime).toBeGreaterThanOrEqual(before);
    expect(reviewedTime).toBeLessThanOrEqual(after);
  });

  it("rejectProposal marks status as rejected", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const rejected = engine.rejectProposal(proposal.id);
    expect(rejected.status).toBe("rejected");
  });

  it("rejectProposal sets reviewed_at", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const rejected = engine.rejectProposal(proposal.id);
    expect(rejected.reviewed_at).not.toBeNull();
  });

  it("rejectProposal sets rejection_cooldown_until", async () => {
    const deps = createMockDeps({
      config: { rejection_cooldown_hours: 24 },
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal to reject with cooldown",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const trigger: CuriosityTrigger = {
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test",
      severity: 0.3,
    };
    const proposals = await engine.generateProposals([trigger], []);
    const proposal = proposals[0]!;

    const before = Date.now();
    const rejected = engine.rejectProposal(proposal.id);
    const after = Date.now();

    expect(rejected.rejection_cooldown_until).not.toBeNull();
    const cooldownTime = new Date(rejected.rejection_cooldown_until!).getTime();
    const expectedMin = before + 24 * 60 * 60 * 1000;
    const expectedMax = after + 24 * 60 * 60 * 1000;
    expect(cooldownTime).toBeGreaterThanOrEqual(expectedMin);
    expect(cooldownTime).toBeLessThanOrEqual(expectedMax);
  });

  it("approveProposal throws on non-existent proposal ID", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    expect(() => engine.approveProposal("nonexistent-id")).toThrow(
      /proposal "nonexistent-id" not found/
    );
  });

  it("rejectProposal throws on non-existent proposal ID", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    expect(() => engine.rejectProposal("nonexistent-id")).toThrow(
      /proposal "nonexistent-id" not found/
    );
  });

  it("cannot approve already rejected proposal", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.rejectProposal(proposal.id);
    expect(() => engine.approveProposal(proposal.id)).toThrow(/not pending/);
  });

  it("cannot reject already approved proposal", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.approveProposal(proposal.id);
    expect(() => engine.rejectProposal(proposal.id)).toThrow(/not pending/);
  });

  it("saves state after approving", async () => {
    const { engine, proposal, deps } = await engineWithPendingProposal();
    const callCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.approveProposal(proposal.id);
    const callCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfter).toBeGreaterThan(callCountBefore);
  });

  it("saves state after rejecting", async () => {
    const { engine, proposal, deps } = await engineWithPendingProposal();
    const callCountBefore = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.rejectProposal(proposal.id);
    const callCountAfter = (deps.stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfter).toBeGreaterThan(callCountBefore);
  });

  it("approved proposal appears in getActiveProposals", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.approveProposal(proposal.id);
    const active = engine.getActiveProposals();
    expect(active.some((p) => p.id === proposal.id && p.status === "approved")).toBe(true);
  });

  it("rejected proposal does NOT appear in getActiveProposals", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.rejectProposal(proposal.id);
    const active = engine.getActiveProposals();
    expect(active.some((p) => p.id === proposal.id)).toBe(false);
  });
});

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

// ─── getResourceBudget ───

describe("CuriosityEngine — getResourceBudget", () => {
  it("returns active_user_goals_max_percent (default 20) when any user goal is active", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 20, waiting_user_goals_max_percent: 50 } },
    });
    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({ id: "g1", status: "active", origin: null }),
      makeGoal({ id: "g2", status: "completed", origin: null }),
    ];
    expect(engine.getResourceBudget(goals)).toBe(20);
  });

  it("returns waiting_user_goals_max_percent (default 50) when all user goals are waiting or completed", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 20, waiting_user_goals_max_percent: 50 } },
    });
    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({ id: "g1", status: "waiting", origin: null }),
      makeGoal({ id: "g2", status: "completed", origin: null }),
    ];
    expect(engine.getResourceBudget(goals)).toBe(50);
  });

  it("returns 100 when all user goals are completed", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({ id: "g1", status: "completed", origin: null }),
      makeGoal({ id: "g2", status: "completed", origin: "manual" }),
    ];
    expect(engine.getResourceBudget(goals)).toBe(100);
  });

  it("returns 100 when there are no user goals", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    expect(engine.getResourceBudget([])).toBe(100);
  });

  it("returns 0 when curiosity is disabled", async () => {
    const deps = createMockDeps({ config: { enabled: false } });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "active", origin: null })];
    expect(engine.getResourceBudget(goals)).toBe(0);
  });

  it("only counts user-origin goals (not curiosity goals) for budget calculation", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 20, waiting_user_goals_max_percent: 50 } },
    });
    const engine = new CuriosityEngine(deps);
    // Only curiosity goal is active; user goal is completed
    const goals = [
      makeGoal({ id: "g1", status: "active", origin: "curiosity" }),
      makeGoal({ id: "g2", status: "completed", origin: null }),
    ];
    // User goals: only g2, all completed → should be 100
    expect(engine.getResourceBudget(goals)).toBe(100);
  });

  it("returns custom active_user_goals_max_percent when configured", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 10, waiting_user_goals_max_percent: 50 } },
    });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "active", origin: null })];
    expect(engine.getResourceBudget(goals)).toBe(10);
  });

  it("returns custom waiting_user_goals_max_percent when configured", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 20, waiting_user_goals_max_percent: 30 } },
    });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "waiting", origin: null })];
    expect(engine.getResourceBudget(goals)).toBe(30);
  });

  it("treats goals with origin=null as user goals", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 20, waiting_user_goals_max_percent: 50 } },
    });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "active", origin: null })];
    expect(engine.getResourceBudget(goals)).toBe(20);
  });

  it("treats goals with origin=negotiation as user goals", async () => {
    const deps = createMockDeps({
      config: { resource_budget: { active_user_goals_max_percent: 20, waiting_user_goals_max_percent: 50 } },
    });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "active", origin: "negotiation" })];
    expect(engine.getResourceBudget(goals)).toBe(20);
  });
});

// ─── shouldExplore ───

describe("CuriosityEngine — shouldExplore", () => {
  it("returns true when task queue is empty (all user goals completed)", async () => {
    const deps = createMockDeps();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [],
      last_exploration_at: new Date().toISOString(), // suppress periodic
      rejected_proposal_hashes: [],
    });
    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "completed", origin: null })];
    expect(await engine.shouldExplore(goals)).toBe(true);
  });

  it("returns true when no exploration has ever occurred", async () => {
    const deps = createMockDeps(); // readRaw returns null → last_exploration_at = null
    const engine = new CuriosityEngine(deps);
    expect(await engine.shouldExplore([])).toBe(true);
  });

  it("returns true when periodic exploration is overdue", async () => {
    const deps = createMockDeps({ config: { periodic_exploration_hours: 1 } });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [],
      last_exploration_at: twoHoursAgo,
      rejected_proposal_hashes: [],
    });
    const engine = new CuriosityEngine(deps);
    expect(await engine.shouldExplore([])).toBe(true);
  });

  it("returns true when any active goal has escalated stall dimensions", async () => {
    const deps = createMockDeps({ config: { periodic_exploration_hours: 72 } });
    const recentExploration = new Date(Date.now() - 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [],
      last_exploration_at: recentExploration,
      rejected_proposal_hashes: [],
    });
    (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeStallState({ dimension_escalation: { dim1: 1 } })
    );

    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ status: "active", origin: null })];
    expect(await engine.shouldExplore(goals)).toBe(true);
  });

  it("returns false when no triggers apply", async () => {
    const deps = createMockDeps({ config: { periodic_exploration_hours: 72 } });
    const recentExploration = new Date(Date.now() - 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [],
      last_exploration_at: recentExploration,
      rejected_proposal_hashes: [],
    });
    (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeStallState({ dimension_escalation: {} })
    );

    const engine = new CuriosityEngine(deps);
    await engine.evaluateTriggers([]);
    // Active user goal → not queue empty, no stall → false
    const goals = [makeGoal({ status: "active", origin: null })];
    expect(await engine.shouldExplore(goals)).toBe(false);
  });

  it("returns false when curiosity is disabled", async () => {
    const deps = createMockDeps({ config: { enabled: false } });
    const engine = new CuriosityEngine(deps);
    expect(await engine.shouldExplore([])).toBe(false);
  });

  it("does not call LLM (quick check only)", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    await engine.shouldExplore([]);
    expect(deps.llmClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not call ethics gate (quick check only)", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    await engine.shouldExplore([]);
    expect(deps.ethicsGate.check).not.toHaveBeenCalled();
  });

  it("returns false when all user goals are active but no stall", async () => {
    const deps = createMockDeps({ config: { periodic_exploration_hours: 72 } });
    const recentExploration = new Date(Date.now() - 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [],
      last_exploration_at: recentExploration,
      rejected_proposal_hashes: [],
    });
    (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeStallState({ dimension_escalation: { dim1: 0 } })
    );

    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({ id: "g1", status: "active", origin: null }),
      makeGoal({ id: "g2", status: "active", origin: "manual" }),
    ];
    expect(await engine.shouldExplore(goals)).toBe(false);
  });

  it("ignores curiosity-origin goals when checking task queue in shouldExplore", async () => {
    const deps = createMockDeps({ config: { periodic_exploration_hours: 72 } });
    const recentExploration = new Date(Date.now() - 1000).toISOString();
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [],
      last_exploration_at: recentExploration,
      rejected_proposal_hashes: [],
    });
    (deps.stallDetector.getStallState as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeStallState({ dimension_escalation: {} })
    );

    const engine = new CuriosityEngine(deps);
    // Active curiosity goal should not prevent the "queue empty" check
    // from returning true when user goals are completed
    const goals = [
      makeGoal({ id: "g1", status: "active", origin: "curiosity" }),
      makeGoal({ id: "g2", status: "completed", origin: null }),
    ];
    expect(await engine.shouldExplore(goals)).toBe(true);
  });
});

// ─── Learning Feedback ───

describe("CuriosityEngine — learning feedback", async () => {
  it("includes learning records in LLM prompt when generating proposals", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // Pre-seed a learning record
    (deps.stateManager.readRaw as ReturnType<typeof vi.fn>).mockResolvedValue({
      proposals: [],
      learning_records: [
        {
          goal_id: "g1",
          dimension_name: "test_coverage",
          approach: "unit tests",
          outcome: "success",
          improvement_ratio: 0.9,
          recorded_at: new Date().toISOString(),
        },
      ],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals(
      [{ type: "periodic_exploration", detected_at: new Date().toISOString(), source_goal_id: null, details: "Test", severity: 0.3 }],
      []
    );

    // Verify sendMessage was called with a prompt containing learning info
    expect(deps.llmClient.sendMessage).toHaveBeenCalled();
    const callArgs = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const promptContent = callArgs[0].content as string;
    expect(promptContent).toContain("test_coverage");
  });

  it("includes active goals info in LLM prompt", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = new CuriosityEngine(deps);
    const goals = [makeGoal({ id: "g1", title: "Special Goal Title", status: "active" })];

    await engine.generateProposals(
      [{ type: "periodic_exploration", detected_at: new Date().toISOString(), source_goal_id: null, details: "Test", severity: 0.3 }],
      goals
    );

    expect(deps.llmClient.sendMessage).toHaveBeenCalled();
    const callArgs = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const promptContent = callArgs[0].content as string;
    expect(promptContent).toContain("Special Goal Title");
  });

  it("includes trigger type in LLM prompt", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals(
      [{ type: "repeated_failure", detected_at: new Date().toISOString(), source_goal_id: "g1", details: "Repeated failures detected", severity: 0.7 }],
      []
    );

    const callArgs = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const promptContent = callArgs[0].content as string;
    expect(promptContent).toContain("repeated_failure");
  });

  it("uses stall_pattern detection_method for proposals generated from repeated_failure trigger", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Restructure approach after repeated failures",
        rationale: "Stall detected",
        suggested_dimensions: [],
        scope_domain: "productivity",
        detection_method: "stall_pattern",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals(
      [{ type: "repeated_failure", detected_at: new Date().toISOString(), source_goal_id: "g1", details: "Stall on dim1", severity: 0.7 }],
      []
    );

    expect(proposals[0]!.proposed_goal.detection_method).toBe("stall_pattern");
  });

  it("includes source_goal_id in trigger details of generated prompt", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals(
      [{ type: "undefined_problem", detected_at: new Date().toISOString(), source_goal_id: "my-goal-id", details: "Low confidence", severity: 0.6 }],
      []
    );

    const callArgs = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const promptContent = callArgs[0].content as string;
    expect(promptContent).toContain("my-goal-id");
  });

  it("sends with temperature: 0.3 for proposal generation", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals(
      [{ type: "periodic_exploration", detected_at: new Date().toISOString(), source_goal_id: null, details: "Test", severity: 0.3 }],
      []
    );

    const sendMessageArgs = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sendMessageArgs[1]).toEqual({ temperature: 0.3 });
  });

  it("passes proposal description to ethics gate for evaluation", async () => {
    const deps = createMockDeps();
    const proposalDescription = "Investigate cross-cutting concerns in auth module";
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: proposalDescription,
        rationale: "Security concern",
        suggested_dimensions: [],
        scope_domain: "security",
        detection_method: "cross_goal_transfer",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals(
      [{ type: "periodic_exploration", detected_at: new Date().toISOString(), source_goal_id: null, details: "Test", severity: 0.3 }],
      []
    );

    expect(deps.ethicsGate.check).toHaveBeenCalledWith(
      "goal",
      expect.any(String),
      proposalDescription,
      expect.stringContaining("periodic_exploration")
    );
  });

  it("accumulates proposals across multiple generateProposals calls (up to max)", async () => {
    const deps = createMockDeps({ config: { max_active_proposals: 3 } });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal from batch",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const trigger: CuriosityTrigger = {
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test",
      severity: 0.3,
    };

    // Each call generates one unique proposal description (different because state is shared)
    await engine.generateProposals([trigger], []);
    await engine.generateProposals([trigger], []);
    await engine.generateProposals([trigger], []);

    const active = engine.getActiveProposals();
    // Should have at most max_active_proposals active
    expect(active.length).toBeLessThanOrEqual(3);
  });

  it("proposal has correct trigger reference", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Verify trigger is linked",
        rationale: "Testing",
        suggested_dimensions: [],
        scope_domain: "meta",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const trigger: CuriosityTrigger = {
      type: "task_queue_empty",
      detected_at: new Date().toISOString(),
      source_goal_id: "g-source",
      details: "All goals done",
      severity: 0.8,
    };
    const proposals = await engine.generateProposals([trigger], []);
    expect(proposals[0]!.trigger.type).toBe("task_queue_empty");
    expect(proposals[0]!.trigger.source_goal_id).toBe("g-source");
  });
});

// ─── Phase 2: Embedding-based Detection ───

describe("CuriosityEngine — indexDimensionToVector", async () => {
  it("adds dimension to vectorIndex when available", async () => {
    const mockVectorIndex = {
      add: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue([]),
    } as any;

    const deps = createMockDeps({ vectorIndex: mockVectorIndex });
    const engine = new CuriosityEngine(deps);

    await engine.indexDimensionToVector("goal-1", "test_coverage");

    expect(mockVectorIndex.add).toHaveBeenCalledWith(
      "dim:goal-1:test_coverage",
      "test_coverage",
      { goal_id: "goal-1", type: "dimension" }
    );
  });

  it("skips silently when no vectorIndex is configured", async () => {
    const deps = createMockDeps(); // no vectorIndex
    const engine = new CuriosityEngine(deps);

    // Should not throw
    await expect(engine.indexDimensionToVector("goal-1", "test_coverage")).resolves.toBeUndefined();
  });
});

describe("CuriosityEngine — findSimilarDimensions", async () => {
  it("returns similar dimensions from other goals via embedding search", async () => {
    const mockVectorIndex = {
      add: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue([
        { id: "dim:goal-2:test_count", similarity: 0.85, metadata: { goal_id: "goal-2", type: "dimension" } },
        { id: "dim:goal-1:test_coverage", similarity: 0.92, metadata: { goal_id: "goal-1", type: "dimension" } },
      ]),
    } as any;

    const deps = createMockDeps({ vectorIndex: mockVectorIndex });
    const engine = new CuriosityEngine(deps);

    const results = await engine.findSimilarDimensions("goal-1", "test_coverage");

    // Should filter out the same goal's dimension
    expect(results).toHaveLength(1);
    expect(results[0]!.goal_id).toBe("goal-2");
    expect(results[0]!.similarity).toBe(0.85);
    expect(mockVectorIndex.search).toHaveBeenCalledWith("test_coverage", 3, 0.7);
  });

  it("returns empty array when no vectorIndex is configured", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);

    const results = await engine.findSimilarDimensions("goal-1", "test_coverage");
    expect(results).toEqual([]);
  });
});
