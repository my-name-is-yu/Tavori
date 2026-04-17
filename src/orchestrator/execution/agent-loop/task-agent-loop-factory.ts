import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import {
  BoundedAgentLoopRunner,
} from "./bounded-agent-loop-runner.js";
import { createProviderNativeAgentLoopModelClient } from "./agent-loop-model-client-factory.js";
import { StaticAgentLoopModelRegistry } from "./agent-loop-model-registry.js";
import {
  defaultAgentLoopCapabilities,
  type AgentLoopModelCapabilities,
  type AgentLoopModelInfo,
} from "./agent-loop-model.js";
import { ToolExecutorAgentLoopToolRuntime } from "./agent-loop-tool-runtime.js";
import { ToolRegistryAgentLoopToolRouter } from "./agent-loop-tool-router.js";
import { ChatAgentLoopRunner } from "./chat-agent-loop-runner.js";
import { TaskAgentLoopRunner } from "./task-agent-loop-runner.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import type { SoilPrefetchQuery, SoilPrefetchResult } from "./agent-loop-context-assembler.js";
import { createPersistentAgentLoopSessionFactory } from "./agent-loop-session-factory.js";
import type { AgentLoopWorktreePolicy } from "./task-agent-loop-worktree.js";
import { resolveExecutionPolicy } from "./execution-policy.js";

export interface NativeTaskAgentLoopRuntimeDeps {
  llmClient: ILLMClient;
  providerConfig: ProviderConfig;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  cwd?: string;
  soilPrefetch?: (query: SoilPrefetchQuery) => Promise<SoilPrefetchResult | null>;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultToolPolicy?: AgentLoopToolPolicy;
  defaultWorktreePolicy?: AgentLoopWorktreePolicy;
  traceBaseDir?: string;
}

export function shouldUseNativeTaskAgentLoop(
  _providerConfig: ProviderConfig,
  _llmClient: ILLMClient,
): boolean {
  // Agent loop eligibility is independent of provider/auth and native tool-call support.
  return true;
}

export function createNativeTaskAgentLoopRunner(
  deps: NativeTaskAgentLoopRuntimeDeps,
): TaskAgentLoopRunner {
  const runtime = createNativeAgentLoopRuntime(deps);
  const executionPolicy = resolveExecutionPolicy({
    workspaceRoot: deps.cwd ?? process.cwd(),
    security: deps.providerConfig.agent_loop?.security,
  });

  return new TaskAgentLoopRunner({
    boundedRunner: runtime.boundedRunner,
    modelClient: runtime.modelClient,
    modelRegistry: runtime.modelRegistry,
    defaultModel: runtime.modelInfo.ref,
    defaultBudget: deps.defaultBudget,
    defaultToolPolicy: deps.defaultToolPolicy,
    defaultToolCallContext: { executionPolicy },
    defaultWorktreePolicy: deps.defaultWorktreePolicy,
    soilPrefetch: deps.soilPrefetch,
    cwd: deps.cwd,
    createSession: deps.traceBaseDir
      ? (() => {
          const createSession = createPersistentAgentLoopSessionFactory({ traceBaseDir: deps.traceBaseDir!, kind: "task" });
          return (_input: { task: import("../../../base/types/task.js").Task }) => createSession();
        })()
      : undefined,
  });
}

export function createNativeChatAgentLoopRunner(
  deps: NativeTaskAgentLoopRuntimeDeps,
): ChatAgentLoopRunner {
  const runtime = createNativeAgentLoopRuntime(deps);
  const executionPolicy = resolveExecutionPolicy({
    workspaceRoot: deps.cwd ?? process.cwd(),
    security: deps.providerConfig.agent_loop?.security,
  });

  return new ChatAgentLoopRunner({
    boundedRunner: runtime.boundedRunner,
    modelClient: runtime.modelClient,
    modelRegistry: runtime.modelRegistry,
    defaultModel: runtime.modelInfo.ref,
    defaultBudget: deps.defaultBudget,
    defaultToolPolicy: deps.defaultToolPolicy,
    defaultToolCallContext: { executionPolicy },
    cwd: deps.cwd,
    createSession: deps.traceBaseDir
      ? createPersistentAgentLoopSessionFactory({ traceBaseDir: deps.traceBaseDir, kind: "chat" })
      : undefined,
  });
}

export function createAgentLoopModelInfo(
  providerConfig: ProviderConfig,
  llmClient: ILLMClient,
): AgentLoopModelInfo {
  const capabilities: AgentLoopModelCapabilities = {
    ...defaultAgentLoopCapabilities,
    toolCalling: llmClient.supportsToolCalling?.() !== false,
    parallelToolCalls: true,
    structuredOutput: true,
    reasoning: providerConfig.provider === "openai",
    contextLimitTokens: inferContextLimit(providerConfig.model),
  };
  return {
    ref: { providerId: providerConfig.provider, modelId: providerConfig.model },
    displayName: `${providerConfig.provider}/${providerConfig.model}`,
    capabilities,
  };
}

function inferContextLimit(model: string): number | undefined {
  if (model.includes("gpt-5") || model.includes("gpt-4.1")) return 1_000_000;
  if (model.includes("gpt-4o")) return 128_000;
  if (model.includes("claude")) return 200_000;
  if (model.includes("qwen") || model.includes("llama")) return 32_000;
  return undefined;
}

function createNativeAgentLoopRuntime(
  deps: NativeTaskAgentLoopRuntimeDeps,
): {
  modelInfo: AgentLoopModelInfo;
  modelRegistry: StaticAgentLoopModelRegistry;
  modelClient: import("./agent-loop-model.js").AgentLoopModelClient;
  boundedRunner: BoundedAgentLoopRunner;
} {
  const modelInfo = createAgentLoopModelInfo(deps.providerConfig, deps.llmClient);
  const modelRegistry = new StaticAgentLoopModelRegistry([modelInfo], modelInfo.ref);
  const modelClient = createProviderNativeAgentLoopModelClient({
    providerConfig: deps.providerConfig,
    llmClient: deps.llmClient,
    modelRegistry,
  });
  const toolRouter = new ToolRegistryAgentLoopToolRouter(deps.toolRegistry);
  const toolRuntime = new ToolExecutorAgentLoopToolRuntime(deps.toolExecutor, toolRouter);
  const boundedRunner = new BoundedAgentLoopRunner({
    modelClient,
    toolRouter,
    toolRuntime,
  });

  return {
    modelInfo,
    modelRegistry,
    modelClient,
    boundedRunner,
  };
}
