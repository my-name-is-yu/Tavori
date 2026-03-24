import { describe, it, expect, vi, beforeEach } from "vitest";
import { CuriosityEngine } from "../src/traits/curiosity-engine.js";
import type { CuriosityEngineDeps } from "../src/traits/curiosity-engine.js";
import type { CuriosityTrigger } from "../src/types/curiosity.js";
import type { StallState } from "../src/types/stall.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Helper Factories ───

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

  const stallDetector = {
    getStallState: vi.fn().mockResolvedValue(makeStallState()),
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
    stallDetector,
    driveSystem,
    config: mergedConfig,
    ...restOverrides,
  };
}

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
    expect(sendMessageArgs[1]).toEqual({ temperature: 0.3, model_tier: 'light' });
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
