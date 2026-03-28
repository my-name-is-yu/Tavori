import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";

// ─── Mock child_process.spawn and fs ───
//
// vi.mock() is hoisted by vitest, so variables used inside factory functions
// must be declared via vi.hoisted().

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

// Track temp file contents for read simulation
const { mockTmpContents } = vi.hoisted(() => ({
  mockTmpContents: { value: "" },
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn((_prefix: string) => "/tmp/pulseed-codex-test123"),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: vi.fn((_prefix: string) => Promise.resolve("/tmp/pulseed-codex-test123")),
    readFile: vi.fn((_path: string, _encoding: string) => Promise.resolve(mockTmpContents.value)),
    access: vi.fn(() => Promise.resolve()),
    unlink: vi.fn(() => Promise.resolve()),
    rmdir: vi.fn(() => Promise.resolve()),
  };
});

import { CodexLLMClient } from "../src/llm/codex-llm-client.js";

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

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

/** Flush microtask queue so that async operations (e.g. fsp.mkdtemp) resolve before we emit child events */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ─── Tests ───

describe("CodexLLMClient", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockTmpContents.value = "default response";
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ─── Constructor ───

  describe("constructor", () => {
    it("uses default cliPath 'codex'", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "response";

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("codex");
    });

    it("uses custom cliPath when configured", async () => {
      const client = new CodexLLMClient({ cliPath: "/usr/local/bin/codex" });
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [cliPath] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cliPath).toBe("/usr/local/bin/codex");
    });
  });

  // ─── spawn arguments ───

  describe("sendMessage: spawn args", () => {
    it("spawns with exec -s danger-full-access -o <path> - (stdin mode) and cwd set", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "do the task" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs, spawnOpts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
      expect(spawnArgs[0]).toBe("exec");
      expect(spawnArgs).not.toContain("--ephemeral");
      expect(spawnArgs).not.toContain("--full-auto");
      expect(spawnArgs).toContain("-s");
      expect(spawnArgs).toContain("danger-full-access");
      // --path is not supported by codex-cli 0.114.0+; cwd is used instead
      expect(spawnArgs).not.toContain("--path");
      expect(spawnOpts.cwd).toBeTruthy();
      expect(spawnArgs).toContain("-o");
      // -o must be followed by a path
      const dashOIdx = spawnArgs.indexOf("-o");
      expect(spawnArgs[dashOIdx + 1]).toBeTruthy();
      // Last arg is "-" (read prompt from stdin)
      expect(spawnArgs[spawnArgs.length - 1]).toBe("-");
    });

    it("includes --model flag when model is configured", async () => {
      const client = new CodexLLMClient({ model: "o4-mini" });
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toContain("--model");
      const modelIdx = spawnArgs.indexOf("--model");
      expect(spawnArgs[modelIdx + 1]).toBe("o4-mini");
    });

    it("omits --model flag when no model is configured", async () => {
      vi.stubEnv("OPENAI_MODEL", "");
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([{ role: "user", content: "hi" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).not.toContain("--model");
    });

    it("uses model from options.model when provided", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage(
        [{ role: "user", content: "hi" }],
        { model: "o3" }
      );
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const [, spawnArgs] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(spawnArgs).toContain("--model");
      const modelIdx = spawnArgs.indexOf("--model");
      expect(spawnArgs[modelIdx + 1]).toBe("o3");
    });
  });

  // ─── Prompt building ───

  describe("sendMessage: prompt building (via stdin)", () => {
    it("writes prompt to stdin from user messages", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([
        { role: "user", content: "hello world" },
      ]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const prompt = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("user: hello world");
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("prepends system instruction to prompt written to stdin", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage(
        [{ role: "user", content: "question" }],
        { system: "You are a helpful assistant." }
      );
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const prompt = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("System instruction: You are a helpful assistant.");
      expect(prompt).toContain("user: question");
      // System should appear before user message
      expect(prompt.indexOf("System instruction")).toBeLessThan(prompt.indexOf("user:"));
    });

    it("concatenates multiple messages in order via stdin", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();

      const promise = client.sendMessage([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]);
      await flushMicrotasks();
      child.emit("close", 0);
      await promise;

      const prompt = child.stdin.write.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("user: first");
      expect(prompt).toContain("assistant: reply");
      expect(prompt).toContain("user: second");
      expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("reply"));
      expect(prompt.indexOf("reply")).toBeLessThan(prompt.indexOf("second"));
    });
  });

  // ─── Response reading ───

  describe("sendMessage: reads response from output file", () => {
    it("returns content read from temp file", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = '{"result": "done"}';

      const promise = client.sendMessage([{ role: "user", content: "go" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      const result = await promise;

      expect(result.content).toBe('{"result": "done"}');
    });

    it("returns stop_reason 'end_turn' on success", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "ok";

      const promise = client.sendMessage([{ role: "user", content: "go" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      const result = await promise;

      expect(result.stop_reason).toBe("end_turn");
    });

    it("returns usage stats as 0 (not available from CLI)", async () => {
      const client = new CodexLLMClient();
      const child = makeFakeChild();
      mockTmpContents.value = "response";

      const promise = client.sendMessage([{ role: "user", content: "go" }]);
      await flushMicrotasks();
      child.emit("close", 0);
      const result = await promise;

      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
    });
  });

  // ─── Error handling ───

  describe("sendMessage: spawn error", () => {
    it("throws when spawn emits error event (single attempt, no retry delay)", async () => {
      // Use fake timers to skip retry delays
      vi.useFakeTimers();

      const client = new CodexLLMClient({ cliPath: "codex" });

      // Queue children for all 3 retry attempts
      const children: FakeChildProcess[] = [];
      for (let i = 0; i < 3; i++) {
        children.push(makeFakeChild());
      }

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);

      // Flush microtasks so mkdtemp resolves and spawn is called before emitting error
      await vi.advanceTimersByTimeAsync(0);
      // Immediately emit error on first child
      children[0]!.emit("error", new Error("spawn ENOENT"));
      // Advance timers to trigger retry delays, emit error on subsequent children
      await vi.advanceTimersByTimeAsync(1001);
      children[1]!.emit("error", new Error("spawn ENOENT"));
      await vi.advanceTimersByTimeAsync(2001);
      children[2]!.emit("error", new Error("spawn ENOENT"));
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("spawn ENOENT");
    });

    it("throws when process exits with non-zero code (after retries)", async () => {
      vi.useFakeTimers();

      const client = new CodexLLMClient();

      const children: FakeChildProcess[] = [];
      for (let i = 0; i < 3; i++) {
        children.push(makeFakeChild());
      }

      const promise = client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);

      // Flush microtasks so mkdtemp resolves and spawn is called before emitting close
      await vi.advanceTimersByTimeAsync(0);
      children[0]!.emit("close", 1);
      await vi.advanceTimersByTimeAsync(1001);
      children[1]!.emit("close", 1);
      await vi.advanceTimersByTimeAsync(2001);
      children[2]!.emit("close", 1);
      await vi.runAllTimersAsync();

      vi.useRealTimers();

      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("exited with code 1");
    });
  });

  // ─── Timeout ───

  describe("sendMessage: timeout", () => {
    it("rejects with timeout error when timeoutMs elapses", async () => {
      const client = new CodexLLMClient({ timeoutMs: 50 });

      // Set up 3 fake children that emit "close" only AFTER timeout fires
      for (let i = 0; i < 3; i++) {
        const child = new FakeChildProcess();
        mockSpawn.mockReturnValueOnce(child);
        // When kill is called (by timeout), emit close
        child.kill.mockImplementation(() => {
          setTimeout(() => child.emit("close", null), 5);
          return true;
        });
      }

      const err = await client.sendMessage([{ role: "user", content: "hi" }]).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("timed out");
    });
  });

  // ─── parseJSON ───

  describe("parseJSON", () => {
    const schema = z.object({ name: z.string(), value: z.number() });

    it("parses bare JSON", () => {
      const client = new CodexLLMClient();
      const result = client.parseJSON('{"name":"test","value":42}', schema);
      expect(result).toEqual({ name: "test", value: 42 });
    });

    it("parses JSON in ```json code block", () => {
      const client = new CodexLLMClient();
      const content = '```json\n{"name":"hello","value":1}\n```';
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "hello", value: 1 });
    });

    it("parses JSON in generic ``` code block", () => {
      const client = new CodexLLMClient();
      const content = '```\n{"name":"world","value":99}\n```';
      const result = client.parseJSON(content, schema);
      expect(result).toEqual({ name: "world", value: 99 });
    });

    it("throws on invalid JSON", () => {
      const client = new CodexLLMClient();
      expect(() => client.parseJSON("not json", schema)).toThrow(
        "LLM response JSON parse failed"
      );
    });

    it("includes content in error message for failed parse", () => {
      const client = new CodexLLMClient();
      const badContent = "definitely not json";
      expect(() => client.parseJSON(badContent, schema)).toThrow(badContent);
    });

    it("throws on schema validation failure", () => {
      const client = new CodexLLMClient();
      expect(() =>
        client.parseJSON('{"name":123,"value":"wrong"}', schema)
      ).toThrow();
    });
  });
});
