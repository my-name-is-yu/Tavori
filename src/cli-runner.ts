#!/usr/bin/env node
// ─── CLIRunner ───
//
// Motiva CLI entry point. Wires all dependencies and exposes subcommands:
//   motiva run --goal <id>            Run CoreLoop once for a given goal
//   motiva goal add "<description>"   Negotiate and register a new goal (interactive)
//   motiva goal list                  List all registered goals
//   motiva goal archive <id>          Archive a completed goal
//   motiva goal show <id>             Show goal details
//   motiva goal reset <id>            Reset goal state for re-running
//   motiva status --goal <id>         Show current progress report
//   motiva report --goal <id>         Show latest report
//   motiva log --goal <id>            View execution/observation log
//   motiva start --goal <id>          Start daemon mode for one or more goals
//   motiva stop                       Stop the running daemon
//   motiva cron --goal <id>           Print crontab entry for a goal
//   motiva cleanup                    Archive all completed goals and remove stale data

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";

import { StateManager } from "./state-manager.js";
import type { IDataSourceAdapter } from "./data-source-adapter.js";
import { FileDataSourceAdapter, HttpApiDataSourceAdapter } from "./data-source-adapter.js";
import { GitHubIssueDataSourceAdapter } from "./adapters/github-issue-datasource.js";
import { FileExistenceDataSourceAdapter } from "./adapters/file-existence-datasource.js";
import { createWorkspaceContextProvider } from "./context-providers/workspace-context.js";
import type { ILLMClient } from "./llm-client.js";
import { buildLLMClient, buildAdapterRegistry } from "./provider-factory.js";
import { loadProviderConfig, saveProviderConfig } from "./provider-config.js";
import type { ProviderConfig } from "./provider-config.js";
import { TrustManager } from "./trust-manager.js";
import { DriveSystem } from "./drive-system.js";
import { ObservationEngine } from "./observation-engine.js";
import { StallDetector } from "./stall-detector.js";
import { SatisficingJudge } from "./satisficing-judge.js";
import { EthicsGate } from "./ethics-gate.js";
import { SessionManager } from "./session-manager.js";
import { StrategyManager } from "./strategy-manager.js";
import { GoalNegotiator, EthicsRejectedError } from "./goal-negotiator.js";
import { TaskLifecycle } from "./task-lifecycle.js";
import { ReportingEngine } from "./reporting-engine.js";
import { CoreLoop } from "./core-loop.js";
import { TreeLoopOrchestrator } from "./tree-loop-orchestrator.js";
import { GoalTreeManager } from "./goal-tree-manager.js";
import { StateAggregator } from "./state-aggregator.js";
import { GoalDependencyGraph } from "./goal-dependency-graph.js";
import { MemoryLifecycleManager } from "./memory-lifecycle.js";
import { DaemonRunner } from "./daemon-runner.js";
import { PIDManager } from "./pid-manager.js";
import { Logger } from "./logger.js";
import { CharacterConfigManager } from "./character-config.js";
import * as GapCalculator from "./gap-calculator.js";
import * as DriveScorer from "./drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule, LoopConfig } from "./core-loop.js";
import type { Task } from "./types/task.js";
import type { ProgressEvent } from "./core-loop.js";

// ─── CLIRunner ───

/**
 * @description Coordinates CLI argument parsing, dependency wiring, and subcommand execution for the Motiva command-line interface.
 */
export class CLIRunner {
  private readonly stateManager: StateManager;
  private readonly characterConfigManager: CharacterConfigManager;
  private activeCoreLoop: CoreLoop | null = null;

  /**
   * @description Creates a CLI runner with state and character configuration managers rooted at the optional base directory.
   * @param {string} [baseDir] Optional base directory for Motiva state storage.
   * @returns {void} Does not return a value.
   */
  constructor(baseDir?: string) {
    this.stateManager = new StateManager(baseDir);
    this.characterConfigManager = new CharacterConfigManager(this.stateManager);
  }

  /**
   * @description Stops the active core loop if one is currently running. Safe to call before `run()` or when no loop is active.
   * @returns {void} Does not return a value.
   */
  stop(): void {
    if (this.activeCoreLoop) {
      this.activeCoreLoop.stop();
    }
  }

  // ─── Dependency Wiring ───

  private getApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  }

  private buildApprovalFn(rl: readline.Interface): (task: Task) => Promise<boolean> {
    return (task: Task): Promise<boolean> => {
      return new Promise((resolve) => {
        rl.pause();
        process.stdout.write("\n--- Approval Required ---\n");
        process.stdout.write(`Task: ${task.work_description}\n`);
        process.stdout.write(`Rationale: ${task.rationale}\n`);
        process.stdout.write(`Reversibility: ${task.reversibility}\n`);
        rl.resume();
        rl.question("Approve this task? [y/N] ", (answer) => {
          process.stdout.write("\n");
          resolve(answer.trim().toLowerCase() === "y");
        });
      });
    };
  }

  private buildDeps(_apiKey: string | undefined, config?: LoopConfig, approvalFn?: (task: Task) => Promise<boolean>, logger?: Logger, onProgress?: (event: ProgressEvent) => void) {
    const stateManager = this.stateManager;
    const characterConfig = this.characterConfigManager.load();
    const llmClient = buildLLMClient();
    const trustManager = new TrustManager(stateManager);
    const driveSystem = new DriveSystem(stateManager);

    // Read datasource configs from ~/.motiva/datasources/
    const dsDir = path.join(os.homedir(), '.motiva', 'datasources');
    const dataSources: IDataSourceAdapter[] = [];
    try {
      if (fs.existsSync(dsDir)) {
        const files = fs.readdirSync(dsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const config = JSON.parse(fs.readFileSync(path.join(dsDir, file), 'utf-8'));
          if (config.type === 'file') {
            dataSources.push(new FileDataSourceAdapter(config));
          } else if (config.type === 'http_api') {
            dataSources.push(new HttpApiDataSourceAdapter(config));
          } else if (config.type === 'github_issue' || config.type === 'custom' || config.type === 'database') {
            dataSources.push(new GitHubIssueDataSourceAdapter(config));
          } else if (config.type === 'file_existence') {
            dataSources.push(new FileExistenceDataSourceAdapter(config));
          }
        }
      }
    } catch (err) {
      console.error(formatOperationError(`load datasource configurations from "${dsDir}"`, err));
    }

    const contextProvider = createWorkspaceContextProvider(
      { workDir: process.cwd() },
      (goalId: string) => {
        try {
          const goal = stateManager.loadGoal(goalId);
          return goal?.description;
        } catch (err) {
          console.error(formatOperationError(`resolve workspace context goal description for "${goalId}"`, err));
          return undefined;
        }
      }
    );

    const observationEngine = new ObservationEngine(stateManager, dataSources, llmClient, contextProvider);
    const stallDetector = new StallDetector(stateManager, characterConfig);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const ethicsGate = new EthicsGate(stateManager, llmClient);

    // Stage 14 — tree mode dependencies (created early so SessionManager can reference goalDependencyGraph)
    const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);

    // C. Pass goalDependencyGraph to SessionManager so it can resolve cross-goal context
    const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const adapterRegistry = buildAdapterRegistry(llmClient);

    const taskLifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { approvalFn, logger }
    );

    const reportingEngine = new ReportingEngine(stateManager, undefined, characterConfig);

    const goalTreeManager = new GoalTreeManager(
      stateManager, llmClient, ethicsGate, goalDependencyGraph
    );
    const stateAggregator = new StateAggregator(stateManager, satisficingJudge);
    const treeLoopOrchestrator = new TreeLoopOrchestrator(
      stateManager, goalTreeManager, stateAggregator, satisficingJudge
    );

    // A. MemoryLifecycleManager — wires 3-tier memory model into CoreLoop.
    // VectorIndex/EmbeddingClient are skipped for MVP (require external embedding service).
    const motivaBaseDir = path.join(os.homedir(), ".motiva");
    let memoryLifecycleManager: MemoryLifecycleManager | undefined;
    try {
      memoryLifecycleManager = new MemoryLifecycleManager(
        motivaBaseDir,
        llmClient,
        undefined  // use default RetentionConfig
        // embeddingClient and vectorIndex omitted — MVP uses LLM-only compression
      );
      memoryLifecycleManager.initializeDirectories();
    } catch (err) {
      console.warn(`[motiva] MemoryLifecycleManager init failed — memory features disabled: ${err instanceof Error ? err.message : String(err)}`);
      memoryLifecycleManager = undefined;
    }

    // Wrap pure-function modules to satisfy the CoreLoopDeps interface
    const gapCalculator: GapCalculatorModule = {
      calculateGapVector: GapCalculator.calculateGapVector,
      aggregateGaps: GapCalculator.aggregateGaps,
    };

    const driveScorer: DriveScorerModule = {
      scoreAllDimensions: (gapVector, context, _config) =>
        DriveScorer.scoreAllDimensions(gapVector, context),
      rankDimensions: DriveScorer.rankDimensions,
    };

    // D. Pass memoryLifecycleManager and goalDependencyGraph to CoreLoop
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

    return { coreLoop, goalNegotiator, reportingEngine, stateManager, driveSystem };
  }

  // ─── Subcommands ───

  private async cmdRun(
    goalId: string,
    loopConfig?: LoopConfig,
    autoApprove?: boolean,
    verbose?: boolean
  ): Promise<number> {
    const apiKey = this.getApiKey();
    const providerConfig = loadProviderConfig();
    const provider = providerConfig.llm_provider;
    if (!apiKey && provider !== "ollama" && provider !== "openai" && provider !== "codex") {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
          "Set it with: export ANTHROPIC_API_KEY=<your-key>\n" +
          "Or use OpenAI: export MOTIVA_LLM_PROVIDER=openai\n" +
          "Or use Ollama: export MOTIVA_LLM_PROVIDER=ollama\n" +
          "Or use Codex: export MOTIVA_LLM_PROVIDER=codex"
      );
      return 1;
    }

    // Create a single readline interface for the entire loop run.
    // It is reused across all approval prompts and closed when the loop ends.
    const rl = autoApprove
      ? null
      : readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

    const approvalFn = autoApprove
      ? async (task: Task) => {
          console.log(`\n--- Auto-approved (--yes) ---`);
          console.log(`Task: ${task.work_description.split("\n")[0]}`);
          return true;
        }
      : this.buildApprovalFn(rl!);

    const logger = new Logger({
      dir: path.join(os.homedir(), ".motiva", "logs"),
      level: "debug",
      consoleOutput: false,
    });

    // Build progress callback for iteration output
    const maxIterations = loopConfig?.maxIterations ?? 100;
    let lastIterationLogged = -1;
    const onProgress = (event: ProgressEvent): void => {
      const prefix = `[${event.iteration}/${event.maxIterations}]`;
      if (event.phase === "Observing...") {
        if (event.iteration !== lastIterationLogged) {
          lastIterationLogged = event.iteration;
          const gapStr = event.gap !== undefined ? ` gap=${event.gap.toFixed(2)}` : "";
          process.stdout.write(`${prefix} Observing...${gapStr}\n`);
        }
      } else if (event.phase === "Generating task...") {
        const gapStr = event.gap !== undefined ? ` gap=${event.gap.toFixed(2)}` : "";
        process.stdout.write(`${prefix} Generating task...${gapStr}\n`);
      } else if (event.phase === "Executing task...") {
        if (event.taskDescription) {
          process.stdout.write(`${prefix} Executing task: "${event.taskDescription}"\n`);
        } else {
          process.stdout.write(`${prefix} Executing task...\n`);
        }
      } else if (event.phase === "Verifying result...") {
        if (event.taskDescription) {
          process.stdout.write(`${prefix} Verifying: "${event.taskDescription}"\n`);
        } else {
          process.stdout.write(`${prefix} Verifying result...\n`);
        }
      }
    };
    void maxIterations; // suppress unused warning

    let deps: ReturnType<typeof this.buildDeps>;
    try {
      deps = this.buildDeps(apiKey, loopConfig, approvalFn, logger, onProgress);
    } catch (err) {
      rl?.close();
      console.error(formatOperationError("initialise dependencies", err));
      if (verbose || process.env.DEBUG) {
        console.error(err instanceof Error ? err.stack : String(err));
      }
      return 1;
    }

    const { coreLoop } = deps;

    // Validate goal exists before starting
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      rl?.close();
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    console.log(`Running Motiva loop for goal: ${goalId}`);
    console.log(`Goal: ${goal.title}`);
    if (loopConfig?.treeMode) {
      console.log("Tree mode enabled — iterating across all tree nodes");
    }
    console.log("Press Ctrl+C to stop.\n");

    // Graceful shutdown on OS signals
    const shutdown = () => {
      console.log("\nStopping loop...");
      coreLoop.stop();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    // Register the active loop so stop() can reach it (after signal handlers)
    this.activeCoreLoop = coreLoop;

    let result: Awaited<ReturnType<CoreLoop["run"]>>;
    try {
      result = await coreLoop.run(goalId);
    } catch (err) {
      console.error(formatOperationError(`run core loop for goal "${goalId}"`, err));
      console.error(`Hint: Check ~/.motiva/logs/ for details or re-run with DEBUG=1 for stack traces.`);
      if (verbose || process.env.DEBUG) {
        console.error(err instanceof Error ? err.stack : String(err));
      }
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      this.activeCoreLoop = null;
      rl?.close();
      return 1;
    }

    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    this.activeCoreLoop = null;
    rl?.close();

    console.log(`\n--- Loop Result ---`);
    console.log(`Goal ID:          ${result.goalId}`);
    console.log(`Final status:     ${result.finalStatus}`);
    console.log(`Total iterations: ${result.totalIterations}`);
    console.log(`Started at:       ${result.startedAt}`);
    console.log(`Completed at:     ${result.completedAt}`);

    switch (result.finalStatus) {
      case "completed":
        return 0;
      case "stalled":
        console.error("Goal stalled — escalation level reached maximum.");
        return 2;
      case "error":
        console.error("Loop ended with error.");
        return 1;
      default:
        return 0;
    }
  }

  private async cmdGoalAdd(
    description: string,
    opts: { deadline?: string; constraints?: string[]; yes?: boolean }
  ): Promise<number> {
    const apiKey = this.getApiKey();
    const providerConfig2 = loadProviderConfig();
    const provider2 = providerConfig2.llm_provider;
    if (!apiKey && provider2 !== "ollama" && provider2 !== "openai" && provider2 !== "codex") {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
          "Set it with: export ANTHROPIC_API_KEY=<your-key>\n" +
          "Or use OpenAI: export MOTIVA_LLM_PROVIDER=openai\n" +
          "Or use Ollama: export MOTIVA_LLM_PROVIDER=ollama\n" +
          "Or use Codex: export MOTIVA_LLM_PROVIDER=codex"
      );
      return 1;
    }

    let deps: ReturnType<typeof this.buildDeps>;
    try {
      deps = this.buildDeps(apiKey);
    } catch (err) {
      console.error(formatOperationError("initialise goal negotiation dependencies", err));
      return 1;
    }

    const { goalNegotiator } = deps;

    console.log(`Negotiating goal: "${description}"`);
    if (opts.deadline) {
      console.log(`Deadline: ${opts.deadline}`);
    }
    if (opts.constraints && opts.constraints.length > 0) {
      console.log(`Constraints: ${opts.constraints.join(", ")}`);
    }
    console.log("This may take a moment...\n");

    try {
      const { goal, response } = await goalNegotiator.negotiate(description, {
        deadline: opts.deadline,
        constraints: opts.constraints,
      });

      // Handle counter_propose: ask user whether to accept before registering
      if (response.type === "counter_propose") {
        console.log(`\nCounter-proposal: ${response.message}`);
        if (response.counter_proposal) {
          console.log(`Suggested target: ${response.counter_proposal.realistic_target}`);
          console.log(`Reasoning: ${response.counter_proposal.reasoning}`);
        }

        let accepted: boolean;
        if (opts.yes) {
          console.log("\n--- Auto-accepted counter-proposal (--yes) ---");
          accepted = true;
        } else {
          accepted = await new Promise<boolean>((resolve) => {
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            process.stdout.write("\nAccept this counter-proposal and register the goal? [y/N] ");
            rl.once("line", (answer) => {
              rl?.close();
              resolve(answer.trim().toLowerCase() === "y");
            });
          });
        }

        if (!accepted) {
          // Goal was saved inside negotiate(); remove it since user declined
          this.stateManager.deleteGoal(goal.id);
          console.log("Goal not registered.");
          return 0;
        }
      }

      // For accept/flag_as_ambitious, goal is already saved inside negotiate().
      // No need to call saveGoal again.

      // Auto-register FileExistenceDataSource for file_existence dimensions (best-effort).
      this.autoRegisterFileExistenceDataSources(goal.dimensions, goal.description, goal.id);

      console.log(`Goal registered successfully!`);
      console.log(`Goal ID:    ${goal.id}`);
      console.log(`Title:      ${goal.title}`);
      console.log(`Status:     ${goal.status}`);
      console.log(`Dimensions: ${goal.dimensions.length}`);
      console.log(`\nResponse: ${response.message}`);

      if (goal.dimensions.length > 0) {
        console.log(`\nDimensions:`);
        for (const dim of goal.dimensions) {
          console.log(`  - ${dim.label} (${dim.name}): ${JSON.stringify(dim.threshold)}`);
        }
      }

      console.log(`\nTo run the loop: motiva run --goal ${goal.id}`);
      return 0;
    } catch (err) {
      if (err instanceof EthicsRejectedError) {
        console.error(formatOperationError(`negotiate goal "${description}" via ethics gate`, err));
        console.error(`Ethics gate reasoning: ${err.verdict.reasoning}`);
        return 1;
      }
      console.error(formatOperationError(`negotiate goal "${description}"`, err));
      return 1;
    }
  }

  private cmdGoalList(opts: { archived?: boolean } = {}): number {
    const goalsDir = path.join(this.stateManager.getBaseDir(), "goals");

    if (!fs.existsSync(goalsDir) || fs.readdirSync(goalsDir).length === 0) {
      console.log("No goals registered. Use `motiva goal add` to create one.");
    } else {
      let entries: string[];
      try {
        entries = fs.readdirSync(goalsDir);
      } catch (err) {
        console.error(formatOperationError("read goals directory", err));
        return 1;
      }

      const goalDirs = entries.filter((e) => {
        try {
          return fs.statSync(path.join(goalsDir, e)).isDirectory();
        } catch (err) {
          console.error(formatOperationError(`inspect goal directory entry "${e}"`, err));
          return false;
        }
      });

      if (goalDirs.length === 0) {
        console.log("No goals registered. Use `motiva goal add` to create one.");
      } else {
        console.log(`Found ${goalDirs.length} goal(s):\n`);
        for (const goalId of goalDirs) {
          const goal = this.stateManager.loadGoal(goalId);
          if (!goal) {
            console.log(`[${goalId}] (could not load)`);
            continue;
          }
          console.log(
            `[${goalId}] status: ${goal.status} — ${goal.title} (dimensions: ${goal.dimensions.length})`
          );
        }
      }
    }

    // Show archived goals count (or full list if --archived flag is set)
    const archivedIds = this.stateManager.listArchivedGoals();
    if (opts.archived && archivedIds.length > 0) {
      console.log(`\nArchived goals (${archivedIds.length}):\n`);
      for (const goalId of archivedIds) {
        // Archived goal.json lives at archive/<goalId>/goal/goal.json
        const archivedGoalPath = path.join(
          this.stateManager.getBaseDir(),
          "archive",
          goalId,
          "goal",
          "goal.json"
        );
        let title = "(could not load)";
        let status = "unknown";
        let dimCount = 0;
        try {
          if (fs.existsSync(archivedGoalPath)) {
            const raw = JSON.parse(fs.readFileSync(archivedGoalPath, "utf-8")) as {
              title?: string;
              status?: string;
              dimensions?: unknown[];
            };
            title = raw.title ?? title;
            status = raw.status ?? status;
            dimCount = raw.dimensions?.length ?? 0;
          }
        } catch (err) {
          console.error(formatOperationError(`read archived goal metadata for "${goalId}"`, err));
        }
        console.log(`[${goalId}] status: ${status} — ${title} (dimensions: ${dimCount})`);
      }
    } else {
      console.log(`\nArchived goals: ${archivedIds.length} (use \`motiva goal list --archived\` to show)`);
    }

    return 0;
  }

  private cmdStatus(goalId: string): number {
    const reportingEngine = new ReportingEngine(this.stateManager);

    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    console.log(`# Status: ${goal.title}`);
    console.log(`\n**Goal ID**: ${goalId}`);
    console.log(`**Status**: ${goal.status}`);
    if (goal.deadline) {
      console.log(`**Deadline**: ${goal.deadline}`);
    }
    console.log(`\n## Dimensions\n`);
    for (const dim of goal.dimensions) {
      const progress =
        typeof dim.current_value === "number"
          ? `${(dim.current_value * 100).toFixed(1)}%`
          : dim.current_value !== null
          ? String(dim.current_value)
          : "not yet measured";
      const confidence = `${(dim.confidence * 100).toFixed(1)}%`;
      console.log(`- **${dim.label}** (${dim.name})`);
      console.log(`  Progress: ${progress}  Confidence: ${confidence}`);
      console.log(`  Target: ${JSON.stringify(dim.threshold)}`);
    }

    // Show latest execution summary
    const reports = reportingEngine.listReports(goalId);
    const execReports = reports
      .filter((r) => r.report_type === "execution_summary")
      .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));

    if (execReports.length > 0) {
      const latest = execReports[0];
      console.log(`\n## Latest Execution Summary\n`);
      console.log(latest.content);
    } else {
      console.log(`\n_No execution reports yet. Run \`motiva run --goal ${goalId}\` to start._`);
    }

    return 0;
  }

  private cmdGoalShow(goalId: string): number {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    console.log(`# Goal: ${goal.title}`);
    console.log(`\nID:          ${goal.id}`);
    console.log(`Status:      ${goal.status}`);
    console.log(`Description: ${goal.description || "(none)"}`);
    if (goal.deadline) {
      console.log(`Deadline:    ${goal.deadline}`);
    }
    console.log(`Created at:  ${goal.created_at}`);

    if (goal.dimensions.length > 0) {
      console.log(`\nDimensions:`);
      for (const dim of goal.dimensions) {
        console.log(`  - ${dim.label} (${dim.name})`);
        console.log(`    Threshold type:  ${dim.threshold.type}`);
        console.log(`    Threshold value: ${JSON.stringify((dim.threshold as { value?: unknown }).value ?? dim.threshold)}`);
      }
    } else {
      console.log(`\nDimensions: (none)`);
    }

    if (goal.constraints.length > 0) {
      console.log(`\nConstraints:`);
      for (const c of goal.constraints) {
        console.log(`  - ${c}`);
      }
    }

    return 0;
  }

  private cmdGoalReset(goalId: string): number {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    const now = new Date().toISOString();
    const resetDimensions = goal.dimensions.map((dim) => ({
      ...dim,
      current_value: null,
      confidence: 0,
      last_updated: null,
      history: [],
    }));

    const resetGoal = {
      ...goal,
      status: "active" as const,
      loop_status: "idle" as const,
      dimensions: resetDimensions,
      updated_at: now,
    };

    this.stateManager.saveGoal(resetGoal);

    console.log(`Goal "${goalId}" reset to active.`);
    console.log(`  Status:      active`);
    console.log(`  Dimensions:  ${resetDimensions.length} dimension(s) cleared`);
    console.log(`\nRun \`motiva run --goal ${goalId}\` to restart the loop.`);

    return 0;
  }

  private cmdLog(goalId: string): number {
    const observationLog = this.stateManager.loadObservationLog(goalId);
    const gapHistory = this.stateManager.loadGapHistory(goalId);

    if ((!observationLog || observationLog.entries.length === 0) && gapHistory.length === 0) {
      console.log(`No logs found for goal ${goalId}`);
      return 0;
    }

    if (observationLog && observationLog.entries.length > 0) {
      console.log(`# Observation Log (${observationLog.entries.length} entries, newest first)\n`);
      const sorted = [...observationLog.entries].sort((a, b) =>
        a.timestamp < b.timestamp ? 1 : -1
      );
      for (const entry of sorted) {
        console.log(`[${entry.timestamp}]`);
        console.log(`  Dimension:  ${entry.dimension_name}`);
        console.log(`  Confidence: ${(entry.confidence * 100).toFixed(1)}%`);
        console.log(`  Layer:      ${entry.layer}`);
        console.log(`  Trigger:    ${entry.trigger}`);
        console.log();
      }
    }

    if (gapHistory.length > 0) {
      console.log(`# Gap History (${gapHistory.length} entries, newest first)\n`);
      const sorted = [...gapHistory].sort((a, b) =>
        a.timestamp < b.timestamp ? 1 : -1
      );
      for (const entry of sorted) {
        const avgGap =
          entry.gap_vector.length > 0
            ? entry.gap_vector.reduce((sum, g) => sum + g.normalized_weighted_gap, 0) /
              entry.gap_vector.length
            : 0;
        console.log(`[${entry.timestamp}]`);
        console.log(`  Iteration: ${entry.iteration}`);
        console.log(`  Avg gap:   ${avgGap.toFixed(4)} (across ${entry.gap_vector.length} dimension(s))`);
        console.log();
      }
    }

    return 0;
  }

  private cmdReport(goalId: string): number {
    const reportingEngine = new ReportingEngine(this.stateManager);

    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    const reports = reportingEngine.listReports(goalId);

    if (reports.length === 0) {
      console.log(`No reports found for goal "${goalId}".`);
      console.log(`Run \`motiva run --goal ${goalId}\` to generate reports.`);
      return 0;
    }

    // Sort by generated_at descending, show the latest
    const sorted = [...reports].sort((a, b) =>
      a.generated_at < b.generated_at ? 1 : -1
    );
    const latest = sorted[0];

    console.log(`# ${latest.title}`);
    console.log(`\n**Report ID**: ${latest.id}`);
    console.log(`**Type**: ${latest.report_type}`);
    console.log(`**Generated**: ${latest.generated_at}`);
    console.log(`**Goal**: ${goalId}`);
    console.log(`\n---\n`);
    console.log(latest.content);

    return 0;
  }

  private async cmdStart(args: string[]): Promise<void> {
    let values: { "api-key"?: string; config?: string; goal?: string[] };
    try {
      ({ values } = parseArgs({
        args,
        options: {
          "api-key": { type: "string" },
          config: { type: "string" },
          goal: { type: "string", multiple: true },
        },
        strict: false,
      }) as { values: { "api-key"?: string; config?: string; goal?: string[] } });
    } catch (err) {
      console.error(formatOperationError("parse start command arguments", err));
      values = {};
    }

    const apiKey = (values["api-key"] as string) || process.env.ANTHROPIC_API_KEY || "";
    const goalIds = (values.goal as string[]) || [];

    if (goalIds.length === 0) {
      console.error("Error: at least one --goal is required for daemon mode");
      process.exit(1);
    }

    const deps = this.buildDeps(apiKey);

    const pidManager = new PIDManager(deps.stateManager.getBaseDir());
    const logger = new Logger({
      dir: path.join(deps.stateManager.getBaseDir(), "logs"),
    });

    if (pidManager.isRunning()) {
      const info = pidManager.readPID();
      console.error(`Daemon already running (PID: ${info?.pid})`);
      process.exit(1);
    }

    const daemon = new DaemonRunner({
      coreLoop: deps.coreLoop,
      driveSystem: deps.driveSystem,
      stateManager: deps.stateManager,
      pidManager,
      logger,
    });

    console.log(`Starting Motiva daemon for goals: ${goalIds.join(", ")}`);
    await daemon.start(goalIds);
  }

  private async cmdStop(_args: string[]): Promise<void> {
    const baseDir = path.join(os.homedir(), ".motiva");
    const pidManager = new PIDManager(baseDir);

    if (!pidManager.isRunning()) {
      console.log("No running daemon found");
      return;
    }

    const info = pidManager.readPID();
    if (info) {
      console.log(`Stopping daemon (PID: ${info.pid})...`);
      try {
        process.kill(info.pid, "SIGTERM");
        console.log("Stop signal sent");
      } catch (err) {
        console.error(formatOperationError(`stop daemon process ${info.pid}`, err));
        pidManager.cleanup();
      }
    }
  }

  private async cmdCron(args: string[]): Promise<void> {
    let values: { goal?: string[]; interval?: string };
    try {
      ({ values } = parseArgs({
        args,
        options: {
          goal: { type: "string", multiple: true },
          interval: { type: "string", default: "60" },
        },
        strict: false,
      }) as { values: { goal?: string[]; interval?: string } });
    } catch (err) {
      console.error(formatOperationError("parse cron command arguments", err));
      values = {};
    }

    const goalIds = (values.goal as string[]) || [];
    const intervalMinutes = parseInt(values.interval as string, 10) || 60;

    if (goalIds.length === 0) {
      console.error("Error: at least one --goal is required");
      process.exit(1);
    }

    console.log("# Motiva crontab entries");
    console.log("# Add these to your crontab with: crontab -e");
    for (const goalId of goalIds) {
      console.log(DaemonRunner.generateCronEntry(goalId, intervalMinutes));
    }
  }

  // ─── Auto DataSource Registration ───

  private autoRegisterFileExistenceDataSources(
    dimensions: Array<{ name: string; label?: string }>,
    goalDescription: string,
    goalId: string
  ): void {
    try {
      const fileExistenceDims = dimensions.filter((d) =>
        /_exists$|_file$|file_existence/.test(d.name)
      );
      if (fileExistenceDims.length === 0) return;

      // Guard: skip auto-registration if goal has quality dimensions
      const nonFileExistenceDims = dimensions.filter((d) =>
        !/_exists$|_file$|file_existence/.test(d.name)
      );
      if (nonFileExistenceDims.length >= 1) {
        console.log(
          `[auto] Skipping FileExistenceDataSource auto-registration: goal has ${nonFileExistenceDims.length} non-FileExistence dimensions that should take priority`
        );
        return;
      }

      const filePathPattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
      const candidateFiles: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = filePathPattern.exec(goalDescription)) !== null) {
        candidateFiles.push(m[1]);
      }

      // Also extract file name candidates from each dimension's label
      for (const dim of fileExistenceDims) {
        if (dim.label) {
          const labelPattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
          let m2: RegExpExecArray | null;
          while ((m2 = labelPattern.exec(dim.label)) !== null) {
            if (!candidateFiles.includes(m2[1])) {
              candidateFiles.push(m2[1]);
            }
          }
        }
      }

      const dimensionMapping: Record<string, string> = {};
      for (const dim of fileExistenceDims) {
        const dimBase = dim.name
          .replace(/_exists$/, "")
          .replace(/_file$/, "")
          .replace(/_/g, "")
          .toLowerCase();
        // Try matching dimension name against candidate files
        let matched = candidateFiles.find((f) => {
          const fBase = path.basename(f).replace(/[._-]/g, "").toLowerCase();
          return fBase.includes(dimBase) || dimBase.includes(fBase);
        });
        // If no match by dim name, try extracting a file name directly from the label
        if (!matched && dim.label) {
          const labelFilePattern = /\b([\w.\-/]+\.\w{1,10})\b/g;
          let lm: RegExpExecArray | null;
          while ((lm = labelFilePattern.exec(dim.label)) !== null) {
            const labelFile = lm[1];
            if (candidateFiles.includes(labelFile)) {
              matched = labelFile;
              break;
            }
          }
        }
        if (matched) {
          dimensionMapping[dim.name] = matched;
        } else if (candidateFiles.length === 1) {
          dimensionMapping[dim.name] = candidateFiles[0];
        }
      }

      if (Object.keys(dimensionMapping).length === 0) return;

      const datasourcesDir = path.join(this.stateManager.getBaseDir(), "datasources");
      if (!fs.existsSync(datasourcesDir)) {
        fs.mkdirSync(datasourcesDir, { recursive: true });
      }

      const id = `ds_auto_${Date.now()}`;
      const config = {
        id,
        name: `auto:file_existence (${Object.values(dimensionMapping).join(", ")})`,
        type: "file_existence",
        connection: { path: process.cwd() },
        dimension_mapping: dimensionMapping,
        scope_goal_id: goalId,
        enabled: true,
        created_at: new Date().toISOString(),
      };

      const configPath = path.join(datasourcesDir, `${id}.json`);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      console.log(
        `[auto] Registered FileExistenceDataSource for: ${Object.keys(dimensionMapping).join(", ")}`
      );
    } catch (err) {
      console.error(formatOperationError("auto-register file existence data sources", err));
    }
  }

  // ─── Datasource Subcommands ───

  private async cmdDatasourceAdd(argv: string[]): Promise<number> {
    const type = argv[0];
    if (!type) {
      console.error("Error: type is required. Usage: motiva datasource add <type> [options]");
      console.error("  Types: file, http_api, github_issue, file_existence");
      return 1;
    }

    if (type !== "file" && type !== "http_api" && type !== "github_issue" && type !== "file_existence") {
      console.error(`Error: unsupported type "${type}". Supported: file, http_api, github_issue, file_existence`);
      return 1;
    }

    let values: { name?: string; path?: string; url?: string };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          name: { type: "string" },
          path: { type: "string" },
          url: { type: "string" },
        },
        strict: false,
      }) as { values: { name?: string; path?: string; url?: string } });
    } catch (err) {
      console.error(formatOperationError(`parse datasource add arguments for type "${type}"`, err));
      values = {};
    }

    const id = `ds_${Date.now()}`;
    const name =
      values.name ??
      (type === "file"
        ? `file:${values.path ?? id}`
        : type === "file_existence"
          ? `file_existence:${values.path ?? id}`
          : type === "github_issue"
            ? `github_issue:${id}`
            : `http_api:${values.url ?? id}`);

    const connection: Record<string, string> = {};
    let extraConfig: Record<string, unknown> = {};
    if (type === "file") {
      if (!values.path) {
        console.error("Error: --path is required for file data source");
        return 1;
      }
      connection["path"] = values.path;
    } else if (type === "file_existence") {
      if (!values.path) {
        console.error("Error: --path is required for file_existence data source");
        return 1;
      }
      connection["path"] = values.path;
      extraConfig = { filePaths: { file_exists: values.path } };
    } else if (type === "github_issue") {
      // No connection params needed — uses `gh` CLI
    } else {
      if (!values.url) {
        console.error("Error: --url is required for http_api data source");
        return 1;
      }
      connection["url"] = values.url;
      connection["method"] = "GET";
    }

    const config = {
      id,
      name,
      type,
      connection,
      ...extraConfig,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    const datasourcesDir = path.join(this.stateManager.getBaseDir(), "datasources");
    if (!fs.existsSync(datasourcesDir)) {
      fs.mkdirSync(datasourcesDir, { recursive: true });
    }

    const configPath = path.join(datasourcesDir, `${id}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    console.log(`Data source registered successfully!`);
    console.log(`  ID:   ${id}`);
    console.log(`  Type: ${type}`);
    console.log(`  Name: ${name}`);

    return 0;
  }

  private cmdDatasourceList(): number {
    const datasourcesDir = path.join(this.stateManager.getBaseDir(), "datasources");

    if (!fs.existsSync(datasourcesDir)) {
      console.log("No data sources registered. Use `motiva datasource add` to register one.");
      return 0;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(datasourcesDir);
    } catch (err) {
      console.error(formatOperationError("read datasources directory", err));
      return 1;
    }

    const jsonFiles = entries.filter((e) => e.endsWith(".json"));

    if (jsonFiles.length === 0) {
      console.log("No data sources registered. Use `motiva datasource add` to register one.");
      return 0;
    }

    console.log(`Found ${jsonFiles.length} data source(s):\n`);
    console.log("ID                          TYPE       ENABLED  NAME");
    console.log("─".repeat(72));

    for (const file of jsonFiles) {
      try {
        const raw = fs.readFileSync(path.join(datasourcesDir, file), "utf-8");
        const cfg = JSON.parse(raw) as { id?: string; type?: string; name?: string; enabled?: boolean };
        const id = cfg.id ?? file.replace(".json", "");
        const type = cfg.type ?? "unknown";
        const enabled = cfg.enabled !== false ? "yes" : "no";
        const name = cfg.name ?? "(unnamed)";
        console.log(`${id.padEnd(28)} ${type.padEnd(10)} ${enabled.padEnd(8)} ${name}`);
      } catch (err) {
        console.error(formatOperationError(`parse datasource config "${file}" during datasource listing`, err));
      }
    }

    return 0;
  }

  private async cmdDatasourceRemove(argv: string[]): Promise<number> {
    const id = argv[0];
    if (!id) {
      console.error("Error: id is required. Usage: motiva datasource remove <id>");
      return 1;
    }

    const configPath = path.join(this.stateManager.getBaseDir(), "datasources", `${id}.json`);

    if (!fs.existsSync(configPath)) {
      console.error(`Error: Data source "${id}" not found.`);
      return 1;
    }

    fs.unlinkSync(configPath);
    console.log(`Data source "${id}" removed.`);

    return 0;
  }

  private cmdConfigCharacter(argv: string[]): number {
    let values: {
      show?: boolean;
      reset?: boolean;
      "caution-level"?: string;
      "stall-flexibility"?: string;
      "communication-directness"?: string;
      "proactivity-level"?: string;
    };

    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          show: { type: "boolean" },
          reset: { type: "boolean" },
          "caution-level": { type: "string" },
          "stall-flexibility": { type: "string" },
          "communication-directness": { type: "string" },
          "proactivity-level": { type: "string" },
        },
        strict: false,
      }) as {
        values: {
          show?: boolean;
          reset?: boolean;
          "caution-level"?: string;
          "stall-flexibility"?: string;
          "communication-directness"?: string;
          "proactivity-level"?: string;
        };
      });
    } catch (err) {
      console.error(formatOperationError("parse character config arguments", err));
      values = {};
    }

    const hasFlags =
      values.show ||
      values.reset ||
      values["caution-level"] !== undefined ||
      values["stall-flexibility"] !== undefined ||
      values["communication-directness"] !== undefined ||
      values["proactivity-level"] !== undefined;

    if (!hasFlags) {
      console.log(`Usage: motiva config character [options]

Options:
  --show                          Show current character config
  --reset                         Reset to defaults
  --caution-level <1-5>           Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>       Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5> Output style (1=considerate, 5=direct/facts only)
  --proactivity-level <1-5>       Report verbosity (1=events-only, 5=always-detailed)`);
      return 0;
    }

    if (values.reset) {
      this.characterConfigManager.reset();
      const config = this.characterConfigManager.load();
      console.log("Character config reset to defaults:");
      printCharacterConfig(config);
      return 0;
    }

    if (values.show) {
      const config = this.characterConfigManager.load();
      console.log("Current character config:");
      printCharacterConfig(config);
      return 0;
    }

    // Build partial update from provided flags
    const partial: Record<string, number> = {};

    const paramMap: Array<[string, string]> = [
      ["caution-level", "caution_level"],
      ["stall-flexibility", "stall_flexibility"],
      ["communication-directness", "communication_directness"],
      ["proactivity-level", "proactivity_level"],
    ];

    for (const [flag, key] of paramMap) {
      const raw = values[flag as keyof typeof values] as string | undefined;
      if (raw !== undefined) {
        const parsed = parseInt(raw, 10);
        if (isNaN(parsed) || parsed < 1 || parsed > 5) {
          console.error(`Error: --${flag} must be an integer between 1 and 5 (got: ${raw})`);
          return 1;
        }
        partial[key] = parsed;
      }
    }

    try {
      const updated = this.characterConfigManager.update(partial);
      console.log("Character config updated:");
      printCharacterConfig(updated);
      return 0;
    } catch (err) {
      console.error(formatOperationError("update character config", err));
      return 1;
    }
  }

  private async cmdGoalArchive(goalId: string, opts: { yes?: boolean; force?: boolean }): Promise<number> {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    if (goal.status !== "completed" && !opts.force && !opts.yes) {
      console.warn(`Warning: Goal "${goalId}" is not completed (status: ${goal.status}).`);
      console.warn("Archive anyway? Use --yes or --force to skip this check.");
      return 1;
    }

    const archived = this.stateManager.archiveGoal(goalId);
    if (!archived) {
      console.error(`Error: Failed to archive goal "${goalId}".`);
      return 1;
    }

    console.log(`Goal "${goalId}" archived successfully.`);
    console.log(`  Title:  ${goal.title}`);
    console.log(`  Status: ${goal.status}`);
    return 0;
  }

  private cmdCleanup(): number {
    const goalIds = this.stateManager.listGoalIds();

    const completed: string[] = [];
    for (const goalId of goalIds) {
      const goal = this.stateManager.loadGoal(goalId);
      if (goal && goal.status === "completed") {
        completed.push(goalId);
      }
    }

    if (completed.length === 0) {
      console.log("No completed goals to archive.");
    } else {
      for (const goalId of completed) {
        this.stateManager.archiveGoal(goalId);
      }
      console.log(`Archived ${completed.length} completed goal(s).`);
    }

    // Report orphaned task/strategy/stall directories not matching any active goal
    const activeGoalIds = new Set(this.stateManager.listGoalIds());
    const baseDir = this.stateManager.getBaseDir();
    const staleReports: string[] = [];

    const reportsDir = path.join(baseDir, "reports");
    if (fs.existsSync(reportsDir)) {
      try {
        const reportFiles = fs.readdirSync(reportsDir).filter((f) => f.endsWith(".json"));
        for (const file of reportFiles) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, file), "utf-8")) as { goal_id?: string };
            if (raw.goal_id && !activeGoalIds.has(raw.goal_id)) {
              staleReports.push(file);
            }
          } catch (err) {
            console.error(formatOperationError(`read report metadata from "${file}"`, err));
          }
        }
      } catch (err) {
        console.error(formatOperationError(`scan reports directory "${reportsDir}"`, err));
      }
    }

    if (staleReports.length > 0) {
      console.log(`\nOrphaned report files (no matching active goal): ${staleReports.length}`);
      for (const f of staleReports) {
        console.log(`  ${f}`);
      }
      console.log("(These can be removed manually from ~/.motiva/reports/)");
    }

    return 0;
  }

  /** Mask API keys in a config object for safe display. */
  private maskSecrets(config: ProviderConfig): ProviderConfig {
    const mask = (val: string | undefined): string | undefined =>
      val && val.length > 8 ? val.slice(0, 4) + "..." + val.slice(-4) : val ? "****" : undefined;
    return JSON.parse(JSON.stringify(config), (key, value) => {
      if (typeof value === "string" && (key === "api_key" || key === "apiKey")) {
        return mask(value);
      }
      return value as unknown;
    }) as ProviderConfig;
  }

  // ─── Provider Subcommands ───

  private cmdProvider(argv: string[]): number {
    const providerSubcommand = argv[0];

    if (!providerSubcommand || providerSubcommand === "show") {
      const config = loadProviderConfig();
      console.log(JSON.stringify(this.maskSecrets(config), null, 2));
      return 0;
    }

    if (providerSubcommand === "set") {
      let values: { llm?: string; adapter?: string };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            llm: { type: "string" },
            adapter: { type: "string" },
          },
          strict: false,
        }) as { values: { llm?: string; adapter?: string } });
      } catch (err) {
        console.error(formatOperationError("parse provider set arguments", err));
        values = {};
      }

      const validLlmProviders = ["anthropic", "openai", "ollama", "codex"];
      const validAdapters = ["claude_code_cli", "claude_api", "openai_codex_cli", "openai_api", "github_issue"];

      if (values.llm && !validLlmProviders.includes(values.llm)) {
        console.error(
          `Error: invalid --llm provider "${values.llm}". Valid: ${validLlmProviders.join(", ")}`
        );
        return 1;
      }

      if (values.adapter && !validAdapters.includes(values.adapter)) {
        console.error(
          `Error: invalid --adapter "${values.adapter}". Valid: ${validAdapters.join(", ")}`
        );
        return 1;
      }

      // Load existing config as base, then update
      const current = loadProviderConfig();
      const updated: ProviderConfig = {
        ...current,
        ...(values.llm ? { llm_provider: values.llm as ProviderConfig["llm_provider"] } : {}),
        ...(values.adapter ? { default_adapter: values.adapter as ProviderConfig["default_adapter"] } : {}),
      };

      saveProviderConfig(updated);
      console.log("Provider config updated:");
      console.log(JSON.stringify(this.maskSecrets(updated), null, 2));
      return 0;
    }

    console.error(`Unknown provider subcommand: "${providerSubcommand}"`);
    console.error("Available: provider show, provider set");
    return 1;
  }

  // ─── Main dispatch ───

  /**
   * @description Parses CLI arguments, dispatches the matching Motiva subcommand, and returns the resulting exit code.
   * @param {string[]} argv Raw subcommand arguments, excluding the `node` executable and script path.
   * @returns {Promise<number>} A promise that resolves to `0` for success, `1` for errors, or `2` for stall escalation.
   */
  async run(argv: string[]): Promise<number> {
    if (argv.length === 0) {
      printUsage();
      return 1;
    }

    // Extract --yes / -y globally so it works regardless of position
    // (e.g. `motiva --yes run --goal <id>` as well as `motiva run --goal <id> --yes`).
    let globalYes = false;
    const filteredArgv: string[] = [];
    for (const arg of argv) {
      if (arg === "--yes" || arg === "-y") {
        globalYes = true;
      } else {
        filteredArgv.push(arg);
      }
    }
    argv = filteredArgv;

    const subcommand = argv[0];

    if (subcommand === "run") {
      let values: { goal?: string; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            goal: { type: "string" },
            "max-iterations": { type: "string" },
            adapter: { type: "string" },
            tree: { type: "boolean" },
            yes: { type: "boolean", short: "y" },
            verbose: { type: "boolean" },
          },
          strict: false,
        }) as { values: { goal?: string; "max-iterations"?: string; adapter?: string; tree?: boolean; yes?: boolean; verbose?: boolean } });
      } catch (err) {
        console.error(formatOperationError("parse run command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        console.error("Error: --goal <id> is required for `motiva run`.");
        return 1;
      }

      const loopConfig: LoopConfig = {};
      if (values["max-iterations"] !== undefined) {
        const parsed = parseInt(values["max-iterations"], 10);
        if (!isNaN(parsed)) {
          loopConfig.maxIterations = parsed;
        }
      }
      if (values.adapter !== undefined) {
        loopConfig.adapterType = values.adapter;
      }
      if (values.tree) {
        loopConfig.treeMode = true;
      }

      return await this.cmdRun(goalId, loopConfig, globalYes || values.yes, values.verbose);
    }

    if (subcommand === "goal") {
      const goalSubcommand = argv[1];

      if (!goalSubcommand) {
        console.error("Error: goal subcommand required. Available: goal add, goal list, goal archive, goal remove, goal show, goal reset");
        return 1;
      }

      if (goalSubcommand === "add") {
        const description = argv[2];
        if (!description) {
          console.error('Error: description is required. Usage: motiva goal add "<description>"');
          return 1;
        }

        let values: { deadline?: string | undefined; constraint?: string[] | undefined; yes?: boolean | undefined };
        try {
          ({ values } = parseArgs({
            args: argv.slice(3),
            options: {
              deadline: { type: "string" },
              constraint: { type: "string", multiple: true },
              yes: { type: "boolean", short: "y" },
            },
            strict: false,
          }) as { values: { deadline?: string; constraint?: string[]; yes?: boolean } });
        } catch (err) {
          console.error(formatOperationError("parse goal add arguments", err));
          values = {};
        }

        const deadline = values.deadline;
        const constraints = values.constraint ?? [];
        const yes = globalYes || (values.yes ?? false);

        return await this.cmdGoalAdd(description, { deadline, constraints, yes });
      }

      if (goalSubcommand === "list") {
        let listValues: { archived?: boolean } = {};
        try {
          ({ values: listValues } = parseArgs({
            args: argv.slice(2),
            options: { archived: { type: "boolean" } },
            strict: false,
          }) as { values: { archived?: boolean } });
        } catch (err) {
          console.error(formatOperationError("parse goal list arguments", err));
          listValues = {};
        }
        return this.cmdGoalList({ archived: listValues.archived });
      }

      if (goalSubcommand === "archive") {
        const goalId = argv[2];
        if (!goalId) {
          console.error("Error: goal ID is required. Usage: motiva goal archive <id>");
          return 1;
        }
        let archiveValues: { yes?: boolean; force?: boolean } = {};
        try {
          ({ values: archiveValues } = parseArgs({
            args: argv.slice(3),
            options: {
              yes: { type: "boolean", short: "y" },
              force: { type: "boolean" },
            },
            strict: false,
          }) as { values: { yes?: boolean; force?: boolean } });
        } catch (err) {
          console.error(formatOperationError("parse goal archive arguments", err));
          archiveValues = {};
        }
        return await this.cmdGoalArchive(goalId, { ...archiveValues, yes: globalYes || archiveValues.yes });
      }

      if (goalSubcommand === "remove") {
        const goalId = argv[2];
        if (!goalId) {
          console.error("Error: goal ID is required. Usage: motiva goal remove <id>");
          return 1;
        }
        const deleted = this.stateManager.deleteGoal(goalId);
        if (deleted) {
          console.log(`Goal ${goalId} removed.`);
          return 0;
        } else {
          console.error(`Goal not found: ${goalId}`);
          return 1;
        }
      }

      if (goalSubcommand === "show") {
        const goalId = argv[2];
        if (!goalId) {
          console.error("Error: goal ID is required. Usage: motiva goal show <id>");
          return 1;
        }
        return this.cmdGoalShow(goalId);
      }

      if (goalSubcommand === "reset") {
        const goalId = argv[2];
        if (!goalId) {
          console.error("Error: goal ID is required. Usage: motiva goal reset <id>");
          return 1;
        }
        return this.cmdGoalReset(goalId);
      }

      console.error(`Unknown goal subcommand: "${goalSubcommand}"`);
      console.error("Available: goal add, goal list, goal archive, goal remove, goal show, goal reset");
      return 1;
    }

    if (subcommand === "status") {
      let values: { goal?: string | undefined };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            goal: { type: "string" },
          },
          strict: false,
        }) as { values: { goal?: string } });
      } catch (err) {
        console.error(formatOperationError("parse status command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        console.error("Error: --goal <id> is required for `motiva status`.");
        return 1;
      }

      return this.cmdStatus(goalId);
    }

    if (subcommand === "report") {
      let values: { goal?: string | undefined };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            goal: { type: "string" },
          },
          strict: false,
        }) as { values: { goal?: string } });
      } catch (err) {
        console.error(formatOperationError("parse report command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        console.error("Error: --goal <id> is required for `motiva report`.");
        return 1;
      }

      return this.cmdReport(goalId);
    }

    if (subcommand === "log") {
      let values: { goal?: string | undefined };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            goal: { type: "string" },
          },
          strict: false,
        }) as { values: { goal?: string } });
      } catch (err) {
        console.error(formatOperationError("parse log command arguments", err));
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        console.error("Error: --goal <id> is required for `motiva log`.");
        return 1;
      }

      return this.cmdLog(goalId);
    }

    if (subcommand === "start") {
      await this.cmdStart(argv.slice(1));
      return 0;
    }

    if (subcommand === "stop") {
      await this.cmdStop(argv.slice(1));
      return 0;
    }

    if (subcommand === "cron") {
      await this.cmdCron(argv.slice(1));
      return 0;
    }

    if (subcommand === "datasource") {
      const dsSubcommand = argv[1];

      if (!dsSubcommand) {
        console.error("Error: datasource subcommand required. Available: datasource add, datasource list, datasource remove");
        return 1;
      }

      if (dsSubcommand === "add") {
        return await this.cmdDatasourceAdd(argv.slice(2));
      }

      if (dsSubcommand === "list") {
        return this.cmdDatasourceList();
      }

      if (dsSubcommand === "remove") {
        return await this.cmdDatasourceRemove(argv.slice(2));
      }

      console.error(`Unknown datasource subcommand: "${dsSubcommand}"`);
      console.error("Available: datasource add, datasource list, datasource remove");
      return 1;
    }

    if (subcommand === "cleanup") {
      return this.cmdCleanup();
    }

    if (subcommand === "provider") {
      return this.cmdProvider(argv.slice(1));
    }

    if (subcommand === "config") {
      const configSubcommand = argv[1];

      if (!configSubcommand) {
        console.error("Error: config subcommand required. Available: config character");
        return 1;
      }

      if (configSubcommand === "character") {
        return this.cmdConfigCharacter(argv.slice(2));
      }

      console.error(`Unknown config subcommand: "${configSubcommand}"`);
      console.error("Available: config character");
      return 1;
    }

    if (subcommand === "tui") {
      // Dynamically import to avoid bundling Ink into the CLI when not needed
      const { startTUI } = await import("./tui/entry.js");
      await startTUI();
      return 0;
    }

    if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
      printUsage();
      return 0;
    }

    console.error(`Unknown subcommand: "${subcommand}"`);
    printUsage();
    return 1;
  }
}

// ─── Usage ───

function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }

  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

function printUsage(): void {
  console.log(`
Motiva — AI agent orchestrator

Usage:
  motiva run --goal <id>              Run CoreLoop for a goal
  motiva goal add "<description>"     Register a new goal (interactive)
  motiva goal list                    List all registered goals
  motiva goal list --archived         Also list archived goals
  motiva goal archive <id>            Archive a completed goal (moves state to ~/.motiva/archive/)
  motiva goal remove <id>             Remove a goal by ID
  motiva goal show <id>               Show goal details (dimensions, constraints, deadline)
  motiva goal reset <id>              Reset goal state for re-running
  motiva cleanup                      Archive all completed goals and remove stale data
  motiva status --goal <id>           Show current status and progress
  motiva report --goal <id>           Show latest report
  motiva log --goal <id>              View observation and gap history log
  motiva tui                          Launch the interactive TUI
  motiva start --goal <id>            Start daemon mode for one or more goals
  motiva stop                         Stop the running daemon
  motiva cron --goal <id>             Print crontab entry for a goal
  motiva config character             Show or update character configuration
  motiva datasource add <type>        Register a new data source (file | http_api)
  motiva datasource list              List all registered data sources
  motiva datasource remove <id>       Remove a data source by ID
  motiva provider show                Show current provider config
  motiva provider set                 Set LLM provider and/or default adapter

Options (motiva run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (motiva goal add):
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (motiva config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (motiva datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (motiva provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  MOTIVA_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  motiva goal add "Increase test coverage to 90%"
  motiva goal list
  motiva goal show <id>
  motiva goal reset <id>
  motiva run --goal <id>
  motiva status --goal <id>
  motiva report --goal <id>
  motiva log --goal <id>
  motiva config character --show
  motiva config character --caution-level 3
  motiva datasource add file --path /path/to/metrics.json --name "My Metrics"
  motiva datasource add http_api --url https://api.example.com/metrics --name "API"
  motiva datasource list
  motiva datasource remove ds_1234567890
`.trim());
}

function printCharacterConfig(config: {
  caution_level: number;
  stall_flexibility: number;
  communication_directness: number;
  proactivity_level: number;
}): void {
  console.log(`  caution_level:              ${config.caution_level}  (1=conservative, 5=ambitious)`);
  console.log(`  stall_flexibility:          ${config.stall_flexibility}  (1=pivot fast, 5=persistent)`);
  console.log(`  communication_directness:   ${config.communication_directness}  (1=considerate, 5=direct)`);
  console.log(`  proactivity_level:          ${config.proactivity_level}  (1=events-only, 5=always-detailed)`);
}

// ─── Entry point (when run directly as a binary) ───

async function main(): Promise<void> {
  // Strip 'node' and script path from process.argv
  const argv = process.argv.slice(2);
  const runner = new CLIRunner();
  try {
    const code = await runner.run(argv);
    process.exit(code);
  } catch (err) {
    console.error(formatOperationError("execute CLI entry point", err));
    process.exit(1);
  }
}

// Only run main() when this file is the entry point
// (not when imported as a module in tests)
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const isMain = (() => {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = realpathSync(process.argv[1]);
    return thisFile === entryFile;
  } catch (err) {
    console.error(formatOperationError("resolve CLI entry point path", err));
    return false;
  }
})();

if (isMain) {
  main();
}
