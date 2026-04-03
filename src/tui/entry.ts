#!/usr/bin/env node
// ─── TUI Entry Point ───
//
// Wires all PulSeed dependencies (mirrors CLIRunner.buildDeps pattern) and
// renders the Ink-based TUI. Use `pulseed tui` or `npm run tui` to launch.

import { render } from "ink";
import React from "react";
import os from "os";
import { execFileSync } from "child_process";

import { StateManager } from "../state/state-manager.js";
import { buildLLMClient, buildAdapterRegistry } from "../llm/provider-factory.js";
import { loadProviderConfig } from "../llm/provider-config.js";
import { createWorkspaceContextProvider } from "../observation/workspace-context.js";
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
import { TaskLifecycle } from "../execution/task/task-lifecycle.js";
import { ReportingEngine } from "../reporting/reporting-engine.js";
import { CoreLoop } from "../loop/core-loop.js";
import { GoalTreeManager } from "../goal/goal-tree-manager.js";
import { StateAggregator } from "../goal/state-aggregator.js";
import { GoalDependencyGraph } from "../goal/goal-dependency-graph.js";
import { TreeLoopOrchestrator } from "../goal/tree-loop-orchestrator.js";
import { MemoryLifecycleManager, DriveScoreAdapter } from "../knowledge/memory/memory-lifecycle.js";
import { CharacterConfigManager } from "../traits/character-config.js";
import { getPulseedDirPath } from "../utils/paths.js";
import * as GapCalculator from "../drive/gap-calculator.js";
import * as DriveScorer from "../drive/drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule } from "../loop/core-loop.js";

import { App, type ApprovalRequest } from "./app.js";
import { getCliLogger } from "../cli/cli-logger.js";
import { ensureProviderConfig } from "../cli/ensure-api-key.js";
import { ActionHandler } from "./actions.js";
import { IntentRecognizer } from "./intent-recognizer.js";
import type { Task } from "../types/task.js";

// ─── Dependency Wiring ───

async function buildDeps() {
  const stateManager = new StateManager();
  const characterConfigManager = new CharacterConfigManager(stateManager);
  const characterConfig = await characterConfigManager.load();
  const llmClient = await buildLLMClient();
  const trustManager = new TrustManager(stateManager);
  const driveSystem = new DriveSystem(stateManager);

  const contextProvider = createWorkspaceContextProvider(
    { workDir: process.cwd() },
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
        getCliLogger().error(`[pulseed] Failed to resolve goal description for "${goalId}": ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
    async (goalId: string) => {
      try {
        const goal = await stateManager.loadGoal(goalId);
        return goal?.constraints;
      } catch (err) {
        getCliLogger().error(`[pulseed] Failed to resolve goal constraints for "${goalId}": ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }
  );

  const observationEngine = new ObservationEngine(stateManager, [], llmClient, contextProvider);
  const progressPredictor = new ProgressPredictor();
  const stallDetector = new StallDetector(stateManager, characterConfig, progressPredictor);
  const satisficingJudge = new SatisficingJudge(stateManager);
  const ethicsGate = new EthicsGate(stateManager, llmClient);
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient, undefined, getCliLogger());
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  const adapterRegistry = await buildAdapterRegistry(llmClient);

  // TUI approval: routed through ApprovalOverlay in the Ink render loop.
  // requestApproval is set once the App component mounts and calls onApprovalReady.
  // pendingApprovals holds requests that arrive before the UI is ready; they are
  // drained in FIFO order the moment the handler is registered.
  let requestApproval: ((req: ApprovalRequest) => void) | null = null;
  const pendingApprovals: ApprovalRequest[] = [];

  const approvalFn = (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      if (requestApproval) {
        requestApproval({ task, resolve });
      } else {
        // UI not ready yet — queue and dispatch once the handler is registered
        pendingApprovals.push({ task, resolve });
      }
    });
  };

  const taskLifecycle = new TaskLifecycle(
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    { approvalFn }
  );

  const reportingEngine = new ReportingEngine(stateManager, undefined, characterConfig);

  const goalTreeManager = new GoalTreeManager(
    stateManager, llmClient, ethicsGate, goalDependencyGraph
  );
  const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const treeLoopOrchestrator = new TreeLoopOrchestrator(
    stateManager, goalTreeManager, stateAggregator, satisficingJudge
  );

  const pulseedBaseDir = getPulseedDirPath();
  let memoryLifecycleManager: MemoryLifecycleManager | undefined;
  let driveScoreAdapter: DriveScoreAdapter | undefined;
  try {
    driveScoreAdapter = new DriveScoreAdapter();
    memoryLifecycleManager = new MemoryLifecycleManager(
      pulseedBaseDir,
      llmClient,
      undefined,
      undefined,
      undefined,
      driveScoreAdapter
    );
    memoryLifecycleManager.initializeDirectories();
  } catch (err) {
    getCliLogger().warn(`[pulseed] MemoryLifecycleManager init failed — memory features disabled: ${err instanceof Error ? err.message : String(err)}`);
    memoryLifecycleManager = undefined;
    driveScoreAdapter = undefined;
  }

  // Wrap pure-function modules to satisfy GapCalculatorModule / DriveScorerModule
  const gapCalculator: GapCalculatorModule = {
    calculateGapVector: GapCalculator.calculateGapVector,
    aggregateGaps: GapCalculator.aggregateGaps,
  };

  const driveScorer: DriveScorerModule = {
    scoreAllDimensions: (gapVector, context, _config) =>
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
    contextProvider,
  });

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

  const setRequestApproval = (fn: (req: ApprovalRequest) => void) => {
    requestApproval = fn;
    // Drain any requests that arrived before the UI was ready
    while (pendingApprovals.length > 0) {
      const pending = pendingApprovals.shift()!;
      requestApproval(pending);
    }
  };

  return { stateManager, llmClient, trustManager, coreLoop, goalNegotiator, reportingEngine, setRequestApproval };
}

// ─── Breadcrumb helpers ───

function getCwd(): string {
  const raw = process.cwd();
  const home = os.homedir();
  return raw.startsWith(home) ? "~" + raw.slice(home.length) : raw;
}

function getGitBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// ─── TUI Entry ───

export async function startTUI(): Promise<void> {
  // 1. Check API key requirements
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 2. Wire all dependencies
  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getCliLogger().error(`Error: Failed to initialise dependencies: ${message}`);
    process.exit(1);
  }

  const { stateManager, llmClient, trustManager, coreLoop, goalNegotiator, reportingEngine, setRequestApproval } = deps;

  // 3. Create TUI-specific instances
  // Note: LoopController is no longer instantiated here — App uses the
  // useLoop() hook internally and creates the controller inside React.
  const actionHandler = new ActionHandler({
    stateManager,
    goalNegotiator,
    reportingEngine,
  });
  const intentRecognizer = new IntentRecognizer(llmClient);

  // 4. Handle SIGINT/SIGTERM gracefully before rendering.
  // Stop the core loop directly (same effect as LoopController.stop()).
  const shutdown = () => {
    coreLoop.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 5. Compute breadcrumb context for the header
  const providerConfig = await loadProviderConfig();
  const breadcrumb = {
    cwd: getCwd(),
    gitBranch: getGitBranch(),
    providerName: providerConfig.provider,
  };

  // 6. Render Ink app — loop deps passed directly; App calls useLoop() internally
  const { waitUntilExit } = render(
    React.createElement(App, {
      coreLoop,
      stateManager,
      trustManager,
      actionHandler,
      intentRecognizer,
      onApprovalReady: setRequestApproval,
      ...breadcrumb,
    })
  );

  await waitUntilExit();
}

// ─── CLI entry (when run directly as a binary) ───

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("entry.js") || process.argv[1].endsWith("entry.ts"));

if (isMain) {
  startTUI().catch((err) => {
    getCliLogger().error(String(err));
    process.exit(1);
  });
}
