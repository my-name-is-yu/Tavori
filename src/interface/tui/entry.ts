#!/usr/bin/env node
// ─── TUI Entry Point ───
//
// Reads daemon_mode from global config and routes to:
//   - Standalone mode (default): wires all deps in-process
//   - Daemon mode: connects to a running PulSeed daemon via SSE

import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { randomUUID } from "node:crypto";

import { StateManager } from "../../base/state/state-manager.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { App, type ApprovalRequest } from "./app.js";
import { isSafeBashCommand } from "./bash-mode.js";
import { getCliLogger } from "../cli/cli-logger.js";
import { ensureProviderConfig } from "../cli/ensure-api-key.js";
import type { Task } from "../../base/types/task.js";
import { isNoFlickerEnabled, createFrameWriter, AlternateScreen, type FrameWriter } from "./flicker/index.js";
import { isRenderableFrameChunk } from "./render-output.js";

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

// ─── Daemon auto-start helpers ───

async function startDaemonDetached(baseDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const scriptPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "cli",
    "cli-runner.js"
  );

  const child = spawn(process.execPath, [scriptPath, "daemon", "start", "--detach"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PULSEED_HOME: baseDir },
  });
  child.unref();
}

async function waitForDaemon(baseDir: string, timeoutMs: number): Promise<number> {
  const { isDaemonRunning } = await import("../../runtime/daemon-client.js");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { running, port } = await isDaemonRunning(baseDir);
    if (running) return port;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Daemon failed to start within timeout");
}

// ─── Standalone dep wiring ───

async function buildDeps() {
  const { buildLLMClient, buildAdapterRegistry } = await import("../../base/llm/provider-factory.js");
  const { createWorkspaceContextProvider } = await import("../../platform/observation/workspace-context.js");
  const { TrustManager } = await import("../../platform/traits/trust-manager.js");
  const { DriveSystem } = await import("../../platform/drive/drive-system.js");
  const { ObservationEngine } = await import("../../platform/observation/observation-engine.js");
  const { StallDetector } = await import("../../platform/drive/stall-detector.js");
  const { ProgressPredictor } = await import("../../platform/drive/progress-predictor.js");
  const { SatisficingJudge } = await import("../../platform/drive/satisficing-judge.js");
  const { EthicsGate } = await import("../../platform/traits/ethics-gate.js");
  const { SessionManager } = await import("../../orchestrator/execution/session-manager.js");
  const { StrategyManager } = await import("../../orchestrator/strategy/strategy-manager.js");
  const { GoalNegotiator } = await import("../../orchestrator/goal/goal-negotiator.js");
  const { TaskLifecycle } = await import("../../orchestrator/execution/task/task-lifecycle.js");
  const { ReportingEngine } = await import("../../reporting/reporting-engine.js");
  const { CoreLoop } = await import("../../orchestrator/loop/core-loop.js");
  const { GoalTreeManager } = await import("../../orchestrator/goal/goal-tree-manager.js");
  const { StateAggregator } = await import("../../orchestrator/goal/state-aggregator.js");
  const { GoalDependencyGraph } = await import("../../orchestrator/goal/goal-dependency-graph.js");
  const { TreeLoopOrchestrator } = await import("../../orchestrator/goal/tree-loop-orchestrator.js");
  const { ScheduleEngine } = await import("../../runtime/schedule-engine.js");
  const { MemoryLifecycleManager, DriveScoreAdapter } = await import("../../platform/knowledge/memory/memory-lifecycle.js");
  const { CharacterConfigManager } = await import("../../platform/traits/character-config.js");
  const { ChatRunner } = await import("../../interface/chat/chat-runner.js");
  const { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } = await import("../../tools/index.js");
  const { ActionHandler } = await import("./actions.js");
  const { IntentRecognizer } = await import("./intent-recognizer.js");
  const GapCalculator = await import("../../platform/drive/gap-calculator.js");
  const DriveScorer = await import("../../platform/drive/drive-scorer.js");

  const stateManager = new StateManager();
  const characterConfigManager = new CharacterConfigManager(stateManager);
  const characterConfig = await characterConfigManager.load();
  const llmClient = await buildLLMClient();
  const trustManager = new TrustManager(stateManager);
  const driveSystem = new DriveSystem(stateManager);
  const scheduleEngine = new ScheduleEngine({ baseDir: stateManager.getBaseDir() });
  await scheduleEngine.loadEntries();
  const toolRegistry = new ToolRegistry();
  for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry, scheduleEngine })) {
    toolRegistry.register(tool);
  }

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

  // TUI approval: routed through ApprovalOverlay in the Ink render loop.
  let requestApproval: ((req: ApprovalRequest) => void) | null = null;
  const pendingApprovals: ApprovalRequest[] = [];

  const enqueueApproval = (task: Task): Promise<boolean> => {
    return new Promise((resolve) => {
      const request = { task, resolve };
      if (requestApproval) {
        requestApproval(request);
      } else {
        pendingApprovals.push(request);
      }
    });
  };

  const approvalFn = (task: Task): Promise<boolean> => enqueueApproval(task);

  const chatToolApprovalFn = async (description: string): Promise<boolean> => {
    return enqueueApproval({
      id: randomUUID(),
      goal_id: "chat-tool-approval",
      strategy_id: null,
      target_dimensions: ["approval"],
      primary_dimension: "approval",
      work_description: description,
      rationale: "Requested by chat tool execution",
      approach: "Wait for explicit approval before continuing the chat tool call.",
      success_criteria: [],
      scope_boundary: {
        in_scope: ["Approve or reject the pending chat tool action."],
        out_of_scope: ["Execute any work beyond the requested chat tool action."],
        blast_radius: "Limited to whether the pending chat tool call proceeds.",
      },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "unknown",
      task_category: "normal",
      status: "pending",
      started_at: null,
      completed_at: null,
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    });
  };

  const taskLifecycle = new TaskLifecycle({
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    options: { approvalFn },
  });

  const reportingEngine = new ReportingEngine(stateManager, undefined, characterConfig);

  const goalTreeManager = new GoalTreeManager(
    stateManager, llmClient, ethicsGate, goalDependencyGraph
  );
  const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
  const treeLoopOrchestrator = new TreeLoopOrchestrator(
    stateManager, goalTreeManager, stateAggregator, satisficingJudge
  );

  const pulseedBaseDir = getPulseedDirPath();
  let memoryLifecycleManager: InstanceType<typeof MemoryLifecycleManager> | undefined;
  let driveScoreAdapter: InstanceType<typeof DriveScoreAdapter> | undefined;
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

  const gapCalculator = {
    calculateGapVector: GapCalculator.calculateGapVector,
    aggregateGaps: GapCalculator.aggregateGaps,
  };

  const driveScorer = {
    scoreAllDimensions: (gapVector: Parameters<typeof DriveScorer.scoreAllDimensions>[0], context: Parameters<typeof DriveScorer.scoreAllDimensions>[1], _config: unknown) =>
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
    while (pendingApprovals.length > 0) {
      const pending = pendingApprovals.shift()!;
      requestApproval(pending);
    }
  };

  let chatRunner: InstanceType<typeof ChatRunner> | undefined;
  try {
    const provConfig = await loadProviderConfig();
    const adapterType = provConfig.adapter ?? "claude_code_cli";
    const adapter = adapterRegistry.getAdapter(adapterType);
    chatRunner = new ChatRunner({
      stateManager,
      adapter,
      llmClient,
      trustManager,
      registry: toolRegistry,
      toolExecutor,
      approvalFn: chatToolApprovalFn,
    });
  } catch (err) {
    getCliLogger().warn(`[pulseed] ChatRunner init failed — free-form chat disabled: ${err instanceof Error ? err.message : String(err)}`);
  }

  const actionHandler = new ActionHandler({
    stateManager,
    goalNegotiator,
    reportingEngine,
  });
  const intentRecognizer = new IntentRecognizer(llmClient);

  return { stateManager, llmClient, trustManager, coreLoop, goalNegotiator, reportingEngine, setRequestApproval, chatRunner, actionHandler, intentRecognizer, toolExecutor };
}

// ─── Standalone mode ───

async function startTUIStandaloneMode(): Promise<void> {
  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getCliLogger().error(`Error: Failed to initialise dependencies: ${message}`);
    process.exit(1);
  }

  const { stateManager, llmClient, trustManager, coreLoop, actionHandler, intentRecognizer, setRequestApproval, chatRunner } = deps;

  process.on("SIGTERM", () => { coreLoop.stop(); process.exit(0); });

  const providerConfig = await loadProviderConfig();
  const breadcrumb = {
    cwd: getCwd(),
    gitBranch: getGitBranch(),
    providerName: providerConfig.provider,
  };

  const { render } = await import("ink");
  const React = await import("react");

  const noFlicker = await isNoFlickerEnabled();
  let frameWriter: FrameWriter | undefined;

  if (noFlicker) {
    frameWriter = createFrameWriter(process.stdout);
    process.stdout.on("resize", () => frameWriter?.requestErase());

    // Install stdout intercept BEFORE render() — chat.tsx patches on top
    const rawWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk: any, ...args: any[]) {
      if (typeof chunk === "string" && isRenderableFrameChunk(chunk)) {
        const [renderOptions] = args;
        const cursorEscape =
          renderOptions &&
          typeof renderOptions === "object" &&
          "cursorEscape" in renderOptions &&
          typeof (renderOptions as { cursorEscape?: unknown }).cursorEscape === "string"
            ? (renderOptions as { cursorEscape: string }).cursorEscape
            : undefined;
        frameWriter!.write(
          chunk,
          cursorEscape,
        );
        return true;
      }
      return (rawWrite as any)(chunk, ...args);
    } as typeof process.stdout.write;
  }

  const appElement = React.createElement(App, {
    coreLoop,
    stateManager,
    trustManager,
    actionHandler,
    intentRecognizer,
    chatRunner,
    onApprovalReady: setRequestApproval,
    noFlicker,
    ...breadcrumb,
  });

  const { waitUntilExit } = render(
    noFlicker
      ? React.createElement(AlternateScreen, { enabled: true }, appElement)
      : appElement,
    { exitOnCtrlC: false }
  );

  await waitUntilExit();
  frameWriter?.destroy();
}

// ─── Daemon mode ───

async function startTUIDaemonMode(): Promise<void> {
  const { DaemonClient, isDaemonRunning } = await import("../../runtime/daemon-client.js");
  const baseDir = process.env.PULSEED_HOME ?? getPulseedDirPath();

  let daemonClient: InstanceType<typeof DaemonClient>;

  try {
    const { running, port } = await isDaemonRunning(baseDir);

    if (running) {
      daemonClient = new DaemonClient({ host: "127.0.0.1", port });
    } else {
      await startDaemonDetached(baseDir);
      const readyPort = await waitForDaemon(baseDir, 10_000);
      daemonClient = new DaemonClient({ host: "127.0.0.1", port: readyPort });
    }

    daemonClient.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getCliLogger().error(`Error: Failed to connect to daemon: ${message}`);
    process.exit(1);
  }

  const stateManager = new StateManager(baseDir);
  await stateManager.init();
  const { TrustManager } = await import("../../platform/traits/trust-manager.js");
  const { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } = await import("../../tools/index.js");
  const trustManager = new TrustManager(stateManager);
  const toolRegistry = new ToolRegistry();
  for (const tool of createBuiltinTools({ stateManager, trustManager })) {
    toolRegistry.register(tool);
  }
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

  const providerConfig = await loadProviderConfig();
  const cwd = getCwd();
  const gitBranch = getGitBranch();
  const providerName = providerConfig.provider;

  process.on("SIGTERM", () => {
    daemonClient.disconnect();
    process.exit(0);
  });

  const { render } = await import("ink");
  const React = await import("react");

  const noFlicker = await isNoFlickerEnabled();
  let frameWriter: FrameWriter | undefined;

  if (noFlicker) {
    frameWriter = createFrameWriter(process.stdout);
    process.stdout.on("resize", () => frameWriter?.requestErase());

    const rawWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk: any, ...args: any[]) {
      if (typeof chunk === "string" && isRenderableFrameChunk(chunk)) {
        const [renderOptions] = args;
        const cursorEscape =
          renderOptions &&
          typeof renderOptions === "object" &&
          "cursorEscape" in renderOptions &&
          typeof (renderOptions as { cursorEscape?: unknown }).cursorEscape === "string"
            ? (renderOptions as { cursorEscape: string }).cursorEscape
            : undefined;
        frameWriter!.write(
          chunk,
          cursorEscape,
        );
        return true;
      }
      return (rawWrite as any)(chunk, ...args);
    } as typeof process.stdout.write;
  }

  const appElement = React.createElement(App, {
    daemonClient,
    stateManager,
    cwd,
    gitBranch,
    providerName,
    noFlicker,
  });

  const { waitUntilExit } = render(
    noFlicker
      ? React.createElement(AlternateScreen, { enabled: true }, appElement)
      : appElement,
    { exitOnCtrlC: false }
  );

  await waitUntilExit();
  frameWriter?.destroy();
}

// ─── Main entry ───

export async function startTUI(): Promise<void> {
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { loadGlobalConfig } = await import("../../base/config/global-config.js");
  const config = await loadGlobalConfig();

  if (config.daemon_mode) {
    await startTUIDaemonMode();
  } else {
    await startTUIStandaloneMode();
  }
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
