import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── Mock child_process.spawn ───
//
// vi.mock() is hoisted to the top of the file by vitest, so any variables
// referenced inside the factory must themselves be declared via vi.hoisted()
// to be available before the mock factory runs.

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { ClaudeCodeCLIAdapter } from "../agents/claude-code-cli.js";
import type { AgentTask } from "../../orchestrator/execution/adapter-layer.js";

// ─── Helpers ───

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  readonly kill = vi.fn();
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "do something",
    timeout_ms: 5000,
    adapter_type: "claude_code_cli",
    ...overrides,
  };
}

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

// ─── Tests ───

describe("ClaudeCodeCLIAdapter", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ─── adapterType ───

  it("adapterType is 'claude_code_cli'", () => {
    const adapter = new ClaudeCodeCLIAdapter();
    expect(adapter.adapterType).toBe("claude_code_cli");
  });

  // ─── spawn arguments (flag verification) ───

  describe("spawn arguments", () => {
    it("spawns claude with --print flag by default", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cliPath, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("claude");
      expect(spawnArgs).toContain("--print");
    });

    it("uses 'claude' as default CLI path", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("claude");
    });

    it("uses custom cliPath when provided", async () => {
      const adapter = new ClaudeCodeCLIAdapter("/usr/local/bin/claude");
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("/usr/local/bin/claude");
    });

    it("passes only --print in spawnArgs (prompt is sent via stdin, not as positional arg)", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "my task" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toEqual(["--print"]);
      // Prompt must NOT be in spawnArgs — it is sent via stdin
      expect(spawnArgs).not.toContain("my task");
    });

    it("writes the task prompt to stdin", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "hello world" }));
      child.emit("close", 0);
      await executePromise;

      expect(child.stdin.write).toHaveBeenCalledWith("hello world", "utf8");
    });

    it("wraps claude execution with docker terminal backend when configured", async () => {
      const adapter = new ClaudeCodeCLIAdapter({
        terminalBackend: { type: "docker", docker: { image: "node:22" } },
      });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ cwd: "/tmp/repo" }));
      child.emit("close", 0);
      await executePromise;

      const [cliPath, spawnArgs, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string }];
      expect(cliPath).toBe("docker");
      expect(spawnArgs).toContain("node:22");
      expect(spawnArgs).toContain("claude");
      expect(spawnArgs).toContain("/tmp/repo:/workspace");
      expect(opts.cwd).toBeUndefined();
    });

    it("closes stdin after writing the prompt", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      expect(child.stdin.end).toHaveBeenCalled();
    });
  });

  // ─── Success path ───

  describe("success result (exit code 0)", () => {
    it("returns success: true on exit code 0", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from("task done"));
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.success).toBe(true);
      expect(result.exit_code).toBe(0);
      expect(result.stopped_reason).toBe("completed");
      expect(result.error).toBeNull();
    });

    it("captures stdout output from the process", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from("first "));
      child.stdout.emit("data", Buffer.from("second"));
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.output).toBe("first second");
    });
  });

  // ─── Non-zero exit code ───

  describe("error result (non-zero exit code)", () => {
    it("returns success: false on non-zero exit code", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stderr.emit("data", Buffer.from("something went wrong"));
      child.emit("close", 1);
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(1);
      expect(result.stopped_reason).toBe("error");
    });

    it("includes stderr in error field when process exits with non-zero code", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stderr.emit("data", Buffer.from("error: flag not recognized"));
      child.emit("close", 2);
      const result = await executePromise;

      expect(result.error).toContain("error: flag not recognized");
    });

    it("falls back to exit code message when stderr is empty and code is non-zero", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 127);
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("127");
    });
  });

  // ─── Timeout ───

  describe("timeout", () => {
    it("sends SIGTERM and returns timeout result when timeout_ms elapses", async () => {
      vi.useFakeTimers();

      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ timeout_ms: 1000 }));

      await vi.advanceTimersByTimeAsync(1001);
      child.emit("close", null);

      const result = await executePromise;
      vi.useRealTimers();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("timeout");
      expect(result.error).toMatch(/Timed out after 1000ms/);
    });
  });

  // ─── elapsed_ms ───

  describe("elapsed_ms", () => {
    it("tracks elapsed_ms as a non-negative number", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Spawn error ───

  describe("spawn error", () => {
    it("returns error result when the process emits an error event", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("spawn ENOENT");
    });

    it("exit_code is null when process emits an error event", async () => {
      const adapter = new ClaudeCodeCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      const result = await executePromise;

      expect(result.exit_code).toBeNull();
    });
  });
});
