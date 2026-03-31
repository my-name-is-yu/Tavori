import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { GuardrailRunner } from "../src/guardrail-runner.js";
import { LLMClient } from "../src/llm/llm-client.js";
import { StateManager } from "../src/state-manager.js";
import { SessionManager } from "../src/execution/session-manager.js";
import { TrustManager } from "../src/traits/trust-manager.js";
import { StrategyManager } from "../src/strategy/strategy-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import { TaskLifecycle } from "../src/execution/task-lifecycle.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../src/llm/llm-client.js";
import type { IGuardrailHook, GuardrailContext } from "../src/types/guardrail.js";
import type { Task } from "../src/types/task.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function makeBlockingHook(
  checkpoint: GuardrailContext["checkpoint"],
  name = "block"
): IGuardrailHook {
  return {
    name,
    checkpoint,
    priority: 1,
    execute: async (ctx) => ({
      hook_name: name,
      checkpoint: ctx.checkpoint,
      allowed: false,
      severity: "critical" as const,
      reason: `${name} blocked request`,
    }),
  };
}

function createMockLLMClient(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      const content = responses[callIndex++] ?? "";
      return {
        content,
        usage: { input_tokens: 10, output_tokens: content.length },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAdapter(
  result: Partial<import("../src/execution/task-lifecycle.js").AgentResult> = {}
): import("../src/execution/task-lifecycle.js").IAdapter {
  return {
    adapterType: "mock",
    async execute(
      _task: import("../src/execution/task-lifecycle.js").AgentTask
    ): Promise<import("../src/execution/task-lifecycle.js").AgentResult> {
      return {
        success: true,
        output: "Task completed successfully",
        error: null,
        exit_code: 0,
        elapsed_ms: 50,
        stopped_reason: "completed",
        ...result,
      };
    },
  };
}

// ─── LLMClient guardrail integration ───

describe("LLMClient guardrail integration", () => {
  // We mock the Anthropic SDK's messages.create to avoid real HTTP calls.
  // LLMClient only has one real API: sendMessage() which calls client.messages.create.

  it("before_model hook blocks the LLM call (throws)", async () => {
    const runner = new GuardrailRunner();
    runner.register(makeBlockingHook("before_model", "block-before"));

    const client = new LLMClient("test-key", runner);

    // Patch the private Anthropic client so no real network call happens
    (client as any).client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      },
    };

    await expect(
      client.sendMessage([{ role: "user", content: "hi" }])
    ).rejects.toThrow(/block-before blocked request/);

    // The underlying API should NOT have been called
    expect((client as any).client.messages.create).not.toHaveBeenCalled();
  });

  it("after_model hook blocks the response (throws)", async () => {
    const runner = new GuardrailRunner();
    runner.register(makeBlockingHook("after_model", "block-after"));

    const client = new LLMClient("test-key", runner);

    // Patch so the API call succeeds but after_model blocks
    (client as any).client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "dangerous output" }],
          usage: { input_tokens: 5, output_tokens: 15 },
          stop_reason: "end_turn",
        }),
      },
    };

    await expect(
      client.sendMessage([{ role: "user", content: "hi" }])
    ).rejects.toThrow(/block-after blocked request/);
  });

  it("passing guardrail runner does not interfere with normal LLM call", async () => {
    const runner = new GuardrailRunner();
    // no blocking hooks

    const client = new LLMClient("test-key", runner);

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok response" }],
      usage: { input_tokens: 5, output_tokens: 5 },
      stop_reason: "end_turn",
    });
    (client as any).client = { messages: { create: mockCreate } };

    const result = await client.sendMessage([{ role: "user", content: "hello" }]);
    expect(result.content).toBe("ok response");
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});

// ─── TaskLifecycle guardrail integration ───

describe("TaskLifecycle guardrail integration", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Default mock execFileSyncFn: simulates a changed file so the post-execution
  // scope check does not force success=false when no real git repo is available.
  const mockExecFileSync = (_cmd: string, _args: string[], _opts: { cwd: string; encoding: "utf-8" }): string => "some-file.ts";

  function createLifecycle(
    llmClient: ILLMClient,
    guardrailRunner?: GuardrailRunner
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { guardrailRunner, execFileSyncFn: mockExecFileSync }
    );
  }

  it("before_tool hook blocks task execution and returns failure AgentResult", async () => {
    const runner = new GuardrailRunner();
    runner.register(makeBlockingHook("before_tool", "block-before-tool"));

    const llmClient = createMockLLMClient([]);
    const lifecycle = createLifecycle(llmClient, runner);
    const task = makeTask();
    const adapter = createMockAdapter();

    const result = await lifecycle.executeTask(task, adapter);

    expect(result.success).toBe(false);
    expect(result.error).toBe("guardrail_rejected");
    expect(result.output).toMatch(/block-before-tool blocked request/);
    expect(result.stopped_reason).toBe("error");
  });

  it("after_tool hook blocks result and returns failure AgentResult", async () => {
    const runner = new GuardrailRunner();
    runner.register(makeBlockingHook("after_tool", "block-after-tool"));

    const llmClient = createMockLLMClient([]);
    const lifecycle = createLifecycle(llmClient, runner);
    const task = makeTask();

    // Adapter succeeds, but after_tool guardrail blocks the result
    const adapter = createMockAdapter({
      success: true,
      output: "task succeeded",
      exit_code: 0,
    });

    const result = await lifecycle.executeTask(task, adapter);

    expect(result.success).toBe(false);
    expect(result.error).toBe("guardrail_rejected");
    expect(result.output).toMatch(/block-after-tool blocked request/);
    expect(result.stopped_reason).toBe("error");
  });

  it("no guardrail runner allows task execution to pass through", async () => {
    const llmClient = createMockLLMClient([]);
    const lifecycle = createLifecycle(llmClient, undefined);
    const task = makeTask();
    const adapter = createMockAdapter({ success: true, output: "done" });

    const result = await lifecycle.executeTask(task, adapter);

    expect(result.success).toBe(true);
    expect(result.output).toBe("done");
  });

  it("before_tool block preserves elapsed_ms as 0", async () => {
    const runner = new GuardrailRunner();
    runner.register(makeBlockingHook("before_tool", "block-before-tool"));

    const lifecycle = createLifecycle(createMockLLMClient([]), runner);
    const result = await lifecycle.executeTask(makeTask(), createMockAdapter());

    expect(result.elapsed_ms).toBe(0);
  });

  it("after_tool block preserves elapsed_ms from underlying execution", async () => {
    const runner = new GuardrailRunner();
    runner.register(makeBlockingHook("after_tool", "block-after-tool"));

    const lifecycle = createLifecycle(createMockLLMClient([]), runner);
    const result = await lifecycle.executeTask(
      makeTask(),
      createMockAdapter({ elapsed_ms: 123 })
    );

    expect(result.elapsed_ms).toBe(123);
  });
});
