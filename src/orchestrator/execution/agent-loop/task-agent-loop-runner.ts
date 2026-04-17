import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopModelClient, AgentLoopModelRef, AgentLoopModelRegistry } from "./agent-loop-model.js";
import { BoundedAgentLoopRunner } from "./bounded-agent-loop-runner.js";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopResult } from "./agent-loop-result.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { AgentLoopContextAssembler, type SoilPrefetchQuery, type SoilPrefetchResult } from "./agent-loop-context-assembler.js";
import { buildTaskAgentLoopTurnContext } from "./task-agent-loop-context.js";
import {
  taskAgentLoopResultToAgentResult,
  type TaskAgentLoopOutput,
} from "./task-agent-loop-result.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import { isTaskRelevantVerificationCommand } from "./task-agent-loop-verification.js";
import {
  prepareTaskAgentLoopWorkspace,
  type AgentLoopWorktreePolicy,
} from "./task-agent-loop-worktree.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { SubagentRole } from "./execution-policy.js";

export interface TaskAgentLoopRunnerDeps {
  boundedRunner: BoundedAgentLoopRunner;
  modelClient: AgentLoopModelClient;
  modelRegistry: AgentLoopModelRegistry;
  defaultModel?: AgentLoopModelRef;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultToolPolicy?: AgentLoopToolPolicy;
  defaultToolCallContext?: Partial<ToolCallContext>;
  defaultWorktreePolicy?: AgentLoopWorktreePolicy;
  contextAssembler?: AgentLoopContextAssembler;
  soilPrefetch?: (query: SoilPrefetchQuery) => Promise<SoilPrefetchResult | null>;
  cwd?: string;
  createSession?: (input: { task: Task }) => AgentLoopSession;
}

export interface TaskAgentLoopRunInput {
  task: Task;
  workspaceContext?: string;
  knowledgeContext?: string;
  model?: AgentLoopModelRef;
  cwd?: string;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  worktreePolicy?: AgentLoopWorktreePolicy;
  resumeState?: AgentLoopSessionState;
  abortSignal?: AbortSignal;
  role?: SubagentRole;
}

export class TaskAgentLoopRunner {
  constructor(private readonly deps: TaskAgentLoopRunnerDeps) {}

  async runTask(input: TaskAgentLoopRunInput): Promise<AgentLoopResult<TaskAgentLoopOutput>> {
    const model = input.model ?? this.deps.defaultModel ?? await this.deps.modelRegistry.defaultModel();
    const modelInfo = await this.deps.modelClient.getModelInfo(model);
    const session = this.deps.createSession?.({ task: input.task }) ?? createAgentLoopSession();
    const requestedCwd = input.cwd ?? this.deps.cwd;
    const workspace = await prepareTaskAgentLoopWorkspace({
      task: input.task,
      cwd: requestedCwd,
      policy: { ...this.deps.defaultWorktreePolicy, ...input.worktreePolicy },
    });
    const contextAssembler = this.deps.contextAssembler ?? new AgentLoopContextAssembler();
    const assembled = await contextAssembler.assembleTask({
      task: input.task,
      workspaceContext: input.workspaceContext,
      knowledgeContext: input.knowledgeContext,
      cwd: workspace.executionCwd,
      soilPrefetch: this.deps.soilPrefetch,
      trustProjectInstructions: this.deps.defaultToolCallContext?.executionPolicy?.trustProjectInstructions,
    });
    const turn = buildTaskAgentLoopTurnContext({
      task: input.task,
      model,
      modelInfo,
      session,
      workspaceContext: input.workspaceContext,
      knowledgeContext: input.knowledgeContext,
      cwd: assembled.cwd,
      systemPrompt: assembled.systemPrompt,
      userPrompt: assembled.userPrompt,
      budget: { ...this.deps.defaultBudget, ...input.budget },
      toolPolicy: { ...this.deps.defaultToolPolicy, ...input.toolPolicy },
      toolCallContext: this.deps.defaultToolCallContext,
      ...(input.resumeState ? { resumeState: input.resumeState } : {}),
      abortSignal: input.abortSignal,
      role: input.role,
    });
    try {
      const result = await this.deps.boundedRunner.run(turn);
      const commandResults = result.commandResults.map((commandResult) => ({
        ...commandResult,
        relevantToTask: isTaskRelevantVerificationCommand(input.task, commandResult),
      }));
      const workspaceOutcome = await workspace.finalize({
        success: result.success,
        changedFiles: result.changedFiles,
      });
      return {
        ...result,
        commandResults,
        workspace: workspaceOutcome,
      };
    } catch (error) {
      await workspace.finalize({ success: false, changedFiles: [] });
      throw error;
    }
  }

  async runTaskAsAgentResult(input: TaskAgentLoopRunInput): Promise<AgentResult> {
    return taskAgentLoopResultToAgentResult(await this.runTask(input));
  }
}
