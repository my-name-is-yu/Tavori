import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import { MockLLMClient } from "../src/llm/llm-client.js";
import { GoalDependencyGraph } from "../src/goal/goal-dependency-graph.js";
import type { DependencyEdge } from "../src/types/dependency.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeEdge(
  from: string,
  to: string,
  type: DependencyEdge["type"] = "prerequisite",
  overrides: Partial<Omit<DependencyEdge, "created_at">> = {}
): Omit<DependencyEdge, "created_at"> {
  return {
    from_goal_id: from,
    to_goal_id: to,
    type,
    status: "active",
    condition: null,
    affected_dimensions: [],
    mitigation: null,
    detection_confidence: 1.0,
    reasoning: null,
    ...overrides,
  };
}

// ─── Tests ───

describe("GoalDependencyGraph", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let graph: GoalDependencyGraph;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    graph = new GoalDependencyGraph(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── addEdge ───

  describe("addEdge", () => {
    it("returns a DependencyEdge with created_at set", async () => {
      const edge = await graph.addEdge(makeEdge("goal-A", "goal-B"));
      expect(edge.from_goal_id).toBe("goal-A");
      expect(edge.to_goal_id).toBe("goal-B");
      expect(edge.type).toBe("prerequisite");
      expect(typeof edge.created_at).toBe("string");
      expect(new Date(edge.created_at).getTime()).not.toBeNaN();
    });

    it("adds nodes for both goals", async () => {
      await graph.addEdge(makeEdge("goal-X", "goal-Y"));
      const g = graph.getGraph();
      expect(g.nodes).toContain("goal-X");
      expect(g.nodes).toContain("goal-Y");
    });

    it("does not add duplicate nodes", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B"));
      await graph.addEdge(makeEdge("goal-A", "goal-C"));
      const g = graph.getGraph();
      expect(g.nodes.filter((n) => n === "goal-A")).toHaveLength(1);
    });

    it("adds multiple edges between different pairs", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B"));
      await graph.addEdge(makeEdge("goal-B", "goal-C"));
      expect(graph.getGraph().edges).toHaveLength(2);
    });

    it("allows non-prerequisite edge types without cycle check", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      await graph.addEdge(makeEdge("goal-B", "goal-A", "synergy")); // would be cycle if prerequisite, but not synergy
      expect(graph.getGraph().edges).toHaveLength(2);
    });

    it("throws if adding a prerequisite edge would create a cycle", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      await graph.addEdge(makeEdge("goal-B", "goal-C", "prerequisite"));
      await expect(
        graph.addEdge(makeEdge("goal-C", "goal-A", "prerequisite"))
      ).rejects.toThrow(/cycle/i);
    });

    it("persists edge to disk", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B"));
      const filePath = path.join(tmpDir, "dependency-graph.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  // ─── removeEdge ───

  describe("removeEdge", () => {
    it("removes a matching edge", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      graph.removeEdge("goal-A", "goal-B", "prerequisite");
      expect(graph.getGraph().edges).toHaveLength(0);
    });

    it("does not remove edges with different type", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      graph.removeEdge("goal-A", "goal-B", "prerequisite");
      expect(graph.getGraph().edges).toHaveLength(1);
    });

    it("does nothing if edge does not exist", () => {
      graph.removeEdge("goal-X", "goal-Y", "prerequisite");
      expect(graph.getGraph().edges).toHaveLength(0);
    });

    it("only removes the matching edge when multiple edges exist", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      graph.addEdge(makeEdge("goal-A", "goal-C", "synergy"));
      graph.removeEdge("goal-A", "goal-B", "synergy");
      expect(graph.getGraph().edges).toHaveLength(1);
      expect(graph.getGraph().edges[0]?.to_goal_id).toBe("goal-C");
    });
  });

  // ─── getEdges ───

  describe("getEdges", () => {
    it("returns all edges involving a goal (from or to)", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B"));
      graph.addEdge(makeEdge("goal-C", "goal-A"));
      graph.addEdge(makeEdge("goal-D", "goal-E")); // unrelated
      const edges = graph.getEdges("goal-A");
      expect(edges).toHaveLength(2);
    });

    it("returns empty array when goal has no edges", () => {
      expect(graph.getEdges("goal-unknown")).toHaveLength(0);
    });
  });

  // ─── getEdge ───

  describe("getEdge", () => {
    it("returns edge for matching from/to", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      const edge = graph.getEdge("goal-A", "goal-B");
      expect(edge).not.toBeNull();
      expect(edge?.type).toBe("synergy");
    });

    it("returns null for non-existent edge", () => {
      const edge = graph.getEdge("goal-A", "goal-Z");
      expect(edge).toBeNull();
    });

    it("filters by type when provided", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      expect(graph.getEdge("goal-A", "goal-B", "prerequisite")).toBeNull();
      expect(graph.getEdge("goal-A", "goal-B", "synergy")).not.toBeNull();
    });
  });

  // ─── updateEdgeStatus ───

  describe("updateEdgeStatus", () => {
    it("updates edge status to satisfied", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B"));
      graph.updateEdgeStatus("goal-A", "goal-B", "satisfied");
      const edge = graph.getEdge("goal-A", "goal-B");
      expect(edge?.status).toBe("satisfied");
    });

    it("does nothing if edge does not exist", () => {
      // Should not throw
      expect(() =>
        graph.updateEdgeStatus("goal-X", "goal-Y", "satisfied")
      ).not.toThrow();
    });
  });

  // ─── detectCycle ───

  describe("detectCycle", () => {
    it("detects a direct cycle", () => {
      graph.addEdge(makeEdge("goal-B", "goal-A", "prerequisite"));
      expect(graph.detectCycle("goal-A", "goal-B")).toBe(true);
    });

    it("detects a transitive cycle", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      graph.addEdge(makeEdge("goal-B", "goal-C", "prerequisite"));
      // Adding goal-C → goal-A would cycle: C→A→B→C
      expect(graph.detectCycle("goal-C", "goal-A")).toBe(true);
    });

    it("returns false when no cycle exists", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      expect(graph.detectCycle("goal-B", "goal-C")).toBe(false);
    });

    it("returns false for self-edge that does not form a cycle through existing edges", () => {
      // No edges: adding A→Z is not a cycle
      expect(graph.detectCycle("goal-A", "goal-Z")).toBe(false);
    });

    it("ignores non-prerequisite edges during cycle detection", () => {
      // synergy edges should not be considered for cycle detection
      graph.addEdge(makeEdge("goal-B", "goal-A", "synergy"));
      // Since only synergy edges, no cycle in prerequisite path
      expect(graph.detectCycle("goal-A", "goal-B")).toBe(false);
    });

    it("ignores satisfied prerequisite edges during cycle detection", () => {
      graph.addEdge(makeEdge("goal-B", "goal-A", "prerequisite", { status: "satisfied" }));
      // Satisfied edge should not count as forming a cycle
      expect(graph.detectCycle("goal-A", "goal-B")).toBe(false);
    });
  });

  // ─── isBlocked / getBlockingGoals ───

  describe("isBlocked", () => {
    it("returns true when goal has active prerequisites", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite")); // A must complete before B
      expect(graph.isBlocked("goal-B")).toBe(true);
    });

    it("returns false when goal has no prerequisites", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      expect(graph.isBlocked("goal-A")).toBe(false);
    });

    it("returns false when all prerequisites are satisfied", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      graph.updateEdgeStatus("goal-A", "goal-B", "satisfied");
      expect(graph.isBlocked("goal-B")).toBe(false);
    });

    it("returns false for a goal with no edges", () => {
      expect(graph.isBlocked("goal-X")).toBe(false);
    });
  });

  describe("getBlockingGoals", () => {
    it("returns IDs of blocking goals", () => {
      graph.addEdge(makeEdge("goal-A", "goal-C", "prerequisite"));
      graph.addEdge(makeEdge("goal-B", "goal-C", "prerequisite"));
      const blocking = graph.getBlockingGoals("goal-C");
      expect(blocking).toContain("goal-A");
      expect(blocking).toContain("goal-B");
      expect(blocking).toHaveLength(2);
    });

    it("returns empty array when goal is not blocked", () => {
      expect(graph.getBlockingGoals("goal-X")).toHaveLength(0);
    });
  });

  // ─── getResourceConflicts / getSynergyPartners ───

  describe("getResourceConflicts", () => {
    it("returns resource_conflict edges involving a goal", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "resource_conflict"));
      const conflicts = graph.getResourceConflicts("goal-A");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.type).toBe("resource_conflict");
    });

    it("returns empty array when no resource conflicts exist", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      expect(graph.getResourceConflicts("goal-A")).toHaveLength(0);
    });

    it("detects conflicts where goal is the target", () => {
      graph.addEdge(makeEdge("goal-X", "goal-Y", "resource_conflict"));
      expect(graph.getResourceConflicts("goal-Y")).toHaveLength(1);
    });
  });

  describe("getSynergyPartners", () => {
    it("returns partner goal IDs for synergy edges", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      const partners = graph.getSynergyPartners("goal-A");
      expect(partners).toContain("goal-B");
    });

    it("returns partner from both sides of the edge", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "synergy"));
      expect(graph.getSynergyPartners("goal-B")).toContain("goal-A");
    });

    it("returns empty array when no synergy edges exist", () => {
      expect(graph.getSynergyPartners("goal-X")).toHaveLength(0);
    });

    it("ignores non-synergy edges", () => {
      graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      expect(graph.getSynergyPartners("goal-A")).toHaveLength(0);
    });
  });

  // ─── Persistence ───

  describe("persistence (save / load)", () => {
    it("loads an empty graph when no file exists", () => {
      const freshGraph = new GoalDependencyGraph(stateManager);
      expect(freshGraph.getGraph().edges).toHaveLength(0);
      expect(freshGraph.getGraph().nodes).toHaveLength(0);
    });

    it("persists and reloads edges correctly", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      await graph.addEdge(makeEdge("goal-B", "goal-C", "synergy"));

      const freshGraph = new GoalDependencyGraph(stateManager);
      await freshGraph.init();
      expect(freshGraph.getGraph().edges).toHaveLength(2);
      expect(freshGraph.getGraph().nodes).toContain("goal-A");
      expect(freshGraph.getGraph().nodes).toContain("goal-B");
      expect(freshGraph.getGraph().nodes).toContain("goal-C");
    });

    it("persists edge status updates", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      await graph.updateEdgeStatus("goal-A", "goal-B", "satisfied");

      const freshGraph = new GoalDependencyGraph(stateManager);
      await freshGraph.init();
      const edge = freshGraph.getEdge("goal-A", "goal-B");
      expect(edge?.status).toBe("satisfied");
    });

    it("persists removals", async () => {
      await graph.addEdge(makeEdge("goal-A", "goal-B", "prerequisite"));
      await graph.removeEdge("goal-A", "goal-B", "prerequisite");

      const freshGraph = new GoalDependencyGraph(stateManager);
      await freshGraph.init();
      expect(freshGraph.getGraph().edges).toHaveLength(0);
    });
  });

  // ─── autoDetectDependencies ───

  describe("autoDetectDependencies", () => {
    it("returns empty array when no llmClient is provided", async () => {
      const graphNoLLM = new GoalDependencyGraph(stateManager);
      const result = await graphNoLLM.autoDetectDependencies("goal-new", ["goal-A"]);
      expect(result).toHaveLength(0);
    });

    it("returns empty array when existingGoalIds is empty", async () => {
      const mockLLM = new MockLLMClient(["[]"]);
      const graphWithLLM = new GoalDependencyGraph(stateManager, mockLLM);
      const result = await graphWithLLM.autoDetectDependencies("goal-new", []);
      expect(result).toHaveLength(0);
    });

    it("parses LLM response and adds detected edges to graph", async () => {
      const mockResponse = JSON.stringify([
        {
          from_goal_id: "goal-A",
          to_goal_id: "goal-new",
          type: "prerequisite",
          condition: "goal-A must be 80% complete",
          affected_dimensions: ["coverage"],
          reasoning: "New goal builds on goal-A output",
          detection_confidence: 0.9,
        },
      ]);

      const mockLLM = new MockLLMClient([mockResponse]);
      const graphWithLLM = new GoalDependencyGraph(stateManager, mockLLM);
      const result = await graphWithLLM.autoDetectDependencies("goal-new", ["goal-A"]);

      expect(result).toHaveLength(1);
      expect(result[0]?.from_goal_id).toBe("goal-A");
      expect(result[0]?.to_goal_id).toBe("goal-new");
      expect(result[0]?.type).toBe("prerequisite");
      expect(result[0]?.detection_confidence).toBe(0.9);
    });

    it("returns empty array when LLM returns invalid JSON", async () => {
      const mockLLM = new MockLLMClient(["not valid json"]);
      const graphWithLLM = new GoalDependencyGraph(stateManager, mockLLM);
      const result = await graphWithLLM.autoDetectDependencies("goal-new", ["goal-A"]);
      expect(result).toHaveLength(0);
    });

    it("returns empty array when LLM returns empty array", async () => {
      const mockLLM = new MockLLMClient(["[]"]);
      const graphWithLLM = new GoalDependencyGraph(stateManager, mockLLM);
      const result = await graphWithLLM.autoDetectDependencies("goal-new", ["goal-A"]);
      expect(result).toHaveLength(0);
    });

    it("persists detected edges to disk", async () => {
      const mockResponse = JSON.stringify([
        {
          from_goal_id: "goal-A",
          to_goal_id: "goal-new",
          type: "synergy",
          condition: null,
          affected_dimensions: [],
          reasoning: "Synergy exists",
          detection_confidence: 0.7,
        },
      ]);

      const mockLLM = new MockLLMClient([mockResponse]);
      const graphWithLLM = new GoalDependencyGraph(stateManager, mockLLM);
      await graphWithLLM.autoDetectDependencies("goal-new", ["goal-A"]);

      const freshGraph = new GoalDependencyGraph(stateManager);
      await freshGraph.init();
      expect(freshGraph.getGraph().edges).toHaveLength(1);
    });

    it("calls LLM exactly once per autoDetect call", async () => {
      const mockLLM = new MockLLMClient(["[]"]);
      const graphWithLLM = new GoalDependencyGraph(stateManager, mockLLM);
      await graphWithLLM.autoDetectDependencies("goal-new", ["goal-A", "goal-B"]);
      expect(mockLLM.callCount).toBe(1);
    });
  });
});
