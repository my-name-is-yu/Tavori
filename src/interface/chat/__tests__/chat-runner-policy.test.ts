import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ChatAgentLoopRunner } from "../../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

vi.mock("../../../base/llm/provider-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/llm/provider-config.js")>();
  return {
    ...actual,
    loadProviderConfig: vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      agent_loop: {
        security: {
          sandbox_mode: "workspace_write",
          approval_policy: "on_request",
          network_access: false,
          trust_project_instructions: true,
        },
      },
    }),
  };
});

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeMockAdapter(): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "adapter output",
      error: null,
      exit_code: 0,
      elapsed_ms: 10,
      stopped_reason: "completed",
    }),
  } as unknown as IAdapter;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatRunner policy commands", () => {
  it("/permissions shows the current execution policy", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    const result = await runner.execute("/permissions", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toContain("sandbox_mode: workspace_write");
    expect(result.output).toContain("network_access: off");
  });

  it("/permissions updates sandbox and network settings for the session", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    const result = await runner.execute("/permissions read-only network on approval never", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toContain("sandbox_mode: read_only");
    expect(result.output).toContain("network_access: on");
    expect(result.output).toContain("approval_policy: never");
  });

  it("/review returns diff summary and execution policy", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    const result = await runner.execute("/review", "/repo");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Review summary");
    expect(result.output).toContain("Execution policy");
  });

  it("/fork creates a new session id", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");
    const before = runner.getSessionId();

    const result = await runner.execute("/fork Branch copy", "/repo");
    const after = runner.getSessionId();

    expect(result.success).toBe(true);
    expect(after).not.toBe(before);
    expect(result.output).toContain("Forked chat session");
  });

  it("/undo removes the latest turn from chat history", async () => {
    const runner = new ChatRunner(makeDeps());
    runner.startSession("/repo");

    await runner.execute("Do something", "/repo");
    expect(runner.getCurrentSessionMessages().length).toBe(2);

    const result = await runner.execute("/undo", "/repo");

    expect(result.success).toBe(true);
    expect(runner.getCurrentSessionMessages().length).toBe(0);
    expect(result.output).toContain("File changes were not reverted");
  });

  it("/permissions updates the execution policy used by native agentloop", async () => {
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agentloop output",
        error: null,
        exit_code: 0,
        elapsed_ms: 10,
        stopped_reason: "completed",
      }),
    } as unknown as ChatAgentLoopRunner;
    const runner = new ChatRunner(makeDeps({ chatAgentLoopRunner }));
    runner.startSession("/repo");

    await runner.execute("/permissions read-only network on", "/repo");
    const result = await runner.execute("Run with agentloop", "/repo");

    expect(result.success).toBe(true);
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    const input = vi.mocked(chatAgentLoopRunner.execute).mock.calls[0][0] as {
      toolCallContext?: { executionPolicy?: { sandboxMode: string; networkAccess: boolean } };
    };
    expect(input.toolCallContext?.executionPolicy?.sandboxMode).toBe("read_only");
    expect(input.toolCallContext?.executionPolicy?.networkAccess).toBe(true);
  });
});
