import { describe, it, expect, vi } from "vitest";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import type { CrossPlatformChatSessionOptions } from "../cross-platform-session.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

function getSessionPaths(stateManager: StateManager): string[] {
  const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
  return writeRawMock.mock.calls
    .map((call: unknown[]) => call[0] as string)
    .filter((path: string) => path.startsWith("chat/sessions/"));
}

describe("CrossPlatformChatSessionManager", () => {
  it("reuses the same ChatRunner session for the same identity_key across platforms", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const events: string[] = [];

    const first = await manager.execute("hello from slack", {
      identity_key: "user-123",
      platform: "slack",
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    const second = await manager.execute("hello from discord", {
      identity_key: "user-123",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
      cwd: "/repo",
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(1);
    expect(sessionPaths[0]).toMatch(/^chat\/sessions\/.+\.json$/);

    const info = manager.getSessionInfo({ identity_key: "user-123" } satisfies CrossPlatformChatSessionOptions);
    expect(info).not.toBeNull();
    expect(info?.identity_key).toBe("user-123");
    expect(info?.platform).toBe("slack");
    expect(info?.conversation_id).toBe("conv-1");
    expect(info?.cwd).toBe("/repo");
    expect(info?.metadata).toMatchObject({
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
    });

    expect(events).toContain("lifecycle_start");
    expect(events).toContain("assistant_final");
  });

  it("keeps sessions isolated when identity_key is omitted", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));

    const sharedOptions: Omit<CrossPlatformChatSessionOptions, "identity_key" | "platform"> = {
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
    };

    await manager.execute("hello from slack", {
      ...sharedOptions,
      platform: "slack",
    });

    await manager.execute("hello from discord", {
      ...sharedOptions,
      platform: "discord",
    });

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(2);
  });

  it("streams ChatEvent updates through the per-turn callback", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const events: Array<{ type: string; text?: string }> = [];

    const result = await manager.execute("stream this turn", {
      identity_key: "stream-user",
      platform: "web",
      conversation_id: "web-1",
      cwd: "/repo",
      onEvent: (event) => {
        events.push({ type: event.type, text: "text" in event ? event.text : undefined });
      },
    });

    expect(result.success).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "lifecycle_start")).toBe(true);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.type === "assistant_final")).toBe(true);
    expect(events.at(-1)?.type).toBe("lifecycle_end");
  });

  it("routes natural-language restart with the current platform reply target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
        operationId: "op-1",
        state: "acknowledged",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      runtimeControlService,
      approvalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("restart queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "restart_daemon" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "user-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
        }),
      })
    );
  });
});
