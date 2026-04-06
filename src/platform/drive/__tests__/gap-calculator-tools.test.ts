import { describe, it, expect, vi } from "vitest";
import {
  needsDirectMeasurement,
  measureDirectly,
} from "../gap-calculator-tools.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext, ToolResult } from "../../../tools/types.js";

// ─── Fixtures ───

const baseContext: ToolCallContext = {
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => true,
};

function makeDimension(
  overrides: Partial<Dimension> = {},
): Dimension {
  return {
    name: "test_dim",
    label: "Test",
    current_value: null,
    threshold: { type: "min", value: 80 },
    confidence: 0.5,
    observation_method: {
      type: "mechanical",
      source: "shell",
      schedule: null,
      endpoint: "npx vitest run",
      confidence_tier: "mechanical",
    },
    last_updated: null,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
    ...overrides,
  };
}

function makeToolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    success: true,
    data: { stdout: "85", stderr: "", exitCode: 0 },
    summary: "ok",
    durationMs: 10,
    ...overrides,
  };
}

function makeExecutor(result: ToolResult): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
    executeBatch: vi.fn().mockResolvedValue([result]),
  } as unknown as ToolExecutor;
}

// ─── needsDirectMeasurement ───

describe("needsDirectMeasurement", () => {
  it("returns true when confidence < 0.6", () => {
    expect(needsDirectMeasurement(makeDimension({ confidence: 0.0 }))).toBe(true);
    expect(needsDirectMeasurement(makeDimension({ confidence: 0.59 }))).toBe(true);
  });

  it("returns false when confidence >= 0.6", () => {
    expect(needsDirectMeasurement(makeDimension({ confidence: 0.6 }))).toBe(false);
    expect(needsDirectMeasurement(makeDimension({ confidence: 1.0 }))).toBe(false);
  });
});

// ─── measureDirectly ───

describe("measureDirectly", () => {
  describe("returns null when not applicable", () => {
    it("returns null when endpoint is null", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "mechanical",
          source: "shell",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult());
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).toBeNull();
    });

    it("returns null for llm_review observation type", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "llm_review",
          source: "llm",
          schedule: null,
          endpoint: "some-endpoint",
          confidence_tier: "independent_review",
        },
      });
      const executor = makeExecutor(makeToolResult());
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).toBeNull();
    });

    it("returns null for manual observation type", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "manual",
          source: "human",
          schedule: null,
          endpoint: "some-endpoint",
          confidence_tier: "self_report",
        },
      });
      const executor = makeExecutor(makeToolResult());
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).toBeNull();
    });

    it("returns null when tool call fails", async () => {
      const dim = makeDimension();
      const executor = makeExecutor(makeToolResult({ success: false, data: null, error: "cmd not found" }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).toBeNull();
    });
  });

  describe("mechanical -> shell", () => {
    it("parses numeric stdout", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "mechanical",
          source: "shell",
          schedule: null,
          endpoint: "wc -l src/*.ts",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { stdout: "42", stderr: "", exitCode: 0 } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).not.toBeNull();
      expect(result!.value).toBe(42);
      expect(result!.confidence).toBe(0.95);
      expect(result!.toolUsed).toBe("shell");
      expect(result!.measuredAt).toBeInstanceOf(Date);
    });

    it("returns string for non-numeric stdout", async () => {
      const dim = makeDimension();
      const executor = makeExecutor(makeToolResult({ data: { stdout: "passed", stderr: "", exitCode: 0 } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe("passed");
    });

    it("passes correct input to executor", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "mechanical",
          source: "shell",
          schedule: null,
          endpoint: "npm test",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult());
      await measureDirectly(dim, executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "shell",
        { command: "npm test", timeoutMs: 30_000 },
        baseContext,
      );
    });
  });

  describe("file_check -> glob", () => {
    it("returns true when files are found", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "file_check",
          source: "filesystem",
          schedule: null,
          endpoint: "dist/index.js",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: ["dist/index.js"] }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe(1);
      expect(result!.confidence).toBe(0.98);
      expect(result!.toolUsed).toBe("glob");
    });

    it("returns false when no files match", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "file_check",
          source: "filesystem",
          schedule: null,
          endpoint: "dist/missing.js",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: [] }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe(0);
    });

    it("passes pattern as glob input", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "file_check",
          source: "filesystem",
          schedule: null,
          endpoint: "src/**/*.ts",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: [] }));
      await measureDirectly(dim, executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "glob",
        { pattern: "src/**/*.ts" },
        baseContext,
      );
    });
  });

  describe("api_query -> http_fetch", () => {
    it("returns true for 200 status", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "api_query",
          source: "http",
          schedule: null,
          endpoint: "http://localhost:3000/health",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { statusCode: 200, body: "ok" } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe(true);
      expect(result!.confidence).toBe(0.90);
      expect(result!.toolUsed).toBe("http_fetch");
    });

    it("returns true for 201 status (created)", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "api_query",
          source: "http",
          schedule: null,
          endpoint: "http://localhost:3000/resource",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { statusCode: 201, body: "created" } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe(true);
    });

    it("returns true for 204 status (no content)", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "api_query",
          source: "http",
          schedule: null,
          endpoint: "http://localhost:3000/resource",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { statusCode: 204, body: "" } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe(true);
    });

    it("returns false for non-200 status", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "api_query",
          source: "http",
          schedule: null,
          endpoint: "http://localhost:3000/health",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { statusCode: 503, body: "down" } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result!.value).toBe(false);
    });

    it("passes URL and method to executor", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "api_query",
          source: "http",
          schedule: null,
          endpoint: "https://api.example.com/status",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { statusCode: 200 } }));
      await measureDirectly(dim, executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "http_fetch",
        { url: "https://api.example.com/status", method: "GET" },
        baseContext,
      );
    });
  });

  describe("git_diff -> git-diff", () => {
    it("resolves to git-diff tool name", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "git_diff",
          source: "git",
          schedule: null,
          endpoint: "src/",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: "diff output" }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).not.toBeNull();
      expect(result!.toolUsed).toBe("git-diff");
      expect(result!.confidence).toBe(0.90);
    });

    it("passes correct input to executor", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "git_diff",
          source: "git",
          schedule: null,
          endpoint: "src/platform/",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: "" }));
      await measureDirectly(dim, executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "git-diff",
        { target: "unstaged", path: "src/platform/" },
        baseContext,
      );
    });
  });

  describe("grep_check -> grep", () => {
    it("resolves to grep tool name", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "grep_check",
          source: "filesystem",
          schedule: null,
          endpoint: "TODO",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: "file.ts:42:TODO fix this" }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).not.toBeNull();
      expect(result!.toolUsed).toBe("grep");
      expect(result!.confidence).toBe(0.92);
    });

    it("passes correct input to executor", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "grep_check",
          source: "filesystem",
          schedule: null,
          endpoint: "TODO",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: "" }));
      await measureDirectly(dim, executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "grep",
        { pattern: "TODO" },
        baseContext,
      );
    });
  });

  describe("test_run -> test-runner", () => {
    it("resolves to test-runner tool name", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "test_run",
          source: "test",
          schedule: null,
          endpoint: "npx vitest run",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { success: true, passed: 10, failed: 0 } }));
      const result = await measureDirectly(dim, executor, baseContext);
      expect(result).not.toBeNull();
      expect(result!.toolUsed).toBe("test-runner");
      expect(result!.confidence).toBe(0.95);
    });

    it("passes correct input to executor", async () => {
      const dim = makeDimension({
        observation_method: {
          type: "test_run",
          source: "test",
          schedule: null,
          endpoint: "npm test",
          confidence_tier: "mechanical",
        },
      });
      const executor = makeExecutor(makeToolResult({ data: { success: true, passed: 5, failed: 0 } }));
      await measureDirectly(dim, executor, baseContext);
      expect(executor.execute).toHaveBeenCalledWith(
        "test-runner",
        { command: "npm test" },
        baseContext,
      );
    });
  });
});
