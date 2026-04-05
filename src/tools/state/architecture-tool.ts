import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";

export const ArchitectureToolInputSchema = z.object({
  module: z.string().optional(),
});
export type ArchitectureToolInput = z.infer<typeof ArchitectureToolInputSchema>;

const LAYERS: Record<string, string> = {
  "Layer 0": "StateManager, AdapterLayer (no dependencies)",
  "Layer 1": "GapCalculator, DriveSystem, TrustManager",
  "Layer 2": "ObservationEngine, DriveScorer, SatisficingJudge, StallDetector",
  "Layer 3": "SessionManager, GoalNegotiator, StrategyManager",
  "Layer 4": "TaskLifecycle",
  "Layer 5": "CoreLoop, ReportingEngine",
  "Layer 6": "CLIRunner",
  "Layer 7": "TUI (Ink/React dashboard, approval UI, chat)",
  "Layer 8": "KnowledgeManager (cross-cutting)",
  "Layer 9": "PortfolioManager",
  "Layer 10": "DaemonRunner, PIDManager, Logger, EventServer, NotificationDispatcher, MemoryLifecycleManager",
  "Layer 11": "CuriosityEngine, CharacterConfigManager",
  "Layer 12": "EmbeddingClient, VectorIndex, KnowledgeGraph, GoalDependencyGraph",
  "Layer 13": "CapabilityDetector, DataSourceAdapter",
  "Layer 14": "GoalTreeManager, StateAggregator, TreeLoopOrchestrator, CrossGoalPortfolio, StrategyTemplateRegistry, LearningPipeline, KnowledgeTransfer",
  "Layer 15": "PluginLoader, NotifierRegistry, INotifier (plugin architecture)",
};

const MODULE_DESCRIPTIONS: Record<string, string> = {
  StateManager: "Persistent goal/session state (file-based JSON at ~/.pulseed/)",
  GapCalculator: "Computes gap score from current state vs. thresholds (5 types: min/max/range/present/match)",
  DriveSystem: "Converts gap into drive intensity; bottleneck aggregation strategy",
  TrustManager: "Asymmetric trust scoring [-100,+100]; delta_success=+3, delta_failure=-10",
  ObservationEngine: "LLM-powered state observation with 3-tier fallback",
  SatisficingJudge: "Decides 'good enough' to stop pursuing a goal",
  StallDetector: "Detects stall conditions (repetition, timeout, loop)",
  SessionManager: "Manages agent session lifecycle",
  TaskLifecycle: "Task selection, execution delegation, verification",
  CoreLoop: "Main orchestration loop: observe -> gap -> score -> task -> execute -> verify (NEVER STOP)",
  EthicsGate: "L1 mechanical safety checks before irreversible actions",
  KnowledgeManager: "Hierarchical memory with LLM page-in/out and semantic archival",
  PortfolioManager: "Orchestrates parallel strategies between DriveScorer and TaskLifecycle",
};

export class ArchitectureTool implements ITool<ArchitectureToolInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "get_architecture",
    aliases: ["architecture", "system_architecture"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["architecture", "self-knowledge"],
  };
  readonly inputSchema = ArchitectureToolInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return "Returns PulSeed system architecture: layer structure, module responsibilities, core loop, 4-element model, and execution boundary. Optionally filter by module name.";
  }

  async call(input: ArchitectureToolInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    if (input.module) {
      const desc = MODULE_DESCRIPTIONS[input.module];
      if (!desc) {
        return {
          success: false,
          data: null,
          summary: `Module not found: ${input.module}`,
          error: `Module not found: ${input.module}. Known modules: ${Object.keys(MODULE_DESCRIPTIONS).join(", ")}`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: { module: input.module, description: desc },
        summary: `${input.module}: ${desc}`,
        durationMs: Date.now() - startTime,
      };
    }

    const data = {
      core_concept: {
        model: "4-element: Goal (with thresholds) -> Current State (observation + confidence) -> Gap -> Constraints",
        core_loop: "observe -> gap -> score -> task -> execute -> verify (NEVER STOP)",
        execution_boundary: "PulSeed always delegates. Direct actions: LLM calls (thinking) + state read/write only.",
      },
      layers: LAYERS,
      modules: MODULE_DESCRIPTIONS,
    };

    return {
      success: true,
      data,
      summary: `PulSeed architecture: ${Object.keys(LAYERS).length} layers, ${Object.keys(MODULE_DESCRIPTIONS).length} modules`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
