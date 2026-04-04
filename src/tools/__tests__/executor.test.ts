// src/tools/__tests__/executor.test.ts

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ToolPermissionManager } from "../permission.js";
import { ConcurrencyController } from "../concurrency.js";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
} from "../types.js";

// --- Mock Helpers ---

const defaultInputSchema = z.object({ value: z.string() });
type DefaultInput = z.infer<typeof defaultInputSchema>;

function createMockTool(
  overrides: Partial<ITool> & { name?: string } = {},
): ITool<DefaultInput> {
  const name = overrides.name ?? "mock-tool";
  const base: ITool<DefaultInput> = {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: [],
      ...((overrides as ITool).metadata ?? {}),
    },
    inputSchema: defaultInputSchema as z.ZodType<DefaultInput>,
    description: () => `Mock tool: ${name}`,
    call: vi.fn().mockResolvedValue({
      success: true,
      data: { result: "ok" },
      summary: "success",
      durationMs: 10,
    } as ToolResult),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
    isConcurrencySafe: vi.fn().mockReturnValue(true),
    ...overrides,
  };
  return base;
}

function createMockContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createExecutor(registeredTools: ITool[] = []) {
  const registry = new ToolRegistry();
  for (const tool of registeredTools) {
    registry.register(tool);
  }
  const permissionManager = new ToolPermissionManager({});
  const concurrency = new ConcurrencyController();
  const executor = new ToolExecutor({ registry, permissionManager, concurrency });
  return { executor, registry, permissionManager, concurrency };
}

// --- Tests ---

describe("ToolExecutor", () => {
  describe("execute()", () => {
    it("returns fail result when tool is not found", async () => {
      const { executor } = createExecutor();
      const ctx = createMockContext();
      const result = await executor.execute("nonexistent", {}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    describe("Gate 1 — Input validation", () => {
      it("rejects input that fails Zod schema", async () => {
        const tool = createMockTool();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        // Missing required "value" field
        const result = await executor.execute("mock-tool", { wrong: 123 }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Input validation failed");
      });

      it("accepts valid input", async () => {
        const tool = createMockTool();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "hello" }, ctx);
        expect(result.success).toBe(true);
      });
    });

    describe("Gate 2 — Semantic validation", () => {
      it("returns fail when checkPermissions returns denied", async () => {
        const tool = createMockTool({
          checkPermissions: vi.fn().mockResolvedValue({
            status: "denied",
            reason: "not allowed semantically",
          } as PermissionCheckResult),
        });
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("not allowed semantically");
      });

      it("proceeds when checkPermissions returns allowed", async () => {
        const tool = createMockTool({
          checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
        });
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(true);
      });
    });

    describe("Gate 3 — Permission manager", () => {
      it("denies when permission manager denies via deny-list", async () => {
        const tool = createMockTool({
          name: "blocked-tool",
          metadata: {
            name: "blocked-tool",
            aliases: [],
            permissionLevel: "read_only",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const registry = new ToolRegistry();
        registry.register(tool);
        const permissionManager = new ToolPermissionManager({
          denyRules: [{ toolName: "blocked-tool", reason: "blocked by policy" }],
        });
        const concurrency = new ConcurrencyController();
        const executor = new ToolExecutor({ registry, permissionManager, concurrency });
        const ctx = createMockContext();
        const result = await executor.execute("blocked-tool", { value: "x" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("blocked by policy");
      });

      it("calls approvalFn when trust balance is low for write_local", async () => {
        const tool = createMockTool({
          name: "write-tool",
          metadata: {
            name: "write-tool",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(true);
        const ctx = createMockContext({ trustBalance: -50, approvalFn });
        await executor.execute("write-tool", { value: "x" }, ctx);
        expect(approvalFn).toHaveBeenCalled();
      });

      it("returns fail when user denies approval", async () => {
        const tool = createMockTool({
          name: "write-tool2",
          metadata: {
            name: "write-tool2",
            aliases: [],
            permissionLevel: "write_local",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
        });
        const { executor } = createExecutor([tool]);
        const approvalFn = vi.fn().mockResolvedValue(false);
        const ctx = createMockContext({ trustBalance: -50, approvalFn });
        const result = await executor.execute("write-tool2", { value: "x" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("User denied approval");
      });
    });

    describe("Gate 4 — Input sanitization", () => {
      it("blocks shell injection patterns for shell tool", async () => {
        const shellTool = createMockTool({
          name: "shell",
          metadata: {
            name: "shell",
            aliases: [],
            permissionLevel: "read_metrics",
            isReadOnly: false,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 8000,
            tags: [],
          } as ITool["metadata"],
          inputSchema: z.object({ value: z.string(), command: z.string() }) as unknown as z.ZodType<DefaultInput>,
          checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
        });
        const registry = new ToolRegistry();
        registry.register(shellTool);
        const permissionManager = new ToolPermissionManager({
          allowRules: [{ toolName: "shell", reason: "test allow" }],
        });
        const concurrency = new ConcurrencyController();
        const executor = new ToolExecutor({ registry, permissionManager, concurrency });
        const ctx = createMockContext({ trustBalance: 100 });
        const result = await executor.execute("shell", { value: "x", command: "ls; rm -rf /" }, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain("sanitization failed");
      });
    });

    describe("Gate 5 — Concurrency control", () => {
      it("executes tool through the concurrency controller", async () => {
        const tool = createMockTool();
        const concurrency = new ConcurrencyController();
        const runSpy = vi.spyOn(concurrency, "run");
        const registry = new ToolRegistry();
        registry.register(tool);
        const permissionManager = new ToolPermissionManager({});
        const executor = new ToolExecutor({ registry, permissionManager, concurrency });
        const ctx = createMockContext();
        await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(runSpy).toHaveBeenCalledOnce();
      });
    });

    describe("Output truncation", () => {
      it("truncates oversized output and updates summary", async () => {
        const bigData = "x".repeat(500);
        const tool = createMockTool({
          metadata: {
            name: "mock-tool",
            aliases: [],
            permissionLevel: "read_only",
            isReadOnly: true,
            isDestructive: false,
            shouldDefer: false,
            alwaysLoad: false,
            maxConcurrency: 0,
            maxOutputChars: 10,
            tags: [],
          } as ITool["metadata"],
          call: vi.fn().mockResolvedValue({
            success: true,
            data: bigData,
            summary: "big result",
            durationMs: 5,
          } as ToolResult),
        });
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(true);
        expect(typeof result.data).toBe("string");
        expect(result.summary).toContain("truncated");
      });

      it("does not truncate output within maxOutputChars", async () => {
        const tool = createMockTool();
        const { executor } = createExecutor([tool]);
        const ctx = createMockContext();
        const result = await executor.execute("mock-tool", { value: "x" }, ctx);
        expect(result.success).toBe(true);
        expect(result.summary).toBe("success");
      });
    });

    describe("Timeout", () => {
      it("times out when tool takes too long", async () => {
        const slowTool = createMockTool({
          call: vi.fn().mockImplementation(
            () => new Promise((resolve) => setTimeout(resolve, 500)),
          ),
        });
        const { executor } = createExecutor([slowTool]);
        const ctx = createMockContext({ timeoutMs: 50 });
        await expect(
          executor.execute("mock-tool", { value: "x" }, ctx),
        ).rejects.toThrow("timed out");
      });
    });
  });

  describe("executeBatch()", () => {
    it("returns results for all batch calls in original order", async () => {
      const tool1 = createMockTool({
        name: "tool-1",
        call: vi.fn().mockResolvedValue({
          success: true, data: 1, summary: "one", durationMs: 5,
        } as ToolResult),
      });
      const tool2 = createMockTool({
        name: "tool-2",
        call: vi.fn().mockResolvedValue({
          success: true, data: 2, summary: "two", durationMs: 5,
        } as ToolResult),
        metadata: {
          name: "tool-2",
          aliases: [],
          permissionLevel: "read_only",
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 8000,
          tags: [],
        } as ITool["metadata"],
      });

      const { executor } = createExecutor([tool1, tool2]);
      const ctx = createMockContext();
      const results = await executor.executeBatch(
        [
          { toolName: "tool-1", input: { value: "a" } },
          { toolName: "tool-2", input: { value: "b" } },
        ],
        ctx,
      );

      expect(results).toHaveLength(2);
      expect(results[0].summary).toBe("one");
      expect(results[1].summary).toBe("two");
    });

    it("runs safe tools (isConcurrencySafe=true) and unsafe sequentially, all succeed", async () => {
      const safeTool = createMockTool({
        name: "safe-tool",
        isConcurrencySafe: vi.fn().mockReturnValue(true),
        call: vi.fn().mockResolvedValue({
          success: true, data: "safe", summary: "safe", durationMs: 5,
        } as ToolResult),
      });
      const unsafeTool = createMockTool({
        name: "unsafe-tool",
        isConcurrencySafe: vi.fn().mockReturnValue(false),
        call: vi.fn().mockResolvedValue({
          success: true, data: "unsafe", summary: "unsafe", durationMs: 5,
        } as ToolResult),
        metadata: {
          name: "unsafe-tool",
          aliases: [],
          permissionLevel: "read_only",
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 8000,
          tags: [],
        } as ITool["metadata"],
      });

      const { executor } = createExecutor([safeTool, unsafeTool]);
      const ctx = createMockContext();
      const results = await executor.executeBatch(
        [
          { toolName: "safe-tool", input: { value: "a" } },
          { toolName: "unsafe-tool", input: { value: "b" } },
          { toolName: "safe-tool", input: { value: "c" } },
        ],
        ctx,
      );

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
    });

    it("handles missing tool in batch gracefully", async () => {
      const { executor } = createExecutor([]);
      const ctx = createMockContext();
      const results = await executor.executeBatch(
        [{ toolName: "nonexistent", input: {} }],
        ctx,
      );
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("not found");
    });
  });

  describe("Audit logging", () => {
    it("calls logger.debug on start and success", async () => {
      const tool = createMockTool();
      const { executor } = createExecutor([tool]);
      const debugFn = vi.fn();
      const logger = { debug: debugFn, warn: vi.fn(), error: vi.fn() };
      const ctx = createMockContext({ logger, callId: "call-123", sessionId: "sess-456" });
      await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(debugFn).toHaveBeenCalledWith("tool.call.start", expect.objectContaining({ tool: "mock-tool", callId: "call-123", sessionId: "sess-456" }));
      expect(debugFn).toHaveBeenCalledWith("tool.call.success", expect.objectContaining({ tool: "mock-tool", callId: "call-123" }));
    });

    it("calls logger.warn on failure (timeout throws)", async () => {
      const slowTool = createMockTool({
        call: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 500)),
        ),
      });
      const { executor } = createExecutor([slowTool]);
      const warnFn = vi.fn();
      const logger = { debug: vi.fn(), warn: warnFn, error: vi.fn() };
      const ctx = createMockContext({ timeoutMs: 50, logger, callId: "call-timeout" });
      await expect(executor.execute("mock-tool", { value: "x" }, ctx)).rejects.toThrow("timed out");
      expect(warnFn).toHaveBeenCalledWith("tool.call.failure", expect.objectContaining({ tool: "mock-tool" }));
    });

    it("works without logger (no-op)", async () => {
      const tool = createMockTool();
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext(); // no logger
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(result.success).toBe(true);
    });
  });

  describe("dryRun mode", () => {
    it("skips tool.call when dryRun is true", async () => {
      const callFn = vi.fn().mockResolvedValue({ success: true, data: "real", summary: "real", durationMs: 5 });
      const tool = createMockTool({ call: callFn });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext({ dryRun: true });
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(callFn).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.summary).toContain("dry-run");
    });
  });

  describe("Retry with backoff", () => {
    it("retries transient errors for concurrency-safe tools", async () => {
      vi.useFakeTimers();
      let attempt = 0;
      const callFn = vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt === 1) throw new Error("ECONNRESET: connection reset");
        return Promise.resolve({ success: true, data: "ok", summary: "ok", durationMs: 5 });
      });
      const tool = createMockTool({
        call: callFn,
        isConcurrencySafe: vi.fn().mockReturnValue(true),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const promise = executor.execute("mock-tool", { value: "x" }, ctx);
      // Advance past first backoff (500ms)
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;
      expect(callFn).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      vi.useRealTimers();
    });

    it("does not retry non-transient errors", async () => {
      const callFn = vi.fn().mockRejectedValue(new Error("Something went very wrong"));
      const tool = createMockTool({
        call: callFn,
        isConcurrencySafe: vi.fn().mockReturnValue(true),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(callFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Something went very wrong");
    });

    it("does not retry for concurrency-unsafe tools even on transient errors", async () => {
      const callFn = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      const tool = createMockTool({
        call: callFn,
        isConcurrencySafe: vi.fn().mockReturnValue(false),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(callFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });
  });

  describe("Truncation metadata", () => {
    it("sets truncated.originalChars when output is truncated", async () => {
      const bigData = "x".repeat(500);
      const tool = createMockTool({
        metadata: {
          name: "mock-tool",
          aliases: [],
          permissionLevel: "read_only",
          isReadOnly: true,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 10,
          tags: [],
        } as ITool["metadata"],
        call: vi.fn().mockResolvedValue({
          success: true,
          data: bigData,
          summary: "big result",
          durationMs: 5,
        } as ToolResult),
      });
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(result.truncated).toBeDefined();
      expect(result.truncated?.originalChars).toBeGreaterThan(10);
    });

    it("does not set truncated when output fits within limit", async () => {
      const tool = createMockTool();
      const { executor } = createExecutor([tool]);
      const ctx = createMockContext();
      const result = await executor.execute("mock-tool", { value: "x" }, ctx);
      expect(result.truncated).toBeUndefined();
    });
  });

  describe("Expanded shell injection patterns", () => {
    function createShellExecutor() {
      const shellTool = createMockTool({
        name: "shell",
        metadata: {
          name: "shell",
          aliases: [],
          permissionLevel: "read_metrics",
          isReadOnly: false,
          isDestructive: false,
          shouldDefer: false,
          alwaysLoad: false,
          maxConcurrency: 0,
          maxOutputChars: 8000,
          tags: [],
        } as ITool["metadata"],
        inputSchema: z.object({ value: z.string(), command: z.string() }) as unknown as z.ZodType<DefaultInput>,
        checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" } as PermissionCheckResult),
      });
      const registry = new ToolRegistry();
      registry.register(shellTool);
      const permissionManager = new ToolPermissionManager({
        allowRules: [{ toolName: "shell", reason: "test allow" }],
      });
      const concurrency = new ConcurrencyController();
      const executor = new ToolExecutor({ registry, permissionManager, concurrency });
      return { executor };
    }

    it.each(["&&", "||", "> /", ">> "])("blocks pattern %s in shell command", async (pattern) => {
      const { executor } = createShellExecutor();
      const ctx = createMockContext({ trustBalance: 100 });
      const result = await executor.execute("shell", { value: "x", command: `ls ${pattern} dangerous` }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain("sanitization failed");
    });
  });

});
