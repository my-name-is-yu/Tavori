// ─── Chat Grounding ───
//
// Builds a system prompt that gives the LLM self-knowledge about PulSeed:
// identity, available commands, current state (goals, plugins, provider).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../state/state-manager.js";

export interface GroundingOptions {
  stateManager: StateManager;
  /** Base directory for PulSeed config files. Defaults to ~/.pulseed */
  homeDir?: string;
}

// ─── Helpers ───

async function readPlugins(homeDir: string): Promise<string[]> {
  const pluginsDir = path.join(homeDir, "plugins");
  try {
    const entries = await fsp.readdir(pluginsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readProvider(homeDir: string): Promise<string> {
  const providerPath = path.join(homeDir, "provider.json");
  try {
    const raw = await fsp.readFile(providerPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const llm = typeof parsed.llm === "string" ? parsed.llm : null;
    const adapter = typeof parsed.default_adapter === "string" ? parsed.default_adapter : null;
    if (llm && adapter) return `${llm} / ${adapter}`;
    if (llm) return llm;
    return "not configured";
  } catch {
    return "not configured";
  }
}

async function buildGoalsBlock(stateManager: StateManager): Promise<string> {
  const ids = await stateManager.listGoalIds();
  if (ids.length === 0) return "No goals configured yet.";

  const lines: string[] = [];
  for (const id of ids) {
    const goal = await stateManager.loadGoal(id);
    if (!goal) continue;
    const status = goal.loop_status !== "idle" ? ` [${goal.loop_status}]` : "";
    lines.push(`- ${goal.title} (${id})${status} — status: ${goal.status}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No goals configured yet.";
}

// ─── Main export ───

export async function buildSystemPrompt(options: GroundingOptions): Promise<string> {
  const homeDir = options.homeDir ?? path.join(
    process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
    ".pulseed"
  );

  const [goalsBlock, plugins, provider] = await Promise.all([
    buildGoalsBlock(options.stateManager),
    readPlugins(homeDir),
    readProvider(homeDir),
  ]);

  const pluginsLine = plugins.length > 0 ? plugins.join(", ") : "none";

  return `
You are PulSeed, an AI agent orchestrator. You help users manage goals, observe progress, and operate PulSeed.
You are NOT a general-purpose assistant — you are PulSeed itself, talking to your operator.
Your purpose: autonomously pursue goals by delegating to agents, observing results, and adjusting strategy.
You do not execute tasks yourself — you orchestrate.

## Available Commands
- \`pulseed goal add "<description>"\`    Register a new goal (via GoalRefiner)
- \`pulseed goal list\`                   List all registered goals
- \`pulseed goal show <id>\`              Show goal details
- \`pulseed goal reset <id>\`             Reset goal state for re-running
- \`pulseed run --goal <id>\`             Start the orchestration loop for a goal
- \`pulseed status --goal <id>\`          Show current progress
- \`pulseed report --goal <id>\`          Show latest report
- \`pulseed start --goal <id> -d\`        Start daemon mode (background)
- \`pulseed stop\`                        Stop the running daemon
- \`pulseed daemon status\`               Show daemon status
- \`pulseed suggest "<context>"\`         Suggest new goals for a project
- \`pulseed improve [path]\`              Analyze path and suggest improvement goals
- \`pulseed tui\`                         Launch interactive TUI
- \`pulseed setup\`                       Interactive first-time setup wizard
- \`pulseed provider set\`                Set LLM provider and adapter
- \`pulseed plugin list\`                 List installed plugins
- \`pulseed logs\`                        View daemon logs
- \`pulseed doctor\`                      Run health checks
- \`pulseed chat\`                        This conversation
- \`/track\`                              Promote this chat session to a tracked goal

## Current State
### Goals
${goalsBlock}

### Plugins
Installed: ${pluginsLine}

### Provider
${provider}

## How to Help
- When the user asks to set something up, guide them step by step using specific commands above
- Reference exact CLI commands with flags when applicable
- If state is needed, tell the user which command to run rather than guessing
- Use \`/track\` to convert this conversation into a persistent goal when the user defines an objective
- Be concise and direct — you are a tool, not a conversationalist
`.trim();
}
