import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { ObservationEngine, registerObservationAllowRules } from "../observation-engine.js";
import { observeWithTools } from "../observation-tools.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { Dimension } from "../../../orchestrator/goal/types/goal.js";
import type { ObservationMethod } from "../../../base/types/core.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ToolPermissionManager } from "../../../tools/permission.js";

// ─── Helpers ───

function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  const defaultMethod: ObservationMethod = {
    type: "mechanical",
    source: "test",
    schedule: null,
    endpoint: "echo hello",
    confidence_tier: "mechanical",
  };
  return {
    name: "test_dim",
    label: "Test Dimension",
    current_value: 0,
    threshold: { type: "min" as const, value: 1 },
    confidence: 0.9,
    observation_method: defaultMethod,
    last_updated: new Date().toISOString(),
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok" as const,
    dimension_mapping: null,
    ...overrides,
  } as Dimension;
}

const ctx: ToolCallContext = {
  cwd: "/tmp/test",
  goalId: "test-goal",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => true,
};

// ─── Tests ───

describe("observeWithTools", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let engine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    engine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns null when no toolExecutor provided", async () => {
    const dim = makeDimension();
    const result = await engine.observeWithTools(dim, ctx);
    expect(result).toBeNull();
  });

  it("returns null when observation_method is undefined", async () => {
    const mockExecutor = { execute: vi.fn() } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({ observation_method: undefined as unknown as ObservationMethod });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).toBeNull();
  });

  it("returns null when endpoint is undefined", async () => {
    const mockExecutor = { execute: vi.fn() } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "mechanical",
        source: "test",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).toBeNull();
  });

  it("handles file_check type — files found", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: ["file1.ts", "file2.ts"], durationMs: 10, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "file_check",
        source: "test",
        schedule: null,
        endpoint: "src/**/*.ts",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("glob");
    expect(result!.parsedValue).toBe(1);
    expect(result!.confidence).toBe(0.98);
    expect(result!.rawData).toEqual(["file1.ts", "file2.ts"]);
  });

  it("handles file_check type — no files found", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: [], durationMs: 5, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "file_check",
        source: "test",
        schedule: null,
        endpoint: "nonexistent/**",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.parsedValue).toBe(0);
  });

  it("handles file_check type — tool failure returns null", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: false, data: null, durationMs: 5, summary: "error", error: "failed" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "file_check",
        source: "test",
        schedule: null,
        endpoint: "src/**",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).toBeNull();
  });

  it("handles mechanical type — success", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: "output", durationMs: 20, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension();
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("shell");
    expect(result!.confidence).toBe(0.95);
    expect(result!.parsedValue).toBe("output");
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      "shell",
      { command: "echo hello", timeoutMs: 30_000 },
      ctx,
    );
  });

  it("handles mechanical type — tool failure returns null", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: false, data: null, durationMs: 5, summary: "error", error: "exit 1" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension();
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).toBeNull();
  });

  it("handles api_query type — success", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: { status: "ok" }, durationMs: 50, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "api_query",
        source: "test",
        schedule: null,
        endpoint: "https://api.example.com/status",
        confidence_tier: "independent_review",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("http_fetch");
    expect(result!.confidence).toBe(0.90);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      "http_fetch",
      { url: "https://api.example.com/status", method: "GET" },
      ctx,
    );
  });

  it("handles api_query type — tool failure returns null", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: false, data: null, durationMs: 30, summary: "error", error: "timeout" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "api_query",
        source: "test",
        schedule: null,
        endpoint: "https://api.example.com/status",
        confidence_tier: "independent_review",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).toBeNull();
  });

  it("returns null for unsupported observation type (llm_review)", async () => {
    const mockExecutor = {
      execute: vi.fn(),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "llm_review",
        source: "test",
        schedule: null,
        endpoint: "some-endpoint",
        confidence_tier: "independent_review",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).toBeNull();
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });


  it("handles git_diff type — has changes", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: "diff --git a/file.ts", durationMs: 15, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "git_diff",
        source: "git",
        schedule: null,
        endpoint: "src/",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("git-diff");
    expect(result!.confidence).toBe(0.90);
    expect(result!.parsedValue).toBe(true);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      "git-diff",
      { target: "unstaged", path: "src/" },
      ctx,
    );
  });

  it("handles git_diff type — no changes", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: "", durationMs: 10, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "git_diff",
        source: "git",
        schedule: null,
        endpoint: "src/",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.parsedValue).toBe(false);
  });

  it("handles grep_check type — pattern found", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: "src/file.ts", durationMs: 20, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "grep_check",
        source: "filesystem",
        schedule: null,
        endpoint: "TODO",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("grep");
    expect(result!.confidence).toBe(0.92);
    expect(result!.parsedValue).toBe(true);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      "grep",
      { pattern: "TODO" },
      ctx,
    );
  });

  it("handles grep_check type — pattern not found", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: "", durationMs: 15, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "grep_check",
        source: "filesystem",
        schedule: null,
        endpoint: "FIXME",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.parsedValue).toBe(false);
  });

  it("handles test_run type — tests pass", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: { success: true, passed: 5, failed: 0 }, durationMs: 300, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "test_run",
        source: "test",
        schedule: null,
        endpoint: "npx vitest run",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("test-runner");
    expect(result!.confidence).toBe(0.95);
    expect(result!.parsedValue).toBe(true);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      "test-runner",
      { command: "npx vitest run" },
      ctx,
    );
  });

  it("handles test_run type — tests fail", async () => {
    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, data: { success: false, passed: 3, failed: 2 }, durationMs: 250, summary: "ok" }),
    } as unknown as ToolExecutor;
    const engineWithExecutor = new ObservationEngine(
      stateManager,
      [],
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      mockExecutor,
    );
    const dim = makeDimension({
      observation_method: {
        type: "test_run",
        source: "test",
        schedule: null,
        endpoint: "npx vitest run",
        confidence_tier: "mechanical",
      },
    });
    const result = await engineWithExecutor.observeWithTools(dim, ctx);
    expect(result).not.toBeNull();
    expect(result!.parsedValue).toBe(false);
  });

  it("observeWithTools returns null when toolExecutor.execute throws", async () => {
    const mockExecutor = {
      execute: vi.fn().mockRejectedValue(new Error("executor crashed")),
    } as unknown as ToolExecutor;
    const dim = makeDimension();
    const result = await observeWithTools(mockExecutor, dim, ctx);
    expect(result).toBeNull();
  });
});

describe("registerObservationAllowRules", () => {
  it("registers shell allow rules for mechanical dimensions", () => {
    const permissionManager = new ToolPermissionManager({});
    const addAllowRuleSpy = vi.spyOn(permissionManager, "addAllowRule");

    const dimensions: Dimension[] = [
      makeDimension({
        name: "dim1",
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: "npm test",
          confidence_tier: "mechanical",
        },
      }),
      makeDimension({
        name: "dim2",
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: "npx vitest run",
          confidence_tier: "mechanical",
        },
      }),
    ];

    registerObservationAllowRules(permissionManager, dimensions);

    expect(addAllowRuleSpy).toHaveBeenCalledTimes(2);
    expect(addAllowRuleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "shell", reason: expect.stringContaining("dim1") }),
    );
    expect(addAllowRuleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "shell", reason: expect.stringContaining("dim2") }),
    );
  });

  it("skips non-mechanical dimensions", () => {
    const permissionManager = new ToolPermissionManager({});
    const addAllowRuleSpy = vi.spyOn(permissionManager, "addAllowRule");

    const dimensions: Dimension[] = [
      makeDimension({
        name: "llm_dim",
        observation_method: {
          type: "llm_review",
          source: "test",
          schedule: null,
          endpoint: "some-endpoint",
          confidence_tier: "independent_review",
        },
      }),
      makeDimension({
        name: "file_dim",
        observation_method: {
          type: "file_check",
          source: "test",
          schedule: null,
          endpoint: "src/**/*.ts",
          confidence_tier: "mechanical",
        },
      }),
      makeDimension({
        name: "mech_no_endpoint",
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
      }),
    ];

    registerObservationAllowRules(permissionManager, dimensions);

    expect(addAllowRuleSpy).not.toHaveBeenCalled();
  });
});
