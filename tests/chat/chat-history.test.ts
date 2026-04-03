import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatHistory } from "../../src/chat/chat-history.js";
import type { StateManager } from "../../src/state/state-manager.js";

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

describe("ChatHistory", () => {
  let stateManager: StateManager;
  const SESSION_ID = "test-session-123";
  const CWD = "/tmp/test-repo";

  beforeEach(() => {
    stateManager = makeMockStateManager();
  });

  it("creates a session with correct id, cwd, and empty messages", () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    const session = history.getSessionData();

    expect(session.id).toBe(SESSION_ID);
    expect(session.cwd).toBe(CWD);
    expect(session.messages).toHaveLength(0);
    expect(session.createdAt).toBeTruthy();
  });

  it("appendUserMessage adds a message with role 'user' and correct content", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("Hello, world!");

    const messages = history.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello, world!");
    expect(messages[0].timestamp).toBeTruthy();
  });

  it("appendUserMessage assigns incrementing turnIndex starting at 0", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);

    await history.appendUserMessage("First message");
    history.appendAssistantMessage("First reply");
    await history.appendUserMessage("Second message");

    const messages = history.getMessages();
    expect(messages[0].turnIndex).toBe(0);
    expect(messages[1].turnIndex).toBe(1);
    expect(messages[2].turnIndex).toBe(2);
  });

  it("appendAssistantMessage adds a message with role 'assistant'", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("Question");
    history.appendAssistantMessage("Answer");

    const messages = history.getMessages();
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Answer");
  });

  it("getMessages returns all messages in order", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("msg1");
    history.appendAssistantMessage("msg2");
    await history.appendUserMessage("msg3");

    const messages = history.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("msg1");
    expect(messages[1].content).toBe("msg2");
    expect(messages[2].content).toBe("msg3");
  });

  it("getMessages returns a copy, not the internal array", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("original");

    const messages = history.getMessages();
    messages.push({ role: "user", content: "injected", timestamp: "", turnIndex: 99 });

    expect(history.getMessages()).toHaveLength(1);
  });

  it("clear() resets messages to empty", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("First");
    history.appendAssistantMessage("Reply");

    history.clear();

    expect(history.getMessages()).toHaveLength(0);
  });

  it("persist() calls stateManager.writeRaw with correct path and session data", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.persist();

    expect(stateManager.writeRaw).toHaveBeenCalledWith(
      `chat/sessions/${SESSION_ID}.json`,
      expect.objectContaining({
        id: SESSION_ID,
        cwd: CWD,
        messages: [],
      })
    );
  });

  it("appendUserMessage awaits persist — stateManager.writeRaw is called before returning", async () => {
    const callOrder: string[] = [];
    const mockWriteRaw = vi.fn().mockImplementation(async () => {
      callOrder.push("writeRaw");
    });
    const sm = { writeRaw: mockWriteRaw, readRaw: vi.fn() } as unknown as StateManager;

    const history = new ChatHistory(sm, SESSION_ID, CWD);
    await history.appendUserMessage("persist-before-execute check");

    callOrder.push("after-await");
    expect(callOrder).toEqual(["writeRaw", "after-await"]);
  });
});
