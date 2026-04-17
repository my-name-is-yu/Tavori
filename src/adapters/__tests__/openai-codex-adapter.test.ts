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

import { OpenAICodexCLIAdapter } from "../agents/openai-codex.js";
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
    adapter_type: "openai_codex_cli",
    ...overrides,
  };
}

/**
 * Creates a FakeChildProcess, registers it with mockSpawn, and returns it
 * so the test can emit events to drive adapter behaviour.
 */
function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

// ─── Tests ───

describe("OpenAICodexCLIAdapter", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ─── adapterType ───

  it("adapterType is 'openai_codex_cli'", () => {
    const adapter = new OpenAICodexCLIAdapter();
    expect(adapter.adapterType).toBe("openai_codex_cli");
  });

  // ─── spawn args ───

  describe("spawn arguments", () => {
    it("spawns codex with sandbox and trusted-directory bypass flags, and writes prompt to stdin", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "run tests" }));
      child.emit("close", 0);
      await executePromise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cliPath, spawnArgs, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string }];
      expect(cliPath).toBe("codex");
      // Prompt must NOT appear in spawn args (would expose it in `ps aux`)
      expect(spawnArgs).toEqual(["exec", "-s", "workspace-write", "--skip-git-repo-check"]);
      expect(spawnArgs).not.toContain("run tests");
      expect(opts.cwd).toBe(".");
      // Prompt is delivered via stdin instead
      expect(child.stdin.write).toHaveBeenCalledWith("run tests", "utf8");
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("uses custom cliPath when configured", async () => {
      const adapter = new OpenAICodexCLIAdapter({ cliPath: "/usr/local/bin/codex" });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("/usr/local/bin/codex");
    });

    it("includes --model flag when model is configured", async () => {
      const adapter = new OpenAICodexCLIAdapter({ model: "o4-mini" });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "do task" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toContain("-m");
      expect(spawnArgs).toContain("o4-mini");
      expect(spawnArgs).not.toContain("--path");
      // Prompt must not appear in spawn args
      expect(spawnArgs).not.toContain("do task");
      // Prompt is written to stdin instead
      expect(child.stdin.write).toHaveBeenCalledWith("do task", "utf8");
    });

    it("omits --model flag when no model is configured", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("--model");
    });

    it("omits -s flag when sandboxPolicy is null", async () => {
      const adapter = new OpenAICodexCLIAdapter({ sandboxPolicy: null });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "hi" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("-s");
      // Prompt is not in args — it goes to stdin
      expect(spawnArgs).toEqual(["exec", "--skip-git-repo-check"]);
      expect(child.stdin.write).toHaveBeenCalledWith("hi", "utf8");
    });

    it("omits --skip-git-repo-check when explicitly disabled", async () => {
      const adapter = new OpenAICodexCLIAdapter({ skipGitRepoCheck: false });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "hi" }));
      child.emit("close", 0);
      await executePromise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("--skip-git-repo-check");
      expect(spawnArgs).toEqual(["exec", "-s", "workspace-write"]);
    });

    it("wraps codex execution with docker terminal backend when configured", async () => {
      const adapter = new OpenAICodexCLIAdapter({
        terminalBackend: { type: "docker", docker: { image: "node:22" } },
      });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ cwd: "/tmp/repo" }));
      child.emit("close", 0);
      await executePromise;

      const [cliPath, spawnArgs, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string }];
      expect(cliPath).toBe("docker");
      expect(spawnArgs).toContain("node:22");
      expect(spawnArgs).toContain("codex");
      expect(spawnArgs).toContain("/tmp/repo:/workspace");
      expect(opts.cwd).toBeUndefined();
    });
  });

  // ─── Success path ───

  describe("success result (exit code 0)", () => {
    it("returns success: true on exit code 0", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from("task completed"));
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.success).toBe(true);
      expect(result.exit_code).toBe(0);
      expect(result.stopped_reason).toBe("completed");
      expect(result.error).toBeNull();
    });

    it("captures stdout from the process", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from("first chunk "));
      child.stdout.emit("data", Buffer.from("second chunk"));
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.output).toBe("first chunk second chunk");
    });
  });

  // ─── Non-zero exit code ───

  describe("error result (non-zero exit code)", () => {
    it("returns success: false on non-zero exit code", async () => {
      const adapter = new OpenAICodexCLIAdapter();
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
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stderr.emit("data", Buffer.from("error: unknown command"));
      child.emit("close", 2);
      const result = await executePromise;

      expect(result.error).toContain("error: unknown command");
    });

    it("falls back to exit code message when stderr is empty and code is non-zero", async () => {
      const adapter = new OpenAICodexCLIAdapter();
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

      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ timeout_ms: 1000 }));

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(1001);

      // Simulate the process being killed: emit close after SIGTERM
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
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      const result = await executePromise;

      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("elapsed_ms reflects real time for a successful execution", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const before = Date.now();
      const executePromise = adapter.execute(makeTask());
      child.emit("close", 0);
      const result = await executePromise;
      const after = Date.now();

      expect(result.elapsed_ms).toBeLessThanOrEqual(after - before + 50);
    });
  });

  // ─── Spawn error ───

  describe("spawn error", () => {
    it("returns error result when the process emits an error event", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("spawn ENOENT");
    });

    it("exit_code is null when process emits an error event", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      const result = await executePromise;

      expect(result.exit_code).toBeNull();
    });

    it("captures any stdout emitted before the error", async () => {
      const adapter = new OpenAICodexCLIAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.stdout.emit("data", Buffer.from("partial output"));
      child.emit("error", new Error("crash"));
      const result = await executePromise;

      expect(result.output).toBe("partial output");
    });
  });
});
