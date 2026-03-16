import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ShellDataSourceAdapter } from "../../src/adapters/shell-datasource.js";
import { ObservationEngine } from "../../src/observation-engine.js";
import { StateManager } from "../../src/state-manager.js";
import type { Goal } from "../../src/types/goal.js";
import type { ObservationMethod } from "../../src/types/core.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-shell-ds-test-"));
}

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "shell-datasource",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "test",
    status: "active",
    dimensions: overrides.dimensions ?? [
      {
        name: "todo_count",
        label: "TODO Count",
        current_value: 5,
        threshold: { type: "max", value: 0 },
        confidence: 0.5,
        observation_method: defaultMethod,
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ─── Tests ───

describe("ShellDataSourceAdapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. observe() with output_type "number" via echo
  it('observe(["count"]) with argv echo "42" and output_type "number" returns {count: 42}', async () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      count: { argv: ["echo", "42"], output_type: "number" },
    });

    const result = await adapter.observe(["count"]);
    expect(result).toEqual({ count: 42 });
  });

  // 2. observe() with output_type "boolean" — stdout "1" → 1
  it('observe(["flag"]) with argv echo "1" and output_type "boolean" returns {flag: 1}', async () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      flag: { argv: ["echo", "1"], output_type: "boolean" },
    });

    const result = await adapter.observe(["flag"]);
    expect(result).toEqual({ flag: 1 });
  });

  // 3. observe() with output_type "boolean" — stdout "false" → 0
  it('observe(["flag"]) with argv echo "false" and output_type "boolean" returns {flag: 0}', async () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      flag: { argv: ["echo", "false"], output_type: "boolean" },
    });

    const result = await adapter.observe(["flag"]);
    expect(result).toEqual({ flag: 0 });
  });

  // 4. observe() with unknown dimension (no command defined) returns {}
  it('observe(["unknown"]) when no command defined for "unknown" returns {}', async () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      count: { argv: ["echo", "5"], output_type: "number" },
    });

    const result = await adapter.observe(["unknown"]);
    expect(result).toEqual({});
  });

  // 5. getSupportedDimensions() returns keys from commands
  it("getSupportedDimensions() returns keys from commands", () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      todo_count: { argv: ["grep", "-rc", "TODO", "src/"], output_type: "number" },
      fixme_count: { argv: ["grep", "-rc", "FIXME", "src/"], output_type: "number" },
    });

    const dims = adapter.getSupportedDimensions();
    expect(dims).toContain("todo_count");
    expect(dims).toContain("fixme_count");
    expect(dims).toHaveLength(2);
  });

  // 6. grep exit code 1 (zero matches) → returns 0 for that dimension
  it("grep exit code 1 (zero matches) returns 0 for that dimension", async () => {
    // grep returns exit 1 when no matches found
    // We search for a string that is extremely unlikely to exist
    const adapter = new ShellDataSourceAdapter(
      "ds_shell_test",
      {
        rare_count: {
          argv: ["grep", "-r", "__MOTIVA_UNLIKELY_TOKEN_XYZ_9999__", "."],
          output_type: "number",
          cwd: tmpDir,
        },
      },
      tmpDir
    );

    // Create a file so grep has something to scan (just returns exit 1 with no matches)
    fs.writeFileSync(path.join(tmpDir, "dummy.txt"), "no special tokens here");

    const result = await adapter.observe(["rare_count"]);
    expect(result).toEqual({ rare_count: 0 });
  });

  // 7. Multi-line grep -c output sums to correct total
  it("multi-line grep -c output (e.g. src/a.ts:2 + src/b.ts:1) sums to 3", async () => {
    // Create files with TODO comments
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "// TODO first\n// TODO second\n");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "// TODO third\n");

    const adapter = new ShellDataSourceAdapter(
      "ds_shell_test",
      {
        todo_count: {
          argv: ["grep", "-rc", "TODO", "."],
          output_type: "number",
          cwd: tmpDir,
        },
      },
      tmpDir
    );

    const result = await adapter.observe(["todo_count"]);
    expect(result["todo_count"]).toBe(3);
  });

  // 8. Integration: ShellDataSourceAdapter registered with ObservationEngine triggers mechanical layer
  it("registered with ObservationEngine, observe() records a mechanical-layer entry", async () => {
    const stateDir = makeTempDir();
    const stateManager = new StateManager(stateDir);

    const adapter = new ShellDataSourceAdapter("ds_shell_integration", {
      todo_count: { argv: ["echo", "3"], output_type: "number" },
    });

    const engine = new ObservationEngine(stateManager, [adapter]);

    const goal = makeGoal({
      id: "goal-shell-integration",
      dimensions: [
        {
          name: "todo_count",
          label: "TODO Count",
          current_value: 5,
          threshold: { type: "max", value: 0 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });

    await stateManager.saveGoal(goal);

    // observeFromDataSource() is the engine method that uses registered adapters
    const entry = await engine.observeFromDataSource(
      goal.id,
      "todo_count",
      "ds_shell_integration"
    );

    expect(entry.layer).toBe("mechanical");
    expect(entry.extracted_value).toBe(3);
    expect(entry.confidence).toBeGreaterThanOrEqual(0.85);
    expect(entry.goal_id).toBe(goal.id);
    expect(entry.dimension_name).toBe("todo_count");

    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
