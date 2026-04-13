import { describe, expect, it } from "vitest";
import { applyChatEventToMessages } from "../chat-event-state.js";

describe("applyChatEventToMessages", () => {
  it("keeps activity as one updatable row per turn", () => {
    const first = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Received. Starting work...",
      sourceId: "lifecycle:start",
      transient: true,
    }, 20);

    const second = applyChatEventToMessages(first, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "tool",
      message: "Running tool: grep - ChatEvent",
      sourceId: "tool-1",
      transient: true,
    }, 20);

    expect(second).toHaveLength(1);
    expect(second[0]!).toMatchObject({
      id: "activity:turn-1",
      role: "pulseed",
      text: "Running tool: grep - ChatEvent",
      messageType: "info",
    });
  });

  it("does not add separate chat rows for raw tool events", () => {
    const messages = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "grep",
      args: { pattern: "ChatEvent" },
    }, 20);

    expect(messages).toEqual([]);
  });
});
