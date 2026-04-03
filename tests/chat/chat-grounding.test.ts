import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Mock context-provider so tests don't walk the real filesystem.
// Must appear before any ChatRunner import.
vi.mock("../../src/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => `Working directory: ${cwd}`,
}));

// Mock spawn-helper used by CLI adapters.
// Vitest hoists vi.mock() calls, so this runs before adapter imports.
vi.mock("../../src/adapters/spawn-helper.js", () => ({
  spawnWithTimeout: vi.fn().mockResolvedValue({
    stdout: "output",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }),
  spawnResultToAgentResult: vi.fn().mockImplementation(
    (result: { exitCode: number | null; stdout: string; stderr: string }, elapsed: number) => ({
      success: result.exitCode === 0,
      output: result.stdout,
      error: result.exitCode !== 0 ? result.stderr : null,
      exit_code: result.exitCode,
      elapsed_ms: elapsed,
      stopped_reason: result.exitCode === 0 ? "completed" : "error",
    })
  ),
}));

// ─── Module imports (after mocks) ───
import { buildSystemPrompt } from "../../src/chat/grounding.js";
import { ClaudeAPIAdapter } from "../../src/adapters/agents/claude-api.js";
import { ClaudeCodeCLIAdapter } from "../../src/adapters/agents/claude-code-cli.js";
import { OpenAICodexCLIAdapter } from "../../src/adapters/agents/openai-codex.js";
import { BrowserUseCLIAdapter } from "../../src/adapters/agents/browser-use-cli.js";
import { ChatRunner } from "../../src/chat/chat-runner.js";
import type { ChatRunnerDeps } from "../../src/chat/chat-runner.js";
import type { IAdapter, AgentResult } from "../../src/execution/adapter-layer.js";
import type { StateManager } from "../../src/state/state-manager.js";
import type { ILLMClient } from "../../src/llm/llm-client.js";
import { spawnWithTimeout } from "../../src/adapters/spawn-helper.js";

// ─── Shared helpers ───

function makeMockStateManager(
  goalIds: string[] = [],
  goals: Record<string, object> = {}
): StateManager {
  return {
    listGoalIds: vi.fn().mockResolvedValue(goalIds),
    loadGoal: vi.fn().mockImplementation(async (id: string) => goals[id] ?? null),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Done.",
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

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

// ─── buildSystemPrompt tests ───

describe("buildSystemPrompt (grounding.ts)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-grounding-test-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes PulSeed identity text", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("You are PulSeed");
    expect(prompt).toContain("AI agent orchestrator");
    expect(prompt).toContain("orchestrate");
  });

  it("includes CLI commands section", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Available Commands");
    expect(prompt).toContain("pulseed goal add");
    expect(prompt).toContain("pulseed run --goal");
    expect(prompt).toContain("pulseed chat");
    expect(prompt).toContain("/track");
  });

  it("shows goals from stateManager", async () => {
    const sm = makeMockStateManager(
      ["goal-1", "goal-2"],
      {
        "goal-1": { title: "Ship feature X", status: "active", loop_status: "running" },
        "goal-2": { title: "Fix prod bug", status: "pending", loop_status: "idle" },
      }
    );
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Ship feature X");
    expect(prompt).toContain("goal-1");
    expect(prompt).toContain("Fix prod bug");
    expect(prompt).toContain("goal-2");
  });

  it("shows 'No goals configured yet' when no goals", async () => {
    const sm = makeMockStateManager([], {});
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("No goals configured yet");
  });

  it("handles stateManager errors — rejects (error propagates)", async () => {
    const sm = {
      listGoalIds: vi.fn().mockRejectedValue(new Error("DB unavailable")),
      loadGoal: vi.fn(),
    } as unknown as StateManager;

    // buildGoalsBlock rejects, which propagates through buildSystemPrompt
    await expect(buildSystemPrompt({ stateManager: sm, homeDir: tmpDir })).rejects.toThrow("DB unavailable");
  });

  it("reads plugins directory and lists installed plugins", async () => {
    const pluginsDir = path.join(tmpDir, "plugins");
    await fsp.mkdir(pluginsDir);
    await fsp.mkdir(path.join(pluginsDir, "slack-notifier"));
    await fsp.mkdir(path.join(pluginsDir, "github-issues"));

    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("slack-notifier");
    expect(prompt).toContain("github-issues");
  });

  it("shows 'none' when plugins directory is absent", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Installed: none");
  });

  it("reads provider.json and shows llm/adapter info", async () => {
    const providerPath = path.join(tmpDir, "provider.json");
    await fsp.writeFile(
      providerPath,
      JSON.stringify({ llm: "claude-sonnet-4", default_adapter: "claude_api" }),
      "utf-8"
    );

    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("claude-sonnet-4");
    expect(prompt).toContain("claude_api");
  });

  it("shows 'not configured' when provider.json is absent", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("not configured");
  });

  it("shows loop_status in goal line when not idle", async () => {
    const sm = makeMockStateManager(
      ["goal-running"],
      {
        "goal-running": { title: "Active task", status: "active", loop_status: "running" },
      }
    );
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("[running]");
  });

  it("does not show loop_status bracket when idle", async () => {
    const sm = makeMockStateManager(
      ["goal-idle"],
      {
        "goal-idle": { title: "Idle task", status: "pending", loop_status: "idle" },
      }
    );
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).not.toContain("[idle]");
    expect(prompt).toContain("Idle task");
  });
});

// ─── ClaudeAPIAdapter system_prompt passthrough ───

describe("ClaudeAPIAdapter — system_prompt passthrough", () => {
  it("passes system_prompt as system option to sendMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      content: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const mockLLMClient = { sendMessage, parseJSON: vi.fn() } as unknown as ILLMClient;
    const adapter = new ClaudeAPIAdapter(mockLLMClient);

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_api",
      system_prompt: "You are PulSeed.",
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [, options] = sendMessage.mock.calls[0];
    expect(options).toMatchObject({ system: "You are PulSeed." });
  });

  it("does not pass system option when system_prompt is undefined", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      content: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const mockLLMClient = { sendMessage, parseJSON: vi.fn() } as unknown as ILLMClient;
    const adapter = new ClaudeAPIAdapter(mockLLMClient);

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_api",
    });

    const [, options] = sendMessage.mock.calls[0];
    expect(options).toBeUndefined();
  });
});

// ─── CLI adapters — system_prompt prepend ───

describe("ClaudeCodeCLIAdapter — system_prompt prepend", () => {
  beforeEach(() => {
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockClear();
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "output",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("prepends [System Context] block when system_prompt is set", async () => {
    const adapter = new ClaudeCodeCLIAdapter("echo");

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_code_cli",
      system_prompt: "You are PulSeed.",
    });

    expect(spawnWithTimeout).toHaveBeenCalledOnce();
    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toContain("[System Context]");
    expect(opts.stdinData).toContain("You are PulSeed.");
    expect(opts.stdinData).toContain("[User Request]");
    expect(opts.stdinData).toContain("Do the thing");
  });

  it("passes prompt directly when system_prompt is undefined", async () => {
    const adapter = new ClaudeCodeCLIAdapter("echo");

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_code_cli",
    });

    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toBe("Do the thing");
    expect(opts.stdinData).not.toContain("[System Context]");
  });
});

describe("OpenAICodexCLIAdapter — system_prompt prepend", () => {
  beforeEach(() => {
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockClear();
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "output",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("prepends [System Context] block when system_prompt is set", async () => {
    const adapter = new OpenAICodexCLIAdapter({ cliPath: "echo", sandboxPolicy: null });

    await adapter.execute({
      prompt: "Analyze the repo",
      timeout_ms: 5000,
      adapter_type: "openai_codex_cli",
      system_prompt: "You are PulSeed.",
    });

    expect(spawnWithTimeout).toHaveBeenCalledOnce();
    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toContain("[System Context]");
    expect(opts.stdinData).toContain("You are PulSeed.");
    expect(opts.stdinData).toContain("[User Request]");
    expect(opts.stdinData).toContain("Analyze the repo");
  });

  it("passes prompt directly when system_prompt is undefined", async () => {
    const adapter = new OpenAICodexCLIAdapter({ cliPath: "echo", sandboxPolicy: null });

    await adapter.execute({
      prompt: "Analyze the repo",
      timeout_ms: 5000,
      adapter_type: "openai_codex_cli",
    });

    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toBe("Analyze the repo");
    expect(opts.stdinData).not.toContain("[System Context]");
  });
});

describe("BrowserUseCLIAdapter — system_prompt prepend", () => {
  beforeEach(() => {
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockClear();
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "output",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("prepends [System Context] block when system_prompt is set", async () => {
    const adapter = new BrowserUseCLIAdapter({ cliPath: "echo" });

    await adapter.execute({
      prompt: "Search the web",
      timeout_ms: 5000,
      adapter_type: "browser_use_cli",
      system_prompt: "You are PulSeed.",
    });

    expect(spawnWithTimeout).toHaveBeenCalledOnce();
    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toContain("[System Context]");
    expect(opts.stdinData).toContain("You are PulSeed.");
    expect(opts.stdinData).toContain("[User Request]");
    expect(opts.stdinData).toContain("Search the web");
  });

  it("passes prompt directly when system_prompt is undefined", async () => {
    const adapter = new BrowserUseCLIAdapter({ cliPath: "echo" });

    await adapter.execute({
      prompt: "Search the web",
      timeout_ms: 5000,
      adapter_type: "browser_use_cli",
    });

    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toBe("Search the web");
    expect(opts.stdinData).not.toContain("[System Context]");
  });
});

// ─── ChatRunner integration tests (grounding) ───

describe("ChatRunner — grounding integration", () => {
  it("sets system_prompt on AgentTask when buildSystemPrompt succeeds", async () => {
    const adapter = makeMockAdapter();
    const stateManager = makeMockStateManager();
    const runner = new ChatRunner(makeDeps({ adapter, stateManager }));

    await runner.execute("Hello", "/repo");

    expect(adapter.execute).toHaveBeenCalledOnce();
    const task = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // system_prompt is set when buildSystemPrompt returns a non-empty string
    expect(task.system_prompt).toBeDefined();
    expect(typeof task.system_prompt).toBe("string");
    expect(task.system_prompt.length).toBeGreaterThan(0);
  });

  it("caches system_prompt across turns — buildSystemPrompt called once per session", async () => {
    const adapter = makeMockAdapter();
    const stateManager = makeMockStateManager();
    const runner = new ChatRunner(makeDeps({ adapter, stateManager }));

    runner.startSession("/repo");
    await runner.execute("Turn 1", "/repo");
    await runner.execute("Turn 2", "/repo");
    await runner.execute("Turn 3", "/repo");

    // listGoalIds is called by buildSystemPrompt; should only be called once (caching)
    const listGoalIdsMock = stateManager.listGoalIds as ReturnType<typeof vi.fn>;
    expect(listGoalIdsMock).toHaveBeenCalledTimes(1);
  });

  it("includes conversation history in prompt for subsequent turns", async () => {
    const adapter = makeMockAdapter();
    const stateManager = makeMockStateManager();
    const runner = new ChatRunner(makeDeps({ adapter, stateManager }));

    runner.startSession("/repo");
    await runner.execute("First message", "/repo");
    await runner.execute("Second message", "/repo");

    // Second call's prompt should include the first turn history
    const secondCallTask = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCallTask.prompt).toContain("Previous conversation");
    expect(secondCallTask.prompt).toContain("First message");
  });

  it("limits history to last 10 turns", async () => {
    const adapter = makeMockAdapter();
    const stateManager = makeMockStateManager();
    const runner = new ChatRunner(makeDeps({ adapter, stateManager }));

    runner.startSession("/repo");

    // Execute 12 turns to build up history
    for (let i = 1; i <= 12; i++) {
      await runner.execute(`Message ${i}`, "/repo");
    }

    // 13th call: priorMessages = allMessages.slice(0, -1).slice(-10)
    // After 12 turns: allMessages has 24 msgs; slice(0,-1) = 23; slice(-10) = last 10
    // Those last 10 are from turns 8-12 area (assistant+user pairs)
    await runner.execute("Message 13", "/repo");
    const lastCallTask = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[12][0];

    // "Message 1" was in position 0 of all messages — should be dropped
    // "Message 12" (user, near end) should be in the window
    expect(lastCallTask.prompt).toContain("Message 12");
    // Message 1 is user message at index 0 — well outside the last 10 window
    // Verify it's not included by checking exact content
    const promptLines = lastCallTask.prompt.split("\n");
    const userLines = promptLines.filter((l: string) => l.startsWith("User: Message 1"));
    // "User: Message 1" might match "User: Message 10", "11", "12" so we check for "User: Message 1\n" pattern
    const exactMsg1 = promptLines.find((l: string) => l === "User: Message 1");
    expect(exactMsg1).toBeUndefined();
  });

  it("does not set system_prompt on AgentTask when buildSystemPrompt fails", async () => {
    // stateManager that makes buildSystemPrompt throw → cachedSystemPrompt = ""
    const sm = {
      listGoalIds: vi.fn().mockRejectedValue(new Error("fail")),
      loadGoal: vi.fn(),
      writeRaw: vi.fn().mockResolvedValue(undefined),
      readRaw: vi.fn().mockResolvedValue(null),
    } as unknown as StateManager;

    const adapter = makeMockAdapter();
    const runner = new ChatRunner(makeDeps({ adapter, stateManager: sm }));

    await runner.execute("Hello", "/repo");

    const task = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // When buildSystemPrompt throws, cachedSystemPrompt = "" → no system_prompt key on task
    expect(task.system_prompt).toBeUndefined();
  });
});
