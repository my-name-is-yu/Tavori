import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ShellDataSourceAdapter } from "../../src/adapters/datasources/shell-datasource.js";
import { ObservationEngine } from "../../src/observation/observation-engine.js";
import { StateManager } from "../../src/state/state-manager.js";
import type { Goal } from "../../src/types/goal.js";
import type { ObservationMethod } from "../../src/types/core.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeGoal } from "../helpers/fixtures.js";

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "shell-datasource",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

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

  // 3b. observe() with output_type "raw" — stdout "73.98" → 73.98 (covers test_coverage use case)
  it('observe(["coverage"]) with argv echo "73.98" and output_type "raw" returns {coverage: 73.98}', async () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      coverage: { argv: ["echo", "73.98"], output_type: "raw" },
    });

    const result = await adapter.observe(["coverage"]);
    expect(result).toEqual({ coverage: 73.98 });
  });

  // 3c. observe() with output_type "raw" — stdout "0" → 0 (parseFloat("0") must NOT fallback to NaN)
  it('observe(["coverage"]) with argv echo "0" and output_type "raw" returns {coverage: 0}', async () => {
    const adapter = new ShellDataSourceAdapter("ds_shell_test", {
      coverage: { argv: ["echo", "0"], output_type: "raw" },
    });

    const result = await adapter.observe(["coverage"]);
    expect(result).toEqual({ coverage: 0 });
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
          argv: ["grep", "-r", "__PULSEED_UNLIKELY_TOKEN_XYZ_9999__", "."],
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

  // shell binary blocklist tests
  describe("shell binary blocklist", () => {
    it("throws when argv[0] is 'bash'", () => {
      expect(() => new ShellDataSourceAdapter("ds_test", {
        count: { argv: ["bash", "-c", "echo 1"], output_type: "number" },
      })).toThrow(/Shell binary "bash" is not allowed/);
    });

    it("throws when argv[0] is 'sh'", () => {
      expect(() => new ShellDataSourceAdapter("ds_test", {
        count: { argv: ["sh", "-c", "echo 1"], output_type: "number" },
      })).toThrow(/Shell binary "sh" is not allowed/);
    });

    it("throws when argv[0] is 'zsh'", () => {
      expect(() => new ShellDataSourceAdapter("ds_test", {
        count: { argv: ["zsh", "-c", "echo 1"], output_type: "number" },
      })).toThrow(/Shell binary "zsh" is not allowed/);
    });

    it("throws when argv[0] is 'powershell'", () => {
      expect(() => new ShellDataSourceAdapter("ds_test", {
        count: { argv: ["powershell", "-Command", "Write-Output 1"], output_type: "number" },
      })).toThrow(/Shell binary "powershell" is not allowed/);
    });

    it("throws when argv[0] is '/bin/bash' (full path blocked via basename)", () => {
      expect(() => new ShellDataSourceAdapter("ds_test", {
        count: { argv: ["/bin/bash", "-c", "echo 1"], output_type: "number" },
      })).toThrow(/Shell binary "\/bin\/bash" is not allowed/);
    });

    it("does NOT throw for safe binaries like 'grep' or 'echo'", () => {
      expect(() => new ShellDataSourceAdapter("ds_test", {
        count: { argv: ["grep", "-rc", "TODO", "src/"], output_type: "number" },
        flag: { argv: ["echo", "1"], output_type: "boolean" },
      })).not.toThrow();
    });
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
