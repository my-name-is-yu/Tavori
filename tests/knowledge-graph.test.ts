import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { KnowledgeGraph } from "../src/knowledge/knowledge-graph.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeGraph(dir: string): KnowledgeGraph {
  return new KnowledgeGraph(path.join(dir, "graph.json"));
}

// ─── Test Setup ───

let tempDir: string;
let graph: KnowledgeGraph;

beforeEach(() => {
  tempDir = makeTempDir();
  graph = makeGraph(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// Node CRUD
// ═══════════════════════════════════════════════════════

describe("addNode", () => {
  it("adds a node and increases nodeCount", async () => {
    expect(graph.nodeCount).toBe(0);
    await graph.addNode("entry-1", "goal-A", ["tag1", "tag2"]);
    expect(graph.nodeCount).toBe(1);
  });

  it("stores correct node fields", async () => {
    await graph.addNode("entry-1", "goal-A", ["tag1", "tag2"]);
    const node = graph.getNode("entry-1");
    expect(node).toBeDefined();
    expect(node!.entry_id).toBe("entry-1");
    expect(node!.goal_id).toBe("goal-A");
    expect(node!.tags).toEqual(["tag1", "tag2"]);
    expect(node!.added_at).toBeTruthy();
  });

  it("duplicate ID updates existing node (upsert semantics)", async () => {
    await graph.addNode("entry-1", "goal-A", ["tag1"]);
    await graph.addNode("entry-1", "goal-B", ["tag2", "tag3"]);
    expect(graph.nodeCount).toBe(1);
    const node = graph.getNode("entry-1");
    expect(node!.goal_id).toBe("goal-B");
    expect(node!.tags).toEqual(["tag2", "tag3"]);
  });

  it("getAllNodes returns all added nodes", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addNode("e3", "goal-B", []);
    expect(graph.getAllNodes()).toHaveLength(3);
  });
});

describe("removeNode", () => {
  it("removes the node and decreases nodeCount", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.removeNode("e1");
    expect(graph.nodeCount).toBe(1);
    expect(graph.getNode("e1")).toBeUndefined();
  });

  it("removes associated edges when node is removed", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addNode("e3", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.8 });
    await graph.addEdge({ from_id: "e3", to_id: "e1", relation: "refines", confidence: 0.7 });
    await graph.addEdge({ from_id: "e2", to_id: "e3", relation: "depends_on", confidence: 0.9 });

    await graph.removeNode("e1");

    expect(graph.edgeCount).toBe(1); // only e2→e3 remains
    expect(graph.getEdgesFrom("e1")).toHaveLength(0);
    expect(graph.getEdgesTo("e1")).toHaveLength(0);
  });

  it("does nothing when removing a non-existent node", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.removeNode("does-not-exist"); // should not throw
    expect(graph.nodeCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// Edge CRUD
// ═══════════════════════════════════════════════════════

describe("addEdge", () => {
  it("creates an edge and increases edgeCount", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    expect(graph.edgeCount).toBe(0);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.9 });
    expect(graph.edgeCount).toBe(1);
  });

  it("auto-populates created_at timestamp", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    const before = new Date();
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.9 });
    const after = new Date();
    const edges = graph.getAllEdges();
    const ts = new Date(edges[0]!.created_at);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("replacing duplicate edge (same from/to/relation) keeps count stable", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.5 });
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.9 });
    expect(graph.edgeCount).toBe(1);
    expect(graph.getAllEdges()[0]!.confidence).toBe(0.9);
  });
});

describe("removeEdge", () => {
  it("removes a specific edge by from/to pair", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addNode("e3", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.8 });
    await graph.addEdge({ from_id: "e1", to_id: "e3", relation: "contradicts", confidence: 0.6 });

    await graph.removeEdge("e1", "e2");

    expect(graph.edgeCount).toBe(1);
    expect(graph.getEdgesFrom("e1")[0]!.to_id).toBe("e3");
  });

  it("removes all edges between two nodes regardless of relation", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.8 });
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "refines", confidence: 0.7 });

    await graph.removeEdge("e1", "e2");

    expect(graph.edgeCount).toBe(0);
  });

  it("does nothing when edge does not exist", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.removeEdge("e1", "e2"); // should not throw
    expect(graph.edgeCount).toBe(0);
  });
});

describe("getEdgesFrom / getEdgesTo", () => {
  beforeEach(async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addNode("e3", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.8 });
    await graph.addEdge({ from_id: "e1", to_id: "e3", relation: "refines", confidence: 0.7 });
    await graph.addEdge({ from_id: "e3", to_id: "e2", relation: "depends_on", confidence: 0.6 });
  });

  it("getEdgesFrom returns all outgoing edges", () => {
    const edges = graph.getEdgesFrom("e1");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.to_id).sort()).toEqual(["e2", "e3"]);
  });

  it("getEdgesFrom returns empty array for node with no outgoing edges", () => {
    expect(graph.getEdgesFrom("e2")).toHaveLength(0);
  });

  it("getEdgesTo returns all incoming edges", () => {
    const edges = graph.getEdgesTo("e2");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.from_id).sort()).toEqual(["e1", "e3"]);
  });

  it("getEdgesTo returns empty array for node with no incoming edges", () => {
    expect(graph.getEdgesTo("e1")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════

describe("getRelated", () => {
  it("returns related nodes with their edges", async () => {
    await graph.addNode("e1", "goal-A", ["tag1"]);
    await graph.addNode("e2", "goal-A", ["tag2"]);
    await graph.addNode("e3", "goal-A", ["tag3"]);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.9 });
    await graph.addEdge({ from_id: "e1", to_id: "e3", relation: "contradicts", confidence: 0.5 });

    const related = graph.getRelated("e1");
    expect(related).toHaveLength(2);

    const ids = related.map((r) => r.node.entry_id).sort();
    expect(ids).toEqual(["e2", "e3"]);

    const relations = related.map((r) => r.edge.relation).sort();
    expect(relations).toContain("supports");
    expect(relations).toContain("contradicts");
  });

  it("returns empty array for node with no outgoing edges", async () => {
    await graph.addNode("e1", "goal-A", []);
    expect(graph.getRelated("e1")).toHaveLength(0);
  });

  it("skips edges pointing to nodes not in the graph", async () => {
    // Edge points to a non-existent node
    await graph.addNode("e1", "goal-A", []);
    // Directly push an edge with a missing target (bypassing API)
    await graph.addEdge({ from_id: "e1", to_id: "missing-node", relation: "supports", confidence: 0.8 });
    const related = graph.getRelated("e1");
    expect(related).toHaveLength(0);
  });
});

describe("getContradictions", () => {
  it("returns only edges with relation=contradicts", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addNode("e3", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.9 });
    await graph.addEdge({ from_id: "e2", to_id: "e3", relation: "contradicts", confidence: 0.7 });
    await graph.addEdge({ from_id: "e1", to_id: "e3", relation: "contradicts", confidence: 0.6 });

    const contradictions = graph.getContradictions();
    expect(contradictions).toHaveLength(2);
    expect(contradictions.every((e) => e.relation === "contradicts")).toBe(true);
  });

  it("returns empty array when no contradictions exist", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.9 });
    expect(graph.getContradictions()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// Cycle Detection
// ═══════════════════════════════════════════════════════

describe("detectCycles", () => {
  it("detects a cycle in A→B→C→A", async () => {
    await graph.addNode("A", "goal-A", []);
    await graph.addNode("B", "goal-A", []);
    await graph.addNode("C", "goal-A", []);
    await graph.addEdge({ from_id: "A", to_id: "B", relation: "depends_on", confidence: 1.0 });
    await graph.addEdge({ from_id: "B", to_id: "C", relation: "depends_on", confidence: 1.0 });
    await graph.addEdge({ from_id: "C", to_id: "A", relation: "depends_on", confidence: 1.0 });

    const cycles = graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);

    // The cycle should contain A, B, C
    const cycleNodes = cycles.flat();
    expect(cycleNodes).toContain("A");
    expect(cycleNodes).toContain("B");
    expect(cycleNodes).toContain("C");
  });

  it("returns no cycles for a simple DAG", async () => {
    await graph.addNode("A", "goal-A", []);
    await graph.addNode("B", "goal-A", []);
    await graph.addNode("C", "goal-A", []);
    await graph.addEdge({ from_id: "A", to_id: "B", relation: "supports", confidence: 0.9 });
    await graph.addEdge({ from_id: "B", to_id: "C", relation: "supports", confidence: 0.9 });

    const cycles = graph.detectCycles();
    expect(cycles).toHaveLength(0);
  });

  it("returns no cycles for an empty graph", () => {
    expect(graph.detectCycles()).toHaveLength(0);
  });

  it("self-loop (A→A) is detected as a cycle", async () => {
    await graph.addNode("A", "goal-A", []);
    await graph.addEdge({ from_id: "A", to_id: "A", relation: "depends_on", confidence: 0.5 });

    const cycles = graph.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════

describe("Persistence", () => {
  it("save/load round-trip preserves nodes and edges", async () => {
    await graph.addNode("e1", "goal-A", ["tag1", "tag2"]);
    await graph.addNode("e2", "goal-B", ["tag3"]);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "refines", confidence: 0.85 });

    // Load fresh instance from the same path
    const graph2 = await KnowledgeGraph.create(path.join(tempDir, "graph.json"));
    expect(graph2.nodeCount).toBe(2);
    expect(graph2.edgeCount).toBe(1);

    const node = graph2.getNode("e1");
    expect(node!.goal_id).toBe("goal-A");
    expect(node!.tags).toEqual(["tag1", "tag2"]);

    const edge = graph2.getAllEdges()[0]!;
    expect(edge.from_id).toBe("e1");
    expect(edge.to_id).toBe("e2");
    expect(edge.relation).toBe("refines");
    expect(edge.confidence).toBe(0.85);
  });

  it("starts fresh when file does not exist", () => {
    const freshGraph = new KnowledgeGraph(
      path.join(tempDir, "nonexistent", "graph.json")
    );
    expect(freshGraph.nodeCount).toBe(0);
    expect(freshGraph.edgeCount).toBe(0);
  });

  it("creates parent directories on first save", async () => {
    const nestedPath = path.join(tempDir, "deep", "nested", "graph.json");
    const g = new KnowledgeGraph(nestedPath);
    await g.addNode("e1", "goal-A", []);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// clear
// ═══════════════════════════════════════════════════════

describe("clear", () => {
  it("removes all nodes and edges", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.addNode("e2", "goal-A", []);
    await graph.addEdge({ from_id: "e1", to_id: "e2", relation: "supports", confidence: 0.8 });

    await graph.clear();

    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
  });

  it("persists empty state after clear", async () => {
    await graph.addNode("e1", "goal-A", []);
    await graph.clear();

    const graph2 = await KnowledgeGraph.create(path.join(tempDir, "graph.json"));
    expect(graph2.nodeCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// _load() branch coverage
// ═══════════════════════════════════════════════════════

describe("_load via KnowledgeGraph.create", () => {
  it("starts empty when file does not exist (create on nonexistent path)", async () => {
    const g = await KnowledgeGraph.create(path.join(tempDir, "no-such-file.json"));
    expect(g.nodeCount).toBe(0);
    expect(g.edgeCount).toBe(0);
  });

  it("recovers from corrupt JSON — starts fresh", async () => {
    const filePath = path.join(tempDir, "corrupt.json");
    // Write corrupt JSON
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "{ this is not valid json !!! ", "utf-8");

    const g = await KnowledgeGraph.create(filePath);
    expect(g.nodeCount).toBe(0);
    expect(g.edgeCount).toBe(0);
  });

  it("handles file with null nodes/edges arrays gracefully", async () => {
    const filePath = path.join(tempDir, "null-arrays.json");
    const { writeFileSync } = await import("node:fs");
    // nodes and edges are missing — ?? [] fallback
    writeFileSync(filePath, JSON.stringify({}), "utf-8");

    const g = await KnowledgeGraph.create(filePath);
    expect(g.nodeCount).toBe(0);
    expect(g.edgeCount).toBe(0);
  });
});
