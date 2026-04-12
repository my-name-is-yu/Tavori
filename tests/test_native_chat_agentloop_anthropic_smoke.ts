import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentResult, IAdapter } from "../src/orchestrator/execution/adapter-layer.js";
import { LLMClient } from "../src/base/llm/llm-client.js";
import { ChatRunner } from "../src/interface/chat/chat-runner.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolPermissionManager } from "../src/tools/permission.js";
import { ConcurrencyController } from "../src/tools/concurrency.js";
import type {
  ApprovalRequest,
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolResult,
} from "../src/tools/types.js";
import { createNativeChatAgentLoopRunner } from "../src/orchestrator/execution/agent-loop/task-agent-loop-factory.js";
import type { ProviderConfig } from "../src/base/llm/provider-config.js";

const shouldRunSmoke = process.env["PULSEED_RUN_SMOKE_TESTS"] === "1";
const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
const anthropicModel = process.env["PULSEED_SMOKE_ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";

class SmokeEchoTool implements ITool<{ value: string }> {
  readonly metadata = {
    name: "smoke_echo",
    aliases: [],
    permissionLevel: "read_only" as const,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    maxOutputChars: 2048,
    tags: ["smoke", "test"],
  };

  readonly inputSchema = z.object({
    value: z.string().min(1),
  });

  description(_context?: ToolDescriptionContext): string {
    return "Echoes back the provided value for Anthropic native chat agentloop smoke testing.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { echoed: input.value },
      summary: `Echoed ${input.value}`,
      durationMs: 0,
    };
  }

  async checkPermissions(
    _input: { value: string },
    _context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { value: string }): boolean {
    return true;
  }
}

function makeStateManagerMock() {
  return {
    writeRaw: async () => undefined,
    readRaw: async () => null,
    listGoalIds: async () => [],
    loadGoal: async () => null,
  };
}

function makeAdapterStub(): IAdapter {
  return {
    adapterType: "agent_loop",
    execute: async (): Promise<AgentResult> => ({
      success: false,
      output: "",
      error: "adapter path should not be used in Anthropic native chat agentloop smoke test",
      exit_code: null,
      elapsed_ms: 0,
      stopped_reason: "error",
    }),
  };
}

async function neverApprove(_request: ApprovalRequest): Promise<boolean> {
  return false;
}

const smokeIt = shouldRunSmoke && anthropicApiKey ? it : it.skip;

describe("native chat agentloop smoke (Anthropic)", () => {
  smokeIt("calls a real tool through ChatRunner", async () => {
    const llmClient = new LLMClient(anthropicApiKey!, undefined, undefined, anthropicModel);
    const providerConfig: ProviderConfig = {
      provider: "anthropic",
      model: anthropicModel,
      adapter: "agent_loop",
      api_key: anthropicApiKey!,
    };
    const registry = new ToolRegistry();
    registry.register(new SmokeEchoTool());
    const toolExecutor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const chatAgentLoopRunner = createNativeChatAgentLoopRunner({
      llmClient,
      providerConfig,
      toolRegistry: registry,
      toolExecutor,
      defaultToolPolicy: {
        allowedTools: ["smoke_echo"],
      },
    });

    const runner = new ChatRunner({
      stateManager: makeStateManagerMock() as never,
      adapter: makeAdapterStub(),
      chatAgentLoopRunner,
      approvalFn: neverApprove,
    });

    const result = await runner.execute(
      'Call the `smoke_echo` tool with value "smoke-ok". Then finish and clearly state smoke-ok.',
      process.cwd(),
      120_000,
    );

    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).toContain("smoke-ok");
  }, 180_000);
});
