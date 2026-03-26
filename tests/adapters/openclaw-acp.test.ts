import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── Mock child_process.spawn ───
//
// vi.mock() is hoisted by vitest. Variables referenced inside the factory
// must be declared via vi.hoisted() to be available before the factory runs.

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { OpenClawACPAdapter } from "../../src/adapters/openclaw-acp.js";
import type { AgentTask } from "../../src/execution/adapter-layer.js";

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
  exitCode: number | null = null;
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "do something",
    timeout_ms: 5000,
    adapter_type: "openclaw_acp",
    ...overrides,
  };
}

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

/** Emit a valid ACP JSON-RPC response for the given request ID. */
function emitResponse(
  child: FakeChildProcess,
  id: number,
  content: string,
  sessionKey = "sess-123"
): void {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content, sessionKey, done: true },
  });
  child.stdout.emit("data", Buffer.from(response + "\n"));
}

/** Emit an ACP error response. */
function emitErrorResponse(
  child: FakeChildProcess,
  id: number,
  code: number,
  message: string
): void {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  child.stdout.emit("data", Buffer.from(response + "\n"));
}

// ─── Tests ───

describe("OpenClawACPAdapter", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ─── adapterType ───

  it("adapterType is 'openclaw_acp'", () => {
    const adapter = new OpenClawACPAdapter();
    expect(adapter.adapterType).toBe("openclaw_acp");
  });

  // ─── capabilities ───

  it("capabilities include expected entries", () => {
    const adapter = new OpenClawACPAdapter();
    const caps = Array.from(adapter.capabilities);
    expect(caps).toContain("execute_code");
    expect(caps).toContain("read_files");
    expect(caps).toContain("write_files");
    expect(caps).toContain("run_commands");
    expect(caps).toContain("browse_web");
    expect(caps).toContain("search");
  });

  // ─── spawn arguments ───

  describe("spawn arguments", () => {
    it("spawns 'openclaw acp --profile default' by default", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      emitResponse(child, 1, "done");
      await executePromise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe("openclaw");
      expect(args).toEqual(["acp", "--profile", "default"]);
    });

    it("uses custom cliPath and profile when provided", async () => {
      const adapter = new OpenClawACPAdapter({
        cliPath: "/usr/local/bin/openclaw",
        profile: "work",
      });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      emitResponse(child, 1, "done");
      await executePromise;

      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe("/usr/local/bin/openclaw");
      expect(args).toContain("work");
    });

    it("appends --model flag when model is configured", async () => {
      const adapter = new OpenClawACPAdapter({ model: "gpt-4o" });
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      emitResponse(child, 1, "done");
      await executePromise;

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(args).toContain("--model");
      expect(args).toContain("gpt-4o");
    });
  });

  // ─── Normal execution ───

  describe("normal execution", () => {
    it("returns success: true with the response content", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "hello" }));
      emitResponse(child, 1, "Hello back!");
      const result = await executePromise;

      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello back!");
      expect(result.error).toBeNull();
      expect(result.stopped_reason).toBe("completed");
      expect(result.exit_code).toBeNull();
    });

    it("elapsed_ms is a non-negative number", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      emitResponse(child, 1, "ok");
      const result = await executePromise;

      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("sends a JSON-RPC message/send request to stdin", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask({ prompt: "my prompt" }));
      emitResponse(child, 1, "ack");
      await executePromise;

      const writtenData = (child.stdin.write as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      const parsed = JSON.parse(writtenData) as {
        jsonrpc: string;
        method: string;
        params: { message: string };
      };
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("message/send");
      expect(parsed.params.message).toBe("my prompt");
    });

    it("reuses the child process across multiple execute() calls", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const p1 = adapter.execute(makeTask({ prompt: "first" }));
      emitResponse(child, 1, "response1");
      await p1;

      const p2 = adapter.execute(makeTask({ prompt: "second" }));
      emitResponse(child, 2, "response2");
      await p2;

      // Spawn should only have been called once
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  // ─── ACP error response ───

  describe("ACP error response", () => {
    it("returns success: false on ACP error", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      emitErrorResponse(child, 1, -32600, "Invalid request");
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("Invalid request");
    });
  });

  // ─── JSON parse error ───

  describe("JSON parse error", () => {
    it("skips non-JSON lines and does not crash", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());

      // Emit garbage first, then valid response
      child.stdout.emit("data", Buffer.from("not-json\n"));
      emitResponse(child, 1, "recovered");

      const result = await executePromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe("recovered");
    });
  });

  // ─── Timeout ───

  describe("timeout", () => {
    it("returns timeout result when timeout_ms elapses with no response", async () => {
      vi.useFakeTimers();

      const adapter = new OpenClawACPAdapter();
      makeFakeChild(); // child created but never responds

      const executePromise = adapter.execute(makeTask({ timeout_ms: 1000 }));

      await vi.advanceTimersByTimeAsync(1001);
      const result = await executePromise;

      vi.useRealTimers();

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("timeout");
      expect(result.error).toMatch(/Timed out after 1000ms/);
    });
  });

  // ─── Process error ───

  describe("process error", () => {
    it("returns error result when the child process emits an error event", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("error", new Error("spawn ENOENT"));
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("spawn ENOENT");
    });

    it("returns error result when the child process closes unexpectedly", async () => {
      const adapter = new OpenClawACPAdapter();
      const child = makeFakeChild();

      const executePromise = adapter.execute(makeTask());
      child.emit("close", null);
      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
    });

    it("returns error result when spawn itself throws (e.g. ENOENT)", async () => {
      // Make spawn throw synchronously
      mockSpawn.mockImplementationOnce(() => {
        throw new Error("spawn ENOENT");
      });

      const adapter = new OpenClawACPAdapter();
      const result = await adapter.execute(makeTask());

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.error).toContain("spawn ENOENT");
    });
  });
});
