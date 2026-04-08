import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createBuiltinTools } from "../../../tools/builtin/index.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { ScheduleEntrySchema } from "../../../runtime/types/schedule.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: async () => "",
}));

vi.mock("../grounding.js", () => ({
  buildStaticSystemPrompt: () => "",
  buildDynamicContextPrompt: async () => "",
}));

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
    listGoalIds: vi.fn().mockResolvedValue([]),
    loadGoal: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeMockAdapter(): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
    }),
  } as unknown as IAdapter;
}

function makeScheduleEntry(overrides: Partial<z.input<typeof ScheduleEntrySchema>> = {}) {
  return ScheduleEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "daily digest",
    layer: "cron",
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    enabled: true,
    cron: {
      prompt_template: "Summarize the latest activity.",
      context_sources: ["memory://daily"],
      output_format: "notification",
      max_tokens: 1200,
    },
    baseline_results: [],
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-04-09T09:00:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    ...overrides,
  });
}

function makeScheduleEngine(entries: ReturnType<typeof makeScheduleEntry>[] = []) {
  return {
    getEntries: vi.fn().mockReturnValue(entries),
    getDueEntries: vi.fn().mockResolvedValue(entries),
    addEntry: vi.fn().mockResolvedValue(makeScheduleEntry()),
    updateEntry: vi.fn().mockResolvedValue(null),
    removeEntry: vi.fn().mockResolvedValue(false),
  } as unknown as ScheduleEngine;
}

function buildRegistry(scheduleEngine: ScheduleEngine): ToolRegistry {
  const stateManager = makeMockStateManager();
  const trustManager = {
    getBalance: vi.fn().mockResolvedValue({ balance: 0 }),
    setOverride: vi.fn().mockResolvedValue(undefined),
  };
  const registry = new ToolRegistry();

  for (const tool of createBuiltinTools({
    stateManager,
    trustManager: trustManager as never,
    registry,
    scheduleEngine,
  })) {
    registry.register(tool);
  }

  return registry;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

describe("ChatRunner schedule integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes schedule tools when the registry is built with a ScheduleEngine", async () => {
    const registry = buildRegistry(makeScheduleEngine());
    const llmClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn().mockImplementation(async (_messages, options) => ({
        content: JSON.stringify({
          seenTools: (options?.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        }),
        tool_calls: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "completed",
      })),
    };

    const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never }));
    const result = await runner.execute("show me the available tools", "/tmp");
    const parsed = JSON.parse(result.output) as { seenTools: string[] };

    expect(parsed.seenTools).toContain("list_schedules");
    expect(registry.get("create_schedule")).toBeDefined();
    expect(registry.get("list_schedules")).toBeDefined();
  });

  it("runs list_schedules through the chat tool execution path", async () => {
    const entry = makeScheduleEntry();
    const scheduleEngine = makeScheduleEngine([entry]);
    const registry = buildRegistry(scheduleEngine);
    const llmClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          tool_calls: [
            {
              id: "tool-call-1",
              function: {
                name: "list_schedules",
                arguments: JSON.stringify({}),
              },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: "Listed schedules",
          tool_calls: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "completed",
        }),
    };

    const runner = new ChatRunner(makeDeps({ registry, llmClient: llmClient as never }));
    await runner.execute("list schedules", "/tmp");

    expect(vi.mocked(scheduleEngine.getEntries)).toHaveBeenCalledTimes(1);
    const secondCallMessages = llmClient.sendMessage.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    const toolResultMessage = secondCallMessages.find(
      (message) => message.role === "user" && message.content.startsWith("Tool result for list_schedules:\n"),
    );

    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.content).toContain(entry.id);
    expect(toolResultMessage?.content).toContain(entry.name);
  });

  it("routes create_schedule through approvalFn before executing", async () => {
    const createdEntry = makeScheduleEntry({ id: "22222222-2222-4222-8222-222222222222", name: "heartbeat check" });
    const scheduleEngine = makeScheduleEngine();
    vi.mocked(scheduleEngine.addEntry).mockResolvedValue(createdEntry);
    const registry = buildRegistry(scheduleEngine);
    const approvalFn = vi.fn().mockResolvedValue(true);
    const llmClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          tool_calls: [
            {
              id: "tool-call-1",
              function: {
                name: "create_schedule",
                arguments: JSON.stringify({
                  name: "heartbeat check",
                  layer: "heartbeat",
                  trigger: { type: "interval", seconds: 30 },
                  heartbeat: {
                    check_type: "http",
                    check_config: { url: "https://example.com/health" },
                  },
                }),
              },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: "Created schedule",
          tool_calls: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "completed",
        }),
    };

    const runner = new ChatRunner(makeDeps({
      registry,
      llmClient: llmClient as never,
      approvalFn,
    }));

    await runner.execute("create a schedule", "/tmp");

    expect(approvalFn).toHaveBeenCalledOnce();
    expect(approvalFn).toHaveBeenCalledWith(
      "Creating a persistent schedule changes background automation and requires approval",
    );
    expect(vi.mocked(scheduleEngine.addEntry)).toHaveBeenCalledOnce();
  });
});
