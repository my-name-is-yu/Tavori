// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import type { IAdapter, AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TaskSchema, type Task } from "../../base/types/task.js";
import type { Goal } from "../../base/types/goal.js";
import { ChatHistory, type ChatSession } from "./chat-history.js";
import {
  ChatSessionCatalog,
  ChatSessionSelectorError,
  type LoadedChatSession,
} from "./chat-session-store.js";
import { buildChatContext, resolveGitRoot } from "../../platform/observation/context-provider.js";
import type { EscalationHandler } from "./escalation.js";
import { buildDynamicContextPrompt, buildStaticSystemPrompt } from "./grounding.js";
import { verifyChatAction } from "./chat-verifier.js";
import type { ApprovalLevel } from "./mutation-tool-defs.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { toToolDefinitionsFiltered } from "../../tools/tool-definition-adapter.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { LLMMessage, LLMRequestOptions, LLMResponse, ToolCallResult } from "../../base/llm/llm-client.js";
import { TendCommand } from "./tend-command.js";
import type { TendDeps } from "./tend-command.js";
import { EventSubscriber } from "./event-subscriber.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { ActivityKind, ChatEvent, ChatEventContext } from "./chat-events.js";
import type { ChatAgentLoopRunner } from "../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import type {
  AgentLoopEvent,
  AgentLoopEventSink,
} from "../../orchestrator/execution/agent-loop/agent-loop-events.js";
import type { AgentLoopSessionState } from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import {
  buildPromptedToolProtocolSystemPrompt,
  extractPromptedToolCalls,
} from "../../orchestrator/execution/agent-loop/prompted-tool-protocol.js";
import { recognizeRuntimeControlIntent } from "../../runtime/control/index.js";
import type { RuntimeControlService } from "../../runtime/control/index.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import {
  resolveExecutionPolicy,
  summarizeExecutionPolicy,
  withExecutionPolicyOverrides,
  type ExecutionPolicy,
} from "../../orchestrator/execution/agent-loop/execution-policy.js";

// ─── Types ───

export interface ChatRunnerDeps {
  stateManager: StateManager;
  adapter: IAdapter;
  /** Optional: reserved for future escalation support (Phase 1c). */
  llmClient?: ILLMClient;
  /** Optional: escalation handler for /track command (Phase 1c). */
  escalationHandler?: EscalationHandler;
  /** Optional: trust manager for self-knowledge tools and mutations. */
  trustManager?: { getBalance(domain: string): Promise<{ balance: number }>; setOverride?(domain: string, balance: number, reason: string): Promise<void> };
  /** Optional: plugin loader for self-knowledge tools and mutations. */
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; type?: string; enabled?: boolean }>> };
  /** Optional: approval handler for mutation tools. */
  approvalFn?: (description: string) => Promise<boolean>;
  /** Optional: goal ID to associate with tool calls made in this session. */
  goalId?: string;
  /** Optional: per-tool approval level overrides. */
  approvalConfig?: Record<string, ApprovalLevel>;
  /** Optional: tool executor for post-change verification (git diff + tests). */
  toolExecutor?: ToolExecutor;
  /** Optional: tool registry providing unified tool catalog. */
  registry?: ToolRegistry;
  /** Optional: called before each tool execution with tool name and args. */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  /** Optional: called after each tool execution with result summary and duration. */
  onToolEnd?: (toolName: string, result: { success: boolean; summary: string; durationMs: number }) => void;
  /** Optional: daemon client for /tend command (start/stop goals via daemon). */
  daemonClient?: DaemonClient;
  /** Optional: goal negotiator for /tend command (auto-generate goal from chat). */
  goalNegotiator?: GoalNegotiator;
  /** Optional: callback to push a system notification message into the chat UI. */
  onNotification?: (message: string) => void;
  /** Optional: daemon event server base URL (e.g. http://127.0.0.1:7823) for EventSubscriber. */
  daemonBaseUrl?: string;
  /** Optional: channel-agnostic chat stream events. */
  onEvent?: (event: ChatEvent) => void;
  /** Optional: native agentloop runner for chat turns. */
  chatAgentLoopRunner?: ChatAgentLoopRunner;
  /** Optional: first-class runtime control service for natural-language restart/update requests. */
  runtimeControlService?: Pick<RuntimeControlService, "request">;
  /** Optional: approval handler scoped to runtime-control operations only. */
  runtimeControlApprovalFn?: (description: string) => Promise<boolean>;
  /** Optional: durable reply target for post-restart reporting. */
  runtimeReplyTarget?: RuntimeControlReplyTarget;
  /** Optional: source metadata for runtime control operation records. */
  runtimeControlActor?: RuntimeControlActor;
}

export interface ChatRunResult {
  success: boolean;
  output: string;
  elapsed_ms: number;
  diagnostics?: ChatRunDiagnostics;
}

export interface ChatRunDiagnostics {
  route: "direct";
  reason: "simple_question";
  modelTier: "light";
  maxTokens: number;
}

export interface RuntimeControlChatContext {
  replyTarget?: RuntimeControlReplyTarget;
  actor?: RuntimeControlActor;
  approvalFn?: (description: string) => Promise<boolean>;
}

interface AssistantBuffer {
  text: string;
}

interface ResumeCommand {
  selector?: string;
}

interface ProviderConfigSummary {
  provider: string;
  model: string;
  adapter: string;
  light_model?: string;
  base_url?: string;
  codex_cli_path?: string;
  has_api_key: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_RETRIES = 2;
const MAX_TOOL_LOOPS = 5;
const ACTIVITY_PREVIEW_CHARS = 40;
const DIRECT_ANSWER_MAX_TOKENS = 256;

// ─── Command help text ───

const COMMAND_HELP = `Available commands:
Session
  /help                 Show this help message
  /clear                Clear conversation history
  /sessions             List prior chat sessions
  /history [id|title]   Show saved chat history
  /title <title>        Rename the current session
  /resume [id|title]    Resume native agentloop state for the current or selected session
  /cleanup [--dry-run]  Clean up stale chat sessions
  /compact              Summarize older chat turns and keep the latest turns
  /exit                 Exit chat mode

Goals and tasks
  /status [goal-id]     Show active goal status, or one goal when an id is provided
  /goals                List goals
  /tasks [goal-id]      List tasks for a goal; uses the only active goal when unambiguous
  /task <task-id> [goal-id]
                        Show one task; searches goals when no goal id is provided
  /track                Promote session to Tier 2 goal pursuit (not yet implemented)
  /tend                 Generate a goal from chat history and start autonomous daemon execution

Configuration
  /config               Show provider configuration with secrets masked
  /model                Show the active provider/model/adapter
  /permissions [args]   Show or update session execution policy
  /plugins              List installed plugins when plugin metadata is available

Review and branching
  /review               Show current diff summary and verification context
  /fork [title]         Fork the current chat session into a new session
  /undo                 Remove the latest chat turn from session history

Deferred
  /retry and /usage are intentionally not supported yet.`;

// ─── Helpers ───

function checkGitChanges(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "HEAD", "--stat"], { cwd, timeout: 5_000 }, (err, stdout, stderr) => {
      resolve(err ? null : (stdout + stderr).trim());
    });
  });
}

function previewActivityText(value: string, maxChars = ACTIVITY_PREVIEW_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function formatToolActivity(action: "Running" | "Finished" | "Failed", toolName: string, detail?: string): string {
  const preview = detail ? previewActivityText(detail) : "";
  return preview ? `${action} tool: ${toolName} - ${preview}` : `${action} tool: ${toolName}`;
}

function shouldUseDirectAnswerRoute(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;

  const lowered = normalized.toLowerCase();
  const questionSignals = [
    /[?？]/,
    /\b(what|why|how|when|where|who|which|is|are|can|could|would|should|tell me|explain|describe|help me understand)\b/,
    /(教えて|説明して|教えてください|説明してください|どう思う|なんで|なぜ|どうして|いつ|どこ|だれ|誰|何|どれ|どっち)/,
  ];
  if (!questionSignals.some((pattern) => pattern.test(lowered))) {
    return false;
  }

  const workSignals = [
    /\b(fix|implement|change|changed|add|remove|delete|update|refactor|patch|debug|diagnose|investigate|review|write|create|build|run|execute|test|verify|confirm|check|inspect|search|open|read|edit|modify|commit|push|merge|release|deploy|start|stop|restart|resume|compare|convert|migrate|optimize|improve|configure|setup|set up)\b/,
    /(修正|実装|変更|追加|削除|更新|リファクタ|デバッグ|調査|確認|レビュー|書いて|作って|作成|実行|走らせ|テスト|検証|調べて|開いて|読んで|編集|コミット|プッシュ|マージ|デプロイ|再起動|再開|設定)/,
    /\b(git|repo|repository|branch|commit|diff|pull request|pr|issue|ticket|adapter|agentloop|tool|tools|code)\b|コード|src\//,
    /\b(latest|most recent|current|today|now|recent|news|web|internet|api|docs|github|release|version)\b|最新|最新版|今日|現在|最近|今|外部|ネット/,
    /\bwhat\s+(files?\s+)?changed\b|\bwhich\s+files?\s+(changed|were\s+(modified|edited))\b/,
    /(\.(ts|tsx|js|jsx|json|md|yml|yaml|toml|py|go|rs|sh|sql)\b|\/[^/\s]+\.[A-Za-z0-9]+$)/,
  ];
  return !workSignals.some((pattern) => pattern.test(lowered));
}

// ─── ChatRunner ───

export class ChatRunner {
  private readonly deps: ChatRunnerDeps;
  private history: ChatHistory | null = null;
  private sessionCwd: string | null = null;
  /** True when startSession() has been called — enables session persistence across execute() calls. */
  private sessionActive = false;
  /** Deferred tools activated by ToolSearch results — included in tool definitions for subsequent turns. */
  private activatedTools: Set<string> = new Set();
  /** Cached static system prompt — reused across turns; dynamic context is rebuilt each turn. */
  private cachedStaticSystemPrompt: string | null = null;
  /** Pending /tend state awaiting user confirmation (Y/n). */
  private pendingTend: { goalId: string; maxIterations?: number } | null = null;
  /** Active EventSubscriber instances keyed by goalId. */
  private activeSubscribers: Map<string, EventSubscriber> = new Map();
  /**
   * Callback invoked when a /tend daemon notification arrives.
   * Can be set after construction (e.g. from a React component via useEffect).
   */
  onNotification: ((message: string) => void) | undefined = undefined;
  onEvent: ((event: ChatEvent) => void) | undefined = undefined;
  private nativeAgentLoopStatePath: string | null = null;
  private runtimeControlContext: RuntimeControlChatContext | null = null;
  private sessionExecutionPolicy: ExecutionPolicy | null = null;

  constructor(deps: ChatRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Initialize a persistent session for interactive (multi-turn) mode.
   * Must be called before the first execute() to share history across turns.
   * If not called, execute() auto-creates a new session per call (Phase 1a behavior).
   */
  startSession(cwd: string): void {
    const gitRoot = resolveGitRoot(cwd);
    const sessionId = crypto.randomUUID();
    this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
    this.sessionCwd = gitRoot;
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = `chat/agentloop/${sessionId}.state.json`;
    this.history.setAgentLoopStatePath(this.nativeAgentLoopStatePath);
    this.sessionExecutionPolicy = null;
  }

  startSessionFromLoadedSession(session: LoadedChatSession): void {
    const chatSession = this.loadedSessionToChatSession(session);
    this.history = ChatHistory.fromSession(this.deps.stateManager, chatSession);
    this.sessionCwd = session.cwd;
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = session.agentLoopStatePath ?? `chat/agentloop/${session.id}.state.json`;
    this.history.setAgentLoopStatePath(this.nativeAgentLoopStatePath);
    this.sessionExecutionPolicy = null;
  }

  getSessionId(): string | null {
    return this.history?.getSessionId() ?? null;
  }

  getCurrentSessionMessages(): ChatSession["messages"] {
    return this.history?.getMessages() ?? [];
  }

  setRuntimeControlContext(context: RuntimeControlChatContext | null): void {
    this.runtimeControlContext = context;
  }

  private loadedSessionToChatSession(session: LoadedChatSession): ChatSession {
    return {
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: [...session.messages],
      ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(session.agentLoopStatePath ? { agentLoopStatePath: session.agentLoopStatePath } : {}),
      ...(session.agentLoopStatus === "running" || session.agentLoopStatus === "completed" || session.agentLoopStatus === "failed"
        ? { agentLoopStatus: session.agentLoopStatus }
        : {}),
      ...(session.agentLoopResumable ? { agentLoopResumable: true } : {}),
      ...(session.agentLoopUpdatedAt ? { agentLoopUpdatedAt: session.agentLoopUpdatedAt } : {}),
      ...(session.agentLoop ? { agentLoop: session.agentLoop } : {}),
    };
  }

  private formatSessionsList(entries: Array<{ id: string; title: string | null; cwd: string; updatedAt: string; messageCount: number; agentLoopResumable: boolean }>): string {
    if (entries.length === 0) return "No chat sessions found.";
    const lines = entries.map((entry) => {
      const title = entry.title ? ` "${entry.title}"` : "";
      const resumable = entry.agentLoopResumable ? " resumable" : "";
      return `${entry.id}${title} - ${entry.messageCount} message(s), updated ${entry.updatedAt}, cwd ${entry.cwd}${resumable}`;
    });
    return `Chat sessions:\n${lines.join("\n")}`;
  }

  private formatHistory(session: LoadedChatSession): string {
    const title = session.title ? ` "${session.title}"` : "";
    if (session.messages.length === 0) {
      return `Session ${session.id}${title} has no messages.`;
    }
    const lines = session.messages.map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${message.content}`;
    });
    return `Session ${session.id}${title} (${session.cwd})\n${lines.join("\n")}`;
  }

  private async loadGoals(): Promise<Goal[]> {
    const goalIds = await this.deps.stateManager.listGoalIds();
    const goals = await Promise.all(goalIds.map((id) => this.deps.stateManager.loadGoal(id)));
    return goals.filter((goal): goal is Goal => goal !== null);
  }

  private async listAllGoalIds(): Promise<string[]> {
    const activeIds = await this.deps.stateManager.listGoalIds();
    const archivedIds = await this.deps.stateManager.listArchivedGoals();
    const recoverableArchivedIds = await this.listRecoverableArchivedGoalIds();
    return [...new Set([...activeIds, ...archivedIds, ...recoverableArchivedIds])];
  }

  private resolveStatePath(baseDir: string, ...segments: string[]): string | null {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, ...segments);
    if (!resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }

  private async listRecoverableArchivedGoalIds(): Promise<string[]> {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    if (typeof stateManager.getBaseDir !== "function") return [];
    const archiveDir = this.resolveStatePath(stateManager.getBaseDir(), "archive");
    if (archiveDir === null) return [];
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await fsp.readdir(archiveDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const goalIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".staging") continue;
      try {
        await fsp.access(path.join(archiveDir, entry.name, "goal", "goal.json"));
        goalIds.push(entry.name);
      } catch {
        continue;
      }
    }
    return goalIds;
  }

  private activeGoals(goals: Goal[]): Goal[] {
    return goals.filter((goal) => goal.status === "active" || goal.status === "waiting" || goal.loop_status === "running");
  }

  private formatGoalLine(goal: Goal): string {
    const dimensions = goal.dimensions.length === 0
      ? "no dimensions"
      : goal.dimensions
        .slice(0, 3)
        .map((dimension) => `${dimension.name}: ${String(dimension.current_value)} target ${JSON.stringify(dimension.threshold)}`)
        .join("; ");
    return `${goal.id} - ${goal.title} [${goal.status}, loop ${goal.loop_status}] ${dimensions}`;
  }

  private async handleStatus(args: string, start: number): Promise<ChatRunResult> {
    if (args) {
      const goal = await this.deps.stateManager.loadGoal(args);
      if (!goal) {
        return { success: false, output: `Goal not found: ${args}`, elapsed_ms: Date.now() - start };
      }
      const lines = [
        `Goal status: ${goal.title}`,
        `ID: ${goal.id}`,
        `Status: ${goal.status}`,
        `Loop: ${goal.loop_status}`,
        `Updated: ${goal.updated_at}`,
        `Children: ${goal.children_ids.length}`,
        `Dimensions:`,
        ...goal.dimensions.map((dimension) =>
          `- ${dimension.name}: current=${String(dimension.current_value)}, threshold=${JSON.stringify(dimension.threshold)}, confidence=${dimension.confidence}`
        ),
      ];
      return { success: true, output: lines.join("\n"), elapsed_ms: Date.now() - start };
    }

    const goals = await this.loadGoals();
    const active = this.activeGoals(goals);
    if (active.length === 0) {
      return { success: true, output: "No active goals found.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Active goals:\n${active.map((goal) => this.formatGoalLine(goal)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleGoals(start: number): Promise<ChatRunResult> {
    const goals = await this.loadGoals();
    if (goals.length === 0) {
      return { success: true, output: "No goals found.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Goals:\n${goals.map((goal) => this.formatGoalLine(goal)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async readTasksFromDir(tasksDir: string): Promise<Task[]> {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(tasksDir);
    } catch {
      return [];
    }

    const tasks: Task[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(await fsp.readFile(path.join(tasksDir, entry), "utf-8"));
      } catch {
        continue;
      }
      const parsed = TaskSchema.safeParse(raw);
      if (parsed.success) tasks.push(parsed.data);
    }
    return tasks.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  private async readTasksForGoal(goalId: string): Promise<Task[]> {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    if (typeof stateManager.getBaseDir !== "function") return [];
    const baseDir = stateManager.getBaseDir();
    const activeTasksDir = this.resolveStatePath(baseDir, "tasks", goalId);
    const archiveTasksDir = this.resolveStatePath(baseDir, "archive", goalId, "tasks");
    if (activeTasksDir === null || archiveTasksDir === null) return [];
    const activeTasks = await this.readTasksFromDir(activeTasksDir);
    if (activeTasks.length > 0) return activeTasks;
    return this.readTasksFromDir(archiveTasksDir);
  }

  private async resolveGoalForTasks(selector: string): Promise<{ goalId?: string; error?: string }> {
    if (selector) return { goalId: selector };
    const active = this.activeGoals(await this.loadGoals());
    if (active.length === 1) return { goalId: active[0].id };
    if (active.length === 0) return { error: "No active goals found. Use /tasks <goal-id>." };
    return { error: "Multiple active goals found. Use /tasks <goal-id>." };
  }

  private formatTaskLine(task: Task): string {
    const verdict = task.verification_verdict ? `, verdict ${task.verification_verdict}` : "";
    return `${task.id} - ${task.status}${verdict}: ${task.work_description}`;
  }

  private async handleTasks(args: string, start: number): Promise<ChatRunResult> {
    const resolved = await this.resolveGoalForTasks(args);
    if (resolved.error || !resolved.goalId) {
      return { success: false, output: resolved.error ?? "Usage: /tasks <goal-id>", elapsed_ms: Date.now() - start };
    }
    const tasks = await this.readTasksForGoal(resolved.goalId);
    if (tasks.length === 0) {
      return { success: true, output: `No tasks found for goal "${resolved.goalId}".`, elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Tasks for goal ${resolved.goalId}:\n${tasks.map((task) => this.formatTaskLine(task)).join("\n")}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private parseTaskArgs(args: string): { taskId?: string; goalId?: string } {
    const parts = args.split(/\s+/).filter(Boolean);
    const goalFlagIndex = parts.indexOf("--goal");
    if (goalFlagIndex >= 0) {
      const goalId = parts[goalFlagIndex + 1];
      parts.splice(goalFlagIndex, goalId ? 2 : 1);
      return { taskId: parts[0], goalId };
    }
    return { taskId: parts[0], goalId: parts[1] };
  }

  private async findTask(taskId: string, goalId?: string): Promise<{ task?: Task; matches: Array<{ goalId: string; task: Task }> }> {
    const goalIds = goalId ? [goalId] : await this.listAllGoalIds();
    const matches: Array<{ goalId: string; task: Task }> = [];
    for (const candidateGoalId of goalIds) {
      let raw: unknown | null = null;
      try {
        raw = await this.deps.stateManager.readRaw(`tasks/${candidateGoalId}/${taskId}.json`);
      } catch {
        raw = null;
      }
      if (!raw) {
        const tasks = await this.readTasksForGoal(candidateGoalId);
        const matched = tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
        if (matched) matches.push({ goalId: candidateGoalId, task: matched });
        continue;
      }
      const parsed = TaskSchema.safeParse(raw);
      if (parsed.success) matches.push({ goalId: candidateGoalId, task: parsed.data });
    }
    return { task: matches.length === 1 ? matches[0].task : undefined, matches };
  }

  private formatTask(task: Task): string {
    const lines = [
      `Task: ${task.id}`,
      `Goal: ${task.goal_id}`,
      `Status: ${task.status}`,
      `Category: ${task.task_category}`,
      `Created: ${task.created_at}`,
      `Work: ${task.work_description}`,
      `Approach: ${task.approach}`,
    ];
    if (task.started_at) lines.push(`Started: ${task.started_at}`);
    if (task.completed_at) lines.push(`Completed: ${task.completed_at}`);
    if (task.verification_verdict) lines.push(`Verification: ${task.verification_verdict}`);
    if (task.verification_evidence?.length) lines.push(`Evidence: ${task.verification_evidence.join("; ")}`);
    if (task.success_criteria.length > 0) {
      lines.push("Success criteria:");
      lines.push(...task.success_criteria.map((criterion) => `- ${criterion.description}`));
    }
    return lines.join("\n");
  }

  private async handleTask(args: string, start: number): Promise<ChatRunResult> {
    const { taskId, goalId } = this.parseTaskArgs(args);
    if (!taskId) {
      return { success: false, output: "Usage: /task <task-id> [goal-id]", elapsed_ms: Date.now() - start };
    }
    const found = await this.findTask(taskId, goalId);
    if (found.matches.length > 1) {
      return {
        success: false,
        output: `Task selector "${taskId}" matched multiple goals. Use /task ${taskId} <goal-id>.\n${found.matches.map((match) => `- ${match.goalId}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    }
    if (!found.task) {
      const suffix = goalId ? ` for goal "${goalId}"` : "";
      return { success: false, output: `Task not found: ${taskId}${suffix}`, elapsed_ms: Date.now() - start };
    }
    return { success: true, output: this.formatTask(found.task), elapsed_ms: Date.now() - start };
  }

  private providerConfigBaseDir(): string {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    return typeof stateManager.getBaseDir === "function" ? stateManager.getBaseDir() : getPulseedDirPath();
  }

  private async readProviderConfigSummary(): Promise<ProviderConfigSummary> {
    const config = await loadProviderConfig({
      baseDir: this.providerConfigBaseDir(),
      saveMigration: false,
    });
    return {
      provider: config.provider,
      model: config.model,
      adapter: config.adapter,
      light_model: config.light_model,
      base_url: config.base_url,
      codex_cli_path: config.codex_cli_path,
      has_api_key: Boolean(config.api_key),
    };
  }

  private formatConfig(config: ProviderConfigSummary): string {
    return Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${typeof value === "string" && /key|token|secret/i.test(key) ? "[masked]" : String(value)}`)
      .join("\n");
  }

  private async handleConfig(start: number): Promise<ChatRunResult> {
    const config = await this.readProviderConfigSummary();
    return { success: true, output: `Provider configuration:\n${this.formatConfig(config)}`, elapsed_ms: Date.now() - start };
  }

  private async handleModel(start: number): Promise<ChatRunResult> {
    const config = await this.readProviderConfigSummary();
    return {
      success: true,
      output: `Model: ${config.model}\nProvider: ${config.provider}\nAdapter: ${config.adapter}`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handlePlugins(start: number): Promise<ChatRunResult> {
    if (!this.deps.pluginLoader) {
      return { success: true, output: "Plugin information is not available in this chat session.", elapsed_ms: Date.now() - start };
    }
    try {
      const plugins = await this.deps.pluginLoader.loadAll();
      if (plugins.length === 0) {
        return { success: true, output: "No plugins found.", elapsed_ms: Date.now() - start };
      }
      return {
        success: true,
        output: `Plugins:\n${plugins.map((plugin) => `${plugin.name} - ${plugin.type ?? "unknown"} - ${plugin.enabled === false ? "disabled" : "enabled"}`).join("\n")}`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: true, output: `Plugin information is unavailable: ${message}`, elapsed_ms: Date.now() - start };
    }
  }

  private deterministicChatSummary(messages: ChatSession["messages"]): string {
    const lines = messages.map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}`);
    return lines.join("\n").slice(0, 4_000);
  }

  private async summarizeChatForCompaction(messages: ChatSession["messages"], existingSummary?: string): Promise<{ summary: string; usedLlm: boolean }> {
    const content = [
      existingSummary ? `Previous summary:\n${existingSummary}` : "",
      `Messages to summarize:\n${messages.map((message) => `${message.role}: ${message.content}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");

    if (this.deps.llmClient) {
      try {
        const response = await this.deps.llmClient.sendMessage([
          { role: "user", content: `Summarize this chat history for later continuation. Preserve decisions, open tasks, constraints, and user preferences. Keep it concise.\n\n${content}` },
        ], { max_tokens: 700, model_tier: "light" });
        if (response.content.trim()) return { summary: response.content.trim(), usedLlm: true };
      } catch {
        // Fall back to deterministic summary below.
      }
    }

    const fallback = [
      existingSummary ? `Previous summary:\n${existingSummary}` : "",
      "Extractive summary:",
      this.deterministicChatSummary(messages),
    ].filter(Boolean).join("\n\n");
    return { summary: fallback, usedLlm: false };
  }

  private async handleCompact(start: number): Promise<ChatRunResult> {
    if (!this.history) {
      return { success: false, output: "No active chat session to compact.", elapsed_ms: Date.now() - start };
    }
    const session = this.history.getSessionData();
    if (session.messages.length <= 4) {
      return { success: true, output: "Chat history is already compact. No messages were removed.", elapsed_ms: Date.now() - start };
    }
    const olderMessages = session.messages.slice(0, -4);
    const { summary, usedLlm } = await this.summarizeChatForCompaction(olderMessages, session.compactionSummary);
    const { before, after } = await this.history.compact(summary, 4);
    const method = usedLlm ? "LLM summary" : "deterministic summary";
    return {
      success: true,
      output: `Compacted chat history with ${method}. Persisted ${before} message(s) down to ${after}; the latest user/assistant turns were kept.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleCommand(input: string): Promise<ChatRunResult | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const cmd = trimmed.toLowerCase().split(/\s+/)[0];
    const start = Date.now();

    if (cmd === "/help") {
      return { success: true, output: COMMAND_HELP, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/clear") {
      await this.history?.clear();
      return { success: true, output: "Conversation history cleared.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/sessions") {
      const catalog = new ChatSessionCatalog(this.deps.stateManager);
      const sessions = await catalog.listSessions();
      return { success: true, output: this.formatSessionsList(sessions), elapsed_ms: Date.now() - start };
    }
    if (cmd === "/history") {
      const catalog = new ChatSessionCatalog(this.deps.stateManager);
      const selector = trimmed.slice("/history".length).trim();
      const session = selector
        ? await catalog.loadSessionBySelector(selector)
        : this.history
          ? await catalog.loadSession(this.history.getSessionId())
          : null;
      if (!session) {
        return { success: false, output: "No chat session history found.", elapsed_ms: Date.now() - start };
      }
      return { success: true, output: this.formatHistory(session), elapsed_ms: Date.now() - start };
    }
    if (cmd === "/title") {
      const title = trimmed.slice("/title".length).trim();
      if (!title) {
        return { success: false, output: "Usage: /title <title>", elapsed_ms: Date.now() - start };
      }
      if (!this.history) {
        return { success: false, output: "No active chat session to rename.", elapsed_ms: Date.now() - start };
      }
      const catalog = new ChatSessionCatalog(this.deps.stateManager);
      this.history.setTitle(title);
      await this.history.persist();
      await catalog.renameSession(this.history.getSessionId(), title);
      return { success: true, output: `Renamed chat session to "${title}".`, elapsed_ms: Date.now() - start };
    }
    if (cmd === "/cleanup") {
      const catalog = new ChatSessionCatalog(this.deps.stateManager);
      const dryRun = trimmed.includes("--dry-run");
      const report = await catalog.cleanupSessions({
        dryRun,
        activeSessionId: this.history?.getSessionId(),
      });
      const verb = dryRun ? "would remove" : "removed";
      return {
        success: true,
        output: `Chat session cleanup ${verb} ${report.removedSessionIds.length} session(s).`,
        elapsed_ms: Date.now() - start,
      };
    }
    if (cmd === "/compact") {
      return this.handleCompact(start);
    }
    if (cmd === "/status") {
      return this.handleStatus(trimmed.slice("/status".length).trim(), start);
    }
    if (cmd === "/goals") {
      return this.handleGoals(start);
    }
    if (cmd === "/tasks") {
      return this.handleTasks(trimmed.slice("/tasks".length).trim(), start);
    }
    if (cmd === "/task") {
      return this.handleTask(trimmed.slice("/task".length).trim(), start);
    }
    if (cmd === "/config") {
      return this.handleConfig(start);
    }
    if (cmd === "/model") {
      return this.handleModel(start);
    }
    if (cmd === "/permissions") {
      return this.handlePermissions(trimmed.slice("/permissions".length).trim(), start);
    }
    if (cmd === "/plugins") {
      return this.handlePlugins(start);
    }
    if (cmd === "/review") {
      return this.handleReview(start);
    }
    if (cmd === "/fork") {
      return this.handleFork(trimmed.slice("/fork".length).trim(), start);
    }
    if (cmd === "/undo") {
      return this.handleUndo(start);
    }
    if (cmd === "/exit") {
      return { success: true, output: "Exiting chat mode.", elapsed_ms: Date.now() - start };
    }
    if (cmd === "/track") {
      return this.handleTrack(start);
    }
    if (cmd === "/tend") {
      const args = trimmed.slice("/tend".length).trim();
      return this.handleTend(args, start);
    }

    // Check if this is a confirmation response for a pending /tend
    if (this.pendingTend !== null) {
      return this.handleTendConfirmation(trimmed, start);
    }

    return {
      success: false,
      output: `Unknown command: ${input.trim()}. Type /help for available commands.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTrack(start: number): Promise<ChatRunResult> {
    if (!this.deps.escalationHandler) {
      return {
        success: false,
        output: "Escalation not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.history || this.history.getMessages().length === 0) {
      return {
        success: false,
        output: "No conversation to escalate. Chat first, then /track.",
        elapsed_ms: Date.now() - start,
      };
    }
    try {
      const result = await this.deps.escalationHandler.escalateToGoal(this.history);
      return {
        success: true,
        output: `Goal created: ${result.title} (ID: ${result.goalId})\nRun: pulseed run --goal ${result.goalId} --yes`,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Escalation failed: ${message}`,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private async handlePermissions(args: string, start: number): Promise<ChatRunResult> {
    const policy = await this.getSessionExecutionPolicy();
    if (!args) {
      return {
        success: true,
        output: summarizeExecutionPolicy(policy),
        elapsed_ms: Date.now() - start,
      };
    }

    const tokens = args.toLowerCase().split(/\s+/).filter(Boolean);
    let nextPolicy = policy;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === "read-only" || token === "readonly" || token === "read_only") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "read_only" });
        continue;
      }
      if (token === "workspace-write" || token === "workspace_write") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "workspace_write" });
        continue;
      }
      if (token === "full-access" || token === "danger-full-access" || token === "danger_full_access") {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { sandboxMode: "danger_full_access" });
        continue;
      }
      if (token === "network" && tokens[index + 1]) {
        nextPolicy = withExecutionPolicyOverrides(nextPolicy, { networkAccess: tokens[index + 1] === "on" });
        index += 1;
        continue;
      }
      if (token === "approval" && tokens[index + 1]) {
        const approvalPolicy = tokens[index + 1];
        if (approvalPolicy === "never" || approvalPolicy === "on_request" || approvalPolicy === "untrusted") {
          nextPolicy = withExecutionPolicyOverrides(nextPolicy, { approvalPolicy });
          index += 1;
          continue;
        }
      }
      return {
        success: false,
        output: "Usage: /permissions [read-only|workspace-write|full-access] [network on|off] [approval on_request|never|untrusted]",
        elapsed_ms: Date.now() - start,
      };
    }

    this.sessionExecutionPolicy = nextPolicy;
    return {
      success: true,
      output: summarizeExecutionPolicy(nextPolicy),
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleReview(start: number): Promise<ChatRunResult> {
    const cwd = this.sessionCwd ?? process.cwd();
    const diffStat = await checkGitChanges(cwd);
    const policy = await this.getSessionExecutionPolicy();
    const output = [
      "Review summary",
      diffStat ? diffStat : "No uncommitted changes detected.",
      "",
      "Execution policy",
      summarizeExecutionPolicy(policy),
    ].join("\n");
    return { success: true, output, elapsed_ms: Date.now() - start };
  }

  private async handleFork(title: string, start: number): Promise<ChatRunResult> {
    const cwd = this.sessionCwd ?? process.cwd();
    const sessionId = crypto.randomUUID();
    const baseSession = this.history?.getSessionData() ?? {
      id: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    const now = new Date().toISOString();
    const forkedSession: ChatSession = {
      ...baseSession,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      title: title || (baseSession.title ? `${baseSession.title} (fork)` : "Forked session"),
    };
    this.history = ChatHistory.fromSession(this.deps.stateManager, forkedSession);
    this.sessionCwd = cwd;
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = `chat/agentloop/${sessionId}.state.json`;
    this.history.setAgentLoopStatePath(this.nativeAgentLoopStatePath);
    await this.history.persist();
    return {
      success: true,
      output: `Forked chat session as ${sessionId}.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleUndo(start: number): Promise<ChatRunResult> {
    if (!this.history) {
      return { success: false, output: "No active chat session to undo.", elapsed_ms: Date.now() - start };
    }
    const removed = await this.history.removeLastTurn();
    if (removed === 0) {
      return { success: false, output: "No chat turn to undo.", elapsed_ms: Date.now() - start };
    }
    return {
      success: true,
      output: `Removed ${removed} message(s) from chat history. File changes were not reverted.`,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTend(args: string, start: number): Promise<ChatRunResult> {
    if (!this.deps.llmClient) {
      return {
        success: false,
        output: "Tend not available — missing LLM configuration",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.deps.goalNegotiator) {
      return {
        success: false,
        output: "Tend not available — missing goal negotiator",
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.deps.daemonClient) {
      return {
        success: false,
        output: "Tend not available — daemon client not configured. Start the daemon with 'pulseed daemon start' first.",
        elapsed_ms: Date.now() - start,
      };
    }

    const history = this.history?.getMessages() ?? [];
    const tendDeps: TendDeps = {
      llmClient: this.deps.llmClient,
      goalNegotiator: this.deps.goalNegotiator,
      daemonClient: this.deps.daemonClient,
      stateManager: this.deps.stateManager,
      chatHistory: history,
    };

    const tendCommand = new TendCommand();
    const result = await tendCommand.execute(args, tendDeps);

    if (result.needsConfirmation && result.goalId) {
      this.pendingTend = { goalId: result.goalId, maxIterations: result.maxIterations };
      return {
        success: true,
        output: result.confirmation ?? result.message,
        elapsed_ms: Date.now() - start,
      };
    }

    return {
      success: result.success,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  private async handleTendConfirmation(input: string, start: number): Promise<ChatRunResult> {
    const pending = this.pendingTend!;
    this.pendingTend = null;

    const normalized = input.trim().toLowerCase();
    const confirmed = normalized === "" || normalized === "y" || normalized === "yes";

    if (!confirmed) {
      // Bug 2: treat any non-y/yes/empty/n/no input as cancellation too
      return {
        success: true,
        output: "Tend cancelled. Continue chatting to refine your goal, then try /tend again.",
        elapsed_ms: Date.now() - start,
      };
    }

    if (!this.deps.daemonClient) {
      return {
        success: false,
        output: "Daemon client not available.",
        elapsed_ms: Date.now() - start,
      };
    }

    try {
      await this.deps.daemonClient.startGoal(pending.goalId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Daemon unavailable: ${msg}. Start the daemon with 'pulseed daemon start' first.`,
        elapsed_ms: Date.now() - start,
      };
    }

    // Subscribe to EventServer progress notifications (non-blocking)
    const { goalId, maxIterations } = pending;
    if (this.deps.daemonBaseUrl && !this.activeSubscribers.has(goalId)) {
      const subscriber = new EventSubscriber(this.deps.daemonBaseUrl, goalId, "normal");
      this.activeSubscribers.set(goalId, subscriber);

      subscriber.on("notification", (notification: unknown) => {
        const n = notification as { message: string };
        // Invoke both the deps callback (wired at construction) and the public
        // onNotification property (wired post-construction, e.g. from React useEffect)
        this.deps.onNotification?.(n.message);
        this.onNotification?.(n.message);
      });

      subscriber.subscribe().catch(() => {
        // Connection failures are handled inside EventSubscriber
      });
    }

    const iterNote = maxIterations !== undefined ? ` (max ${maxIterations} iterations)` : "";
    const shortId = goalId.length > 12 ? goalId.slice(0, 12) : goalId;
    return {
      success: true,
      output: `[tend] ${shortId}: Started — daemon is now tending your goal${iterNote}.\nRun 'pulseed status' to check progress.`,
      elapsed_ms: Date.now() - start,
    };
  }

  /**
   * Execute a single chat turn.
   *
   * Flow:
   *  1. Intercept slash commands before adapter dispatch
   *  2. Resolve git root → create ChatHistory
   *  3. Build chat context and assemble prompt
   *  4. Persist user message BEFORE calling adapter (crash-safe)
   *  5. Execute via adapter
   *  6. Verify changes (git diff + tests); retry up to MAX_VERIFY_RETRIES if tests fail
   *  7. Persist assistant response only after the final assistant text is complete
   */
  async execute(input: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChatRunResult> {
    const eventContext = this.createEventContext();
    const resumeCommand = this.parseResumeCommand(input);
    const resumeOnly = resumeCommand !== null;

    // Intercept commands before any adapter call
    const commandResult = resumeOnly ? null : await this.handleCommand(input);
    if (commandResult !== null) {
      if (commandResult.output) {
        this.emitEvent({
          type: "assistant_final",
          text: commandResult.output,
          persisted: false,
          ...this.eventBase(eventContext),
        });
      }
      this.emitLifecycleEndEvent(commandResult.success ? "completed" : "error", commandResult.elapsed_ms, eventContext, false);
      return commandResult;
    }

    // Intercept plain Y/n responses (and any other input) when a /tend confirmation is pending
    if (this.pendingTend !== null && !resumeOnly) {
      const confirmationResult = await this.handleTendConfirmation(input.trim(), Date.now());
      if (confirmationResult.output) {
        this.emitEvent({
          type: "assistant_final",
          text: confirmationResult.output,
          persisted: false,
          ...this.eventBase(eventContext),
        });
      }
      this.emitLifecycleEndEvent(
        confirmationResult.success ? "completed" : "error",
        confirmationResult.elapsed_ms,
        eventContext,
        false
      );
      return confirmationResult;
    }

    const runtimeControlResult = resumeOnly
      ? null
      : await this.handleRuntimeControlIntent(input, cwd, Date.now());
    if (runtimeControlResult !== null) {
      if (runtimeControlResult.output) {
        this.emitEvent({
          type: "assistant_final",
          text: runtimeControlResult.output,
          persisted: false,
          ...this.eventBase(eventContext),
        });
      }
      this.emitLifecycleEndEvent(
        runtimeControlResult.success ? "completed" : "error",
        runtimeControlResult.elapsed_ms,
        eventContext,
        false
      );
      return runtimeControlResult;
    }

    if (resumeOnly && resumeCommand.selector) {
      try {
        const catalog = new ChatSessionCatalog(this.deps.stateManager);
        const session = await catalog.loadSessionBySelector(resumeCommand.selector);
        if (!session) {
          const elapsed_ms = 0;
          const output = `No chat session matched selector "${resumeCommand.selector}".`;
          this.emitEvent({
            type: "assistant_final",
            text: output,
            persisted: false,
            ...this.eventBase(eventContext),
          });
          this.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
          return { success: false, output, elapsed_ms };
        }
        this.startSessionFromLoadedSession(session);
      } catch (err) {
        const elapsed_ms = 0;
        const output = err instanceof ChatSessionSelectorError ? err.message : `Failed to load chat session: ${err instanceof Error ? err.message : String(err)}`;
        this.emitEvent({
          type: "assistant_final",
          text: output,
          persisted: false,
          ...this.eventBase(eventContext),
        });
        this.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
        return { success: false, output, elapsed_ms };
      }
    }

    // Reuse session (interactive mode) or create a fresh one per call (1-shot mode)
    if (!this.sessionActive) {
      const gitRoot = resolveGitRoot(cwd);
      const sessionId = crypto.randomUUID();
      this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
      this.nativeAgentLoopStatePath = `chat/agentloop/${sessionId}.state.json`;
      this.history.setAgentLoopStatePath(this.nativeAgentLoopStatePath);
    }
    const gitRoot = this.sessionCwd ?? resolveGitRoot(cwd);

    // history is always assigned by this point (either by startSession or the block above)
    const history = this.history!;

    this.emitEvent({
      type: "lifecycle_start",
      input,
      ...this.eventBase(eventContext),
    });

    // Persist-before-execute: user message written to disk before model or adapter execution.
    if (!resumeOnly) {
      await history.appendUserMessage(input);
    }

    // Build static grounding once per session; dynamic context is rebuilt each turn.
    if (this.cachedStaticSystemPrompt === null) {
      try {
        this.cachedStaticSystemPrompt = buildStaticSystemPrompt();
      } catch {
        this.cachedStaticSystemPrompt = "";
      }
    }

    // Build conversation history from prior turns (last 10), including any manual compaction summary.
    const messages = history.getMessages();
    const compactionSummary = history.getSessionData().compactionSummary;
    const priorTurns = resumeOnly ? messages.slice(-10) : messages.slice(0, -1).slice(-10);
    let historyBlock = "";
    const historySections: string[] = [];
    if (compactionSummary) {
      historySections.push(`Compacted previous conversation summary:\n${compactionSummary}`);
    }
    if (priorTurns.length > 0) {
      const lines = priorTurns.map((m: { role: string; content: string }) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
      ).join("\n");
      historySections.push(`Previous conversation:\n${lines}`);
    }
    if (historySections.length > 0) {
      historyBlock = `${historySections.join("\n\n")}\n\nCurrent message:\n`;
    }

    const directAnswerRoute = !resumeOnly && !this.deps.chatAgentLoopRunner && this.deps.llmClient !== undefined && shouldUseDirectAnswerRoute(input);
    const directPrompt = historyBlock ? `${historyBlock}${input}` : input;

    const start = Date.now();
    const assistantBuffer: AssistantBuffer = { text: "" };

    if (directAnswerRoute) {
      try {
        this.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
        const directResponse = await this.sendLLMMessage(
          this.deps.llmClient!,
          [{ role: "user", content: directPrompt }],
          {
            ...(this.cachedStaticSystemPrompt ? { system: this.cachedStaticSystemPrompt } : {}),
            model_tier: "light",
            max_tokens: DIRECT_ANSWER_MAX_TOKENS,
          },
          assistantBuffer,
          eventContext
        );
        const elapsed_ms = Date.now() - start;
        const output = assistantBuffer.text || directResponse.content || "(no response)";
        await history.appendAssistantMessage(output);
        this.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
        this.emitEvent({
          type: "assistant_final",
          text: output,
          persisted: true,
          ...this.eventBase(eventContext),
        });
        this.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
        return {
          success: true,
          output,
          elapsed_ms,
          diagnostics: {
            route: "direct",
            reason: "simple_question",
            modelTier: "light",
            maxTokens: DIRECT_ANSWER_MAX_TOKENS,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitLifecycleErrorEvent(message, assistantBuffer.text, eventContext);
        this.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
        return {
          success: false,
          output: assistantBuffer.text
            ? `${assistantBuffer.text}\n\n[interrupted: ${message}]`
            : `Error: ${message}`,
          elapsed_ms: Date.now() - start,
          diagnostics: {
            route: "direct",
            reason: "simple_question",
            modelTier: "light",
            maxTokens: DIRECT_ANSWER_MAX_TOKENS,
          },
        };
      }
    }

    let dynamicSystemPrompt = "";
    try {
      this.emitActivity("lifecycle", "Preparing context...", eventContext, "lifecycle:context");
      dynamicSystemPrompt = await buildDynamicContextPrompt({ stateManager: this.deps.stateManager });
    } catch {
      dynamicSystemPrompt = "";
    }

    const systemPrompt = [this.cachedStaticSystemPrompt, dynamicSystemPrompt]
      .filter((section) => section && section.trim().length > 0)
      .join("\n\n")
      .trim();
    const agentLoopSystemPrompt = [
      systemPrompt,
      compactionSummary ? `## Compacted Chat Summary\n${compactionSummary}` : "",
    ]
      .filter((section) => section && section.trim().length > 0)
      .join("\n\n")
      .trim();

    const context = resumeOnly ? "" : await buildChatContext(input, gitRoot);
    const basePrompt = resumeOnly ? "" : (context ? `${context}\n\n${input}` : input);
    const prompt = historyBlock ? `${historyBlock}${basePrompt}` : basePrompt;

    if (resumeOnly && !this.deps.chatAgentLoopRunner) {
      const elapsed_ms = Date.now() - start;
      const output = "Resume requires the native chat agentloop runtime.";
      this.emitEvent({
        type: "assistant_final",
        text: output,
        persisted: false,
        ...this.eventBase(eventContext),
      });
      this.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return {
        success: false,
        output,
        elapsed_ms,
      };
    }

    if (this.deps.chatAgentLoopRunner) {
      try {
        const resumeState = resumeOnly ? await this.loadResumableAgentLoopState() : null;
        if (resumeOnly && !resumeState) {
          const elapsed_ms = Date.now() - start;
          const output = "No resumable native agentloop state found.";
          this.emitEvent({
            type: "assistant_final",
            text: output,
            persisted: false,
            ...this.eventBase(eventContext),
          });
          this.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
          return {
            success: false,
            output,
            elapsed_ms,
          };
        }
        this.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
        const result = await this.deps.chatAgentLoopRunner.execute({
          message: basePrompt,
          cwd,
          goalId: this.deps.goalId,
          history: priorTurns.map((m: { role: string; content: string }) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          eventSink: this.createAgentLoopEventSink(eventContext),
          approvalFn: async (request) => {
            if (this.deps.approvalFn) {
              return this.deps.approvalFn(request.reason);
            }
            return false;
          },
          toolCallContext: {
            executionPolicy: await this.getSessionExecutionPolicy(),
          },
          ...(this.nativeAgentLoopStatePath ? { resumeStatePath: this.nativeAgentLoopStatePath } : {}),
          ...(resumeState ? { resumeState } : {}),
          ...(resumeOnly ? { resumeOnly: true } : {}),
          ...(agentLoopSystemPrompt ? { systemPrompt: agentLoopSystemPrompt } : {}),
        });
        const elapsed_ms = Date.now() - start;
        if (result.output) {
          this.pushAssistantDelta(result.output, assistantBuffer, eventContext);
        }
        if (result.success) {
          await history.appendAssistantMessage(result.output);
          this.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
          this.emitEvent({
            type: "assistant_final",
            text: result.output,
            persisted: true,
            ...this.eventBase(eventContext),
          });
          this.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
        } else {
          this.emitLifecycleErrorEvent(result.output || result.error || "Unknown error", assistantBuffer.text, eventContext);
          this.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
        }
        return {
          success: result.success,
          output: result.output,
          elapsed_ms,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitLifecycleErrorEvent(message, assistantBuffer.text, eventContext);
        this.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
        return {
          success: false,
          output: assistantBuffer.text
            ? `${assistantBuffer.text}\n\n[interrupted: ${message}]`
            : `Error: ${message}`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    // Prefer the local LLM/tool loop over the external adapter fallback whenever a client is available.
    if (this.deps.llmClient) {
      try {
        const toolResult = await this.executeWithTools(prompt, eventContext, assistantBuffer, systemPrompt || undefined);
        const elapsed_ms = Date.now() - start;
        await history.appendAssistantMessage(toolResult);
        this.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
        this.emitEvent({
          type: "assistant_final",
          text: toolResult,
          persisted: true,
          ...this.eventBase(eventContext),
        });
        this.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
        return { success: true, output: toolResult, elapsed_ms };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitLifecycleErrorEvent(message, assistantBuffer.text, eventContext);
        this.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
        return {
          success: false,
          output: assistantBuffer.text
            ? `${assistantBuffer.text}\n\n[interrupted: ${message}]`
            : `Error: ${message}`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    const task: AgentTask = {
      prompt,
      timeout_ms: timeoutMs,
      adapter_type: this.deps.adapter.adapterType,
      cwd,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    };
    const resolvedTimeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.emitActivity("lifecycle", "Calling adapter...", eventContext, "lifecycle:adapter");
    const adapterPromise = this.deps.adapter.execute(task);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Chat adapter timed out after ${resolvedTimeoutMs}ms`)), resolvedTimeoutMs)
    );
    let result = await Promise.race([adapterPromise, timeoutPromise]);
    // Surface adapter errors into output when output is empty
    if (!result.output && result.error) {
      result = { ...result, output: `Error: ${result.error}` };
    }
    const elapsed_ms = Date.now() - start;
    if (result.output) {
      this.pushAssistantDelta(result.output, assistantBuffer, eventContext);
    }

    // Verification loop: check if git has uncommitted changes; if so, run tests
    const gitChanges = await checkGitChanges(gitRoot);
    if (gitChanges !== null && gitChanges !== "") {
      let retries = 0;
      const VERIFY_TIMEOUT_MS = 30_000;
      this.emitActivity("lifecycle", "Checking result...", eventContext, "lifecycle:checking");
      let verification = await Promise.race([
        verifyChatAction(gitRoot, this.deps.toolExecutor),
        new Promise<{ passed: true }>((resolve) =>
          setTimeout(() => resolve({ passed: true }), VERIFY_TIMEOUT_MS)
        ),
      ]);

      while (!verification.passed && retries < MAX_VERIFY_RETRIES) {
        retries++;
        const retryPrompt = `The previous changes caused test failures. Please fix them.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`;
        const retryTask: AgentTask = { ...task, prompt: retryPrompt };
        result = await this.deps.adapter.execute(retryTask);
        verification = await verifyChatAction(gitRoot, this.deps.toolExecutor);
      }

      if (!verification.passed) {
        this.emitLifecycleErrorEvent(
          `Changes applied but tests are still failing after ${MAX_VERIFY_RETRIES} retries.`,
          assistantBuffer.text,
          eventContext
        );
        this.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
        return {
          success: false,
          output: `${assistantBuffer.text}\n\n[interrupted: tests are still failing after ${MAX_VERIFY_RETRIES} retries]\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`.trim(),
          elapsed_ms: Date.now() - start,
        };
      }
    }

    if (result.success) {
      await history.appendAssistantMessage(result.output);
      this.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
      this.emitEvent({
        type: "assistant_final",
        text: result.output,
        persisted: true,
        ...this.eventBase(eventContext),
      });
      this.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
    } else {
      const partialText = assistantBuffer.text !== result.output ? assistantBuffer.text : "";
      this.emitLifecycleErrorEvent(result.output || result.error || "Unknown error", partialText, eventContext);
      this.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
    }

    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  }

  private async handleRuntimeControlIntent(
    input: string,
    cwd: string,
    start: number
  ): Promise<ChatRunResult | null> {
    const intent = recognizeRuntimeControlIntent(input);
    if (intent === null) return null;

    if (!this.deps.runtimeControlService) {
      return {
        success: false,
        output: "Runtime control is not available in this chat surface yet.",
        elapsed_ms: Date.now() - start,
      };
    }

    const replyTarget = this.runtimeControlContext?.replyTarget ?? this.deps.runtimeReplyTarget;
    const actor = this.runtimeControlContext?.actor ?? this.deps.runtimeControlActor;
    const result = await this.deps.runtimeControlService.request({
      intent,
      cwd,
      requestedBy: actor ?? {
        surface: replyTarget?.surface ?? "chat",
        platform: replyTarget?.platform,
        conversation_id: replyTarget?.conversation_id,
        identity_key: replyTarget?.identity_key,
        user_id: replyTarget?.user_id,
      },
      replyTarget: replyTarget ?? { surface: "chat" },
      approvalFn: this.runtimeControlContext?.approvalFn
        ?? this.deps.runtimeControlApprovalFn
        ?? this.deps.approvalFn,
    });

    return {
      success: result.success,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  /**
   * Execute a chat turn using llmClient with self-knowledge tools (function calling).
   * Loops up to MAX_TOOL_LOOPS times to resolve tool calls, then returns final text.
   */
  private async executeWithTools(
    prompt: string,
    eventContext: ChatEventContext,
    assistantBuffer: AssistantBuffer,
    systemPrompt?: string
  ): Promise<string> {
    const llmClient = this.deps.llmClient!;
    const messages: LLMMessage[] = [{ role: "user", content: prompt }];
    const toolCallContext = await this.buildToolCallContext();

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      // Recompute tools each iteration so newly activated deferred tools are included
      const tools = this.deps.registry
        ? toToolDefinitionsFiltered(this.deps.registry.listAll(), { activatedTools: this.activatedTools })
        : [];
      const supportsNativeToolCalling = llmClient.supportsToolCalling?.() !== false;
      let response: LLMResponse;
      try {
        this.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
        response = await this.sendLLMMessage(llmClient, messages, {
          ...(supportsNativeToolCalling
            ? { tools, ...(systemPrompt ? { system: systemPrompt } : {}) }
            : { system: buildPromptedToolProtocolSystemPrompt({ systemPrompt, tools }) }),
        }, assistantBuffer, eventContext);
      } catch (err) {
        console.error("[chat-runner] executeWithTools error:", err);
        const hint = err instanceof Error ? `: ${err.message}` : "";
        throw new Error(`Sorry, I encountered an error processing your request${hint}.`);
      }

      const toolCalls = response.tool_calls?.length
        ? response.tool_calls
        : supportsNativeToolCalling
          ? []
          : extractPromptedToolCalls({
              content: response.content,
              tools,
              createId: () => `prompted-${loop}-${crypto.randomUUID()}`,
            }).map((call): ToolCallResult => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input ?? {}),
              },
            }));

      if (!supportsNativeToolCalling && toolCalls.length > 0) {
        assistantBuffer.text = "";
      }

      // No tool calls — return the text content
      if (toolCalls.length === 0) {
        return assistantBuffer.text || response.content || "(no response)";
      }

      // Append assistant message, then process tool calls
      messages.push({ role: "assistant", content: response.content || "" });

      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          // ignore parse errors, use empty args
        }
        const toolResult = await this.dispatchToolCall(
          tc.id,
          tc.function.name,
          args,
          toolCallContext,
          eventContext
        );
        // When ToolSearch returns results, activate deferred tools for subsequent turns
        if (tc.function.name === "tool_search") {
          this.activateToolSearchResults(toolResult);
        }
        messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
      }
    }

    // Max loops reached — return last assistant content or fallback
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    return lastAssistant?.content || "I was unable to complete the request within the allowed tool call limit.";
  }

  /**
   * Parse ToolSearch result JSON and activate any deferred tools found.
   * Called after each tool_search execution so the LLM can call found tools on the next turn.
   */
  private activateToolSearchResults(toolResult: string): void {
    try {
      const parsed = JSON.parse(toolResult) as unknown;
      const results = Array.isArray(parsed) ? parsed : null;
      if (results) {
        for (const item of results) {
          if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["name"] === "string") {
            this.activatedTools.add((item as Record<string, unknown>)["name"] as string);
          }
        }
      }
    } catch {
      // Non-JSON result or unexpected shape — ignore
    }
  }

  private createAgentLoopEventSink(eventContext: ChatEventContext): AgentLoopEventSink {
    return {
      emit: async (event: AgentLoopEvent) => {
        if (event.type === "tool_call_started") {
          const detail = event.inputPreview ? previewActivityText(event.inputPreview) : undefined;
          this.emitActivity("tool", formatToolActivity("Running", event.toolName, detail), eventContext, event.callId);
          this.emitEvent({
            type: "tool_start",
            toolCallId: event.callId,
            toolName: event.toolName,
            args: this.parseAgentLoopPreview(event.inputPreview),
            ...this.eventBase(eventContext),
          });
          this.emitEvent({
            type: "tool_update",
            toolCallId: event.callId,
            toolName: event.toolName,
            status: "running",
            message: "started",
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "tool_call_finished") {
          this.emitActivity(
            "tool",
            formatToolActivity(event.success ? "Finished" : "Failed", event.toolName, event.outputPreview),
            eventContext,
            event.callId
          );
          this.emitEvent({
            type: "tool_end",
            toolCallId: event.callId,
            toolName: event.toolName,
            success: event.success,
            summary: event.outputPreview,
            durationMs: event.durationMs,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "assistant_message" && event.phase === "commentary" && event.contentPreview) {
          this.emitActivity("commentary", previewActivityText(event.contentPreview, 120), eventContext, `commentary:${event.eventId}`);
          return;
        }

        if (event.type === "plan_update") {
          this.emitActivity("tool", `Updated plan: ${previewActivityText(event.summary)}`, eventContext, `plan:${event.turnId}`);
          this.emitEvent({
            type: "tool_update",
            toolCallId: `plan:${event.turnId}:${event.createdAt}`,
            toolName: "update_plan",
            status: "result",
            message: event.summary,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "approval_request") {
          this.emitActivity("tool", formatToolActivity("Running", event.toolName, `awaiting approval: ${event.reason}`), eventContext, event.callId);
          this.emitEvent({
            type: "tool_update",
            toolCallId: event.callId,
            toolName: event.toolName,
            status: "awaiting_approval",
            message: event.reason,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "approval") {
          this.emitActivity("tool", formatToolActivity("Finished", event.toolName, `approval ${event.status}: ${event.reason}`), eventContext);
          this.emitEvent({
            type: "tool_update",
            toolCallId: `approval:${event.turnId}:${event.createdAt}`,
            toolName: event.toolName,
            status: "result",
            message: `approval ${event.status}: ${event.reason}`,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "resumed") {
          this.emitEvent({
            type: "tool_update",
            toolCallId: `resume:${event.turnId}:${event.createdAt}`,
            toolName: "agentloop_resume",
            status: "result",
            message: `resumed ${event.restoredMessages} message(s) from ${event.fromUpdatedAt}`,
            ...this.eventBase(eventContext),
          });
          return;
        }

        if (event.type === "context_compaction") {
          this.emitEvent({
            type: "tool_update",
            toolCallId: `compaction:${event.turnId}:${event.createdAt}`,
            toolName: "context_compaction",
            status: "result",
            message: `${event.phase} ${event.reason}: ${event.inputMessages} -> ${event.outputMessages}`,
            ...this.eventBase(eventContext),
          });
        }
      },
    };
  }

  private parseAgentLoopPreview(preview: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(preview) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    return preview ? { preview } : {};
  }

  private parseResumeCommand(input: string): ResumeCommand | null {
    const trimmed = input.trim();
    const match = /^\/resume(?:\s+(.+))?$/i.exec(trimmed);
    if (!match) return null;
    const selector = match[1]?.trim();
    return selector ? { selector } : {};
  }

  private async loadResumableAgentLoopState(): Promise<AgentLoopSessionState | null> {
    if (!this.nativeAgentLoopStatePath) return null;
    const raw = await this.deps.stateManager.readRaw(this.nativeAgentLoopStatePath);
    if (!this.isAgentLoopSessionState(raw)) return null;
    if (raw.status === "completed") return null;
    return {
      ...raw,
      messages: [...raw.messages],
      calledTools: [...raw.calledTools],
    };
  }

  private isAgentLoopSessionState(value: unknown): value is AgentLoopSessionState {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate["sessionId"] === "string"
      && typeof candidate["traceId"] === "string"
      && typeof candidate["turnId"] === "string"
      && typeof candidate["goalId"] === "string"
      && typeof candidate["cwd"] === "string"
      && typeof candidate["modelRef"] === "string"
      && Array.isArray(candidate["messages"])
      && Array.isArray(candidate["calledTools"])
      && typeof candidate["status"] === "string";
  }

  /** Dispatch a tool call through the registry. */
  private async dispatchToolCall(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
    eventContext: ChatEventContext,
  ): Promise<string> {
    if (!this.deps.registry) {
      this.emitActivity("tool", formatToolActivity("Failed", name, "No tool registry configured"), eventContext, toolCallId);
      return JSON.stringify({ error: `No tool registry configured` });
    }
    const tool = this.deps.registry.get(name);
    if (!tool) {
      this.emitActivity("tool", formatToolActivity("Failed", name, `Unknown tool: ${name}`), eventContext, toolCallId);
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    const startTime = Date.now();
    try {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        this.emitActivity("tool", formatToolActivity("Failed", name, `Invalid input: ${parsed.error.message}`), eventContext, toolCallId);
        this.emitEvent({
          type: "tool_end",
          toolCallId,
          toolName: name,
          success: false,
          summary: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startTime,
          ...this.eventBase(eventContext),
        });
        return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
      }

      this.emitEvent({
        type: "tool_start",
        toolCallId,
        toolName: name,
        args,
        ...this.eventBase(eventContext),
      });
      this.emitActivity("tool", formatToolActivity("Running", name, JSON.stringify(args)), eventContext, toolCallId);

      let result: { success: boolean; summary: string; data?: unknown; error?: string };
      if (this.deps.toolExecutor) {
        this.emitEvent({
          type: "tool_update",
          toolCallId,
          toolName: name,
          status: "running",
          message: "running",
          ...this.eventBase(eventContext),
        });
        this.deps.onToolStart?.(name, args);
        result = await this.deps.toolExecutor.execute(name, parsed.data, context);
      } else {
        // Gate: check permissions before execution
        const permResult = await tool.checkPermissions(parsed.data, context);
        if (permResult.status === "denied") {
          this.emitEvent({
            type: "tool_end",
            toolCallId,
            toolName: name,
            success: false,
            summary: permResult.reason,
            durationMs: Date.now() - startTime,
            ...this.eventBase(eventContext),
          });
          return `Tool ${name} denied: ${permResult.reason}`;
        }
        if (permResult.status === "needs_approval") {
          this.emitActivity("tool", formatToolActivity("Running", name, `awaiting approval: ${permResult.reason}`), eventContext, toolCallId);
          this.emitEvent({
            type: "tool_update",
            toolCallId,
            toolName: name,
            status: "awaiting_approval",
            message: permResult.reason,
            ...this.eventBase(eventContext),
          });
          const approved = await context.approvalFn({
            toolName: name,
            input: parsed.data,
            reason: permResult.reason,
            permissionLevel: tool.metadata.permissionLevel,
            isDestructive: tool.metadata.isDestructive,
            reversibility: "unknown",
          });
          if (!approved) {
            this.emitEvent({
              type: "tool_end",
              toolCallId,
              toolName: name,
              success: false,
              summary: `Not approved: ${permResult.reason}`,
              durationMs: Date.now() - startTime,
              ...this.eventBase(eventContext),
            });
            return `Tool ${name} not approved: ${permResult.reason}`;
          }
        }
        this.emitEvent({
          type: "tool_update",
          toolCallId,
          toolName: name,
          status: "running",
          message: "running",
          ...this.eventBase(eventContext),
        });
        this.deps.onToolStart?.(name, args);
        result = await tool.call(parsed.data, context);
      }

      const durationMs = Date.now() - startTime;
      this.deps.onToolEnd?.(name, { success: result.success, summary: result.summary || '...', durationMs });
      this.emitActivity(
        "tool",
        formatToolActivity(result.success ? "Finished" : "Failed", name, result.summary || "..."),
        eventContext,
        toolCallId
      );
      this.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "result",
        message: result.summary || "...",
        ...this.eventBase(eventContext),
      });
      this.emitEvent({
        type: "tool_end",
        toolCallId,
        toolName: name,
        success: result.success,
        summary: result.summary || "...",
        durationMs,
        ...this.eventBase(eventContext),
      });
      // Prefer structured data (JSON) over plain summary so the LLM gets actionable content
      return result.data != null ? JSON.stringify(result.data) : (result.summary ?? "(no result)");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      this.deps.onToolEnd?.(name, { success: false, summary: message, durationMs });
      this.emitActivity("tool", formatToolActivity("Failed", name, message), eventContext, toolCallId);
      this.emitEvent({
        type: "tool_end",
        toolCallId,
        toolName: name,
        success: false,
        summary: message,
        durationMs,
        ...this.eventBase(eventContext),
      });
      return JSON.stringify({ error: `Tool ${name} failed: ${message}` });
    }
  }

  private async sendLLMMessage(
    llmClient: ILLMClient,
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    assistantBuffer: AssistantBuffer,
    eventContext: ChatEventContext
  ): Promise<LLMResponse> {
    let streamed = false;
    if (llmClient.sendMessageStream) {
      const response = await llmClient.sendMessageStream(messages, options, {
        onTextDelta: (delta) => {
          streamed = true;
          this.pushAssistantDelta(delta, assistantBuffer, eventContext);
        },
      });
      if (!streamed && response.content) {
        this.pushAssistantDelta(response.content, assistantBuffer, eventContext);
      }
      return response;
    }

    const response = await llmClient.sendMessage(messages, options);
    if (response.content) {
      this.pushAssistantDelta(response.content, assistantBuffer, eventContext);
    }
    return response;
  }

  private createEventContext(): ChatEventContext {
    return {
      runId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
    };
  }

  private eventBase(context: ChatEventContext): ChatEventContext & { createdAt: string } {
    return { ...context, createdAt: new Date().toISOString() };
  }

  private emitEvent(event: ChatEvent): void {
    const handler = this.onEvent ?? this.deps.onEvent;
    handler?.(event);
  }

  private emitActivity(
    kind: ActivityKind,
    message: string,
    eventContext: ChatEventContext,
    sourceId?: string
  ): void {
    if (!message.trim()) return;
    this.emitEvent({
      type: "activity",
      kind,
      message,
      ...(sourceId ? { sourceId } : {}),
      transient: true,
      ...this.eventBase(eventContext),
    });
  }

  private pushAssistantDelta(
    delta: string,
    assistantBuffer: AssistantBuffer,
    eventContext: ChatEventContext
  ): void {
    if (!delta) return;
    assistantBuffer.text += delta;
    this.emitEvent({
      type: "assistant_delta",
      delta,
      text: assistantBuffer.text,
      ...this.eventBase(eventContext),
    });
  }

  private emitLifecycleEndEvent(
    status: "completed" | "error",
    elapsedMs: number,
    eventContext: ChatEventContext,
    persisted: boolean
  ): void {
    this.emitEvent({
      type: "lifecycle_end",
      status,
      elapsedMs,
      persisted,
      ...this.eventBase(eventContext),
    });
  }

  private emitLifecycleErrorEvent(
    error: string,
    partialText: string,
    eventContext: ChatEventContext
  ): void {
    this.emitEvent({
      type: "lifecycle_error",
      error,
      partialText,
      persisted: false,
      ...this.eventBase(eventContext),
    });
  }

  /** Build a ToolCallContext from ChatRunnerDeps for tool dispatch. */
  private async getSessionExecutionPolicy(): Promise<ExecutionPolicy> {
    if (this.sessionExecutionPolicy) return this.sessionExecutionPolicy;
    const config = await loadProviderConfig({ saveMigration: false });
    this.sessionExecutionPolicy = resolveExecutionPolicy({
      workspaceRoot: this.sessionCwd ?? process.cwd(),
      security: config.agent_loop?.security,
    });
    return this.sessionExecutionPolicy;
  }

  private async buildToolCallContext(): Promise<ToolCallContext> {
    const executionPolicy = await this.getSessionExecutionPolicy();
    return {
      cwd: this.sessionCwd ?? process.cwd(),
      goalId: this.deps.goalId ?? "",
      trustBalance: 0,
      preApproved: false,
      approvalFn: async (req) => {
        if (this.deps.approvalFn) {
          return this.deps.approvalFn(req.reason);
        }
        return false;
      },
      executionPolicy,
    };
  }
}
