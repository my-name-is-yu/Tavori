import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscalationHandler } from "../../src/chat/escalation.js";
import type { EscalationDeps } from "../../src/chat/escalation.js";
import type { StateManager } from "../../src/state/state-manager.js";
import type { ILLMClient, LLMResponse } from "../../src/llm/llm-client.js";
import type { GoalNegotiator } from "../../src/goal/goal-negotiator.js";
import { ChatHistory } from "../../src/chat/chat-history.js";

// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../src/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => `Working directory: ${cwd}`,
}));

// ─── Factories ───

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeMockLLMClient(responseText = "Improve test coverage"): ILLMClient {
  const response: LLMResponse = {
    content: responseText,
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  };
  return {
    sendMessage: vi.fn().mockResolvedValue(response),
    parseJSON: vi.fn(),
  } as unknown as ILLMClient;
}

function makeMockGoalNegotiator(goalId = "goal-123", title = "Improve test coverage"): GoalNegotiator {
  return {
    negotiate: vi.fn().mockResolvedValue({
      goal: {
        id: goalId,
        title,
        description: title,
        status: "active",
      },
      response: { accepted: true },
      log: {},
    }),
  } as unknown as GoalNegotiator;
}

function makeDeps(overrides: Partial<EscalationDeps> = {}): EscalationDeps {
  return {
    stateManager: makeMockStateManager(),
    llmClient: makeMockLLMClient(),
    goalNegotiator: makeMockGoalNegotiator(),
    ...overrides,
  };
}

async function makeChatHistoryWithMessages(stateManager: StateManager): Promise<ChatHistory> {
  const history = new ChatHistory(stateManager, "test-session", "/test");
  await history.appendUserMessage("How can I improve test coverage?");
  history.appendAssistantMessage("You could add more unit tests for edge cases.");
  await history.appendUserMessage("Make it a tracked goal");
  return history;
}

// ─── Tests ───

describe("EscalationHandler", () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = makeMockStateManager();
  });

  it("calls llmClient.sendMessage with the conversation messages", async () => {
    const llmClient = makeMockLLMClient();
    const deps = makeDeps({ stateManager, llmClient });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await handler.escalateToGoal(history);

    expect(llmClient.sendMessage).toHaveBeenCalledOnce();
    const [messages] = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("includes system prompt instructing goal extraction", async () => {
    const llmClient = makeMockLLMClient();
    const deps = makeDeps({ stateManager, llmClient });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await handler.escalateToGoal(history);

    const [, options] = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options?.system).toContain("PulSeed goal");
    expect(options?.system).toContain("ONLY the goal description");
  });

  it("passes LLM-extracted description to goalNegotiator.negotiate", async () => {
    const description = "Improve test coverage to 90%";
    const llmClient = makeMockLLMClient(description);
    const goalNegotiator = makeMockGoalNegotiator("goal-abc", description);
    const deps = makeDeps({ stateManager, llmClient, goalNegotiator });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await handler.escalateToGoal(history);

    expect(goalNegotiator.negotiate).toHaveBeenCalledWith(description);
  });

  it("returns EscalationResult with goalId and title from negotiated goal", async () => {
    const goalId = "goal-xyz";
    const title = "Achieve 90% test coverage";
    const goalNegotiator = makeMockGoalNegotiator(goalId, title);
    const deps = makeDeps({ stateManager, goalNegotiator });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    const result = await handler.escalateToGoal(history);

    expect(result.goalId).toBe(goalId);
    expect(result.title).toBe(title);
    expect(typeof result.description).toBe("string");
  });

  it("throws when history is empty", async () => {
    const deps = makeDeps({ stateManager });
    const handler = new EscalationHandler(deps);
    const emptyHistory = new ChatHistory(stateManager, "empty-session", "/test");

    await expect(handler.escalateToGoal(emptyHistory)).rejects.toThrow("No conversation history");
  });

  it("throws when LLM returns empty content", async () => {
    const llmClient = makeMockLLMClient("   ");
    const deps = makeDeps({ stateManager, llmClient });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await expect(handler.escalateToGoal(history)).rejects.toThrow("empty goal description");
  });

  it("propagates LLM failure as an error", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      parseJSON: vi.fn(),
    } as unknown as ILLMClient;
    const deps = makeDeps({ stateManager, llmClient });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await expect(handler.escalateToGoal(history)).rejects.toThrow("LLM timeout");
  });

  it("propagates GoalNegotiator failure as an error", async () => {
    const goalNegotiator = {
      negotiate: vi.fn().mockRejectedValue(new Error("Negotiation failed")),
    } as unknown as GoalNegotiator;
    const deps = makeDeps({ stateManager, goalNegotiator });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await expect(handler.escalateToGoal(history)).rejects.toThrow("Negotiation failed");
  });

  it("passes all conversation messages (user and assistant) to the LLM", async () => {
    const llmClient = makeMockLLMClient();
    const deps = makeDeps({ stateManager, llmClient });
    const handler = new EscalationHandler(deps);
    const history = await makeChatHistoryWithMessages(stateManager);

    await handler.escalateToGoal(history);

    const [messages] = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });
});
