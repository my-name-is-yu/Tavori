// ─── CLI Dependency Setup ───
//
// buildDeps() wires all PulSeed dependencies for CLI subcommands.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getPulseedDirPath, getDatasourcesDir } from "../utils/paths.js";
import { readJsonFile } from "../utils/json-io.js";

import { StateManager } from "../state-manager.js";
import type { DataSourceConfig } from "../types/data-source.js";
import type { IDataSourceAdapter } from "../observation/data-source-adapter.js";
import { FileDataSourceAdapter, HttpApiDataSourceAdapter } from "../observation/data-source-adapter.js";
import { GitHubIssueDataSourceAdapter } from "../adapters/github-issue-datasource.js";
import { FileExistenceDataSourceAdapter } from "../adapters/file-existence-datasource.js";
import { ShellDataSourceAdapter } from "../adapters/shell-datasource.js";
import { createWorkspaceContextProvider } from "../observation/workspace-context.js";
import { buildLLMClient, buildAdapterRegistry } from "../llm/provider-factory.js";
import { TrustManager } from "../traits/trust-manager.js";
import { DriveSystem } from "../drive/drive-system.js";
import { ObservationEngine } from "../observation/observation-engine.js";
import { StallDetector } from "../drive/stall-detector.js";
import { ProgressPredictor } from "../drive/progress-predictor.js";
import { SatisficingJudge } from "../drive/satisficing-judge.js";
import { EthicsGate } from "../traits/ethics-gate.js";
import { SessionManager } from "../execution/session-manager.js";
import { StrategyManager } from "../strategy/strategy-manager.js";
import { GoalNegotiator } from "../goal/goal-negotiator.js";
import { TaskLifecycle } from "../execution/task-lifecycle.js";
import { ReportingEngine } from "../reporting-engine.js";
import { CoreLoop } from "../core-loop.js";
import { TreeLoopOrchestrator } from "../goal/tree-loop-orchestrator.js";
import { GoalTreeManager } from "../goal/goal-tree-manager.js";
import { StateAggregator } from "../goal/state-aggregator.js";
import { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import { GoalRefiner } from "../goal/goal-refiner.js";
import { MemoryLifecycleManager, DriveScoreAdapter } from "../knowledge/memory-lifecycle.js";
import { KnowledgeManager } from "../knowledge/knowledge-manager.js";
import { VectorIndex } from "../knowledge/vector-index.js";
import { OpenAIEmbeddingClient, MockEmbeddingClient } from "../knowledge/embedding-client.js";
import type { IEmbeddingClient } from "../knowledge/embedding-client.js";
import { CharacterConfigManager } from "../traits/character-config.js";
import * as GapCalculator from "../drive/gap-calculator.js";
import * as DriveScorer from "../drive/drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule, LoopConfig } from "../core-loop.js";
import type { Task } from "../types/task.js";
import type { ProgressEvent } from "../core-loop.js";
import { Logger } from "../runtime/logger.js";
import { HookManager } from "../runtime/hook-manager.js";
import { getCliLogger } from "./cli-logger.js";
import { formatOperationError } from "./utils.js";

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
        if (cfg.type === 'file') {
          dataSources.push(new FileDataSourceAdapter(cfg));
        } else if (cfg.type === 'http_api') {
          dataSources.push(new HttpApiDataSourceAdapter(cfg));
        } else if (cfg.type === 'github_issue' || cfg.type === 'custom' || cfg.type === 'database') {
          dataSources.push(new GitHubIssueDataSourceAdapter(cfg));
        } else if (cfg.type === 'file_existence') {
          dataSources.push(new FileExistenceDataSourceAdapter(cfg));
        } else if (cfg.type === 'shell') {
          const adapter = new ShellDataSourceAdapter(
            cfg.id,
            (cfg.connection.commands ?? {}) as Record<string, import("../adapters/shell-datasource.js").ShellCommandSpec>,
            cfg.connection?.path ?? process.cwd()
          );
          // Propagate scope_goal_id from datasource config for dimension matching
          if (cfg.scope_goal_id) {
            (adapter.config as Record<string, unknown>).scope_goal_id = cfg.scope_goal_id;
          }
          dataSources.push(adapter);
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
        let desc = goal.description;
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

  const observationEngine = new ObservationEngine(stateManager, dataSources, llmClient, contextProvider, {}, logger, undefined, hookManager);
  const progressPredictor = new ProgressPredictor();
  const stallDetector = new StallDetector(stateManager, characterConfig, progressPredictor);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const ethicsGate = new EthicsGate(stateManager, llmClient);

  // Stage 14 — tree mode dependencies
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient, undefined, logger);
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  const adapterRegistry = await buildAdapterRegistry(llmClient);

  const taskLifecycle = new TaskLifecycle(
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    { approvalFn, logger, hookManager }
  );

  const reportingEngine = new ReportingEngine(stateManager, undefined, characterConfig);

  const goalTreeManager = new GoalTreeManager(
    stateManager, llmClient, ethicsGate, goalDependencyGraph
  );
  const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const treeLoopOrchestrator = new TreeLoopOrchestrator(
    stateManager, goalTreeManager, stateAggregator, satisficingJudge
  );

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

  const gapCalculator: GapCalculatorModule = {
    calculateGapVector: GapCalculator.calculateGapVector,
    aggregateGaps: GapCalculator.aggregateGaps,
  };

  const driveScorer: DriveScorerModule = {
    scoreAllDimensions: (gapVector, context, _cfg) =>
      DriveScorer.scoreAllDimensions(gapVector, context),
    rankDimensions: DriveScorer.rankDimensions,
  };

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
  }, config);

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

  return { coreLoop, goalNegotiator, goalRefiner, reportingEngine, stateManager, driveSystem, llmClient };
}
