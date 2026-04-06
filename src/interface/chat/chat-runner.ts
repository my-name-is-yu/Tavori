// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import { execFile } from "node:child_process";
import type { StateManager } from "../../base/state/state-manager.js";
import type { IAdapter, AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { ChatHistory } from "./chat-history.js";
import { buildChatContext, resolveGitRoot } from "../../platform/observation/context-provider.js";
import type { EscalationHandler } from "./escalation.js";
import { buildSystemPrompt } from "./grounding.js";
import { verifyChatAction } from "./chat-verifier.js";
import type { ApprovalLevel } from "./self-knowledge-mutation-tools.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { toToolDefinitionsFiltered } from "../../tools/tool-definition-adapter.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { LLMMessage, LLMResponse } from "../../base/llm/llm-client.js";
import { TendCommand } from "./tend-command.js";
import type { TendDeps } from "./tend-command.js";
import { EventSubscriber } from "./event-subscriber.js";
import type { DaemonClient } from "../../runtime/daemon-client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";

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
}

export interface ChatRunResult {
  success: boolean;
  output: string;
  elapsed_ms: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_RETRIES = 2;
const MAX_TOOL_LOOPS = 5;

// ─── Command help text ───

const COMMAND_HELP = `Available commands:
  /help    Show this help message
  /clear   Clear conversation history
  /exit    Exit chat mode
  /track   Promote session to Tier 2 goal pursuit (not yet implemented)
  /tend    Generate a goal from chat history and start autonomous daemon execution`;

// ─── Helpers ───

function checkGitChanges(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "HEAD", "--stat"], { cwd, timeout: 5_000 }, (err, stdout, stderr) => {
      resolve(err ? null : (stdout + stderr).trim());
    });
  });
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
  /** Cached system prompt — built once per session, reused across turns. */
  private cachedSystemPrompt: string | null = null;
  /** Pending /tend goal ID awaiting user confirmation (Y/n). */
  private pendingTendGoalId: string | null = null;
  /** Active EventSubscriber instances keyed by goalId. */
  private activeSubscribers: Map<string, EventSubscriber> = new Map();
  /**
   * Callback invoked when a /tend daemon notification arrives.
   * Can be set after construction (e.g. from a React component via useEffect).
   */
  onNotification: ((message: string) => void) | undefined = undefined;

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
      this.history?.clear();
      return { success: true, output: "Conversation history cleared.", elapsed_ms: Date.now() - start };
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
    if (this.pendingTendGoalId !== null) {
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
      this.pendingTendGoalId = result.goalId;
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
    const goalId = this.pendingTendGoalId!;
    this.pendingTendGoalId = null;

    const normalized = input.trim().toLowerCase();
    const confirmed = normalized === "" || normalized === "y" || normalized === "yes";

    if (!confirmed) {
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
      await this.deps.daemonClient.startGoal(goalId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Daemon unavailable: ${msg}. Start the daemon with 'pulseed daemon start' first.`,
        elapsed_ms: Date.now() - start,
      };
    }

    // Subscribe to EventServer progress notifications (non-blocking)
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

    const shortId = goalId.length > 12 ? goalId.slice(0, 12) : goalId;
    return {
      success: true,
      output: `[tend] ${shortId}: Started — daemon is now tending your goal.\nRun 'pulseed status' to check progress.`,
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
   *  7. Persist assistant response (fire-and-forget)
   */
  async execute(input: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChatRunResult> {
    // Intercept commands before any adapter call
    const commandResult = await this.handleCommand(input);
    if (commandResult !== null) {
      return commandResult;
    }

    // Intercept plain Y/n responses when a /tend confirmation is pending
    if (this.pendingTendGoalId !== null) {
      const normalized = input.trim().toLowerCase();
      if (["y", "yes", "n", "no", ""].includes(normalized)) {
        return this.handleTendConfirmation(normalized, Date.now());
      }
    }

    // Reuse session (interactive mode) or create a fresh one per call (1-shot mode)
    if (!this.sessionActive) {
      const gitRoot = resolveGitRoot(cwd);
      const sessionId = crypto.randomUUID();
      this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
    }
    const gitRoot = this.sessionCwd ?? resolveGitRoot(cwd);

    // history is always assigned by this point (either by startSession or the block above)
    const history = this.history!;

    // Persist-before-execute: user message written to disk first
    await history.appendUserMessage(input);

    // Build grounding system prompt on first turn, cache for session
    if (this.cachedSystemPrompt === null) {
      try {
        this.cachedSystemPrompt = await buildSystemPrompt({ stateManager: this.deps.stateManager });
      } catch {
        this.cachedSystemPrompt = "";
      }
    }

    // Build conversation history from prior turns (last 10)
    const messages = history.getMessages();
    const priorTurns = messages.slice(0, -1).slice(-10);
    let historyBlock = "";
    if (priorTurns.length > 0) {
      const lines = priorTurns.map((m: { role: string; content: string }) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
      ).join("\n");
      historyBlock = `Previous conversation:\n${lines}\n\nCurrent message:\n`;
    }

    const context = await buildChatContext(input, gitRoot);
    const basePrompt = context ? `${context}\n\n${input}` : input;
    const prompt = historyBlock ? `${historyBlock}${basePrompt}` : basePrompt;

    const start = Date.now();

    // Use llmClient with self-knowledge tools when available (function calling path)
    // Skip executeWithTools for clients that don't support tool calling (e.g. CodexLLMClient)
    if (this.deps.llmClient && this.deps.llmClient.supportsToolCalling?.() !== false) {
      const toolResult = await this.executeWithTools(prompt, this.cachedSystemPrompt ?? undefined);
      const elapsed_ms = Date.now() - start;
      await history.appendAssistantMessage(toolResult);
      return { success: true, output: toolResult, elapsed_ms };
    }

    const task: AgentTask = {
      prompt,
      timeout_ms: timeoutMs,
      adapter_type: this.deps.adapter.adapterType,
      cwd,
      ...(this.cachedSystemPrompt ? { system_prompt: this.cachedSystemPrompt } : {}),
    };
    const resolvedTimeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
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

    // Verification loop: check if git has uncommitted changes; if so, run tests
    const gitChanges = await checkGitChanges(gitRoot);
    if (gitChanges !== null && gitChanges !== "") {
      let retries = 0;
      const VERIFY_TIMEOUT_MS = 30_000;
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
        // Fire-and-forget: persist assistant response
        history.appendAssistantMessage(result.output);
        return {
          success: false,
          output: `Changes applied but tests are still failing after ${MAX_VERIFY_RETRIES} retries. Please intervene manually.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`,
          elapsed_ms: Date.now() - start,
        };
      }
    }

    // Fire-and-forget: persist assistant response after completion
    history.appendAssistantMessage(result.output);

    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  }

  /**
   * Execute a chat turn using llmClient with self-knowledge tools (function calling).
   * Loops up to MAX_TOOL_LOOPS times to resolve tool calls, then returns final text.
   */
  private async executeWithTools(prompt: string, systemPrompt?: string): Promise<string> {
    const llmClient = this.deps.llmClient!;
    const messages: LLMMessage[] = [{ role: "user", content: prompt }];
    const toolCallContext = this.buildToolCallContext();

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      // Recompute tools each iteration so newly activated deferred tools are included
      const tools = this.deps.registry
        ? toToolDefinitionsFiltered(this.deps.registry.listAll(), { activatedTools: this.activatedTools })
        : [];
      let response: LLMResponse;
      try {
        response = await llmClient.sendMessage(messages, {
          tools,
          ...(systemPrompt ? { system: systemPrompt } : {}),
        });
      } catch (err) {
        console.error("[chat-runner] executeWithTools error:", err);
        const hint = err instanceof Error ? `: ${err.message}` : "";
        return `Sorry, I encountered an error processing your request${hint}.`;
      }

      // No tool calls — return the text content
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return response.content || "(no response)";
      }

      // Append assistant message, then process tool calls
      messages.push({ role: "assistant", content: response.content || "" });

      for (const tc of response.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          // ignore parse errors, use empty args
        }
        const toolResult = await this.dispatchToolCall(tc.function.name, args, toolCallContext);
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

  /** Dispatch a tool call through the registry. */
  private async dispatchToolCall(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<string> {
    if (!this.deps.registry) {
      return JSON.stringify({ error: `No tool registry configured` });
    }
    const tool = this.deps.registry.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    const startTime = Date.now();
    try {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
      }

      // Gate: check permissions before execution
      const permResult = await tool.checkPermissions(parsed.data, context);
      if (permResult.status === "denied") {
        return `Tool ${name} denied: ${permResult.reason}`;
      }
      if (permResult.status === "needs_approval") {
        const approved = await context.approvalFn({
          toolName: name,
          input: parsed.data,
          reason: permResult.reason,
          permissionLevel: tool.metadata.permissionLevel,
          isDestructive: tool.metadata.isDestructive,
          reversibility: "unknown",
        });
        if (!approved) {
          return `Tool ${name} not approved: ${permResult.reason}`;
        }
      }

      this.deps.onToolStart?.(name, args);
      const result = await tool.call(parsed.data, context);
      const durationMs = Date.now() - startTime;
      this.deps.onToolEnd?.(name, { success: result.success, summary: result.summary || '...', durationMs });
      // Prefer structured data (JSON) over plain summary so the LLM gets actionable content
      return result.data != null ? JSON.stringify(result.data) : (result.summary ?? "(no result)");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.onToolEnd?.(name, { success: false, summary: message, durationMs: Date.now() - startTime });
      return JSON.stringify({ error: `Tool ${name} failed: ${message}` });
    }
  }

  /** Build a ToolCallContext from ChatRunnerDeps for tool dispatch. */
  private buildToolCallContext(): ToolCallContext {
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
    };
  }
}
