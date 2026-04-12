import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAILLMClient } from "../src/base/llm/openai-client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolPermissionManager } from "../src/tools/permission.js";
import { ConcurrencyController } from "../src/tools/concurrency.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolResult,
} from "../src/tools/types.js";
import { createNativeTaskAgentLoopRunner } from "../src/orchestrator/execution/agent-loop/task-agent-loop-factory.js";
import type { ProviderConfig } from "../src/base/llm/provider-config.js";
import type { Task } from "../src/base/types/task.js";

const shouldRunSmoke = process.env["PULSEED_RUN_SMOKE_TESTS"] === "1";
const openAiApiKey = process.env["OPENAI_API_KEY"];
const openAiModel = process.env["PULSEED_SMOKE_OPENAI_MODEL"] ?? "gpt-5.4-mini";

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
    return "Echoes back the provided value for native task agentloop smoke testing.";
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

function makeSmokeTask(): Task {
  return {
    id: "smoke-task-1",
    goal_id: "smoke-goal",
    strategy_id: null,
    target_dimensions: ["execution"],
    primary_dimension: "execution",
    work_description: "Call the smoke_echo tool and report the echoed value.",
    rationale: "Smoke test for native task agentloop",
    approach: "Use the required tool once, then finish with a concise answer.",
    success_criteria: [
      { description: "The final answer includes smoke-ok.", verification_method: "output", is_blocking: true },
    ],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "minutes" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

const smokeIt = shouldRunSmoke && openAiApiKey ? it : it.skip;

describe("native task agentloop smoke (OpenAI)", () => {
  smokeIt("completes a simple task through the real model and tool runtime", async () => {
    const llmClient = new OpenAILLMClient({
      apiKey: openAiApiKey!,
      model: openAiModel,
    });
    const providerConfig: ProviderConfig = {
      provider: "openai",
      model: openAiModel,
      adapter: "agent_loop",
      api_key: openAiApiKey!,
    };
    const registry = new ToolRegistry();
    registry.register(new SmokeEchoTool());
    const toolExecutor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runner = createNativeTaskAgentLoopRunner({
      llmClient,
      providerConfig,
      toolRegistry: registry,
      toolExecutor,
      defaultToolPolicy: {
        allowedTools: ["smoke_echo"],
      },
    });

    const result = await runner.runTask({
      task: makeSmokeTask(),
      cwd: process.cwd(),
    });

    expect(result.success).toBe(true);
    expect(result.output?.status).toBe("done");
    expect(result.output?.finalAnswer.toLowerCase()).toContain("smoke-ok");
  }, 180_000);
});
