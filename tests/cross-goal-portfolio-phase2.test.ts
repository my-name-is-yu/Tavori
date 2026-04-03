import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import { VectorIndex } from "../src/knowledge/vector-index.js";
import { MockEmbeddingClient } from "../src/knowledge/embedding-client.js";
import { CrossGoalPortfolio } from "../src/strategy/cross-goal-portfolio.js";
import { GoalSchema } from "../src/types/goal.js";
import type { Goal } from "../src/types/goal.js";
import type {
  GoalPriorityFactors,
  CrossGoalAllocation,
  MomentumInfo,
  AllocationStrategy,
  DependencySchedule,
} from "../src/types/cross-portfolio.js";

import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeGoal(overrides: Partial<Goal> & { id: string }): Goal {
  const now = new Date().toISOString();
  return GoalSchema.parse({
    id: overrides.id,
    title: overrides.title ?? `Goal ${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "active",
    dimensions: overrides.dimensions ?? [],
    constraints: overrides.constraints ?? [],
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    deadline: overrides.deadline ?? null,
    children_ids: overrides.children_ids ?? [],
    ...overrides,
  });
}

function makePriority(
  goalId: string,
  computedPriority: number = 0.5
): GoalPriorityFactors {
  return {
    goal_id: goalId,
    deadline_urgency: 0,
    gap_severity: 0,
    dependency_weight: 0,
    user_priority: 0.5,
    computed_priority: computedPriority,
  };
}

function makeAllocation(
  goalId: string,
  resourceShare: number
): CrossGoalAllocation {
  return {
    goal_id: goalId,
    priority: 0.5,
    resource_share: resourceShare,
    adjustment_reason: "test",
  };
}

function makePrerequisiteEdge(from: string, to: string) {
  return {
    from_goal_id: from,
    to_goal_id: to,
    type: "prerequisite" as const,
    status: "active" as const,
    condition: null,
    affected_dimensions: [],
    mitigation: null,
    detection_confidence: 1.0,
    reasoning: null,
  };
}

// ─── Setup / Teardown ───

let tmpDir: string;
let stateManager: StateManager;
let depGraph: GoalDependencyGraph;
let embeddingClient: MockEmbeddingClient;
let vectorIndex: VectorIndex;
let portfolio: CrossGoalPortfolio;

beforeEach(() => {
  tmpDir = makeTempDir();
  stateManager = new StateManager(tmpDir);
  depGraph = new GoalDependencyGraph(stateManager);
  embeddingClient = new MockEmbeddingClient(8);
  vectorIndex = new VectorIndex(path.join(tmpDir, "vector.json"), embeddingClient);
  portfolio = new CrossGoalPortfolio(
    stateManager,
    depGraph,
    vectorIndex,
    embeddingClient,
    { max_concurrent_goals: 5, min_goal_share: 0.05, synergy_bonus: 0.2 }
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── calculateMomentum ───

describe("CrossGoalPortfolio Phase 2", () => {
  describe("calculateMomentum", () => {
    it("returns stalled when no snapshots provided", () => {
      const result = portfolio.calculateMomentum("g1", []);
      expect(result.goalId).toBe("g1");
      expect(result.trend).toBe("stalled");
      expect(result.velocity).toBe(0);
      expect(result.recentProgress).toBe(0);
    });

    it("returns stalled when only one snapshot provided", () => {
      const result = portfolio.calculateMomentum("g1", [0.5]);
      expect(result.trend).toBe("stalled");
      expect(result.velocity).toBe(0);
    });

    it("detects stalled trend when progress is flat", () => {
      const snapshots = [0.5, 0.5, 0.5, 0.5, 0.5];
      const result = portfolio.calculateMomentum("g1", snapshots);
      expect(result.trend).toBe("stalled");
      expect(result.velocity).toBeCloseTo(0, 4);
      expect(result.recentProgress).toBeCloseTo(0, 4);
    });

    it("detects steady trend for constant progress", () => {
      // Uniform steps: each is +0.1
      const snapshots = [0.0, 0.1, 0.2, 0.3, 0.4];
      const result = portfolio.calculateMomentum("g1", snapshots);
      expect(result.trend).toBe("steady");
      expect(result.velocity).toBeGreaterThan(0);
      expect(result.recentProgress).toBeCloseTo(0.4, 4);
    });

    it("detects accelerating trend when later deltas are larger", () => {
      // Early deltas small, later deltas large
      const snapshots = [0.0, 0.01, 0.03, 0.10, 0.25, 0.50];
      const result = portfolio.calculateMomentum("g1", snapshots);
      expect(result.trend).toBe("accelerating");
      expect(result.velocity).toBeGreaterThan(0);
    });

    it("detects decelerating trend when later deltas are smaller", () => {
      // Early deltas large, later deltas small
      const snapshots = [0.0, 0.30, 0.50, 0.55, 0.57, 0.58];
      const result = portfolio.calculateMomentum("g1", snapshots);
      expect(result.trend).toBe("decelerating");
    });

    it("recentProgress is the total delta from first to last snapshot", () => {
      const snapshots = [0.2, 0.3, 0.4, 0.5, 0.6];
      const result = portfolio.calculateMomentum("g-x", snapshots);
      expect(result.recentProgress).toBeCloseTo(0.4, 5);
    });

    it("velocity is positive for progressing goals", () => {
      const snapshots = [0.1, 0.2, 0.3, 0.4, 0.5];
      const result = portfolio.calculateMomentum("g1", snapshots);
      expect(result.velocity).toBeGreaterThan(0);
    });

    it("goalId is returned in the result", () => {
      const result = portfolio.calculateMomentum("my-goal-id", [0.0, 0.5]);
      expect(result.goalId).toBe("my-goal-id");
    });

    it("handles two-snapshot minimum correctly", () => {
      const result = portfolio.calculateMomentum("g1", [0.1, 0.2]);
      expect(result.recentProgress).toBeCloseTo(0.1, 5);
      expect(result.velocity).toBeGreaterThan(0);
    });
  });

  // ─── buildDependencySchedule ───

  describe("buildDependencySchedule", () => {
    it("returns empty phases for empty goalIds", () => {
      const schedule = portfolio.buildDependencySchedule([], depGraph);
      expect(schedule.phases).toHaveLength(0);
      expect(schedule.criticalPath).toHaveLength(0);
    });

    it("single goal with no dependencies is in phase 0 with empty blockedBy", () => {
      const schedule = portfolio.buildDependencySchedule(["g1"], depGraph);
      expect(schedule.phases).toHaveLength(1);
      expect(schedule.phases[0]!.phase).toBe(0);
      expect(schedule.phases[0]!.goalIds).toContain("g1");
      expect(schedule.phases[0]!.blockedBy).toHaveLength(0);
    });

    it("linear chain: A → B → C produces 3 phases", () => {
      // A must complete before B, B before C
      depGraph.addEdge(makePrerequisiteEdge("A", "B"));
      depGraph.addEdge(makePrerequisiteEdge("B", "C"));

      const schedule = portfolio.buildDependencySchedule(["A", "B", "C"], depGraph);
      expect(schedule.phases).toHaveLength(3);
      expect(schedule.phases[0]!.goalIds).toContain("A");
      expect(schedule.phases[1]!.goalIds).toContain("B");
      expect(schedule.phases[2]!.goalIds).toContain("C");
    });

    it("diamond dependency: A → B, A → C, B+C → D", () => {
      depGraph.addEdge(makePrerequisiteEdge("A", "B"));
      depGraph.addEdge(makePrerequisiteEdge("A", "C"));
      depGraph.addEdge(makePrerequisiteEdge("B", "D"));
      depGraph.addEdge(makePrerequisiteEdge("C", "D"));

      const schedule = portfolio.buildDependencySchedule(["A", "B", "C", "D"], depGraph);

      // Phase 0: A (no prereqs)
      const phase0 = schedule.phases[0]!;
      expect(phase0.goalIds).toContain("A");

      // Phase 1: B and C (both depend only on A)
      const phase1 = schedule.phases[1]!;
      expect(phase1.goalIds).toContain("B");
      expect(phase1.goalIds).toContain("C");

      // Phase 2: D (depends on B and C)
      const phase2 = schedule.phases[2]!;
      expect(phase2.goalIds).toContain("D");
    });

    it("goals with no dependencies all go into phase 0", () => {
      const schedule = portfolio.buildDependencySchedule(
        ["g1", "g2", "g3"],
        depGraph
      );
      expect(schedule.phases).toHaveLength(1);
      expect(schedule.phases[0]!.goalIds).toHaveLength(3);
      expect(schedule.phases[0]!.blockedBy).toHaveLength(0);
    });

    it("phase blockedBy contains prerequisite goalIds", () => {
      depGraph.addEdge(makePrerequisiteEdge("A", "B"));

      const schedule = portfolio.buildDependencySchedule(["A", "B"], depGraph);
      const phaseB = schedule.phases.find((p) => p.goalIds.includes("B"))!;
      expect(phaseB.blockedBy).toContain("A");
    });

    it("critical path for linear chain A → B → C is [A, B, C]", () => {
      depGraph.addEdge(makePrerequisiteEdge("A", "B"));
      depGraph.addEdge(makePrerequisiteEdge("B", "C"));

      const schedule = portfolio.buildDependencySchedule(["A", "B", "C"], depGraph);
      expect(schedule.criticalPath).toEqual(["A", "B", "C"]);
    });

    it("critical path picks the longest chain in a diamond graph", () => {
      // A → B → D (length 3) vs A → C → D (length 3) — either path valid
      depGraph.addEdge(makePrerequisiteEdge("A", "B"));
      depGraph.addEdge(makePrerequisiteEdge("A", "C"));
      depGraph.addEdge(makePrerequisiteEdge("B", "D"));
      depGraph.addEdge(makePrerequisiteEdge("C", "D"));

      const schedule = portfolio.buildDependencySchedule(["A", "B", "C", "D"], depGraph);
      expect(schedule.criticalPath).toHaveLength(3); // A → B|C → D
      expect(schedule.criticalPath[0]).toBe("A");
      expect(schedule.criticalPath[schedule.criticalPath.length - 1]).toBe("D");
    });

    it("critical path for single goal is [goalId]", () => {
      const schedule = portfolio.buildDependencySchedule(["g1"], depGraph);
      expect(schedule.criticalPath).toEqual(["g1"]);
    });

    it("critical path picks longer branch when chains differ in length", () => {
      // A → B → C → D (length 4) and E → D (length 2)
      depGraph.addEdge(makePrerequisiteEdge("A", "B"));
      depGraph.addEdge(makePrerequisiteEdge("B", "C"));
      depGraph.addEdge(makePrerequisiteEdge("C", "D"));
      depGraph.addEdge(makePrerequisiteEdge("E", "D"));

      const schedule = portfolio.buildDependencySchedule(
        ["A", "B", "C", "D", "E"],
        depGraph
      );
      expect(schedule.criticalPath).toHaveLength(4);
      expect(schedule.criticalPath).toContain("A");
      expect(schedule.criticalPath).toContain("D");
    });
  });

  // ─── allocateResources with strategies ───

  describe("allocateResources with AllocationStrategy", () => {
    it("default (no strategy) works as before — priority proportional", () => {
      const priorities = [
        makePriority("g1", 0.8),
        makePriority("g2", 0.2),
      ];
      const result = portfolio.allocateResources(priorities);
      expect(result[0]!.resource_share).toBeGreaterThan(result[1]!.resource_share);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("equal strategy gives equal shares", () => {
      const priorities = [
        makePriority("g1", 0.9),
        makePriority("g2", 0.1),
        makePriority("g3", 0.5),
      ];
      const strategy: AllocationStrategy = { type: "equal" };
      const result = portfolio.allocateResources(priorities, strategy);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
      // All shares roughly equal
      for (const r of result) {
        expect(r.resource_share).toBeCloseTo(1 / 3, 2);
      }
    });

    it("momentum strategy weights higher-velocity goals more", () => {
      const priorities = [
        makePriority("g1", 0.5),
        makePriority("g2", 0.5),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.4, velocity: 0.8, trend: "accelerating" }],
        ["g2", { goalId: "g2", recentProgress: 0.01, velocity: 0.1, trend: "steady" }],
      ]);
      const strategy: AllocationStrategy = { type: "momentum", momentumWeight: 1.0 };
      const result = portfolio.allocateResources(priorities, strategy, momentumMap);

      const g1 = result.find((r) => r.goal_id === "g1")!;
      const g2 = result.find((r) => r.goal_id === "g2")!;
      expect(g1.resource_share).toBeGreaterThan(g2.resource_share);

      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("momentum strategy falls back to priority when no momentumMap provided", () => {
      const priorities = [
        makePriority("g1", 0.8),
        makePriority("g2", 0.2),
      ];
      const strategy: AllocationStrategy = { type: "momentum" };
      const result = portfolio.allocateResources(priorities, strategy);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("dependency_aware strategy boosts critical path goals", () => {
      const priorities = [
        makePriority("A", 0.5),
        makePriority("B", 0.5),
        makePriority("C", 0.5),
      ];
      // A and B are critical path; C is not
      const depSchedule: DependencySchedule = {
        phases: [
          { phase: 0, goalIds: ["A"], blockedBy: [] },
          { phase: 1, goalIds: ["B", "C"], blockedBy: ["A"] },
        ],
        criticalPath: ["A", "B"],
      };
      const strategy: AllocationStrategy = { type: "dependency_aware" };
      const result = portfolio.allocateResources(
        priorities,
        strategy,
        undefined,
        depSchedule
      );

      const aShare = result.find((r) => r.goal_id === "A")!.resource_share;
      const cShare = result.find((r) => r.goal_id === "C")!.resource_share;
      // A is on critical path and unblocked → should get more than C
      expect(aShare).toBeGreaterThan(cShare);

      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("dependency_aware falls back to priority when no schedule provided", () => {
      const priorities = [
        makePriority("g1", 0.7),
        makePriority("g2", 0.3),
      ];
      const strategy: AllocationStrategy = { type: "dependency_aware" };
      const result = portfolio.allocateResources(priorities, strategy);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("adjustment_reason mentions strategy type", () => {
      const priorities = [makePriority("g1", 0.6), makePriority("g2", 0.4)];
      const strategy: AllocationStrategy = { type: "equal" };
      const result = portfolio.allocateResources(priorities, strategy);
      for (const r of result) {
        expect(r.adjustment_reason.length).toBeGreaterThan(0);
      }
    });
  });

  // ─── rebalanceOnStall ───

  describe("rebalanceOnStall", () => {
    it("returns empty array when no allocations provided", () => {
      const result = portfolio.rebalanceOnStall([], new Map());
      expect(result).toHaveLength(0);
    });

    it("returns empty array when no goals are stalled", () => {
      const allocations = [
        makeAllocation("g1", 0.5),
        makeAllocation("g2", 0.5),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.1, velocity: 0.1, trend: "steady" }],
        ["g2", { goalId: "g2", recentProgress: 0.2, velocity: 0.2, trend: "accelerating" }],
      ]);
      const result = portfolio.rebalanceOnStall(allocations, momentumMap);
      expect(result).toHaveLength(0);
    });

    it("reduces resource_share for stalled goals to 0", () => {
      const allocations = [
        makeAllocation("g1", 0.4),
        makeAllocation("g2", 0.6),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["g2", { goalId: "g2", recentProgress: 0.2, velocity: 0.2, trend: "steady" }],
      ]);
      const actions = portfolio.rebalanceOnStall(allocations, momentumMap);

      const g1Action = actions.find((a) => a.goalId === "g1")!;
      expect(g1Action.action).toBe("reduce");
      expect(g1Action.newShare).toBe(0);
    });

    it("increases resource_share for progressing goals", () => {
      const allocations = [
        makeAllocation("g1", 0.5),
        makeAllocation("g2", 0.5),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["g2", { goalId: "g2", recentProgress: 0.3, velocity: 0.3, trend: "steady" }],
      ]);
      const actions = portfolio.rebalanceOnStall(allocations, momentumMap);

      const g2Action = actions.find((a) => a.goalId === "g2")!;
      expect(g2Action.action).toBe("increase");
      expect(g2Action.newShare).toBeGreaterThan(g2Action.previousShare);
    });

    it("multiple stalled goals redistribute to single progressing goal", () => {
      const allocations = [
        makeAllocation("g1", 0.3),
        makeAllocation("g2", 0.3),
        makeAllocation("g3", 0.4),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["g2", { goalId: "g2", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["g3", { goalId: "g3", recentProgress: 0.2, velocity: 0.2, trend: "accelerating" }],
      ]);
      const actions = portfolio.rebalanceOnStall(allocations, momentumMap);

      const g3Action = actions.find((a) => a.goalId === "g3")!;
      // g3 should receive the 0.6 from g1+g2
      expect(g3Action.newShare).toBeCloseTo(0.4 + 0.6, 4);
    });

    it("returns empty when all goals are stalled (nothing to redistribute to)", () => {
      const allocations = [
        makeAllocation("g1", 0.5),
        makeAllocation("g2", 0.5),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["g2", { goalId: "g2", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
      ]);
      const result = portfolio.rebalanceOnStall(allocations, momentumMap);
      expect(result).toHaveLength(0);
    });

    it("goals without momentum info keep their allocation", () => {
      const allocations = [
        makeAllocation("g1", 0.5),
        makeAllocation("g2", 0.5),
      ];
      // g1 has no momentum info → skipped (neutral), not treated as stalled
      const momentumMap = new Map<string, MomentumInfo>([
        ["g2", { goalId: "g2", recentProgress: 0.2, velocity: 0.2, trend: "steady" }],
      ]);
      const actions = portfolio.rebalanceOnStall(allocations, momentumMap);

      const g1Action = actions.find((a) => a.goalId === "g1");
      expect(g1Action).toBeUndefined();
    });

    it("previousShare is recorded correctly in actions", () => {
      const allocations = [
        makeAllocation("stalled-goal", 0.3),
        makeAllocation("active-goal", 0.7),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["stalled-goal", { goalId: "stalled-goal", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["active-goal", { goalId: "active-goal", recentProgress: 0.1, velocity: 0.1, trend: "steady" }],
      ]);
      const actions = portfolio.rebalanceOnStall(allocations, momentumMap);

      const stalledAction = actions.find((a) => a.goalId === "stalled-goal")!;
      expect(stalledAction.previousShare).toBeCloseTo(0.3, 5);
    });

    it("higher velocity progressing goals get a larger bonus", () => {
      const allocations = [
        makeAllocation("stalled", 0.4),
        makeAllocation("fast", 0.3),
        makeAllocation("slow", 0.3),
      ];
      const momentumMap = new Map<string, MomentumInfo>([
        ["stalled", { goalId: "stalled", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["fast", { goalId: "fast", recentProgress: 0.5, velocity: 0.5, trend: "accelerating" }],
        ["slow", { goalId: "slow", recentProgress: 0.05, velocity: 0.05, trend: "steady" }],
      ]);
      const actions = portfolio.rebalanceOnStall(allocations, momentumMap);

      const fastAction = actions.find((a) => a.goalId === "fast")!;
      const slowAction = actions.find((a) => a.goalId === "slow")!;
      expect(fastAction.newShare).toBeGreaterThan(slowAction.newShare);
    });
  });

  // ─── Edge cases ───

  describe("edge cases", () => {
    it("calculateMomentum with negative progress gives negative velocity", () => {
      const snapshots = [0.8, 0.7, 0.6, 0.5, 0.4];
      const result = portfolio.calculateMomentum("g1", snapshots);
      expect(result.velocity).toBeLessThan(0);
      expect(result.recentProgress).toBeCloseTo(-0.4, 5);
    });

    it("buildDependencySchedule ignores prerequisite edges between goals not in the list", () => {
      // Add edges between goals outside the provided list
      depGraph.addEdge(makePrerequisiteEdge("OUTSIDE", "g1"));

      const schedule = portfolio.buildDependencySchedule(["g1"], depGraph);
      // g1 should still be in phase 0 since OUTSIDE is not in the goal list
      expect(schedule.phases[0]!.goalIds).toContain("g1");
      expect(schedule.phases[0]!.blockedBy).toHaveLength(0);
    });

    it("allocateResources with momentum strategy and zero velocities distributes equally", () => {
      const priorities = [makePriority("g1", 0.5), makePriority("g2", 0.5)];
      const momentumMap = new Map<string, MomentumInfo>([
        ["g1", { goalId: "g1", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
        ["g2", { goalId: "g2", recentProgress: 0.0, velocity: 0.0, trend: "stalled" }],
      ]);
      const strategy: AllocationStrategy = { type: "momentum", momentumWeight: 1.0 };
      const result = portfolio.allocateResources(priorities, strategy, momentumMap);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("buildDependencySchedule critical path for goals with no prereqs is any single goal", () => {
      const schedule = portfolio.buildDependencySchedule(["g1", "g2", "g3"], depGraph);
      expect(schedule.criticalPath).toHaveLength(1);
    });
  });
});
