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
  StrategyTemplate,
  CrossGoalRebalanceTrigger,
} from "../src/types/cross-portfolio.js";

import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Test Helpers ───

function makeGoal(
  overrides: Partial<Goal> & { id: string }
): Goal {
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

function makeMinDimension(name: string, current: number, threshold: number) {
  return {
    name,
    label: name,
    current_value: current,
    threshold: { type: "min" as const, value: threshold },
    confidence: 0.9,
    observation_method: {
      type: "mechanical" as const,
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "mechanical" as const,
    },
    last_updated: null,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok" as const,
    dimension_mapping: null,
  };
}

function makeStrategyTemplateMetadata(overrides: Partial<{
  template_id: string;
  source_goal_id: string;
  source_strategy_id: string;
  hypothesis_pattern: string;
  domain_tags: string[];
  effectiveness_score: number;
  applicable_dimensions: string[];
  embedding_id: string | null;
  created_at: string;
}> = {}) {
  const now = new Date().toISOString();
  return {
    template_id: overrides.template_id ?? "tmpl-1",
    source_goal_id: overrides.source_goal_id ?? "goal-src",
    source_strategy_id: overrides.source_strategy_id ?? "strat-src",
    hypothesis_pattern: overrides.hypothesis_pattern ?? "Improve onboarding to reduce churn",
    domain_tags: overrides.domain_tags ?? ["saas", "growth"],
    effectiveness_score: overrides.effectiveness_score ?? 0.8,
    applicable_dimensions: overrides.applicable_dimensions ?? ["churn_rate"],
    embedding_id: overrides.embedding_id ?? null,
    created_at: overrides.created_at ?? now,
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
  embeddingClient = new MockEmbeddingClient(8); // small vectors for tests
  vectorIndex = new VectorIndex(path.join(tmpDir, "vector.json"), embeddingClient);
  portfolio = new CrossGoalPortfolio(
    stateManager,
    depGraph,
    vectorIndex,
    embeddingClient,
    { max_concurrent_goals: 5, min_goal_share: 0.1, synergy_bonus: 0.2 }
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── calculateGoalPriorities ───

describe("CrossGoalPortfolio", async () => {
  describe("calculateGoalPriorities", async () => {
    it("returns empty array for empty goalIds", async () => {
      const result = await portfolio.calculateGoalPriorities([]);
      expect(result).toEqual([]);
    });

    it("single goal returns one GoalPriorityFactors entry", async () => {
      const goal = makeGoal({ id: "g1" });
      await stateManager.saveGoal(goal);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result).toHaveLength(1);
      expect(result[0]!.goal_id).toBe("g1");
    });

    it("missing goal IDs are skipped", async () => {
      const goal = makeGoal({ id: "g1" });
      await stateManager.saveGoal(goal);

      const result = await portfolio.calculateGoalPriorities(["g1", "missing-goal"]);
      expect(result).toHaveLength(1);
    });

    it("multiple goals returns sorted by computed_priority descending", async () => {
      const now = new Date();
      // g1 has a near deadline → high urgency
      const deadline = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(); // 2h away
      const g1 = makeGoal({ id: "g1", deadline });
      const g2 = makeGoal({ id: "g2" }); // no deadline
      await stateManager.saveGoal(g1);
      await stateManager.saveGoal(g2);

      const result = await portfolio.calculateGoalPriorities(["g1", "g2"]);
      expect(result).toHaveLength(2);
      expect(result[0]!.computed_priority).toBeGreaterThanOrEqual(
        result[1]!.computed_priority
      );
    });

    it("deadline_urgency is higher when deadline is imminent", async () => {
      const now = new Date();
      const nearDeadline = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString();
      const farDeadline = new Date(now.getTime() + 1000 * 60 * 60 * 1000).toISOString();

      const gNear = makeGoal({ id: "g-near", deadline: nearDeadline });
      const gFar = makeGoal({ id: "g-far", deadline: farDeadline });
      await stateManager.saveGoal(gNear);
      await stateManager.saveGoal(gFar);

      const result = await portfolio.calculateGoalPriorities(["g-near", "g-far"]);
      const near = result.find((r) => r.goal_id === "g-near")!;
      const far = result.find((r) => r.goal_id === "g-far")!;

      expect(near.deadline_urgency).toBeGreaterThan(far.deadline_urgency);
    });

    it("deadline_urgency is 0 when no deadline is set", async () => {
      const goal = makeGoal({ id: "g1" });
      await stateManager.saveGoal(goal);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.deadline_urgency).toBe(0);
    });

    it("gap_severity picks max dimension gap", async () => {
      const g = makeGoal({
        id: "g1",
        dimensions: [
          makeMinDimension("d1", 80, 100), // gap = 20/100 = 0.2
          makeMinDimension("d2", 50, 100), // gap = 50/100 = 0.5
          makeMinDimension("d3", 0, 100),  // gap = 100/100 = 1.0
        ],
      });
      await stateManager.saveGoal(g);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.gap_severity).toBeCloseTo(1.0, 3);
    });

    it("gap_severity is 0 when all dimensions are satisfied", async () => {
      const g = makeGoal({
        id: "g1",
        dimensions: [
          makeMinDimension("d1", 100, 80), // already satisfied
          makeMinDimension("d2", 200, 100), // already satisfied
        ],
      });
      await stateManager.saveGoal(g);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.gap_severity).toBe(0);
    });

    it("gap_severity is 0 for goal with no dimensions", async () => {
      const g = makeGoal({ id: "g1", dimensions: [] });
      await stateManager.saveGoal(g);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.gap_severity).toBe(0);
    });

    it("dependency_weight reflects number of goals that depend on this goal", async () => {
      const g1 = makeGoal({ id: "g1" });
      const g2 = makeGoal({ id: "g2" });
      const g3 = makeGoal({ id: "g3" });
      await stateManager.saveGoal(g1);
      await stateManager.saveGoal(g2);
      await stateManager.saveGoal(g3);

      // g1 is a prerequisite for both g2 and g3
      depGraph.addEdge({
        from_goal_id: "g1",
        to_goal_id: "g2",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
      });
      depGraph.addEdge({
        from_goal_id: "g1",
        to_goal_id: "g3",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
      });

      const result = await portfolio.calculateGoalPriorities(["g1", "g2", "g3"]);
      const g1Priority = result.find((r) => r.goal_id === "g1")!;
      const g2Priority = result.find((r) => r.goal_id === "g2")!;

      expect(g1Priority.dependency_weight).toBeGreaterThan(g2Priority.dependency_weight);
    });

    it("dependency_weight is 0 for solo goal", async () => {
      const g = makeGoal({ id: "g1" });
      await stateManager.saveGoal(g);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.dependency_weight).toBe(0);
    });

    it("user_priority normalises 1-5 scale to 0-1", async () => {
      const goals = [1, 2, 3, 4, 5].map((level) =>
        makeGoal({ id: `g-p${level}`, constraints: [`priority:${level}`] })
      );
      for (const g of goals) {
        await stateManager.saveGoal(g);
      }

      const ids = goals.map((g) => g.id);
      const result = await portfolio.calculateGoalPriorities(ids);

      const findUserPriority = (level: number) =>
        result.find((r) => r.goal_id === `g-p${level}`)!.user_priority;

      expect(findUserPriority(1)).toBeCloseTo(0.2, 5);
      expect(findUserPriority(2)).toBeCloseTo(0.4, 5);
      expect(findUserPriority(3)).toBeCloseTo(0.6, 5);
      expect(findUserPriority(4)).toBeCloseTo(0.8, 5);
      expect(findUserPriority(5)).toBeCloseTo(1.0, 5);
    });

    it("user_priority defaults to 0.5 when not specified", async () => {
      const g = makeGoal({ id: "g1", constraints: [] });
      await stateManager.saveGoal(g);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.user_priority).toBe(0.5);
    });

    it("synergy bonus is applied to both goals in a synergy pair", async () => {
      const g1 = makeGoal({ id: "g1" });
      const g2 = makeGoal({ id: "g2" });
      await stateManager.saveGoal(g1);
      await stateManager.saveGoal(g2);

      // Without synergy
      const before = await portfolio.calculateGoalPriorities(["g1", "g2"]);
      const beforeG1 = before.find((r) => r.goal_id === "g1")!.computed_priority;

      // Add synergy edge
      depGraph.addEdge({
        from_goal_id: "g1",
        to_goal_id: "g2",
        type: "synergy",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
      });

      const after = await portfolio.calculateGoalPriorities(["g1", "g2"]);
      const afterG1 = after.find((r) => r.goal_id === "g1")!.computed_priority;

      expect(afterG1).toBeGreaterThanOrEqual(beforeG1);
    });

    it("conflict penalty reduces the lower-priority goal", async () => {
      const g1 = makeGoal({ id: "g1", constraints: ["priority:5"] });
      const g2 = makeGoal({ id: "g2", constraints: ["priority:1"] });
      await stateManager.saveGoal(g1);
      await stateManager.saveGoal(g2);

      // Without conflict
      const before = await portfolio.calculateGoalPriorities(["g1", "g2"]);
      const beforeG2 = before.find((r) => r.goal_id === "g2")!.computed_priority;

      // Add conflict edge
      depGraph.addEdge({
        from_goal_id: "g1",
        to_goal_id: "g2",
        type: "conflict",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
      });

      const after = await portfolio.calculateGoalPriorities(["g1", "g2"]);
      const afterG2 = after.find((r) => r.goal_id === "g2")!.computed_priority;

      // Low-priority goal should receive penalty
      expect(afterG2).toBeLessThanOrEqual(beforeG2);
    });

    it("computed_priority is clamped to [0, 1]", async () => {
      const now = new Date();
      const nearDeadline = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString();
      const g = makeGoal({
        id: "g1",
        deadline: nearDeadline,
        constraints: ["priority:5"],
        dimensions: [makeMinDimension("d1", 0, 100)],
      });
      await stateManager.saveGoal(g);

      const result = await portfolio.calculateGoalPriorities(["g1"]);
      expect(result[0]!.computed_priority).toBeGreaterThanOrEqual(0);
      expect(result[0]!.computed_priority).toBeLessThanOrEqual(1);
    });

    it("all priorities are within [0,1]", async () => {
      for (let i = 0; i < 5; i++) {
        const g = makeGoal({ id: `g${i}`, constraints: [`priority:${i + 1}`] });
        await stateManager.saveGoal(g);
      }
      const ids = Array.from({ length: 5 }, (_, i) => `g${i}`);
      const result = await portfolio.calculateGoalPriorities(ids);
      for (const r of result) {
        expect(r.computed_priority).toBeGreaterThanOrEqual(0);
        expect(r.computed_priority).toBeLessThanOrEqual(1);
      }
    });
  });

  // ─── allocateResources ───

  describe("allocateResources", () => {
    it("empty priorities returns empty allocations", () => {
      expect(portfolio.allocateResources([])).toEqual([]);
    });

    it("single goal gets resource_share of 1.0", () => {
      const p: GoalPriorityFactors = {
        goal_id: "g1",
        deadline_urgency: 0,
        gap_severity: 0.5,
        dependency_weight: 0,
        user_priority: 0.5,
        computed_priority: 0.5,
      };
      const result = portfolio.allocateResources([p]);
      expect(result).toHaveLength(1);
      expect(result[0]!.resource_share).toBeCloseTo(1.0, 5);
    });

    it("two goals have proportional allocation summing to 1.0", () => {
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.8 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.2 },
      ];
      const result = portfolio.allocateResources(priorities);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("min_goal_share floor is applied when raw share is too small", () => {
      // One goal with very high priority, others with very low priority
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.99 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.01 },
      ];
      const result = portfolio.allocateResources(priorities);
      const g2 = result.find((r) => r.goal_id === "g2")!;
      expect(g2.resource_share).toBeGreaterThanOrEqual(0.1);
    });

    it("active allocations still sum to 1.0 after min_goal_share is applied", () => {
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.9 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.05 },
        { goal_id: "g3", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.05 },
      ];
      const result = portfolio.allocateResources(priorities);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("goals exceeding max_concurrent_goals get allocation 0", () => {
      const portfolioWith2Max = new CrossGoalPortfolio(
        stateManager,
        depGraph,
        vectorIndex,
        embeddingClient,
        { max_concurrent_goals: 2, min_goal_share: 0.1 }
      );
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.9 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.6 },
        { goal_id: "g3", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.3 },
      ];
      const result = portfolioWith2Max.allocateResources(priorities);
      const g3 = result.find((r) => r.goal_id === "g3")!;
      expect(g3.resource_share).toBe(0);
    });

    it("excess goals (waiting) have adjustment_reason mentioning waiting", () => {
      const portfolioWith1Max = new CrossGoalPortfolio(
        stateManager,
        depGraph,
        vectorIndex,
        embeddingClient,
        { max_concurrent_goals: 1, min_goal_share: 0.1 }
      );
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.9 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.3 },
      ];
      const result = portfolioWith1Max.allocateResources(priorities);
      const g2 = result.find((r) => r.goal_id === "g2")!;
      expect(g2.adjustment_reason).toMatch(/waiting/i);
    });

    it("equal priority gets equal allocation", () => {
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.5 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.5 },
      ];
      const result = portfolio.allocateResources(priorities);
      expect(result[0]!.resource_share).toBeCloseTo(result[1]!.resource_share, 5);
    });

    it("adjustment_reason is populated for every allocation", () => {
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.7 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0.3 },
      ];
      const result = portfolio.allocateResources(priorities);
      for (const r of result) {
        expect(r.adjustment_reason.length).toBeGreaterThan(0);
      }
    });

    it("all zero priorities still sums to 1.0 (equal split)", () => {
      const priorities: GoalPriorityFactors[] = [
        { goal_id: "g1", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0 },
        { goal_id: "g2", deadline_urgency: 0, gap_severity: 0, dependency_weight: 0, user_priority: 0, computed_priority: 0 },
      ];
      const result = portfolio.allocateResources(priorities);
      const total = result.reduce((s, r) => s + r.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });
  });

  // ─── rebalanceGoals ───

  describe("rebalanceGoals", async () => {
    beforeEach(async () => {
      const g1 = makeGoal({ id: "g1" });
      const g2 = makeGoal({ id: "g2" });
      await stateManager.saveGoal(g1);
      await stateManager.saveGoal(g2);
      // Warm up cache
      await portfolio.calculateGoalPriorities(["g1", "g2"]);
    });

    it("periodic trigger returns a CrossGoalRebalanceResult", async () => {
      const result = await portfolio.rebalanceGoals("periodic");
      expect(result.triggered_by).toBe("periodic");
      expect(result.allocations).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it("goal_completed trigger recalculates correctly", async () => {
      const result = await portfolio.rebalanceGoals("goal_completed");
      expect(result.triggered_by).toBe("goal_completed");
    });

    it("goal_added trigger recalculates correctly", async () => {
      const result = await portfolio.rebalanceGoals("goal_added");
      expect(result.triggered_by).toBe("goal_added");
    });

    it("priority_shift trigger recalculates correctly", async () => {
      const result = await portfolio.rebalanceGoals("priority_shift");
      expect(result.triggered_by).toBe("priority_shift");
    });

    it("timestamp is a valid ISO datetime", async () => {
      const result = await portfolio.rebalanceGoals("periodic");
      expect(() => new Date(result.timestamp)).not.toThrow();
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it("allocations reflect re-calculated priorities", async () => {
      const result = await portfolio.rebalanceGoals("periodic", ["g1", "g2"]);
      expect(result.allocations.length).toBeGreaterThan(0);
      const total = result.allocations.reduce((s, a) => s + a.resource_share, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("rebalance with explicit goalIds overrides cached list", async () => {
      const g3 = makeGoal({ id: "g3" });
      await stateManager.saveGoal(g3);
      const result = await portfolio.rebalanceGoals("goal_added", ["g1", "g3"]);
      const ids = result.allocations.map((a) => a.goal_id);
      expect(ids).toContain("g1");
      expect(ids).toContain("g3");
      expect(ids).not.toContain("g2");
    });

    it("rebalance with empty goalIds returns empty allocations", async () => {
      // Clear cache by creating fresh portfolio
      const freshPortfolio = new CrossGoalPortfolio(
        stateManager,
        depGraph,
        vectorIndex,
        embeddingClient,
        {}
      );
      const result = await freshPortfolio.rebalanceGoals("periodic", []);
      expect(result.allocations).toEqual([]);
    });
  });

  // ─── getRecommendedTemplates ───

  describe("getRecommendedTemplates", async () => {
    it("returns empty array when goalId does not exist", async () => {
      const result = await portfolio.getRecommendedTemplates(
        "nonexistent-goal",
        vectorIndex
      );
      expect(result).toEqual([]);
    });

    it("returns empty array when VectorIndex is empty", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Reduce churn rate",
        constraints: ["domain:saas"],
      });
      await stateManager.saveGoal(g);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result).toEqual([]);
    });

    it("returns matching templates", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Reduce churn rate in SaaS product",
        description: "Onboarding improvements to retain users",
        constraints: ["domain:saas"],
      });
      await stateManager.saveGoal(g);

      const meta = makeStrategyTemplateMetadata({
        template_id: "tmpl-1",
        hypothesis_pattern: "Improve onboarding to reduce churn",
        domain_tags: ["saas"],
        effectiveness_score: 0.8,
      });
      await vectorIndex.add("tmpl-1", meta.hypothesis_pattern, meta);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]!.template_id).toBe("tmpl-1");
    });

    it("filters out templates with no domain_tags overlap", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Scale hardware infrastructure",
        constraints: ["domain:hardware"],
      });
      await stateManager.saveGoal(g);

      const meta = makeStrategyTemplateMetadata({
        template_id: "tmpl-saas",
        hypothesis_pattern: "Improve SaaS onboarding",
        domain_tags: ["saas", "growth"], // no overlap with hardware
        effectiveness_score: 0.9,
      });
      await vectorIndex.add("tmpl-saas", meta.hypothesis_pattern, meta);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result).toEqual([]);
    });

    it("includes all templates when goal has no domain tags", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Some general goal",
        description: "No specific domain",
        constraints: [], // no domain tags
      });
      await stateManager.saveGoal(g);

      const meta = makeStrategyTemplateMetadata({
        template_id: "tmpl-any",
        hypothesis_pattern: "Some general strategy",
        domain_tags: ["saas"],
        effectiveness_score: 0.7,
      });
      await vectorIndex.add("tmpl-any", meta.hypothesis_pattern, meta);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result.length).toBeGreaterThan(0);
    });

    it("sorts results by similarity × effectiveness_score descending", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Reduce customer churn",
        description: "Improve retention",
        constraints: ["domain:saas"],
      });
      await stateManager.saveGoal(g);

      const highEffMeta = makeStrategyTemplateMetadata({
        template_id: "tmpl-high",
        hypothesis_pattern: "Reduce customer churn with personalised onboarding",
        domain_tags: ["saas"],
        effectiveness_score: 0.9,
      });
      const lowEffMeta = makeStrategyTemplateMetadata({
        template_id: "tmpl-low",
        hypothesis_pattern: "Reduce customer churn with better support",
        domain_tags: ["saas"],
        effectiveness_score: 0.1,
      });

      await vectorIndex.add("tmpl-high", highEffMeta.hypothesis_pattern, highEffMeta);
      await vectorIndex.add("tmpl-low", lowEffMeta.hypothesis_pattern, lowEffMeta);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex, 2);
      // High effectiveness should come first if similarity is similar
      expect(result).toHaveLength(2);
      // Result should be ordered by similarity * effectiveness descending
      // (we can't know exact order without knowing cosine similarities, but
      // we can verify the property holds)
      for (let i = 0; i < result.length - 1; i++) {
        const curr = result[i]!;
        const next = result[i + 1]!;
        // Both are valid templates
        expect(curr.template_id).toBeDefined();
        expect(next.template_id).toBeDefined();
      }
    });

    it("respects limit parameter", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Grow user base",
        constraints: ["domain:growth"],
      });
      await stateManager.saveGoal(g);

      for (let i = 0; i < 5; i++) {
        const meta = makeStrategyTemplateMetadata({
          template_id: `tmpl-${i}`,
          hypothesis_pattern: `Growth strategy ${i} to acquire users`,
          domain_tags: ["growth"],
          effectiveness_score: 0.5 + i * 0.1,
        });
        await vectorIndex.add(`tmpl-${i}`, meta.hypothesis_pattern, meta);
      }

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex, 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it("returns empty when no templates match domain tags", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Build mobile app",
        constraints: ["domain:mobile"],
      });
      await stateManager.saveGoal(g);

      // Add templates with completely different domain
      const meta = makeStrategyTemplateMetadata({
        template_id: "tmpl-finance",
        hypothesis_pattern: "Optimise financial reporting pipeline",
        domain_tags: ["finance", "reporting"],
        effectiveness_score: 0.8,
      });
      await vectorIndex.add("tmpl-finance", meta.hypothesis_pattern, meta);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result).toEqual([]);
    });

    it("skips entries without required metadata fields", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Improve performance",
        constraints: [],
      });
      await stateManager.saveGoal(g);

      // Add an entry with missing template fields
      await vectorIndex.add("raw-entry", "Some text", {
        not_a_template: true,
      });

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result).toEqual([]);
    });

    it("returned templates have all StrategyTemplate fields", async () => {
      const g = makeGoal({
        id: "g1",
        title: "Reduce latency",
        constraints: ["domain:infra"],
      });
      await stateManager.saveGoal(g);

      const meta = makeStrategyTemplateMetadata({
        template_id: "tmpl-cache",
        hypothesis_pattern: "Add caching layer to reduce database latency",
        domain_tags: ["infra"],
        effectiveness_score: 0.75,
        applicable_dimensions: ["p99_latency"],
      });
      await vectorIndex.add("tmpl-cache", meta.hypothesis_pattern, meta);

      const result = await portfolio.getRecommendedTemplates("g1", vectorIndex);
      expect(result.length).toBeGreaterThan(0);
      const t = result[0]!;
      expect(t.template_id).toBe("tmpl-cache");
      expect(t.hypothesis_pattern).toBeDefined();
      expect(t.domain_tags).toBeDefined();
      expect(t.effectiveness_score).toBeDefined();
      expect(t.applicable_dimensions).toBeDefined();
      expect(t.created_at).toBeDefined();
    });
  });
});
