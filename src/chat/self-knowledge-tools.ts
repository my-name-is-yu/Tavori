import * as fs from "fs";
import * as path from "path";
import type { StateManager } from "../state/state-manager.js";
import type { ToolDefinition } from "../llm/llm-client.js";
export type { ToolDefinition };

// ─── Dependencies ───

export interface SelfKnowledgeDeps {
  stateManager: StateManager;
  trustManager?: { getBalance(domain: string): Promise<{ balance: number }> };
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; type?: string; enabled?: boolean }>> };
  homeDir: string;
}

// ─── Tool Definitions ───

export function getSelfKnowledgeToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "get_goals",
        description:
          "Returns detailed information about all goals: title, description, thresholds, status, loop_status, confidence, current_state, and gap_score.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_sessions",
        description:
          "Returns recent session history including goal_id, adapter, status, duration, and created_at.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Number of recent sessions to return (default: 5)",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_trust_state",
        description:
          "Returns the current trust state: trust_score, balance range, delta_success, delta_failure, high_trust_threshold, ethics_gate_level, and execution_boundary.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_config",
        description:
          "Returns runtime configuration: provider, model, default_adapter, and pulseed_home_dir.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_plugins",
        description:
          "Returns the list of installed plugins with name, type, and enabled status.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_architecture",
        description:
          "Returns a static description of PulSeed architecture, layer structure, core loop, 4-element model, and execution boundary.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
  ];
}

// ─── Handlers ───

async function handleGetGoals(deps: SelfKnowledgeDeps): Promise<string> {
  const goalIds = await deps.stateManager.listGoalIds();
  if (goalIds.length === 0) {
    return JSON.stringify({ goals: [], message: "No goals found." });
  }
  const goals = await Promise.all(
    goalIds.map(async (id) => {
      const goal = await deps.stateManager.loadGoal(id);
      if (!goal) return null;
      return {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        loop_status: goal.loop_status,
        dimensions: goal.dimensions.map((d) => ({
          name: d.name,
          label: d.label,
          current_value: d.current_value,
          threshold: d.threshold,
          confidence: d.confidence,
        })),
      };
    })
  );
  return JSON.stringify({ goals: goals.filter(Boolean) });
}

async function handleGetSessions(
  args: Record<string, unknown>,
  deps: SelfKnowledgeDeps
): Promise<string> {
  const limit = typeof args.limit === "number" ? args.limit : 5;
  const sessionsDir = path.join(deps.homeDir, ".pulseed", "sessions");
  try {
    if (!fs.existsSync(sessionsDir)) {
      return JSON.stringify({ message: "No session information available.", sessions: [] });
    }
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-limit);
    const sessions = files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, f), "utf-8");
        return JSON.parse(raw) as unknown;
      } catch {
        return { file: f, error: "Failed to parse" };
      }
    });
    return JSON.stringify({ sessions });
  } catch {
    return JSON.stringify({ message: "No session information available.", sessions: [] });
  }
}

async function handleGetTrustState(deps: SelfKnowledgeDeps): Promise<string> {
  let trustScore: number | string = "unavailable";
  if (deps.trustManager) {
    try {
      const balance = await deps.trustManager.getBalance("default");
      trustScore = balance.balance;
    } catch {
      trustScore = "unavailable";
    }
  }
  return JSON.stringify({
    trust_score: trustScore,
    trust_balance_range: [-100, 100],
    delta_success: 3,
    delta_failure: -10,
    high_trust_threshold: 20,
    ethics_gate_level: "L1",
    execution_boundary:
      "PulSeed always delegates. Direct actions are LLM calls (for thinking) and state read/write only.",
  });
}

async function handleGetConfig(deps: SelfKnowledgeDeps): Promise<string> {
  const providerPath = path.join(deps.homeDir, ".pulseed", "provider.json");
  const defaults = {
    provider: "unknown",
    model: "unknown",
    default_adapter: "claude-code-cli",
    pulseed_home_dir: path.join(deps.homeDir, ".pulseed"),
  };
  try {
    if (!fs.existsSync(providerPath)) {
      return JSON.stringify(defaults);
    }
    const raw = fs.readFileSync(providerPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify({
      provider: config["provider"] ?? defaults.provider,
      model: config["model"] ?? defaults.model,
      default_adapter: config["default_adapter"] ?? defaults.default_adapter,
      pulseed_home_dir: defaults.pulseed_home_dir,
    });
  } catch {
    return JSON.stringify(defaults);
  }
}

async function handleGetPlugins(deps: SelfKnowledgeDeps): Promise<string> {
  if (!deps.pluginLoader) {
    return JSON.stringify({ message: "Plugin information is not available.", plugins: [] });
  }
  try {
    const pluginStates = await deps.pluginLoader.loadAll();
    const plugins = pluginStates.map((p) => ({
      name: p.name,
      type: p.type ?? "unknown",
      enabled: p.enabled ?? true,
    }));
    return JSON.stringify({ plugins });
  } catch {
    return JSON.stringify({ message: "Failed to load plugin information.", plugins: [] });
  }
}

function handleGetArchitecture(): string {
  const text = `PulSeed Architecture

## Core Concept
4-element model: Goal (with thresholds) -> Current State (observation + confidence) -> Gap -> Constraints
Core loop: observe -> gap -> score -> task -> execute -> verify (NEVER STOP)
Execution boundary: PulSeed always delegates. Direct actions are LLM calls (for thinking) and state read/write only.

## Layer Structure
- Layer 0:  StateManager, AdapterLayer (no dependencies)
- Layer 1:  GapCalculator, DriveSystem, TrustManager
- Layer 2:  ObservationEngine, DriveScorer, SatisficingJudge, StallDetector
- Layer 3:  SessionManager, GoalNegotiator, StrategyManager
- Layer 4:  TaskLifecycle
- Layer 5:  CoreLoop, ReportingEngine
- Layer 6:  CLIRunner
- Layer 7:  TUI (Ink/React dashboard, approval UI, chat)
- Layer 8:  KnowledgeManager (cross-cutting)
- Layer 9:  PortfolioManager
- Layer 10: DaemonRunner, PIDManager, Logger, EventServer, NotificationDispatcher, MemoryLifecycleManager
- Layer 11: CuriosityEngine, CharacterConfigManager
- Layer 12: EmbeddingClient, VectorIndex, KnowledgeGraph, GoalDependencyGraph
- Layer 13: CapabilityDetector, DataSourceAdapter
- Layer 14: GoalTreeManager, StateAggregator, TreeLoopOrchestrator, CrossGoalPortfolio, StrategyTemplateRegistry, LearningPipeline, KnowledgeTransfer
- Layer 15: PluginLoader, NotifierRegistry, INotifier (plugin architecture)

## Module Responsibilities (summary)
- StateManager: persistent goal/session state (file-based JSON)
- GapCalculator: computes gap score from current state vs. thresholds
- DriveSystem: converts gap into drive intensity
- TrustManager: asymmetric trust scoring [-100,+100]
- ObservationEngine: LLM-powered state observation with 3-tier fallback
- SatisficingJudge: decides "good enough" to stop pursuing a goal
- StallDetector: detects stall conditions (repetition, timeout, loop)
- SessionManager: manages agent session lifecycle
- TaskLifecycle: task selection, execution delegation, verification
- CoreLoop: the main orchestration loop (observe->gap->score->task->execute->verify)
- EthicsGate: L1 mechanical safety checks before irreversible actions`;
  return JSON.stringify({ architecture: text });
}

// ─── Dispatcher ───

export async function handleSelfKnowledgeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  deps: SelfKnowledgeDeps
): Promise<string> {
  switch (toolName) {
    case "get_goals":
      return handleGetGoals(deps);
    case "get_sessions":
      return handleGetSessions(args, deps);
    case "get_trust_state":
      return handleGetTrustState(deps);
    case "get_config":
      return handleGetConfig(deps);
    case "get_plugins":
      return handleGetPlugins(deps);
    case "get_architecture":
      return handleGetArchitecture();
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}
