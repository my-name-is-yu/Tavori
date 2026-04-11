import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMResponse } from "../../../base/llm/llm-client.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ITool, ToolResult, ToolCallContext } from "../../../tools/types.js";
import { z } from "zod";

// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, _cwd: string) => Promise.resolve(""),
}));

// ─── Helpers ───

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeMockAdapter(): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue({ success: true, output: "", error: null, elapsed_ms: 10 }),
  } as unknown as IAdapter;
}

/** Create a minimal mock ITool with controllable call behavior. */
function makeMockTool(name: string, callImpl: (input: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult>): ITool {
  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 4000,
      tags: [],
    },
    inputSchema: z.object({}),
    description: () => "mock tool",
    call: vi.fn().mockImplementation(callImpl),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  } as unknown as ITool;
}

/** Create an LLM client that returns a single tool call, then a final text response. */
function makeLLMClientWithToolCall(toolName: string, toolArgs: Record<string, unknown>): ILLMClient {
  let callCount = 0;
  return {
    supportsToolCalling: () => true,
    sendMessage: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: return a tool_call response
        return {
          content: "",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_calls",
          tool_calls: [
            {
              id: "tc-001",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(toolArgs),
              },
            },
          ],
        } satisfies LLMResponse;
      }
      // Second call: return final text (after tool result)
      return {
        content: "Tool executed, here is the result.",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "completed",
        tool_calls: [],
      } satisfies LLMResponse;
    }),
  } as unknown as ILLMClient;
}

/** Create a ToolRegistry mock that returns the given tool by name. */
function makeMockRegistry(tool: ITool): ToolRegistry {
  return {
    get: vi.fn().mockImplementation((name: string) => (name === tool.metadata.name ? tool : undefined)),
    listAll: vi.fn().mockReturnValue([tool]),
    register: vi.fn(),
  } as unknown as ToolRegistry;
}

function makeMockExecutor(
  executeImpl: (toolName: string, input: unknown, context: ToolCallContext) => Promise<ToolResult>
): ToolExecutor {
  return {
    execute: vi.fn().mockImplementation(executeImpl),
  } as unknown as ToolExecutor;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

// ─── Tests ───

describe("ChatRunner — tool status callbacks", () => {
  const toolName = "mock-tool";
  const toolArgs = {};

  describe("onToolStart callback", () => {
    it("is called with correct toolName before tool execution", async () => {
      const onToolStart = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "done",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolStart,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolStart).toHaveBeenCalledOnce();
      expect(onToolStart).toHaveBeenCalledWith(toolName, toolArgs);
    });

    it("routes tool calls through ToolExecutor when available", async () => {
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => {
        throw new Error("raw tool.call should not run");
      });
      const executor = makeMockExecutor(async (executedName, input, context) => {
        expect(executedName).toBe(toolName);
        expect(input).toEqual(toolArgs);
        const approved = await context.approvalFn({
          toolName: executedName,
          input,
          reason: "approval required",
          permissionLevel: "write_local",
          isDestructive: false,
          reversibility: "unknown",
        });
        expect(approved).toBe(false);
        return {
          success: false,
          data: null,
          summary: "User denied approval",
          durationMs: 5,
        };
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolStart,
        onToolEnd,
        toolExecutor: executor,
      });
      const runner = new ChatRunner(deps);

      const result = await runner.execute("test", "/repo");

      expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(tool.call).not.toHaveBeenCalled();
      expect(onToolStart).toHaveBeenCalledOnce();
      expect(onToolEnd).toHaveBeenCalledOnce();
      expect(result.output).toBe("Tool executed, here is the result.");
    });

    it("is called before tool.call() executes", async () => {
      const callOrder: string[] = [];
      const onToolStart = vi.fn().mockImplementation(() => callOrder.push("onToolStart"));
      const tool = makeMockTool(toolName, async () => {
        callOrder.push("tool.call");
        return { success: true, data: null, summary: "done", durationMs: 5 };
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolStart,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(callOrder).toEqual(["onToolStart", "tool.call"]);
    });
  });

  describe("onToolEnd callback — success path", () => {
    it("is called with success=true and correct summary after successful execution", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "operation completed",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolEnd).toHaveBeenCalledOnce();
      const [calledName, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledName).toBe(toolName);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("operation completed");
    });

    it("passes durationMs as a positive number", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      const [, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("uses '...' as fallback summary when tool returns empty summary", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: { key: "value" },
        summary: "",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      const [, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(result.summary).toBe("...");
    });
  });

  describe("onToolEnd callback — failure path", () => {
    it("is called with success=false when tool.call() throws", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => {
        throw new Error("tool exploded");
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolEnd).toHaveBeenCalledOnce();
      const [calledName, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledName).toBe(toolName);
      expect(result.success).toBe(false);
      expect(result.summary).toBe("tool exploded");
    });

    it("includes durationMs even when tool throws", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => {
        throw new Error("boom");
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      const [, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("optional callbacks", () => {
    it("does not throw when onToolStart is not provided", async () => {
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        // onToolStart intentionally omitted
      });
      const runner = new ChatRunner(deps);
      await expect(runner.execute("test", "/repo")).resolves.toBeDefined();
    });

    it("does not throw when onToolEnd is not provided", async () => {
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        // onToolEnd intentionally omitted
      });
      const runner = new ChatRunner(deps);
      await expect(runner.execute("test", "/repo")).resolves.toBeDefined();
    });

    it("does not throw when neither callback is provided", async () => {
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
      });
      const runner = new ChatRunner(deps);
      await expect(runner.execute("test", "/repo")).resolves.toBeDefined();
    });

    it("does not call callbacks when no tool calls are made (text-only response)", async () => {
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const llmClient: ILLMClient = {
        supportsToolCalling: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          content: "Just a text response, no tools needed.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "completed",
          tool_calls: [],
        } satisfies LLMResponse),
      } as unknown as ILLMClient;
      const deps = makeDeps({
        llmClient,
        registry: makeMockRegistry(makeMockTool(toolName, async () => ({ success: true, data: null, summary: "ok", durationMs: 5 }))),
        onToolStart,
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolStart).not.toHaveBeenCalled();
      expect(onToolEnd).not.toHaveBeenCalled();
    });
  });
});
