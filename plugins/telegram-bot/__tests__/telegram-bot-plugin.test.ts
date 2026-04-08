import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Imports from plugin source ───

import { loadConfig } from "../src/config.js";
import { TelegramAPI } from "../src/telegram-api.js";
import {
  formatNotification,
  type NotificationEvent,
} from "../src/message-formatter.js";
import { TelegramNotifier } from "../src/notifier.js";
import { PollingLoop } from "../src/polling-loop.js";
import { ChatBridge } from "../src/chat-bridge.js";
import { TelegramChatEventAdapter } from "../src/telegram-chat-event-adapter.js";
import { TelegramBotPlugin } from "../src/index.js";

// ─── Helpers ───

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: "goal_complete",
    goal_id: "goal-1",
    timestamp: "2026-04-01T00:00:00.000Z",
    summary: "Goal reached threshold",
    details: {},
    severity: "info",
    ...overrides,
  };
}

function writeTmpConfig(dir: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(data), "utf-8");
}

// ─── config.ts ───

describe("config — loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  it("loads valid config successfully", () => {
    writeTmpConfig(tmpDir, { bot_token: "tok123", chat_id: 42 });
    const cfg = loadConfig(tmpDir);
    expect(cfg.bot_token).toBe("tok123");
    expect(cfg.chat_id).toBe(42);
  });

  it("throws when bot_token is missing", () => {
    writeTmpConfig(tmpDir, { chat_id: 42 });
    expect(() => loadConfig(tmpDir)).toThrow("bot_token");
  });

  it("throws when chat_id is missing", () => {
    writeTmpConfig(tmpDir, { bot_token: "tok" });
    expect(() => loadConfig(tmpDir)).toThrow("chat_id");
  });

  it("defaults polling_timeout to 30", () => {
    writeTmpConfig(tmpDir, { bot_token: "tok", chat_id: 1 });
    const cfg = loadConfig(tmpDir);
    expect(cfg.polling_timeout).toBe(30);
  });

  it("defaults allowed_user_ids to []", () => {
    writeTmpConfig(tmpDir, { bot_token: "tok", chat_id: 1 });
    const cfg = loadConfig(tmpDir);
    expect(cfg.allowed_user_ids).toEqual([]);
  });

  it("throws when config.json does not exist", () => {
    expect(() => loadConfig(tmpDir)).toThrow("telegram-bot: failed to read config.json");
  });
});

// ─── telegram-api.ts ───

describe("TelegramAPI — getMe", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: TelegramAPI;

  beforeEach(() => {
    api = new TelegramAPI("test-token");
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({
        ok: true,
        result: { id: 1, first_name: "MyBot", username: "mybot" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls getMe endpoint", async () => {
    await api.getMe();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/getMe");
    expect(url).toContain("test-token");
  });

  it("returns parsed BotInfo", async () => {
    const info = await api.getMe();
    expect(info.username).toBe("mybot");
    expect(info.id).toBe(1);
  });
});

describe("TelegramAPI — getUpdates", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: TelegramAPI;

  beforeEach(() => {
    api = new TelegramAPI("test-token");
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ ok: true, result: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls getUpdates endpoint", async () => {
    await api.getUpdates(0, 30);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/getUpdates");
  });

  it("sends offset and timeout in the body", async () => {
    await api.getUpdates(10, 15);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { offset: number; timeout: number };
    expect(body.offset).toBe(10);
    expect(body.timeout).toBe(15);
  });

  it("returns update array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({
        ok: true,
        result: [{ update_id: 1, message: { message_id: 1, from: { id: 99 }, chat: { id: 99 }, text: "hi" } }],
      }),
    });
    const updates = await api.getUpdates(0, 30);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update_id).toBe(1);
  });
});

describe("TelegramAPI — sendMessage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: TelegramAPI;

  beforeEach(() => {
    api = new TelegramAPI("test-token");
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ ok: true, result: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls sendMessage endpoint with chat_id and text", async () => {
    await api.sendMessage(42, "Hello");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(init.body as string) as { chat_id: number; text: string };
    expect(body.chat_id).toBe(42);
    expect(body.text).toBe("Hello");
  });

  it("splits messages over 4096 chars into multiple calls", async () => {
    const longText = "x".repeat(5000);
    await api.sendMessage(42, longText);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on API error response (ok=false)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ ok: false, description: "Bad Request" }),
    });
    await expect(api.sendMessage(1, "hi")).rejects.toThrow("Bad Request");
  });

  it("throws on HTTP error status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });
    await expect(api.sendMessage(1, "hi")).rejects.toThrow("403");
  });
});

// ─── message-formatter.ts ───

describe("formatNotification", () => {
  it("formats critical with 🔴", () => {
    const result = formatNotification(makeEvent({ severity: "critical" }));
    expect(result).toContain("🔴");
  });

  it("formats warning with 🚨", () => {
    const result = formatNotification(makeEvent({ severity: "warning" }));
    expect(result).toContain("🚨");
  });

  it("formats info with ℹ️", () => {
    const result = formatNotification(makeEvent({ severity: "info" }));
    expect(result).toContain("ℹ️");
  });

  it("formats success with ✅", () => {
    const result = formatNotification(makeEvent({ severity: "success" }));
    expect(result).toContain("✅");
  });

  it("includes goal_id in output", () => {
    const result = formatNotification(makeEvent({ goal_id: "my-goal-xyz" }));
    expect(result).toContain("my-goal-xyz");
  });

  it("includes summary in output", () => {
    const result = formatNotification(makeEvent({ summary: "Task done successfully" }));
    expect(result).toContain("Task done successfully");
  });

  it("includes detail key-value pairs when present", () => {
    const result = formatNotification(makeEvent({ details: { score: 95 } }));
    expect(result).toContain("score");
  });

  it("omits details section when details is empty", () => {
    const result = formatNotification(makeEvent({ details: {} }));
    // Should not have extra detail lines — just the 3 main lines
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
  });
});

// ─── notifier.ts ───

describe("TelegramNotifier", () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let mockApi: TelegramAPI;
  let notifier: TelegramNotifier;

  beforeEach(() => {
    sendMessageMock = vi.fn().mockResolvedValue(undefined);
    mockApi = { sendMessage: sendMessageMock } as unknown as TelegramAPI;
    notifier = new TelegramNotifier(mockApi, 123);
  });

  it("name is 'telegram-bot'", () => {
    expect(notifier.name).toBe("telegram-bot");
  });

  it("supports() returns true for any event type", () => {
    expect(notifier.supports("goal_complete")).toBe(true);
    expect(notifier.supports("stall_detected")).toBe(true);
    expect(notifier.supports("anything")).toBe(true);
  });

  it("notify() calls sendMessage with formatted text", async () => {
    await notifier.notify(makeEvent({ goal_id: "g-42", severity: "success" }));
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [chatId, text] = sendMessageMock.mock.calls[0] as [number, string];
    expect(chatId).toBe(123);
    expect(text).toContain("✅");
    expect(text).toContain("g-42");
  });

  it("notify() forwards sendMessage errors", async () => {
    sendMessageMock.mockRejectedValue(new Error("network error"));
    await expect(notifier.notify(makeEvent())).rejects.toThrow("network error");
  });
});

// ─── polling-loop.ts ───
//
// The PollingLoop runs a while(running) loop; we test it by calling start()
// then stop() immediately and letting the first iteration complete.
// We use a controllable fetch that resolves after stop() is called.

describe("PollingLoop", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let api: TelegramAPI;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    api = new TelegramAPI("tok");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Helper: build a fetch response for getUpdates
  function updatesResponse(updates: unknown[]): Response {
    return {
      ok: true,
      text: async () => "",
      json: async () => ({ ok: true, result: updates }),
    } as unknown as Response;
  }

  it("processes messages from allowed users", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);

    // First call returns one message; second call blocks until stop()
    let stopLoop!: () => void;
    const blocker = new Promise<Response>((resolve) => { stopLoop = () => resolve(updatesResponse([])); });

    fetchMock
      .mockResolvedValueOnce(updatesResponse([
        { update_id: 1, message: { message_id: 1, from: { id: 111 }, chat: { id: 200 }, text: "hello" } },
      ]))
      .mockReturnValueOnce(blocker);

    const loop = new PollingLoop(api, onMessage, [111]);
    loop.start();

    // Let the first iteration run
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onMessage).toHaveBeenCalledWith("hello", 111, 200);

    loop.stop();
    stopLoop();
  });

  it("rejects messages from non-allowed users", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);

    let stopLoop!: () => void;
    const blocker = new Promise<Response>((resolve) => { stopLoop = () => resolve(updatesResponse([])); });

    fetchMock
      .mockResolvedValueOnce(updatesResponse([
        { update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 200 }, text: "hello" } },
      ]))
      .mockReturnValueOnce(blocker);

    const loop = new PollingLoop(api, onMessage, [111]); // 999 not in list
    loop.start();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onMessage).not.toHaveBeenCalled();

    loop.stop();
    stopLoop();
  });

  it("allows all users when allowed_user_ids is empty", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);

    let stopLoop!: () => void;
    const blocker = new Promise<Response>((resolve) => { stopLoop = () => resolve(updatesResponse([])); });

    fetchMock
      .mockResolvedValueOnce(updatesResponse([
        { update_id: 1, message: { message_id: 1, from: { id: 777 }, chat: { id: 300 }, text: "hi" } },
      ]))
      .mockReturnValueOnce(blocker);

    const loop = new PollingLoop(api, onMessage, []); // empty = allow all
    loop.start();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onMessage).toHaveBeenCalledWith("hi", 777, 300);

    loop.stop();
    stopLoop();
  });

  it("stop() halts the loop — running becomes false", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);

    let stopLoop!: () => void;
    const blocker = new Promise<Response>((resolve) => { stopLoop = () => resolve(updatesResponse([])); });

    fetchMock.mockReturnValueOnce(blocker);

    const loop = new PollingLoop(api, onMessage, []);
    loop.start();

    loop.stop(); // stop before first fetch resolves
    stopLoop();

    await new Promise((r) => setImmediate(r));

    // onMessage never called since loop stopped before any updates processed
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("handles getUpdates errors without crashing (backoff)", async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let stopLoop!: () => void;
    const blocker = new Promise<Response>((resolve) => { stopLoop = () => resolve(updatesResponse([])); });

    fetchMock
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockReturnValueOnce(blocker);

    const loop = new PollingLoop(api, onMessage, []);
    loop.start();

    await new Promise((r) => setImmediate(r));

    // The error should have triggered a console.warn
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("polling error"));

    loop.stop();
    stopLoop();
    warnSpy.mockRestore();
  });
});

// ─── chat-bridge.ts ───

describe("ChatBridge", () => {
  it("handleMessage calls processMessage with text and event handler", async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    const sendPlainMessage = vi.fn().mockResolvedValue(101);
    const adapterFactory = vi.fn().mockReturnValue({
      handle: vi.fn(),
      sendFinalFallback: vi.fn(),
      renderedAssistantOutput: false,
    });
    const bridge = new ChatBridge(processor, adapterFactory);

    await bridge.handleMessage("ping", 1, 100);

    expect(processor).toHaveBeenCalledTimes(1);
    expect(processor.mock.calls[0]![0]).toBe("ping");
    expect(processor.mock.calls[0]![1]).toBe(100);
    expect(typeof processor.mock.calls[0]![2]).toBe("function");
    expect(adapterFactory).toHaveBeenCalledWith(100);
    void sendPlainMessage;
  });

  it("falls back to the returned string when no events were emitted", async () => {
    const processor = vi.fn().mockResolvedValue("ok");
    const sendFinalFallback = vi.fn().mockResolvedValue(undefined);
    const bridge = new ChatBridge(
      processor,
      () => ({
        handle: vi.fn(),
        sendFinalFallback,
        renderedAssistantOutput: false,
      } as unknown as TelegramChatEventAdapter)
    );

    await bridge.handleMessage("hello", 42, 999);

    expect(processor).toHaveBeenCalledWith("hello", 999, expect.any(Function));
    expect(sendFinalFallback).toHaveBeenCalledWith("ok");
  });

  it("does not send a fallback when assistant events already rendered output", async () => {
    const processor = vi.fn().mockImplementation(async (_text: string, emit: (event: { type: string; runId: string; turnId: string; createdAt: string }) => Promise<void>) => {
      await emit({
        type: "assistant_final",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: new Date().toISOString(),
        text: "streamed",
        persisted: true,
      } as never);
      return "streamed";
    });
    const sendFinalFallback = vi.fn().mockResolvedValue(undefined);
    const bridge = new ChatBridge(
      processor,
      () => ({
        handle: vi.fn(),
        sendFinalFallback,
        renderedAssistantOutput: true,
      } as unknown as TelegramChatEventAdapter)
    );

    await bridge.handleMessage("hello", 42, 999);

    expect(sendFinalFallback).not.toHaveBeenCalled();
  });

  it("returns a fallback error when processMessage throws", async () => {
    const processor = vi.fn().mockRejectedValue(new Error("process failed"));
    const sendFinalFallback = vi.fn().mockResolvedValue(undefined);
    const bridge = new ChatBridge(
      processor,
      () => ({ handle: vi.fn(), sendFinalFallback, renderedAssistantOutput: false } as unknown as TelegramChatEventAdapter)
    );

    await expect(bridge.handleMessage("test", 1, 1)).resolves.toBeUndefined();
    expect(sendFinalFallback).toHaveBeenCalledWith("Error: process failed");
  });

  it("setProcessMessage replaces the processor", async () => {
    const first = vi.fn().mockResolvedValue("first");
    const second = vi.fn().mockResolvedValue("second");
    const sendFinalFallback = vi.fn().mockResolvedValue(undefined);
    const bridge = new ChatBridge(
      first,
      () => ({ handle: vi.fn(), sendFinalFallback, renderedAssistantOutput: false } as unknown as TelegramChatEventAdapter)
    );

    bridge.setProcessMessage(second);
    await bridge.handleMessage("test", 1, 1);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(sendFinalFallback).toHaveBeenCalledWith("second");
  });
});

describe("TelegramChatEventAdapter", () => {
  it("edits the same assistant message for assistant_delta and assistant_final", async () => {
    const sendPlainMessage = vi.fn().mockResolvedValue(10);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const api = {
      sendPlainMessage,
      editMessageText,
    } as unknown as TelegramAPI;

    const adapter = new TelegramChatEventAdapter(api, 777);

    await adapter.handle({
      type: "lifecycle_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      input: "hello",
    });
    await adapter.handle({
      type: "assistant_delta",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      delta: "Hel",
      text: "Hel",
    });
    await adapter.handle({
      type: "assistant_delta",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      delta: "lo",
      text: "Hello",
    });
    await adapter.handle({
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:03.000Z",
      text: "Hello",
      persisted: true,
    });

    expect(sendPlainMessage).toHaveBeenCalledOnce();
    expect(editMessageText).toHaveBeenCalledTimes(2);
    expect(editMessageText.mock.calls[0]![2]).toBe("Hello");
    expect(editMessageText.mock.calls[1]![2]).toBe("Hello");
  });

  it("renders tool events as a separate Telegram message and updates it", async () => {
    const sendPlainMessage = vi.fn().mockResolvedValue(11);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const api = {
      sendPlainMessage,
      editMessageText,
    } as unknown as TelegramAPI;

    const adapter = new TelegramChatEventAdapter(api, 777);

    await adapter.handle({
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell",
      args: { command: "ls" },
    });
    await adapter.handle({
      type: "tool_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "shell",
      success: true,
      summary: "done",
      durationMs: 12,
    });

    expect(sendPlainMessage).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText.mock.calls[0]![2]).toContain("done");
  });

  it("edits the assistant message to show lifecycle_error partial text", async () => {
    const sendPlainMessage = vi.fn().mockResolvedValue(12);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const api = {
      sendPlainMessage,
      editMessageText,
    } as unknown as TelegramAPI;

    const adapter = new TelegramChatEventAdapter(api, 777);

    await adapter.handle({
      type: "assistant_delta",
      runId: "run-2",
      turnId: "turn-2",
      createdAt: "2026-04-08T00:00:00.000Z",
      delta: "Partial",
      text: "Partial",
    });
    await adapter.handle({
      type: "lifecycle_error",
      runId: "run-2",
      turnId: "turn-2",
      createdAt: "2026-04-08T00:00:01.000Z",
      error: "boom",
      partialText: "Partial",
      persisted: false,
    });

    expect(sendPlainMessage).toHaveBeenCalledOnce();
    expect(editMessageText).toHaveBeenLastCalledWith(777, 12, "Partial\n\n[interrupted: boom]");
  });
});

// ─── index.ts — TelegramBotPlugin ───

describe("TelegramBotPlugin", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-plugin-"));
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({
        ok: true,
        result: { id: 1, first_name: "Bot", username: "testbot" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
    vi.unstubAllGlobals();
  });

  it("init() succeeds with valid config", async () => {
    writeTmpConfig(tmpDir, { bot_token: "tok123", chat_id: 42 });
    const plugin = new TelegramBotPlugin(tmpDir);
    await expect(plugin.init()).resolves.not.toThrow();
  });

  it("getNotifier() returns TelegramNotifier after init", async () => {
    writeTmpConfig(tmpDir, { bot_token: "tok123", chat_id: 42 });
    const plugin = new TelegramBotPlugin(tmpDir);
    await plugin.init();
    const notifier = plugin.getNotifier();
    expect(notifier).not.toBeNull();
    expect(notifier!.name).toBe("telegram-bot");
  });

  it("getNotifier() returns null before init", () => {
    const plugin = new TelegramBotPlugin(tmpDir);
    expect(plugin.getNotifier()).toBeNull();
  });

  it("init() throws when config is missing", async () => {
    // tmpDir has no config.json
    const plugin = new TelegramBotPlugin(tmpDir);
    await expect(plugin.init()).rejects.toThrow("telegram-bot: failed to read config.json");
  });

  it("startPolling() and stopPolling() do not throw after init", async () => {
    writeTmpConfig(tmpDir, { bot_token: "tok123", chat_id: 42 });
    const plugin = new TelegramBotPlugin(tmpDir);
    await plugin.init();
    expect(() => plugin.startPolling()).not.toThrow();
    expect(() => plugin.stopPolling()).not.toThrow();
  });

  it("setMessageProcessor updates the bridge handler after init", async () => {
    writeTmpConfig(tmpDir, { bot_token: "tok123", chat_id: 42 });
    const plugin = new TelegramBotPlugin(tmpDir);
    await plugin.init();

    expect(() => plugin.setMessageProcessor(async (text, chatId) => `handled: ${text} in ${chatId}`)).not.toThrow();
  });

  it("does not crash init when the PulSeed provider is not configured", async () => {
    writeTmpConfig(tmpDir, { bot_token: "tok123", chat_id: 42 });
    const plugin = new TelegramBotPlugin(tmpDir);
    await plugin.init();

    const bridge = (plugin as unknown as { bridge?: ChatBridge }).bridge;
    expect(bridge).toBeDefined();
  });
});
