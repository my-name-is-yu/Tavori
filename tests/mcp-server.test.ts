// ─── MCP Server Tool Tests ───

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state/state-manager.js";
import {
  toolGoalList,
  toolGoalStatus,
  toolGoalCreate,
  toolObserve,
  toolTaskList,
  toolKnowledgeSearch,
  toolTrigger,
  type MCPServerDeps,
} from "../src/mcp-server/tools.js";

// ─── Helpers ───

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-mcp-test-"));
}

function parseMCPText(result: { content: [{ type: string; text: string }] }): unknown {
  return JSON.parse(result.content[0].text);
}

function makeDeps(baseDir: string): MCPServerDeps {
  const stateManager = new StateManager(baseDir);
  return { stateManager, baseDir };
}

async function createGoalFile(baseDir: string, id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  const goalDir = path.join(baseDir, "goals", id);
  await fsp.mkdir(goalDir, { recursive: true });
  const goal = {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Test Goal ${id}`,
    description: "A test goal",
    status: "active",
    dimensions: [],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: "manual",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  await fsp.writeFile(path.join(goalDir, "goal.json"), JSON.stringify(goal), "utf-8");
}

// ─── Tests ───

describe("pulseed_goal_list", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty list when no goals", async () => {
    const result = await toolGoalList(deps);
    const data = parseMCPText(result) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it("returns goals with correct fields", async () => {
    await createGoalFile(tmpDir, "goal-1");
    await createGoalFile(tmpDir, "goal-2");

    const result = await toolGoalList(deps);
    const data = parseMCPText(result) as Array<{ id: string; title: string; status: string; loop_status: string }>;

    expect(data).toHaveLength(2);
    const ids = data.map((g) => g.id).sort();
    expect(ids).toEqual(["goal-1", "goal-2"]);
    for (const g of data) {
      expect(g.title).toBeDefined();
      expect(g.status).toBeDefined();
      expect(g.loop_status).toBeDefined();
    }
  });
});

describe("pulseed_goal_status", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error for unknown goal", async () => {
    const result = await toolGoalStatus(deps, { goal_id: "nonexistent" });
    const data = parseMCPText(result) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  it("returns goal and gap for valid goal_id", async () => {
    await createGoalFile(tmpDir, "goal-abc");

    const result = await toolGoalStatus(deps, { goal_id: "goal-abc" });
    const data = parseMCPText(result) as { goal: { id: string }; latest_gap: unknown };
    expect(data.goal.id).toBe("goal-abc");
    expect(data.latest_gap).toBeNull();
  });
});

describe("pulseed_goal_create", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a goal file and returns goal_id", async () => {
    const result = await toolGoalCreate(deps, { title: "My Goal", description: "Do something" });
    const data = parseMCPText(result) as { goal_id: string; title: string; status: string };

    expect(data.goal_id).toBeDefined();
    expect(data.title).toBe("My Goal");
    expect(data.status).toBe("pending");

    // Verify the file was created
    const filePath = path.join(tmpDir, "goals", data.goal_id, "goal.json");
    const raw = await fsp.readFile(filePath, "utf-8");
    const saved = JSON.parse(raw);
    expect(saved.title).toBe("My Goal");
  });
});

describe("pulseed_knowledge_search", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty results when knowledge base is empty", async () => {
    const result = await toolKnowledgeSearch(deps, { query: "anything" });
    const data = parseMCPText(result) as { query: string; results: unknown[] };
    expect(data.query).toBe("anything");
    expect(data.results).toHaveLength(0);
  });
});

describe("pulseed_trigger", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates an event file", async () => {
    const result = await toolTrigger(deps, {
      source: "test",
      event_type: "test.event",
      data: { key: "value" },
    });
    const data = parseMCPText(result) as { event_id: string; status: string };
    expect(data.event_id).toBeDefined();
    expect(data.status).toBe("queued");

    // Verify file was created
    const filePath = path.join(tmpDir, "events", `${data.event_id}.json`);
    const raw = await fsp.readFile(filePath, "utf-8");
    const event = JSON.parse(raw);
    expect(event.source).toBe("test");
    expect(event.event_type).toBe("test.event");
    expect(event.data.key).toBe("value");
  });
});
