#!/usr/bin/env node
// ─── TUI Entry Point ───
//
// Reads daemon_mode from global config and routes to:
//   - Standalone mode (default): wires all deps in-process
//   - Daemon mode: connects to a running PulSeed daemon via SSE

import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import { StateManager } from "../../base/state/state-manager.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { App, type ApprovalRequest } from "./app.js";
import type { ChatRunner } from "../../interface/chat/chat-runner.js";
import { isSafeBashCommand } from "./bash-mode.js";
import { getCliLogger } from "../cli/cli-logger.js";
import { ensureProviderConfig } from "../cli/ensure-api-key.js";
import type { Task } from "../../base/types/task.js";
import { isNoFlickerEnabled, AlternateScreen, MouseTracking } from "./flicker/index.js";
import { DEFAULT_CURSOR_STYLE, HIDE_CURSOR, SHOW_CURSOR, STEADY_BAR_CURSOR } from "./flicker/dec.js";
import { setTrustedTuiControlStream } from "./terminal-output.js";
import { getGitBranch } from "./git-branch.js";
import { createNoFlickerOutputController } from "./output-controller.js";
import { PIDManager } from "../../runtime/pid-manager.js";
import { probeDaemonHealth, readDaemonAuthToken } from "../../runtime/daemon/client.js";
import { DEFAULT_PORT } from "../../runtime/port-utils.js";

// ─── Breadcrumb helpers ───

const EXISTING_DAEMON_HEALTH_TIMEOUT_MS = 10_000;
const EXISTING_DAEMON_HEALTH_POLL_MS = 250;

function getCwd(): string {
  const raw = process.cwd();
  const home = os.homedir();
  return raw.startsWith(home) ? "~" + raw.slice(home.length) : raw;
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

async function readDaemonPort(baseDir: string): Promise<number> {
  try {
    const configPath = path.join(baseDir, "daemon.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const port = parsed.event_server_port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

export async function resolveRunningDaemonConnection(
  baseDir: string
): Promise<{ port: number; authToken?: string | null } | null> {
  const pidManager = new PIDManager(baseDir);
  const status = await pidManager.inspect();
  if (status.running) {
    const port = await readDaemonPort(baseDir);
    const authToken = readDaemonAuthToken(baseDir, port);
    const deadline = Date.now() + EXISTING_DAEMON_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const probe = await probeDaemonHealth({ host: "127.0.0.1", port });
      if (probe.ok) {
        return { port, authToken };
      }
      const refreshed = await pidManager.inspect();
      if (!refreshed.running) break;
      await new Promise((resolve) => setTimeout(resolve, EXISTING_DAEMON_HEALTH_POLL_MS));
    }
  }

  const { isDaemonRunning } = await import("../../runtime/daemon/client.js");
  const running = await isDaemonRunning(baseDir);
  if (!running.running) return null;
  return {
    port: running.port,
    authToken: running.authToken ?? readDaemonAuthToken(baseDir, running.port),
  };
}

async function waitForDaemon(baseDir: string, timeoutMs: number): Promise<{ port: number; authToken?: string | null }> {
  const { isDaemonRunning } = await import("../../runtime/daemon/client.js");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { running, port, authToken } = await isDaemonRunning(baseDir);
    if (running) return { port, authToken };
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
  const { ScheduleEngine } = await import("../../runtime/schedule/engine.js");
  const { MemoryLifecycleManager, DriveScoreAdapter } = await import("../../platform/knowledge/memory/memory-lifecycle.js");
  const { KnowledgeManager } = await import("../../platform/knowledge/knowledge-manager.js");
  const { CharacterConfigManager } = await import("../../platform/traits/character-config.js");
  const { ChatRunner } = await import("../../interface/chat/chat-runner.js");
  const { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } = await import("../../tools/index.js");
  const { buildCliDataSourceRegistry } = await import("../cli/data-source-bootstrap.js");
  const {
    createNativeChatAgentLoopRunner,
    createNativeTaskAgentLoopRunner,
    shouldUseNativeTaskAgentLoop,
  } = await import("../../orchestrator/execution/agent-loop/index.js");
  const { ActionHandler } = await import("./actions.js");
  const { IntentRecognizer } = await import("./intent-recognizer.js");
  const GapCalculator = await import("../../platform/drive/gap-calculator.js");
  const DriveScorer = await import("../../platform/drive/drive-scorer.js");

  const stateManager = new StateManager();
  const characterConfigManager = new CharacterConfigManager(stateManager);
  const characterConfig = await characterConfigManager.load();
  const llmClient = await buildLLMClient();
  const providerConfig = await loadProviderConfig();
  const trustManager = new TrustManager(stateManager);
  const driveSystem = new DriveSystem(stateManager);
  const dataSourceRegistry = await buildCliDataSourceRegistry(process.cwd(), getCliLogger());
  const toolRegistry = new ToolRegistry();
  const registerToolIfMissing = (tool: ReturnType<typeof createBuiltinTools>[number]) => {
    if (!toolRegistry.get(tool.metadata.name)) {
      toolRegistry.register(tool);
    }
  };
  for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry })) {
    registerToolIfMissing(tool);
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

  const observationEngine = new ObservationEngine(stateManager, dataSourceRegistry.getAllSources(), llmClient, contextProvider);
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
  const knowledgeManager = new KnowledgeManager(stateManager, llmClient);

  const soilPrefetch = memoryLifecycleManager
    ? async (query: { query: string; rootDir: string; limit: number }) => {
        const lessons = await memoryLifecycleManager!.searchCrossGoalLessons(query.query, query.limit);
        if (lessons.length === 0) return null;
        return {
          content: [
            "Soil cross-goal lessons:",
            ...lessons.map((lesson, index) => `${index + 1}. ${lesson.lesson}`),
          ].join("\n"),
          soilIds: lessons.map((lesson) => lesson.lesson_id),
          retrievalSource: "manifest" as const,
        };
      }
    : undefined;
  const agentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeTaskAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: process.cwd(),
          traceBaseDir: stateManager.getBaseDir(),
          soilPrefetch,
          defaultWorktreePolicy: providerConfig.agent_loop?.worktree
            ? {
                enabled: providerConfig.agent_loop.worktree.enabled,
                baseDir: providerConfig.agent_loop.worktree.base_dir,
                keepForDebug: providerConfig.agent_loop.worktree.keep_for_debug,
                cleanupPolicy: providerConfig.agent_loop.worktree.cleanup_policy,
              }
            : undefined,
        })
    : undefined;

  const taskLifecycle = new TaskLifecycle({
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    options: {
      approvalFn,
      toolExecutor,
      agentLoopRunner,
      revertCwd: process.cwd(),
      healthCheckCwd: process.cwd(),
    },
  });

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

  const scheduleEngine = new ScheduleEngine({
    baseDir: stateManager.getBaseDir(),
    dataSourceRegistry,
    llmClient,
    coreLoop,
    stateManager,
    reportingEngine,
    memoryLifecycle: memoryLifecycleManager,
    knowledgeManager,
  });
  await scheduleEngine.loadEntries();
  for (const tool of createBuiltinTools({
    stateManager,
    trustManager,
    registry: toolRegistry,
    scheduleEngine,
    adapterRegistry,
    sessionManager,
    observationEngine,
    knowledgeManager,
  })) {
    registerToolIfMissing(tool);
  }

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
    const adapterType = providerConfig.adapter ?? "claude_code_cli";
    const adapter = adapterRegistry.getAdapter(adapterType);
    const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
      ? createNativeChatAgentLoopRunner({
          llmClient,
          providerConfig,
          toolRegistry,
          toolExecutor,
          cwd: process.cwd(),
          traceBaseDir: stateManager.getBaseDir(),
        })
      : undefined;
    chatRunner = new ChatRunner({
      stateManager,
      adapter,
      llmClient,
      trustManager,
      registry: toolRegistry,
      toolExecutor,
      chatAgentLoopRunner,
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
  const noFlicker = await isNoFlickerEnabled();
  const outputController = noFlicker ? createNoFlickerOutputController() : null;
  outputController?.install();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (noFlicker) {
      outputController?.writeTerminal(DEFAULT_CURSOR_STYLE + SHOW_CURSOR);
    }
    outputController?.destroy();
    setTrustedTuiControlStream(null);
  };

  try {
    let deps: Awaited<ReturnType<typeof buildDeps>>;
    try {
      deps = await buildDeps();
    } catch (err) {
      cleanup();
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
    const terminalStream = outputController?.terminalStream ?? process.stdout;
    setTrustedTuiControlStream(terminalStream);
    if (noFlicker) {
      outputController?.writeTerminal(STEADY_BAR_CURSOR + HIDE_CURSOR);
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
      controlStream: terminalStream,
      ...breadcrumb,
    });

    const { waitUntilExit } = render(
      React.createElement(
        AlternateScreen,
        { enabled: noFlicker, stream: terminalStream },
        React.createElement(
          MouseTracking,
          { stream: terminalStream },
          appElement,
        ),
      ),
      {
        exitOnCtrlC: false,
        incrementalRendering: noFlicker,
        maxFps: noFlicker ? 60 : 30,
        patchConsole: false,
        stdout: outputController?.renderStdout ?? process.stdout,
        stderr: outputController?.renderStderr ?? process.stderr,
      }
    );
    await waitUntilExit();
  } finally {
    cleanup();
  }
}

// ─── Daemon mode ───

async function startTUIDaemonMode(): Promise<void> {
  const { DaemonClient } = await import("../../runtime/daemon/client.js");
  const baseDir = process.env.PULSEED_HOME ?? getPulseedDirPath();
  const noFlicker = await isNoFlickerEnabled();
  const outputController = noFlicker ? createNoFlickerOutputController() : null;
  outputController?.install();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (noFlicker) {
      outputController?.writeTerminal(DEFAULT_CURSOR_STYLE + SHOW_CURSOR);
    }
    outputController?.destroy();
    setTrustedTuiControlStream(null);
  };

  try {
    let daemonClient: InstanceType<typeof DaemonClient>;

    try {
      const existingConnection = await resolveRunningDaemonConnection(baseDir);

      if (existingConnection) {
        daemonClient = new DaemonClient({ host: "127.0.0.1", ...existingConnection, baseDir });
      } else {
        await startDaemonDetached(baseDir);
        const ready = await waitForDaemon(baseDir, 10_000);
        daemonClient = new DaemonClient({ host: "127.0.0.1", port: ready.port, authToken: ready.authToken, baseDir });
      }

      daemonClient.connect();
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      getCliLogger().error(`Error: Failed to connect to daemon: ${message}`);
      process.exit(1);
    }

    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    let chatRunner: ChatRunner | undefined;
    const { TrustManager } = await import("../../platform/traits/trust-manager.js");
    const { ScheduleEngine } = await import("../../runtime/schedule/engine.js");
    const { buildCliDataSourceRegistry } = await import("../cli/data-source-bootstrap.js");
    const { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController, createBuiltinTools } = await import("../../tools/index.js");
    const trustManager = new TrustManager(stateManager);
    const toolRegistry = new ToolRegistry();
    const dataSourceRegistry = await buildCliDataSourceRegistry(process.cwd(), getCliLogger());
    const scheduleEngine = new ScheduleEngine({ baseDir, dataSourceRegistry });
    await scheduleEngine.loadEntries();
    for (const tool of createBuiltinTools({ stateManager, trustManager, registry: toolRegistry, scheduleEngine })) {
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

    try {
      const { ChatRunner } = await import("../../interface/chat/chat-runner.js");
      const { buildLLMClient, buildAdapterRegistry } = await import("../../base/llm/provider-factory.js");
      const { createNativeChatAgentLoopRunner, shouldUseNativeTaskAgentLoop } = await import("../../orchestrator/execution/agent-loop/index.js");
      const llmClient = await buildLLMClient();
      const adapterRegistry = await buildAdapterRegistry(llmClient);
      const adapterType = providerConfig.adapter ?? "claude_code_cli";
      const adapter = adapterRegistry.getAdapter(adapterType);
      const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
        ? createNativeChatAgentLoopRunner({
            llmClient,
            providerConfig,
            toolRegistry,
            toolExecutor,
            cwd: process.cwd(),
            traceBaseDir: stateManager.getBaseDir(),
          })
        : undefined;
      chatRunner = new ChatRunner({
        stateManager,
        adapter,
        llmClient,
        trustManager,
        registry: toolRegistry,
        toolExecutor,
        chatAgentLoopRunner,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getCliLogger().warn(`[pulseed] Daemon-mode ChatRunner init failed — free-form chat disabled: ${message}`);
      chatRunner = undefined;
    }

    process.on("SIGTERM", () => {
      daemonClient.disconnect();
      process.exit(0);
    });

    const { render } = await import("ink");
    const React = await import("react");
    const terminalStream = outputController?.terminalStream ?? process.stdout;
    setTrustedTuiControlStream(terminalStream);
    if (noFlicker) {
      outputController?.writeTerminal(STEADY_BAR_CURSOR + HIDE_CURSOR);
    }

    const appElement = React.createElement(App, {
      daemonClient,
      stateManager,
      cwd,
      gitBranch,
      providerName,
      noFlicker,
      chatRunner,
      controlStream: terminalStream,
    });

    const { waitUntilExit } = render(
      React.createElement(
        AlternateScreen,
        { enabled: noFlicker, stream: terminalStream },
        React.createElement(
          MouseTracking,
          { stream: terminalStream },
          appElement,
        ),
      ),
      {
        exitOnCtrlC: false,
        incrementalRendering: noFlicker,
        maxFps: noFlicker ? 60 : 30,
        patchConsole: false,
        stdout: outputController?.renderStdout ?? process.stdout,
        stderr: outputController?.renderStderr ?? process.stderr,
      }
    );
    await waitUntilExit();
  } finally {
    cleanup();
  }
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
