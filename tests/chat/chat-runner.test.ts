import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatRunner } from "../../src/chat/chat-runner.js";
import type { ChatRunnerDeps } from "../../src/chat/chat-runner.js";
import type { StateManager } from "../../src/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../src/execution/adapter-layer.js";
import type { EscalationHandler, EscalationResult } from "../../src/chat/escalation.js";

// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../src/observation/context-provider.js", () => ({
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

describe("ChatRunner", () => {
  describe("normal execution", () => {
    it("calls adapter.execute with correct AgentTask shape", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      await runner.execute("Fix the tests", "/repo", 30_000);

      expect(adapter.execute).toHaveBeenCalledOnce();
      const task = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(task).toMatchObject({
        adapter_type: "mock",
        cwd: "/repo",
        timeout_ms: 30_000,
      });
      expect(typeof task.prompt).toBe("string");
      expect(task.prompt.length).toBeGreaterThan(0);
    });

    it("returns ChatRunResult with success, output, and elapsed_ms", async () => {
      const runner = new ChatRunner(makeDeps());
      const result = await runner.execute("Do something", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Task completed successfully.");
      expect(typeof result.elapsed_ms).toBe("number");
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("propagates adapter failure to ChatRunResult", async () => {
      const failResult: AgentResult = { ...CANNED_RESULT, success: false, output: "Agent failed", error: "boom", exit_code: 1 };
      const runner = new ChatRunner(makeDeps({ adapter: makeMockAdapter(failResult) }));

      const result = await runner.execute("Do something risky", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toBe("Agent failed");
    });
  });

  describe("slash commands", () => {
    it("/help returns help text without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/help", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("/help");
      expect(result.output).toContain("/clear");
      expect(result.output).toContain("/exit");
      expect(result.output).toContain("/track");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/clear returns cleared message without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/clear", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("cleared");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/track without escalationHandler returns 'not available' message", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/track", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("not available");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/track with escalationHandler but no history returns 'No conversation' message", async () => {
      const escalationHandler = {
        escalateToGoal: vi.fn(),
      } as unknown as EscalationHandler;
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter, escalationHandler }));

      const result = await runner.execute("/track", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("No conversation");
      expect(escalationHandler.escalateToGoal).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("/track with escalationHandler and history returns goal info", async () => {
      const escalationResult: EscalationResult = {
        goalId: "goal-abc-123",
        title: "My tracked goal",
        description: "My tracked goal",
      };
      const escalationHandler = {
        escalateToGoal: vi.fn().mockResolvedValue(escalationResult),
      } as unknown as EscalationHandler;
      const adapter = makeMockAdapter();
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ adapter, stateManager, escalationHandler }));

      // Populate history by running a normal turn first
      runner.startSession("/repo");
      await runner.execute("What should I track?", "/repo");

      const result = await runner.execute("/track", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("goal-abc-123");
      expect(result.output).toContain("My tracked goal");
      expect(result.output).toContain("pulseed run --goal");
      expect(adapter.execute).toHaveBeenCalledOnce(); // only the non-command turn
    });

    it("/exit returns exit message without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/exit", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Exiting");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("unknown /command returns error message without calling adapter", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/unknown-cmd", "/repo");

      expect(result.success).toBe(false);
      expect(result.output).toContain("Unknown command");
      expect(result.output).toContain("/unknown-cmd");
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it("slash command comparison is case-insensitive", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      const result = await runner.execute("/HELP", "/repo");

      expect(result.success).toBe(true);
      expect(result.output).toContain("/help");
      expect(adapter.execute).not.toHaveBeenCalled();
    });
  });

  describe("history population", () => {
    it("populates history with user and assistant messages after execution", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      await runner.execute("What is 2+2?", "/repo");

      // writeRaw should have been called at least twice:
      // once for the user message (persist-before-execute) and
      // once for the assistant message (fire-and-forget)
      const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
      expect(writeRawMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Both writes use the same session path
      const paths = writeRawMock.mock.calls.map((c: unknown[]) => c[0] as string);
      const sessionPaths = paths.filter((p: string) => p.startsWith("chat/sessions/"));
      expect(sessionPaths.length).toBeGreaterThanOrEqual(2);
    });

    it("user message is included in the session data written to stateManager", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      const userInput = "Hello from test";
      await runner.execute(userInput, "/repo");

      const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
      // The first call contains the user message (persist-before-execute)
      const firstWriteData = writeRawMock.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
      const userMsg = firstWriteData.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      // The prompt passed to adapter may include context prefix, so check the session content
      expect(userMsg?.content).toBe(userInput);
    });
  });

  describe("startSession / multi-turn behavior", () => {
    it("startSession initializes a session that is reused across multiple execute() calls", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      runner.startSession("/repo");
      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");

      const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
      const paths = writeRawMock.mock.calls.map((c: unknown[]) => c[0] as string);
      const sessionPaths = paths.filter((p: string) => p.startsWith("chat/sessions/"));
      // All writes should use the same session path
      const uniquePaths = new Set(sessionPaths);
      expect(uniquePaths.size).toBe(1);
    });

    it("multiple execute() calls without startSession create separate sessions", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      await runner.execute("Turn 1", "/repo");
      await runner.execute("Turn 2", "/repo");

      const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
      const paths = writeRawMock.mock.calls.map((c: unknown[]) => c[0] as string);
      const sessionPaths = paths.filter((p: string) => p.startsWith("chat/sessions/"));
      // Each call creates a fresh session → two distinct session paths
      const uniquePaths = new Set(sessionPaths);
      expect(uniquePaths.size).toBe(2);
    });

    it("history accumulates across turns when session is started", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      runner.startSession("/repo");
      await runner.execute("First question", "/repo");
      await runner.execute("Second question", "/repo");

      const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
      // Last write contains all accumulated messages (2 user + 2 assistant = 4)
      const lastCall = writeRawMock.mock.calls[writeRawMock.mock.calls.length - 1];
      const sessionData = lastCall[1] as { messages: Array<{ role: string }> };
      expect(sessionData.messages.length).toBeGreaterThanOrEqual(4);
    });

    it("startSession calls from execute() for 1-shot mode are adapter-call-safe", async () => {
      const adapter = makeMockAdapter();
      const runner = new ChatRunner(makeDeps({ adapter }));

      // Without startSession, two calls should both reach the adapter
      await runner.execute("Task A", "/repo");
      await runner.execute("Task B", "/repo");

      expect(adapter.execute).toHaveBeenCalledTimes(2);
    });

    it("startSession followed by /clear still keeps the same session path", async () => {
      const stateManager = makeMockStateManager();
      const runner = new ChatRunner(makeDeps({ stateManager }));

      runner.startSession("/repo");
      await runner.execute("Before clear", "/repo");
      await runner.execute("/clear", "/repo");
      await runner.execute("After clear", "/repo");

      const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
      const paths = writeRawMock.mock.calls.map((c: unknown[]) => c[0] as string);
      const sessionPaths = paths.filter((p: string) => p.startsWith("chat/sessions/"));
      const uniquePaths = new Set(sessionPaths);
      expect(uniquePaths.size).toBe(1);
    });
  });

  describe("persist-before-execute ordering", () => {
    it("stateManager.writeRaw is called before adapter.execute", async () => {
      const callOrder: string[] = [];

      const stateManager = {
        writeRaw: vi.fn().mockImplementation(async () => {
          callOrder.push("writeRaw");
        }),
        readRaw: vi.fn().mockResolvedValue(null),
      } as unknown as StateManager;

      const adapter = {
        adapterType: "mock",
        execute: vi.fn().mockImplementation(async () => {
          callOrder.push("adapter.execute");
          return CANNED_RESULT;
        }),
      } as unknown as IAdapter;

      const runner = new ChatRunner({ stateManager, adapter });
      await runner.execute("persist ordering check", "/repo");

      const writeIndex = callOrder.indexOf("writeRaw");
      const executeIndex = callOrder.indexOf("adapter.execute");
      expect(writeIndex).toBeGreaterThanOrEqual(0);
      expect(executeIndex).toBeGreaterThanOrEqual(0);
      expect(writeIndex).toBeLessThan(executeIndex);
    });
  });
});
