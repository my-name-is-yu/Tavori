import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import type { ContextSlot } from "../src/types/session.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeSlot(priority: number, label: string, content: string, tokenEstimate = 0): ContextSlot {
  return { priority, label, content, token_estimate: tokenEstimate };
}

// ─── Tests ───

describe("SessionManager Phase 2", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    manager = new SessionManager(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── estimateTokens ───

  describe("estimateTokens", () => {
    it("returns 1 for a 4-character string", () => {
      expect(manager.estimateTokens("abcd")).toBe(1);
    });

    it("returns 25 for a 100-character string", () => {
      expect(manager.estimateTokens("a".repeat(100))).toBe(25);
    });

    it("rounds up for non-divisible lengths (5 chars → 2 tokens)", () => {
      expect(manager.estimateTokens("abcde")).toBe(2);
    });

    it("returns 0 for empty string", () => {
      expect(manager.estimateTokens("")).toBe(0);
    });

    it("returns a reasonable estimate for typical context content", () => {
      const text = "This is a typical context slot with some information about a goal.";
      const estimate = manager.estimateTokens(text);
      // 67 chars / 4 = 16.75 → 17
      expect(estimate).toBe(17);
    });
  });

  // ─── compressSlot ───

  describe("compressSlot", () => {
    it("returns slot unchanged when content fits within maxTokens", () => {
      const slot = makeSlot(1, "test", "short content");
      const result = manager.compressSlot(slot, 100);
      expect(result.content).toBe("short content");
    });

    it("truncates content to fit within maxTokens", () => {
      const longContent = "a".repeat(400); // 100 tokens
      const slot = makeSlot(1, "test", longContent);
      const result = manager.compressSlot(slot, 50); // max 50 tokens = 200 chars
      expect(result.content.length).toBeLessThanOrEqual(200 + "\n...[truncated]...\n".length);
    });

    it("preserves head and tail portions (head + tail strategy)", () => {
      const content = "HEAD_CONTENT" + "x".repeat(400) + "TAIL_CONTENT";
      const slot = makeSlot(1, "test", content);
      // Very tight budget to force compression
      const result = manager.compressSlot(slot, 10);
      expect(result.content).toContain("HEAD_CONTENT");
      expect(result.content).toContain("TAIL_CONTENT");
    });

    it("compressed slot contains truncation marker", () => {
      const slot = makeSlot(1, "test", "a".repeat(400));
      const result = manager.compressSlot(slot, 10);
      expect(result.content).toContain("[truncated]");
    });

    it("preserves original priority and label after compression", () => {
      const slot = makeSlot(3, "my_label", "a".repeat(400));
      const result = manager.compressSlot(slot, 10);
      expect(result.priority).toBe(3);
      expect(result.label).toBe("my_label");
    });

    it("updates token_estimate to reflect compressed content", () => {
      const slot = makeSlot(1, "test", "a".repeat(400));
      const result = manager.compressSlot(slot, 10);
      // token_estimate should reflect compressed length, not original
      expect(result.token_estimate).toBe(manager.estimateTokens(result.content));
    });
  });

  // ─── Budget-based dynamic context selection ───

  describe("filterSlotsByBudget with priority ordering", () => {
    it("includes lower priority (higher number) slots only when budget allows", () => {
      const slots: ContextSlot[] = [
        makeSlot(1, "p1", "a".repeat(40), 10),
        makeSlot(2, "p2", "b".repeat(40), 10),
        makeSlot(3, "p3", "c".repeat(40), 10),
        makeSlot(5, "p5-retry", "e".repeat(40), 10),
      ];
      // Budget fits only 3 slots (30 tokens)
      const result = manager.filterSlotsByBudget(slots, 30);
      expect(result).toHaveLength(3);
      expect(result.map((s) => s.label)).toContain("p1");
      expect(result.map((s) => s.label)).toContain("p2");
      expect(result.map((s) => s.label)).toContain("p3");
      expect(result.map((s) => s.label)).not.toContain("p5-retry");
    });

    it("priority-5 slot included when budget is sufficient", () => {
      const slots: ContextSlot[] = [
        makeSlot(1, "p1", "a", 5),
        makeSlot(2, "p2", "b", 5),
        makeSlot(3, "p3", "c", 5),
        makeSlot(5, "p5-retry", "e", 5),
      ];
      const result = manager.filterSlotsByBudget(slots, 100);
      expect(result.map((s) => s.label)).toContain("p5-retry");
    });

    it("excludes low-priority slots when budget is exhausted by high-priority ones", () => {
      const slots: ContextSlot[] = [
        makeSlot(1, "critical", "a".repeat(400), 100),
        makeSlot(6, "memory_layer", "m".repeat(400), 100),
      ];
      // Budget fits only one slot
      const result = manager.filterSlotsByBudget(slots, 100);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("critical");
    });

    it("tracks token usage across multiple slots", () => {
      const slots: ContextSlot[] = [
        makeSlot(1, "s1", "a", 20),
        makeSlot(2, "s2", "b", 20),
        makeSlot(3, "s3", "c", 20),
        makeSlot(4, "s4", "d", 20),
        makeSlot(5, "s5", "e", 20),
      ];
      // Budget = 75 → fits 3 slots (60 tokens) but not 4 (80 tokens)
      const result = manager.filterSlotsByBudget(slots, 75);
      expect(result).toHaveLength(3);
    });

    it("returns all slots when budget is very large", () => {
      const slots: ContextSlot[] = [
        makeSlot(1, "s1", "a", 10),
        makeSlot(2, "s2", "b", 10),
        makeSlot(3, "s3", "c", 10),
      ];
      const result = manager.filterSlotsByBudget(slots, 1_000_000);
      expect(result).toHaveLength(3);
    });

    it("returns empty array when budget is zero", () => {
      const slots: ContextSlot[] = [makeSlot(1, "s1", "content", 10)];
      const result = manager.filterSlotsByBudget(slots, 0);
      expect(result).toHaveLength(0);
    });

    it("returns empty array when input is empty", () => {
      const result = manager.filterSlotsByBudget([], 50_000);
      expect(result).toHaveLength(0);
    });
  });

  // ─── checkResourceConflicts ───

  describe("checkResourceConflicts", () => {
    let depGraph: GoalDependencyGraph;
    let managerWithGraph: SessionManager;

    beforeEach(() => {
      depGraph = new GoalDependencyGraph(stateManager);
      managerWithGraph = new SessionManager(stateManager, depGraph);
    });

    it("returns empty array when no dependency graph is configured", () => {
      const result = manager.checkResourceConflicts("goal-A");
      expect(result).toEqual([]);
    });

    it("returns empty array when no resource_conflict edges exist", () => {
      const result = managerWithGraph.checkResourceConflicts("goal-A");
      expect(result).toEqual([]);
    });

    it("detects resource conflicts involving the goal as from_goal_id", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["filesystem", "database"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const result = managerWithGraph.checkResourceConflicts("goal-A");
      expect(result).toHaveLength(1);
      expect(result[0].conflictingGoalId).toBe("goal-B");
      expect(result[0].sharedResources).toEqual(["filesystem", "database"]);
    });

    it("detects resource conflicts involving the goal as to_goal_id", () => {
      depGraph.addEdge({
        from_goal_id: "goal-C",
        to_goal_id: "goal-A",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["api_quota"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const result = managerWithGraph.checkResourceConflicts("goal-A");
      expect(result).toHaveLength(1);
      expect(result[0].conflictingGoalId).toBe("goal-C");
      expect(result[0].sharedResources).toEqual(["api_quota"]);
    });

    it("does not return non-resource_conflict edges", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "synergy",
        status: "active",
        condition: null,
        affected_dimensions: ["coverage"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const result = managerWithGraph.checkResourceConflicts("goal-A");
      expect(result).toHaveLength(0);
    });

    it("returns multiple conflicts when multiple resource_conflict edges exist", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["resource-1"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-C",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["resource-2"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const result = managerWithGraph.checkResourceConflicts("goal-A");
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.conflictingGoalId);
      expect(ids).toContain("goal-B");
      expect(ids).toContain("goal-C");
    });
  });

  // ─── buildContextWithConflictAwareness ───

  describe("buildContextWithConflictAwareness", () => {
    let depGraph: GoalDependencyGraph;
    let managerWithGraph: SessionManager;

    beforeEach(() => {
      depGraph = new GoalDependencyGraph(stateManager);
      managerWithGraph = new SessionManager(stateManager, depGraph);
    });

    it("returns standard slots when no conflicts exist", () => {
      const slots = managerWithGraph.buildContextWithConflictAwareness("goal-A", "goal_review");
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("resource_conflict_awareness");
    });

    it("adds conflict-awareness slot when resource_conflict edges exist", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["filesystem"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const slots = managerWithGraph.buildContextWithConflictAwareness("goal-A", "goal_review");
      const conflictSlot = slots.find((s) => s.label === "resource_conflict_awareness");
      expect(conflictSlot).toBeDefined();
    });

    it("conflict-awareness slot content mentions conflicting goal ID", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["shared-db"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const slots = managerWithGraph.buildContextWithConflictAwareness("goal-A", "goal_review");
      const conflictSlot = slots.find((s) => s.label === "resource_conflict_awareness")!;
      expect(conflictSlot.content).toContain("goal-B");
      expect(conflictSlot.content).toContain("shared-db");
    });

    it("conflict-awareness slot has priority 4.5 (between p4 constraints and p5)", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const slots = managerWithGraph.buildContextWithConflictAwareness("goal-A", "goal_review");
      const conflictSlot = slots.find((s) => s.label === "resource_conflict_awareness")!;
      expect(conflictSlot.priority).toBe(4.5);
    });

    it("respects tokenBudget option and excludes low-priority slots when budget exhausted", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["resource-X"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      // Very tight budget — only fits high-priority slots
      const slots = managerWithGraph.buildContextWithConflictAwareness(
        "goal-A",
        "goal_review",
        { tokenBudget: 1 }
      );
      // With a budget of 1 token, even the first slot might be excluded
      // The key check is that the result is within budget
      const totalTokens = slots.reduce(
        (sum, s) => sum + (s.token_estimate > 0 ? s.token_estimate : Math.ceil(s.content.length / 4)),
        0
      );
      expect(totalTokens).toBeLessThanOrEqual(1);
    });

    it("works without dependency graph (returns standard slots only)", () => {
      const slots = manager.buildContextWithConflictAwareness("goal-A", "task_execution");
      // Without dep graph, no conflict slot added
      const labels = slots.map((s) => s.label);
      expect(labels).not.toContain("resource_conflict_awareness");
      // Standard task_execution slots present
      expect(labels).toContain("task_definition_and_success_criteria");
    });

    it("conflict-awareness slot content instructs avoiding concurrent operations", () => {
      depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["filesystem"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const slots = managerWithGraph.buildContextWithConflictAwareness("goal-A", "goal_review");
      const conflictSlot = slots.find((s) => s.label === "resource_conflict_awareness")!;
      expect(conflictSlot.content.toLowerCase()).toContain("concurrent");
    });
  });

  // ─── createSession dynamic budget wiring ───

  describe("createSession conflict-aware context wiring", () => {
    it("uses conflict-aware context when dependencyGraph is available", async () => {
      const depGraph = new GoalDependencyGraph(stateManager);
      const managerWithGraph = new SessionManager(stateManager, depGraph);

      await depGraph.addEdge({
        from_goal_id: "goal-A",
        to_goal_id: "goal-B",
        type: "resource_conflict",
        status: "active",
        condition: null,
        affected_dimensions: ["filesystem"],
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: null,
      });

      const session = await managerWithGraph.createSession("goal_review", "goal-A", null);
      const labels = session.context_slots.map((s) => s.label);
      expect(labels).toContain("resource_conflict_awareness");
    });

    it("falls back to basic context when no dependencyGraph is configured", async () => {
      const session = await manager.createSession("goal_review", "goal-A", null);
      const labels = session.context_slots.map((s) => s.label);
      expect(labels).not.toContain("resource_conflict_awareness");
      expect(labels).toContain("goal_definition");
    });
  });
});
