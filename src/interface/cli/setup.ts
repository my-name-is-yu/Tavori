// ─── CLI Dependency Setup ───
//
// buildDeps() wires all PulSeed dependencies for CLI subcommands.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getPulseedDirPath, getDatasourcesDir } from "../../base/utils/paths.js";
import { readJsonFile } from "../../base/utils/json-io.js";

import { StateManager } from "../../base/state/state-manager.js";
import type { DataSourceConfig } from "../../base/types/data-source.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import { FileDataSourceAdapter, HttpApiDataSourceAdapter, PostgresDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import { GitHubIssueDataSourceAdapter } from "../../adapters/datasources/github-issue-datasource.js";
import { FileExistenceDataSourceAdapter } from "../../adapters/datasources/file-existence-datasource.js";
import { ShellDataSourceAdapter } from "../../adapters/datasources/shell-datasource.js";
import { createWorkspaceContextProvider } from "../../platform/observation/workspace-context.js";
import { buildLLMClient, buildAdapterRegistry } from "../../base/llm/provider-factory.js";
import { TrustManager } from "../../platform/traits/trust-manager.js";
import { CuriosityEngine } from "../../platform/traits/curiosity-engine.js";
import { DriveSystem } from "../../platform/drive/drive-system.js";
import { ObservationEngine } from "../../platform/observation/observation-engine.js";
import { DimensionPreChecker } from "../../platform/observation/dimension-pre-checker.js";
import { StallDetector } from "../../platform/drive/stall-detector.js";
import { ProgressPredictor } from "../../platform/drive/progress-predictor.js";
import { SatisficingJudge } from "../../platform/drive/satisficing-judge.js";
import { EthicsGate } from "../../platform/traits/ethics-gate.js";
import { SessionManager } from "../../orchestrator/execution/session-manager.js";
import { StrategyManager } from "../../orchestrator/strategy/strategy-manager.js";
import { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import { TaskLifecycle } from "../../orchestrator/execution/task/task-lifecycle.js";
import { ReportingEngine } from "../../reporting/reporting-engine.js";
import { CoreLoop } from "../../orchestrator/loop/core-loop.js";
import { ScheduleEngine } from "../../runtime/schedule/engine.js";
import { TreeLoopOrchestrator } from "../../orchestrator/goal/tree-loop-orchestrator.js";
import { GoalTreeManager } from "../../orchestrator/goal/goal-tree-manager.js";
import { StateAggregator } from "../../orchestrator/goal/state-aggregator.js";
import { GoalDependencyGraph } from "../../orchestrator/goal/goal-dependency-graph.js";
import { GoalRefiner } from "../../orchestrator/goal/goal-refiner.js";
import { MemoryLifecycleManager, DriveScoreAdapter } from "../../platform/knowledge/memory/memory-lifecycle.js";
import { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { VectorIndex } from "../../platform/knowledge/vector-index.js";
import { OpenAIEmbeddingClient, MockEmbeddingClient } from "../../platform/knowledge/embedding-client.js";
import type { IEmbeddingClient } from "../../platform/knowledge/embedding-client.js";
import { CharacterConfigManager } from "../../platform/traits/character-config.js";
import * as GapCalculator from "../../platform/drive/gap-calculator.js";
import * as DriveScorer from "../../platform/drive/drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule, LoopConfig } from "../../orchestrator/loop/core-loop.js";
import type { Task } from "../../base/types/task.js";
import type { ProgressEvent } from "../../orchestrator/loop/core-loop.js";
import { Logger } from "../../runtime/logger.js";
import { TimeHorizonEngine } from "../../platform/time/time-horizon-engine.js";
import { HookManager } from "../../runtime/hook-manager.js";
import { getCliLogger } from "./cli-logger.js";
import { formatOperationError } from "./utils.js";
import { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } from "../../tools/index.js";
import { isSafeBashCommand } from "../tui/bash-mode.js";

export function createCliDataSourceAdapter(cfg: DataSourceConfig): IDataSourceAdapter | null {
  if (cfg.type === "file") {
    return new FileDataSourceAdapter(cfg);
  }
  if (cfg.type === "http_api") {
    return new HttpApiDataSourceAdapter(cfg);
  }
  if (cfg.type === "database") {
    return new PostgresDataSourceAdapter(cfg);
  }
  if (cfg.type === "github_issue") {
    return new GitHubIssueDataSourceAdapter(cfg);
  }
  if (cfg.type === "file_existence") {
    return new FileExistenceDataSourceAdapter(cfg);
  }
  if (cfg.type === "shell") {
    const adapter = new ShellDataSourceAdapter(
      cfg.id,
      (cfg.connection.commands ?? {}) as Record<string, import("../../adapters/datasources/shell-datasource.js").ShellCommandSpec>,
      cfg.connection?.path ?? process.cwd()
    );
    if (cfg.scope_goal_id) {
      (adapter.config as Record<string, unknown>).scope_goal_id = cfg.scope_goal_id;
    }
    return adapter;
  }

  return null;
}

export async function buildDeps(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  config?: LoopConfig,
  approvalFn?: (task: Task) => Promise<boolean>,
  logger?: Logger,
  onProgress?: (event: ProgressEvent) => void,
  workspacePath?: string,
) {
  const characterConfig = await characterConfigManager.load();
  const llmClient = await buildLLMClient();
  const trustManager = new TrustManager(stateManager);
  const driveSystem = new DriveSystem(stateManager);
  const adapterRegistry = await buildAdapterRegistry(llmClient);
  const scheduleEngine = new ScheduleEngine({ baseDir: stateManager.getBaseDir() });
  await scheduleEngine.loadEntries();
  const toolRegistry = new ToolRegistry();
  const registerBuiltinTools = (deps?: Parameters<typeof createBuiltinTools>[0]) => {
    for (const tool of createBuiltinTools(deps)) {
      if (!toolRegistry.get(tool.metadata.name)) {
        toolRegistry.register(tool);
      }
    }
  };
  registerBuiltinTools({ stateManager, trustManager, registry: toolRegistry, scheduleEngine });
  const permissionManager = new ToolPermissionManager({
    trustManager,
    allowRules: [
      {
        toolName: "shell",
        inputMatcher: (input) =>
          typeof input === "object" &&
          input !== null &&
          typeof (input as Record<string, unknown>)["command"] === "string" &&
          isSafeBashCommand((input as Record<string, unknown>)["command"] as string),
        reason: "safe shell command",
      },
    ],
  });
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager,
    concurrency: new ConcurrencyController(),
  });

  // Read datasource configs from ~/.pulseed/datasources/
  const dsDir = getDatasourcesDir();
  const dataSources: IDataSourceAdapter[] = [];
  try {
    let dsExists = false;
    try { await fsp.access(dsDir); dsExists = true; } catch { /* not found */ }
    if (dsExists) {
      const files = (await fsp.readdir(dsDir)).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const cfg = await readJsonFile<DataSourceConfig>(path.join(dsDir, file));
        const adapter = createCliDataSourceAdapter(cfg);
        if (adapter) {
          dataSources.push(adapter);
        } else {
          getCliLogger().warn(`[pulseed] Unsupported built-in datasource type "${cfg.type}" in ${file}; skipping`);
        }
      }
    }
  } catch (err) {
    getCliLogger().error(formatOperationError(`load datasource configurations from "${dsDir}"`, err));
  }

  const contextProvider = createWorkspaceContextProvider(
    { workDir: workspacePath ?? process.cwd() },
    async (goalId: string) => {
      try {
        const goal = await stateManager.loadGoal(goalId);
        if (!goal) return undefined;
        let desc = goal.title + "\n" + goal.description;
        if (goal.parent_id) {
          const parent = await stateManager.loadGoal(goal.parent_id);
          if (parent?.description) {
            desc = `${desc}\n${parent.description}`;
          }
        }
        return desc;
      } catch (err) {
        getCliLogger().error(formatOperationError(`resolve workspace context goal description for "${goalId}"`, err));
        return undefined;
      }
    },
    async (goalId: string) => {
      try {
        const goal = await stateManager.loadGoal(goalId);
        return goal?.constraints;
      } catch (err) {
        getCliLogger().error(formatOperationError(`resolve workspace context goal constraints for "${goalId}"`, err));
        return undefined;
      }
    }
  );

  // HookManager — load lifecycle hooks from ~/.pulseed/hooks.json
  const hookManager = new HookManager(stateManager.getBaseDir(), logger);
  await hookManager.loadHooks();

  const observationPreChecker = new DimensionPreChecker({
    min_observation_interval_sec: 60,
    strategies: ["age", "git_diff"],
    toolExecutor,
  });
  const observationEngine = new ObservationEngine(
    stateManager,
    dataSources,
    llmClient,
    contextProvider,
    {},
    logger,
    observationPreChecker,
    hookManager,
    toolExecutor
  );
  const progressPredictor = new ProgressPredictor();
  const stallDetector = new StallDetector(stateManager, characterConfig, progressPredictor);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const ethicsGate = new EthicsGate(stateManager, llmClient);

  // Stage 14 — tree mode dependencies
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient, undefined, logger);
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  strategyManager.setToolExecutor?.(toolExecutor);

  const reportingEngine = new ReportingEngine(stateManager, undefined, characterConfig);

  const goalTreeManager = new GoalTreeManager(
    stateManager, llmClient, ethicsGate, goalDependencyGraph
  );
  const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  // MemoryLifecycleManager — wires 3-tier memory model into CoreLoop.
  const pulseedBaseDir = getPulseedDirPath();

  // --- Embedding + Vector infrastructure ---
  const embeddingClient: IEmbeddingClient = process.env["OPENAI_API_KEY"]
    ? new OpenAIEmbeddingClient(process.env["OPENAI_API_KEY"])
    : new MockEmbeddingClient();

  let vectorIndex: VectorIndex | undefined;
  try {
    const vectorDir = path.join(pulseedBaseDir, "memory");
    await fsp.mkdir(vectorDir, { recursive: true });
    const vectorIndexPath = path.join(vectorDir, "vector-index.json");
    vectorIndex = await VectorIndex.create(vectorIndexPath, embeddingClient);
  } catch (err) {
    // Non-fatal: semantic search disabled if vector index init fails
    console.warn(`[pulseed] VectorIndex init failed — semantic search disabled: ${err instanceof Error ? err.message : String(err)}`);
  }

  let memoryLifecycleManager: MemoryLifecycleManager | undefined;
  let driveScoreAdapter: DriveScoreAdapter | undefined;
  try {
    driveScoreAdapter = new DriveScoreAdapter();
    memoryLifecycleManager = new MemoryLifecycleManager(
      pulseedBaseDir,
      llmClient,
      undefined,
      embeddingClient,
      vectorIndex,
      driveScoreAdapter
    );
    memoryLifecycleManager.initializeDirectories();
  } catch (err) {
    getCliLogger().warn(`[pulseed] MemoryLifecycleManager init failed — memory features disabled: ${err instanceof Error ? err.message : String(err)}`);
    memoryLifecycleManager = undefined;
    driveScoreAdapter = undefined;
  }

  const knowledgeManager = new KnowledgeManager(
    stateManager,
    llmClient,
    vectorIndex,
    embeddingClient,
  );
  registerBuiltinTools({
    adapterRegistry,
    knowledgeManager,
    observationEngine,
    sessionManager,
  });

  const taskLifecycle = new TaskLifecycle({
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    options: {
      approvalFn,
      logger,
      hookManager,
      adapterRegistry,
      knowledgeManager,
      memoryLifecycle: memoryLifecycleManager,
      toolExecutor,
    },
  });

  const gapCalculator: GapCalculatorModule = {
    calculateGapVector: GapCalculator.calculateGapVector,
    aggregateGaps: GapCalculator.aggregateGaps,
  };

  const driveScorer: DriveScorerModule = {
    scoreAllDimensions: (gapVector, context, _cfg) =>
      DriveScorer.scoreAllDimensions(gapVector, context),
    rankDimensions: DriveScorer.rankDimensions,
  };

  const goalNegotiator = new GoalNegotiator(
    stateManager,
    llmClient,
    ethicsGate,
    observationEngine,
    characterConfig,
    satisficingJudge,
    goalTreeManager,
    adapterRegistry.getAdapterCapabilities()
  );

  const goalRefiner = new GoalRefiner(
    stateManager,
    llmClient,
    observationEngine,
    goalNegotiator,
    goalTreeManager,
    ethicsGate,
  );

  const treeLoopOrchestrator = new TreeLoopOrchestrator(
    stateManager, goalTreeManager, stateAggregator, satisficingJudge, goalRefiner
  );

  const coreLoop = new CoreLoop({
    stateManager,
    observationEngine,
    gapCalculator,
    driveScorer,
    taskLifecycle,
    satisficingJudge,
    stallDetector,
    strategyManager,
    reportingEngine,
    driveSystem,
    adapterRegistry,
    goalTreeManager,
    stateAggregator,
    treeLoopOrchestrator,
    goalDependencyGraph,
    memoryLifecycleManager,
    driveScoreAdapter,
    knowledgeManager,
    hookManager,
    logger,
    contextProvider,
    onProgress,
    goalRefiner,
    toolExecutor,
    toolRegistry,
  }, config);

  coreLoop.setTimeHorizonEngine(new TimeHorizonEngine());

  const curiosityEngine = new CuriosityEngine({
    stateManager,
    llmClient,
    ethicsGate,
    stallDetector,
    driveSystem,
    vectorIndex,
  });

  return {
    coreLoop,
    curiosityEngine,
    goalNegotiator,
    goalRefiner,
    reportingEngine,
    stateManager,
    driveSystem,
    llmClient,
    hookManager,
    memoryLifecycleManager,
    knowledgeManager,
    toolExecutor,
    toolRegistry,
  };
}
