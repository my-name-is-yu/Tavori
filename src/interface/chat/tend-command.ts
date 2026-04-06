// --- TendCommand ---
//
// Implements the /tend slash command for chat mode.
// Summarizes chat history via LLM, generates a structured goal,
// confirms with the user, then starts a daemon to work on it autonomously.

import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { DaemonClient } from "../../runtime/daemon-client.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { Goal } from "../../base/types/goal.js";
import type { ChatMessage } from "./chat-history.js";

// --- Types ---

export interface TendDeps {
  llmClient: ILLMClient;
  goalNegotiator: GoalNegotiator;
  daemonClient: DaemonClient;
  stateManager: StateManager;
  chatHistory: ChatMessage[];
}

export interface TendResult {
  success: boolean;
  goalId?: string;
  goalTitle?: string;
  /** Formatted message for chat display. */
  message: string;
  /** Formatted confirmation prompt shown to user before daemon start. */
  confirmation?: string;
  /** True when execution is paused waiting for user confirmation. */
  needsConfirmation?: boolean;
}

// --- Constants ---

const MAX_HISTORY_MESSAGES = 20;
const SUMMARY_PROMPT = `You are analyzing a developer's chat conversation to extract their main objective.
Summarize what the user wants to achieve in 1-3 sentences. Focus on concrete, measurable outcomes.
Be specific -- mention file names, metrics, or technical goals if present.
Output only the summary, no preamble.`;

// --- TendCommand ---

export class TendCommand {
  /**
   * Main entry point for /tend.
   * Parses args, optionally generates a goal from chat history,
   * and starts the daemon.
   */
  async execute(args: string, deps: TendDeps): Promise<TendResult> {
    const { goalId, maxIterations } = parseArgs(args);

    // Path A: existing goal-id provided -- skip generation
    if (goalId) {
      return this.tendExistingGoal(goalId, maxIterations, deps);
    }

    // Path B: no chat history to work from
    if (deps.chatHistory.length === 0) {
      return {
        success: false,
        message: "No conversation yet. Chat first to describe what you want, then use /tend.",
      };
    }

    // Path C: auto-generate goal from chat history
    return this.tendFromChat(maxIterations, deps);
  }

  /**
   * Summarize recent chat messages into a concise objective string.
   */
  async summarizeChat(history: ChatMessage[], llmClient: ILLMClient): Promise<string> {
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    const transcript = recent
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const prompt = `${SUMMARY_PROMPT}\n\nConversation:\n${transcript}`;

    try {
      const response = await llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { max_tokens: 200, model_tier: "light" }
      );
      return response.content.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to summarize chat: ${msg}`);
    }
  }

  /**
   * Generate a structured Goal from a plain-text summary via GoalNegotiator.
   */
  async generateGoal(summary: string, goalNegotiator: GoalNegotiator): Promise<Goal> {
    const result = await goalNegotiator.negotiate(summary, {
      constraints: ["source: tend (auto-generated from chat)"],
    });
    return result.goal;
  }

  /**
   * Format a goal for the confirmation prompt shown to the user before daemon start.
   * Prefixed with the seedling symbol per design spec.
   */
  formatConfirmation(goal: Goal): string {
    const lines: string[] = [
      "🌱 Tend to this goal?",
      "",
      `  Title: ${goal.title}`,
    ];

    if (goal.dimensions.length > 0) {
      lines.push("  Dimensions:");
      for (const dim of goal.dimensions) {
        const t = dim.threshold;
        let thresholdStr = "";
        if (t.type === "min") thresholdStr = `min ${t.value}`;
        else if (t.type === "max") thresholdStr = `max ${t.value}`;
        else if (t.type === "range") thresholdStr = `${t.low}–${t.high}`;
        else if (t.type === "present") thresholdStr = "present";
        else if (t.type === "match") thresholdStr = `match: ${t.value}`;
        lines.push(`    - ${dim.name}: ${thresholdStr}`);
      }
    }

    if (goal.constraints && goal.constraints.length > 0) {
      lines.push("  Constraints:");
      for (const c of goal.constraints) {
        lines.push(`    - ${c}`);
      }
    }

    lines.push("");
    lines.push("  [Y/n]");
    return lines.join("\n");
  }

  // --- Private helpers ---

  private async tendExistingGoal(
    goalId: string,
    maxIterations: number | undefined,
    deps: TendDeps
  ): Promise<TendResult> {
    const goal = await deps.stateManager.loadGoal(goalId);
    if (!goal) {
      return {
        success: false,
        message: `Goal not found: ${goalId}`,
      };
    }
    return this.startDaemon(goal, maxIterations, deps.daemonClient);
  }

  private async tendFromChat(
    maxIterations: number | undefined,
    deps: TendDeps
  ): Promise<TendResult> {
    let summary: string;
    try {
      summary = await this.summarizeChat(deps.chatHistory, deps.llmClient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Could not summarize chat: ${msg}. Try /track or create a goal manually with 'pulseed add'.`,
      };
    }

    let goal: Goal;
    try {
      goal = await this.generateGoal(summary, deps.goalNegotiator);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Could not generate goal: ${msg}. Try describing your goal more specifically and retry /tend.`,
      };
    }

    const confirmation = this.formatConfirmation(goal);
    return {
      success: true,
      goalId: goal.id,
      goalTitle: goal.title,
      message: "Generated goal from conversation.",
      confirmation,
      needsConfirmation: true,
    };
  }

  private async startDaemon(
    goal: Goal,
    maxIterations: number | undefined,
    daemonClient: DaemonClient
  ): Promise<TendResult> {
    try {
      await daemonClient.startGoal(goal.id);
      const iterNote = maxIterations !== undefined ? ` (max ${maxIterations} iterations)` : "";
      return {
        success: true,
        goalId: goal.id,
        goalTitle: goal.title,
        message: `🌱 [tend] ${goal.id}: Started — "${goal.title}"${iterNote}\nRun 'pulseed status' to check progress.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Daemon unavailable: ${msg}. Start the daemon with 'pulseed daemon start' first.`,
      };
    }
  }
}

// --- Arg parsing ---

function parseArgs(args: string): { goalId?: string; maxIterations?: number } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let goalId: string | undefined;
  let maxIterations: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "--max" && parts[i + 1]) {
      const n = parseInt(parts[i + 1], 10);
      if (!isNaN(n) && n > 0) maxIterations = n;
      i++;
    } else if (!parts[i].startsWith("--")) {
      goalId = parts[i];
    }
  }

  return { goalId, maxIterations };
}
