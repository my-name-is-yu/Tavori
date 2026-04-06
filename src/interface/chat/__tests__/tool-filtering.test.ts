import { describe, it, expect, vi } from "vitest";
import { toToolDefinitionsFiltered } from "../../../tools/tool-definition-adapter.js";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMResponse } from "../../../base/llm/llm-client.js";
import type { ToolRegistry } from "../../../tools/registry.js";
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

function makeMockTool(
  name: string,
  opts?: { shouldDefer?: boolean; alwaysLoad?: boolean },
  callImpl?: () => Promise<ToolResult>,
): ITool {
  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: opts?.shouldDefer ?? false,
      alwaysLoad: opts?.alwaysLoad ?? false,
      maxConcurrency: 0,
      maxOutputChars: 4000,
      tags: [],
    },
    inputSchema: z.object({}),
    description: () => `mock tool ${name}`,
    call: vi.fn().mockImplementation(callImpl ?? (() => Promise.resolve({
      success: true,
      data: { result: "ok" },
      summary: `${name} called`,
      durationMs: 1,
    }))),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  } as unknown as ITool;
}

function makeRegistry(tools: ITool[]): ToolRegistry {
  return {
    listAll: () => tools,
    get: (name: string) => tools.find(t => t.metadata.name === name),
    searchTools: (query: string) =>
      tools
        .filter(t => t.metadata.name.includes(query))
        .map(t => ({ name: t.metadata.name, description: `mock ${t.metadata.name}`, category: "test", tags: [] })),
  } as unknown as ToolRegistry;
}

// ─── Tests: toToolDefinitionsFiltered ───

describe("toToolDefinitionsFiltered", () => {
  it("excludes deferred tools by default", () => {
    const tools = [
      makeMockTool("normal_tool"),
      makeMockTool("deferred_tool", { shouldDefer: true }),
    ];
    const defs = toToolDefinitionsFiltered(tools);
    const names = defs.map(d => d.function.name);
    expect(names).toContain("normal_tool");
    expect(names).not.toContain("deferred_tool");
  });

  it("always includes alwaysLoad tools even when deferred", () => {
    const tools = [
      makeMockTool("always_tool", { shouldDefer: true, alwaysLoad: true }),
    ];
    const defs = toToolDefinitionsFiltered(tools);
    const names = defs.map(d => d.function.name);
    expect(names).toContain("always_tool");
  });

  it("includes non-deferred tools without any options", () => {
    const tools = [
      makeMockTool("tool_a"),
      makeMockTool("tool_b"),
    ];
    const defs = toToolDefinitionsFiltered(tools);
    expect(defs).toHaveLength(2);
  });

  it("includes deferred tools that are in activatedTools set", () => {
    const tools = [
      makeMockTool("deferred_tool", { shouldDefer: true }),
    ];
    const activated = new Set(["deferred_tool"]);
    const defs = toToolDefinitionsFiltered(tools, { activatedTools: activated });
    const names = defs.map(d => d.function.name);
    expect(names).toContain("deferred_tool");
  });

  it("does not include deferred tools not in activatedTools", () => {
    const tools = [
      makeMockTool("deferred_a", { shouldDefer: true }),
      makeMockTool("deferred_b", { shouldDefer: true }),
    ];
    const activated = new Set(["deferred_a"]);
    const defs = toToolDefinitionsFiltered(tools, { activatedTools: activated });
    const names = defs.map(d => d.function.name);
    expect(names).toContain("deferred_a");
    expect(names).not.toContain("deferred_b");
  });
});

// ─── Tests: ChatRunner integration ───

describe("ChatRunner tool filtering integration", () => {
  function makeDepsWithTools(tools: ITool[]): ChatRunnerDeps {
    let callCount = 0;
    const llmClient: ILLMClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn().mockImplementation(async (_msgs, opts) => {
        callCount++;
        // Return tool names seen by the LLM (from the tools option)
        const toolNames = (opts?.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
        return {
          content: JSON.stringify({ seenTools: toolNames, call: callCount }),
          tool_calls: [],
        } satisfies LLMResponse;
      }),
    } as unknown as ILLMClient;

    return {
      stateManager: makeMockStateManager(),
      adapter: makeMockAdapter(),
      llmClient,
      registry: makeRegistry(tools),
    };
  }

  it("does not send deferred tools to LLM on initial call", async () => {
    const tools = [
      makeMockTool("visible_tool"),
      makeMockTool("hidden_tool", { shouldDefer: true }),
    ];
    const deps = makeDepsWithTools(tools);
    const runner = new ChatRunner(deps);
    const result = await runner.execute("hello", "/tmp");

    const parsed = JSON.parse(result.output) as { seenTools: string[] };
    expect(parsed.seenTools).toContain("visible_tool");
    expect(parsed.seenTools).not.toContain("hidden_tool");
  });

  it("sends alwaysLoad deferred tools to LLM even on initial call", async () => {
    const tools = [
      makeMockTool("always_available", { shouldDefer: true, alwaysLoad: true }),
    ];
    const deps = makeDepsWithTools(tools);
    const runner = new ChatRunner(deps);
    const result = await runner.execute("hello", "/tmp");

    const parsed = JSON.parse(result.output) as { seenTools: string[] };
    expect(parsed.seenTools).toContain("always_available");
  });

  it("activates deferred tool after tool_search returns it", async () => {
    const deferredTool = makeMockTool("rare_tool", { shouldDefer: true });
    const searchResults = [{ name: "rare_tool", description: "a rare tool", category: "test", tags: [] }];

    let callCount = 0;
    const llmClient: ILLMClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn().mockImplementation(async (_msgs, opts) => {
        callCount++;
        const toolNames = (opts?.tools ?? []).map((t: { function: { name: string } }) => t.function.name);

        if (callCount === 1) {
          // First call: request tool_search
          return {
            content: "",
            tool_calls: [{
              id: "tc-1",
              type: "function",
              function: { name: "tool_search", arguments: JSON.stringify({ query: "rare" }) },
            }],
          } satisfies LLMResponse;
        }
        // Second call: report which tools are now available
        return {
          content: JSON.stringify({ seenTools: toolNames }),
          tool_calls: [],
        } satisfies LLMResponse;
      }),
    } as unknown as ILLMClient;

    const registry: ToolRegistry = {
      listAll: () => [deferredTool, makeMockTool("tool_search")],
      get: (name: string) => {
        if (name === "tool_search") {
          return makeMockTool("tool_search", {}, async () => ({
            success: true,
            data: searchResults,
            summary: "Found 1 tool",
            durationMs: 1,
          }));
        }
        if (name === "rare_tool") return deferredTool;
        return undefined;
      },
      searchTools: () => searchResults,
    } as unknown as ToolRegistry;

    const deps: ChatRunnerDeps = {
      stateManager: makeMockStateManager(),
      adapter: makeMockAdapter(),
      llmClient,
      registry,
    };

    const runner = new ChatRunner(deps);
    const result = await runner.execute("find me the rare tool", "/tmp");

    // After ToolSearch, rare_tool should be activated and visible in 2nd LLM call
    const parsed = JSON.parse(result.output) as { seenTools: string[] };
    expect(parsed.seenTools).toContain("rare_tool");
  });
});
