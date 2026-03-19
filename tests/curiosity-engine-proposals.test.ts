import { describe, it, expect, vi, beforeEach } from "vitest";
import { CuriosityEngine } from "../src/traits/curiosity-engine.js";
import type { CuriosityEngineDeps } from "../src/traits/curiosity-engine.js";
import type { CuriosityProposal, CuriosityTrigger } from "../src/types/curiosity.js";
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
