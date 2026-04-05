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
import { toToolDefinitions } from "../../tools/tool-definition-adapter.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { LLMMessage, LLMResponse } from "../../base/llm/llm-client.js";

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
  /** Optional: per-tool approval level overrides. */
  approvalConfig?: Record<string, ApprovalLevel>;
  /** Optional: tool executor for post-change verification (git diff + tests). */
  toolExecutor?: ToolExecutor;
  /** Optional: tool registry providing unified tool catalog. */
  registry?: ToolRegistry;
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
  /track   Promote session to Tier 2 goal pursuit (not yet implemented)`;

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
  /** Cached system prompt — built once per session, reused across turns. */
  private cachedSystemPrompt: string | null = null;

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
    const tools = this.deps.registry
      ? toToolDefinitions(this.deps.registry.listAll())
      : [];
    const messages: LLMMessage[] = [{ role: "user", content: prompt }];
    const toolCallContext = this.buildToolCallContext();

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
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
        messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
      }
    }

    // Max loops reached — return last assistant content or fallback
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    return lastAssistant?.content || "I was unable to complete the request within the allowed tool call limit.";
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
    try {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
      }
      const result = await tool.call(parsed.data, context);
      return result.summary || JSON.stringify(result.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Tool ${name} failed: ${message}` });
    }
  }

  /** Build a ToolCallContext from ChatRunnerDeps for tool dispatch. */
  private buildToolCallContext(): ToolCallContext {
    return {
      cwd: this.sessionCwd ?? process.cwd(),
      goalId: "",
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
