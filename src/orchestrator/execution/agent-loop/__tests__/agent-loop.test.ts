import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import * as fs from "node:fs";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../../base/llm/llm-client.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolResult } from "../../../../tools/types.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import { SessionManager } from "../../session-manager.js";
import { TrustManager } from "../../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../../strategy/strategy-manager.js";
import { StallDetector } from "../../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../../task/task-lifecycle.js";
import type { Task } from "../../../../base/types/task.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import {
  BoundedAgentLoopRunner,
  ILLMClientAgentLoopModelClient,
  InMemoryAgentLoopTraceStore,
  StaticAgentLoopModelRegistry,
  TaskAgentLoopRunner,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  createAgentLoopSession,
  defaultAgentLoopCapabilities,
  parseAgentLoopModelRef,
  withDefaultBudget,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
} from "../index.js";

class EchoTool implements ITool<{ value: string }> {
  readonly metadata = {
    name: "echo",
    aliases: [],
    permissionLevel: "read_only" as const,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test"],
  };
  readonly inputSchema = z.object({ value: z.string() });

  description(): string {
    return "Echo a test value.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { echoed: input.value },
      summary: `echoed ${input.value}`,
      durationMs: 1,
    };
  }

  async checkPermissions(_input: { value: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { value: string }): boolean {
    return true;
  }
}

class VerifyTool implements ITool<{ command: string; cwd?: string }> {
  readonly metadata = {
    name: "verify",
    aliases: [],
    permissionLevel: "read_only" as const,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test", "verification"],
  };
  readonly inputSchema = z.object({ command: z.string(), cwd: z.string().optional() });

  description(): string {
    return "Record a verification command for tests.";
  }

  async call(input: { command: string; cwd?: string }, context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { verified: input.command, cwd: input.cwd ?? context.cwd },
      summary: `verified ${input.command}`,
      durationMs: 1,
      contextModifier: `Verification output: ${input.command}`,
    };
  }

  async checkPermissions(_input: { command: string; cwd?: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { command: string; cwd?: string }): boolean {
    return true;
  }
}

class ScriptedModelClient implements AgentLoopModelClient {
  calls: AgentLoopModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly modelInfo: AgentLoopModelInfo,
    private readonly responses: AgentLoopModelResponse[],
  ) {}

  async getModelInfo(): Promise<AgentLoopModelInfo> {
    return this.modelInfo;
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    this.calls.push(input);
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1];
  }
}

function makeModelInfo(overrides: Partial<AgentLoopModelInfo> = {}): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
    ...overrides,
  };
}

function makeToolRuntime() {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
  return {
    registry,
    router,
    runtime: new ToolExecutorAgentLoopToolRuntime(executor, router),
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
    success_criteria: [{ description: "done", verification_method: "unit", is_blocking: true }],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
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

function finalJson(status = "done") {
  return JSON.stringify({
    status,
    finalAnswer: "finished",
    summary: "summary",
    filesChanged: ["src/example.ts"],
    testsRun: [{ command: "npm test", passed: true, outputSummary: "ok" }],
    completionEvidence: ["unit evidence"],
    verificationHints: ["hint"],
    blockers: [],
  });
}

describe("agentloop phase 0", () => {
  it("stores trace events and parses provider/model refs", async () => {
    const ref = parseAgentLoopModelRef("openai/gpt-test");
    expect(ref).toEqual({ providerId: "openai", modelId: "gpt-test" });

    const store = new InMemoryAgentLoopTraceStore();
    await store.append({
      type: "started",
      eventId: "event-1",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "turn-1",
      goalId: "goal-1",
      createdAt: new Date().toISOString(),
    });
    expect(await store.list("trace-1")).toHaveLength(1);
  });
});

describe("agentloop phase 1", () => {
  it("exposes structured tool schemas to the model", () => {
    const { router } = makeToolRuntime();
    const tools = router.modelVisibleTools({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: { providerId: "test", modelId: "model" },
      modelInfo: makeModelInfo(),
      messages: [{ role: "user", content: "schema" }],
      outputSchema: z.object({ ok: z.boolean() }),
      budget: withDefaultBudget({}),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(tools[0]?.function.name).toBe("echo");
    expect(tools[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        value: {
          type: "string",
        },
      },
      required: ["value"],
    });
  });

  it("executes model-selected tools and returns schema-valid final output", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", input: { value: "hello" } }],
        stopReason: "tool_use",
      },
      { content: finalJson(), toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const session = createAgentLoopSession();

    const result = await runner.run({
      session,
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.output?.finalAnswer).toBe("finished");
    expect(result.toolCalls).toBe(1);
    expect(modelClient.calls[1].messages.some((message) => message.role === "tool")).toBe(true);
    const events = await session.traceStore.list(session.traceId);
    expect(events.some((event) => event.type === "final")).toBe(true);
    const assistantMessages = events.filter((event) => event.type === "assistant_message");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]).toMatchObject({ phase: "commentary" });
    expect(assistantMessages[1]).toMatchObject({ phase: "final_candidate" });
  });

  it("stops after the schema repair budget is exhausted", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: "not json", toolCalls: [], stopReason: "end_turn" },
      { content: "still not json", toolCalls: [], stopReason: "end_turn" },
      { content: "still not json", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "final only" }],
      outputSchema: z.object({ ok: z.boolean() }),
      budget: withDefaultBudget({ maxSchemaRepairAttempts: 2, maxModelTurns: 5 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("schema_error");
    expect(modelClient.calls).toHaveLength(3);
  });

  it("stops when the model repeats the same tool loop too many times", async () => {
    const modelInfo = makeModelInfo();
    const repeatedResponse: AgentLoopModelResponse = {
      content: "",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "loop" } }],
      stopReason: "tool_use",
    };
    const modelClient = new ScriptedModelClient(modelInfo, [
      repeatedResponse,
      repeatedResponse,
      repeatedResponse,
      repeatedResponse,
      repeatedResponse,
    ]);
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "loop" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 8, maxRepeatedToolCalls: 3 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("stalled_tool_loop");
  });
});

describe("agentloop phase 2", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("runs TaskLifecycle execution through TaskAgentLoopRunner and owns task status updates", async () => {
    const modelInfo = makeModelInfo();
    const registry = new StaticAgentLoopModelRegistry([modelInfo]);
    let llmCallCount = 0;
    const llmClient: ILLMClient = {
      async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            content: "",
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "tool_use",
            tool_calls: [{
              id: "call-1",
              function: {
                name: "verify",
                arguments: JSON.stringify({ command: "test -f src/example.ts", cwd: tmpDir }),
              },
            }],
          };
        }
        return {
          content: finalJson(),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
      supportsToolCalling: () => true,
    };
    const modelClient = new ILLMClientAgentLoopModelClient(llmClient, registry);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new EchoTool());
    toolRegistry.register(new VerifyTool());
    const router = new ToolRegistryAgentLoopToolRouter(toolRegistry);
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const taskRunner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient,
      modelRegistry: registry,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["echo", "verify"] },
    });

    const stateManager = new StateManager(tmpDir);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const lifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      new StallDetector(stateManager),
      { agentLoopRunner: taskRunner, execFileSyncFn: () => "" },
    );
    const task = makeTask();
    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

    const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

    expect(result.success).toBe(true);
    expect(result.output).toBe("finished");
    const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Task;
    expect(persisted.status).toBe("completed");
    expect(persisted.execution_output).toBe("finished");

    expect(result.stopped_reason).toBe("completed");
    expect(result.agentLoop).toMatchObject({
      stopReason: "completed",
      completionEvidence: expect.arrayContaining(["unit evidence", "verified command: test -f src/example.ts"]),
      verificationHints: ["hint"],
      filesChangedPaths: ["src/example.ts"],
    });
  });

  it("rejects premature done until runtime verification evidence exists", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "finished",
          summary: "summary",
          filesChanged: ["src/example.ts"],
          testsRun: [],
          completionEvidence: [],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "verify", input: { command: "test -f src/example.ts", cwd: tmpDir } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "finished after verify",
          summary: "summary",
          filesChanged: ["src/example.ts"],
          testsRun: [],
          completionEvidence: [],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new VerifyTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const taskRunner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient,
      modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["echo", "verify"] },
    });

    const result = await taskRunner.runTask({ task: makeTask(), cwd: tmpDir });

    expect(result.success).toBe(true);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0]).toMatchObject({ toolName: "verify", command: "test -f src/example.ts", success: true });
    expect(modelClient.calls[1].messages.some((message) =>
      message.role === "user" && message.content.includes("premature"))
    ).toBe(true);
  });
});
