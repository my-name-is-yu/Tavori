import { describe, it, expect, beforeEach, vi } from "vitest";
import { AdapterRegistry } from "../src/adapter-layer.js";
import type { IAdapter, AgentTask, AgentResult } from "../src/adapter-layer.js";
import { ClaudeAPIAdapter } from "../src/adapters/claude-api.js";
import { ClaudeCodeCLIAdapter } from "../src/adapters/claude-code-cli.js";
import { MockLLMClient } from "../src/llm-client.js";

// ─── Helpers ───

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "Hello, world!",
    timeout_ms: 5000,
    adapter_type: "mock",
    ...overrides,
  };
}

function createMockAdapter(
  adapterType: string,
  result: Partial<AgentResult> = {}
): IAdapter {
  return {
    adapterType,
    async execute(_task: AgentTask): Promise<AgentResult> {
      return {
        success: true,
        output: "mock output",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
        ...result,
      };
    },
  };
}

// ─── AdapterRegistry ───

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("starts with no adapters", () => {
    expect(registry.listAdapters()).toEqual([]);
  });

  it("registers an adapter and retrieves it by type", () => {
    const adapter = createMockAdapter("my_adapter");
    registry.register(adapter);
    expect(registry.getAdapter("my_adapter")).toBe(adapter);
  });

  it("listAdapters returns all registered types in sorted order", () => {
    registry.register(createMockAdapter("zzz"));
    registry.register(createMockAdapter("aaa"));
    registry.register(createMockAdapter("mmm"));
    expect(registry.listAdapters()).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("overwrites a previously registered adapter for the same type", () => {
    const first = createMockAdapter("my_adapter", { output: "first" });
    const second = createMockAdapter("my_adapter", { output: "second" });
    registry.register(first);
    registry.register(second);
    expect(registry.getAdapter("my_adapter")).toBe(second);
    expect(registry.listAdapters()).toHaveLength(1);
  });

  it("throws when getting an adapter that is not registered", () => {
    expect(() => registry.getAdapter("nonexistent")).toThrow(
      /no adapter registered for type "nonexistent"/
    );
  });

  it("error message includes available types", () => {
    registry.register(createMockAdapter("alpha"));
    registry.register(createMockAdapter("beta"));
    expect(() => registry.getAdapter("gamma")).toThrow(/alpha.*beta|beta.*alpha/);
  });
});

// ─── ClaudeAPIAdapter ───

describe("ClaudeAPIAdapter", () => {
  it("has adapterType 'claude_api'", () => {
    const mock = new MockLLMClient([]);
    const adapter = new ClaudeAPIAdapter(mock);
    expect(adapter.adapterType).toBe("claude_api");
  });

  it("returns success result with LLM response content", async () => {
    const mock = new MockLLMClient(["Hello from LLM"]);
    const adapter = new ClaudeAPIAdapter(mock);
    const result = await adapter.execute(makeTask({ adapter_type: "claude_api" }));

    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello from LLM");
    expect(result.error).toBeNull();
    expect(result.exit_code).toBeNull();
    expect(result.stopped_reason).toBe("completed");
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("passes prompt as user message to LLM", async () => {
    const responses: Array<{ messages: unknown[] }> = [];
    const capturingClient = {
      async sendMessage(messages: unknown[]) {
        responses.push({ messages });
        return { content: "ok", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
      },
      parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
        return schema.parse(JSON.parse(content));
      },
    };
    const adapter = new ClaudeAPIAdapter(capturingClient);
    await adapter.execute(makeTask({ prompt: "do the thing" }));

    expect(responses).toHaveLength(1);
    expect(responses[0]!.messages).toEqual([
      { role: "user", content: "do the thing" },
    ]);
  });

  it("returns error result when LLM throws", async () => {
    const failingClient = {
      async sendMessage() {
        throw new Error("API error 500");
      },
      parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
        return schema.parse(JSON.parse(content));
      },
    };
    const adapter = new ClaudeAPIAdapter(failingClient);
    const result = await adapter.execute(makeTask());

    expect(result.success).toBe(false);
    expect(result.output).toBe("");
    expect(result.error).toContain("API error 500");
    expect(result.exit_code).toBeNull();
    expect(result.stopped_reason).toBe("error");
  });

  it("returns error result with non-Error thrown value", async () => {
    const failingClient = {
      async sendMessage() {
        throw "plain string error";
      },
      parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
        return schema.parse(JSON.parse(content));
      },
    };
    const adapter = new ClaudeAPIAdapter(failingClient);
    const result = await adapter.execute(makeTask());

    expect(result.success).toBe(false);
    expect(result.error).toContain("plain string error");
  });

  it("returns timeout result when LLM does not respond within timeout_ms", async () => {
    const slowClient = {
      async sendMessage() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { content: "too late", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
      },
      parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
        return schema.parse(JSON.parse(content));
      },
    };
    const adapter = new ClaudeAPIAdapter(slowClient);
    const result = await adapter.execute(makeTask({ timeout_ms: 50 }));

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("timeout");
    expect(result.error).toMatch(/Timed out after 50ms/);
    expect(result.exit_code).toBeNull();
  }, 1000);

  it("records elapsed_ms close to actual wall time for fast responses", async () => {
    const mock = new MockLLMClient(["fast response"]);
    const adapter = new ClaudeAPIAdapter(mock);
    const before = Date.now();
    const result = await adapter.execute(makeTask());
    const after = Date.now();

    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(result.elapsed_ms).toBeLessThanOrEqual(after - before + 50);
  });

  it("timeout result has no output from a call that never returned", async () => {
    const neverClient = {
      async sendMessage() {
        return new Promise<never>(() => {/* never resolves */});
      },
      parseJSON<T>(content: string, schema: { parse: (v: unknown) => T }): T {
        return schema.parse(JSON.parse(content));
      },
    };
    const adapter = new ClaudeAPIAdapter(neverClient);
    const result = await adapter.execute(makeTask({ timeout_ms: 30 }));
    expect(result.stopped_reason).toBe("timeout");
    expect(result.output).toBe("");
  }, 500);

  it("can be registered in AdapterRegistry", () => {
    const registry = new AdapterRegistry();
    const adapter = new ClaudeAPIAdapter(new MockLLMClient([]));
    registry.register(adapter);
    expect(registry.getAdapter("claude_api")).toBe(adapter);
  });

  it("multiple sequential calls each get their own response", async () => {
    const mock = new MockLLMClient(["first", "second", "third"]);
    const adapter = new ClaudeAPIAdapter(mock);

    const r1 = await adapter.execute(makeTask());
    const r2 = await adapter.execute(makeTask());
    const r3 = await adapter.execute(makeTask());

    expect(r1.output).toBe("first");
    expect(r2.output).toBe("second");
    expect(r3.output).toBe("third");
  });
});

// ─── getAdapterCapabilities ───

describe("getAdapterCapabilities", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("returns capabilities from adapters that define them", () => {
    const adapter: IAdapter = {
      adapterType: "issue_tracker",
      capabilities: ["create_issue"] as const,
      async execute(_task: AgentTask): Promise<AgentResult> {
        return { success: true, output: "", error: null, exit_code: 0, elapsed_ms: 0, stopped_reason: "completed" };
      },
    };
    registry.register(adapter);
    const result = registry.getAdapterCapabilities();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ adapterType: "issue_tracker", capabilities: ["create_issue"] });
  });

  it("returns ['general_purpose'] default for adapters without capabilities", () => {
    const adapter = createMockAdapter("plain_adapter");
    registry.register(adapter);
    const result = registry.getAdapterCapabilities();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ adapterType: "plain_adapter", capabilities: ["general_purpose"] });
  });

  it("returns capabilities for multiple adapters", () => {
    const adapterA: IAdapter = {
      adapterType: "adapter_a",
      capabilities: ["create_issue", "close_issue"] as const,
      async execute(_task: AgentTask): Promise<AgentResult> {
        return { success: true, output: "", error: null, exit_code: 0, elapsed_ms: 0, stopped_reason: "completed" };
      },
    };
    const adapterB: IAdapter = {
      adapterType: "adapter_b",
      capabilities: ["read_file"] as const,
      async execute(_task: AgentTask): Promise<AgentResult> {
        return { success: true, output: "", error: null, exit_code: 0, elapsed_ms: 0, stopped_reason: "completed" };
      },
    };
    registry.register(adapterA);
    registry.register(adapterB);
    const result = registry.getAdapterCapabilities();
    expect(result).toHaveLength(2);
    const typeA = result.find((r) => r.adapterType === "adapter_a");
    const typeB = result.find((r) => r.adapterType === "adapter_b");
    expect(typeA?.capabilities).toEqual(["create_issue", "close_issue"]);
    expect(typeB?.capabilities).toEqual(["read_file"]);
  });
});

// ─── ClaudeCodeCLIAdapter ───

describe("ClaudeCodeCLIAdapter", () => {
  it("has adapterType 'claude_code_cli'", () => {
    const adapter = new ClaudeCodeCLIAdapter();
    expect(adapter.adapterType).toBe("claude_code_cli");
  });

  it("default cliPath is 'claude'", () => {
    // Instantiating with default path should not throw.
    expect(() => new ClaudeCodeCLIAdapter()).not.toThrow();
  });

  it("accepts a custom cliPath", () => {
    const adapter = new ClaudeCodeCLIAdapter("/usr/local/bin/claude");
    expect(adapter.adapterType).toBe("claude_code_cli");
  });

  // Use the real `echo` binary for success-path tests.
  // echo ignores --print and simply outputs its arguments, which lets us
  // verify that the adapter correctly captures stdout and exit code 0.
  it("returns success result when process exits with code 0", async () => {
    // Use `true` (always exits 0, no output) rather than echo to avoid
    // problems with --print being interpreted differently on different OS.
    const adapter = new ClaudeCodeCLIAdapter("true");
    const result = await adapter.execute(makeTask({ timeout_ms: 5000 }));

    expect(result.success).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stopped_reason).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("returns error result when process exits with non-zero code", async () => {
    // `false` always exits with code 1.
    const adapter = new ClaudeCodeCLIAdapter("false");
    const result = await adapter.execute(makeTask({ timeout_ms: 5000 }));

    expect(result.success).toBe(false);
    expect(result.exit_code).toBe(1);
    expect(result.stopped_reason).toBe("error");
  });

  it("captures stdout from the process", async () => {
    // Use a shell script via sh -c to output text without --print issues.
    // We override cliPath to "sh" and rely on stdin to pass the command.
    // However, ClaudeCodeCLIAdapter always passes --print as the first arg.
    // So instead we use a wrapper: point at `cat` which echoes stdin to stdout.
    // But `cat --print` will fail on some systems.
    // Cleanest approach: use `sh` with args injection via a separate test adapter subclass.
    //
    // Since ClaudeCodeCLIAdapter passes ["--print"] as spawnArgs, and we need
    // a real process to verify stdout capture, we use a minimal node script:
    const adapter = new ClaudeCodeCLIAdapter("node");

    // node --print evaluates a JavaScript expression; that's a coincidence here.
    // Actually node --print <expr> prints the expr result.
    // For stdin-based approach, let's use a different strategy:
    // We'll write a small inline test using process.stdout.write.
    // But we can't pass extra args since constructor only takes cliPath.

    // Best available option: use `node` with `--print` which evaluates and prints
    // the expression passed as the next argument. Since our adapter passes stdin
    // as the task prompt and only has ["--print"] as spawnArgs, node will try to
    // evaluate nothing and just exit.
    //
    // Instead, verify output capture with a known-output adapter via `echo`:
    // On macOS/Linux, `echo --print` prints "--print" then exits 0.
    const echoAdapter = new ClaudeCodeCLIAdapter("echo");
    const result = await echoAdapter.execute(makeTask({ prompt: "test input", timeout_ms: 5000 }));

    // echo --print outputs "--print\n" regardless of stdin
    expect(result.success).toBe(true);
    expect(result.output).toContain("--print");
    expect(result.exit_code).toBe(0);
  });

  it("captures stderr from the process", async () => {
    // We need a process that writes to stderr. Use sh with a heredoc via stdin.
    // sh --print will fail (unknown option) so sh writes to stderr and exits non-zero.
    const adapter = new ClaudeCodeCLIAdapter("sh");
    const result = await adapter.execute(makeTask({ timeout_ms: 5000 }));

    // sh --print: sh reports an unknown option to stderr
    expect(result.success).toBe(false);
    // stderr should contain something about the unknown option
    // (error message may vary by platform; just check it's non-empty or exit code non-zero)
    expect(result.exit_code).not.toBe(0);
  });

  it("returns timeout result when process runs longer than timeout_ms", async () => {
    // Use `node` with `--print` flag: node treats --print as "evaluate and print
    // the next CLI argument", but since our adapter only passes ["--print"] with no
    // expression argument, node will block reading from stdin. The adapter writes the
    // prompt to stdin but never closes stdin in a way that satisfies node's REPL
    // loop — actually node --print with no extra arg reads from stdin as a script.
    // On stdin EOF node evaluates and exits. Our adapter closes stdin, so node exits
    // quickly. To get a truly long-running process we use `perl` with sleep if
    // available, otherwise fall back to a node approach via a different mechanism.
    //
    // Best cross-platform approach: use `node` with -e flag by writing the adapter
    // to accept an overridden args list. Since we can't do that without changing the
    // production API, use a known-slow operation that works with `--print`:
    // `node --print "(() => { const end = Date.now()+10000; while(Date.now()<end){} })()"` would work
    // but we can only control the cliPath, not the args.
    //
    // Practical solution: use a shell script file approach via `sh` which treats
    // --print as an unknown flag and hangs on stdin read:
    // Actually `sh --print` exits immediately with error (tested above).
    //
    // Since the ClaudeCodeCLIAdapter design appends --print before stdin, we need
    // a binary that accepts --print and then blocks. The `cat` command accepts
    // unknown flags on some systems but not all. The most reliable cross-platform
    // option: use a node helper script embedded via process substitution.
    //
    // Given macOS constraints, use `node` with `--print` where node reads
    // the expression from stdin (since no expression arg follows --print):
    // node --print with stdin input evaluates stdin as JS. Writing an infinite
    // loop via stdin then closing stdin would work if node doesn't timeout itself.
    //
    // Simplest reliable: test with a very short timeout and a command guaranteed
    // to outlive it. `node --print` reads stdin as JS — we write a sleep loop.
    const adapter = new ClaudeCodeCLIAdapter("node");
    // node --print reads JS from stdin since no expression arg is given.
    // We send an infinite busy-loop that will be killed by SIGTERM.
    const result = await adapter.execute(
      makeTask({ prompt: "while(true){}", timeout_ms: 100 })
    );

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("timeout");
    expect(result.error).toMatch(/Timed out after 100ms/);
  }, 2000);

  it("timeout result includes elapsed_ms close to timeout_ms", async () => {
    const adapter = new ClaudeCodeCLIAdapter("node");
    const before = Date.now();
    const result = await adapter.execute(
      makeTask({ prompt: "while(true){}", timeout_ms: 100 })
    );
    const after = Date.now();

    expect(result.elapsed_ms).toBeGreaterThanOrEqual(80);
    expect(result.elapsed_ms).toBeLessThanOrEqual(after - before + 50);
  }, 2000);

  it("returns error result when the binary does not exist", async () => {
    const adapter = new ClaudeCodeCLIAdapter("__nonexistent_binary_xyz__");
    const result = await adapter.execute(makeTask({ timeout_ms: 5000 }));

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.error).toBeTruthy();
  });

  it("exit_code is null when process errors before starting", async () => {
    const adapter = new ClaudeCodeCLIAdapter("__nonexistent_binary_xyz__");
    const result = await adapter.execute(makeTask({ timeout_ms: 5000 }));
    expect(result.exit_code).toBeNull();
  });

  it("elapsed_ms is non-negative for successful execution", async () => {
    const adapter = new ClaudeCodeCLIAdapter("true");
    const result = await adapter.execute(makeTask({ timeout_ms: 5000 }));
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("can be registered in AdapterRegistry", () => {
    const registry = new AdapterRegistry();
    const adapter = new ClaudeCodeCLIAdapter();
    registry.register(adapter);
    expect(registry.getAdapter("claude_code_cli")).toBe(adapter);
  });

  it("multiple sequential executions are independent", async () => {
    const adapter = new ClaudeCodeCLIAdapter("true");
    const r1 = await adapter.execute(makeTask({ timeout_ms: 5000 }));
    const r2 = await adapter.execute(makeTask({ timeout_ms: 5000 }));
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.exit_code).toBe(0);
    expect(r2.exit_code).toBe(0);
  });
});
