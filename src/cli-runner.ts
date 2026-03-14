#!/usr/bin/env node
// ─── CLIRunner ───
//
// Motiva CLI entry point. Wires all dependencies and exposes subcommands:
//   motiva run --goal <id>            Run CoreLoop once for a given goal
//   motiva goal add "<description>"   Negotiate and register a new goal (interactive)
//   motiva goal list                  List all registered goals
//   motiva status --goal <id>         Show current progress report
//   motiva report --goal <id>         Show latest report
//   motiva start --goal <id>          Start daemon mode for one or more goals
//   motiva stop                       Stop the running daemon
//   motiva cron --goal <id>           Print crontab entry for a goal

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";

import { StateManager } from "./state-manager.js";
import { LLMClient } from "./llm-client.js";
import { OllamaLLMClient } from "./ollama-client.js";
import type { ILLMClient } from "./llm-client.js";
import { TrustManager } from "./trust-manager.js";
import { DriveSystem } from "./drive-system.js";
import { ObservationEngine } from "./observation-engine.js";
import { StallDetector } from "./stall-detector.js";
import { SatisficingJudge } from "./satisficing-judge.js";
import { EthicsGate } from "./ethics-gate.js";
import { SessionManager } from "./session-manager.js";
import { StrategyManager } from "./strategy-manager.js";
import { GoalNegotiator, EthicsRejectedError } from "./goal-negotiator.js";
import { AdapterRegistry } from "./adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "./adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "./adapters/claude-api.js";
import { TaskLifecycle } from "./task-lifecycle.js";
import { ReportingEngine } from "./reporting-engine.js";
import { CoreLoop } from "./core-loop.js";
import { DaemonRunner } from "./daemon-runner.js";
import { PIDManager } from "./pid-manager.js";
import { Logger } from "./logger.js";
import { CharacterConfigManager } from "./character-config.js";
import * as GapCalculator from "./gap-calculator.js";
import * as DriveScorer from "./drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule, LoopConfig } from "./core-loop.js";
import type { Task } from "./types/task.js";

// ─── CLIRunner ───

export class CLIRunner {
  private readonly stateManager: StateManager;
  private readonly characterConfigManager: CharacterConfigManager;
  private activeCoreLoop: CoreLoop | null = null;

  constructor(baseDir?: string) {
    this.stateManager = new StateManager(baseDir);
    this.characterConfigManager = new CharacterConfigManager(this.stateManager);
  }

  /**
   * Stop the active CoreLoop (if one is running).
   * Safe to call before run() or when no loop is active.
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

  /**
   * Build the LLM client based on environment configuration.
   * When MOTIVA_LLM_PROVIDER=ollama, returns an OllamaLLMClient.
   * Otherwise returns a LLMClient (Anthropic).
   */
  private buildLLMClient(apiKey?: string): ILLMClient {
    const provider = process.env.MOTIVA_LLM_PROVIDER;
    if (provider === "ollama") {
      const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const model = process.env.OLLAMA_MODEL ?? "qwen3:4b";
      return new OllamaLLMClient({ baseUrl, model });
    }
    return new LLMClient(apiKey);
  }

  private buildApprovalFn(rl: readline.Interface): (task: Task) => Promise<boolean> {
    return (task: Task): Promise<boolean> => {
      return new Promise((resolve) => {
        console.log("\n--- Approval Required ---");
        console.log(`Task: ${task.work_description}`);
        console.log(`Rationale: ${task.rationale}`);
        console.log(`Reversibility: ${task.reversibility}`);

        rl.question("Approve this task? [y/N] ", (answer) => {
          resolve(answer.trim().toLowerCase() === "y");
        });
      });
    };
  }

  private buildDeps(apiKey: string | undefined, config?: LoopConfig, approvalFn?: (task: Task) => Promise<boolean>) {
    const stateManager = this.stateManager;
    const characterConfig = this.characterConfigManager.load();
    const llmClient = this.buildLLMClient(apiKey);
    const trustManager = new TrustManager(stateManager);
    const driveSystem = new DriveSystem(stateManager);
    const observationEngine = new ObservationEngine(stateManager);
    const stallDetector = new StallDetector(stateManager, characterConfig);
    const satisficingJudge = new SatisficingJudge(stateManager);
    const ethicsGate = new EthicsGate(stateManager, llmClient);
    const sessionManager = new SessionManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const adapterRegistry = new AdapterRegistry();

    // Register default adapters
    adapterRegistry.register(new ClaudeCodeCLIAdapter());
    adapterRegistry.register(new ClaudeAPIAdapter(llmClient));

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
    }, config);

    const goalNegotiator = new GoalNegotiator(
      stateManager,
      llmClient,
      ethicsGate,
      observationEngine,
      characterConfig
    );

    return { coreLoop, goalNegotiator, reportingEngine, stateManager, driveSystem };
  }

  // ─── Subcommands ───

  private async cmdRun(
    goalId: string,
    loopConfig?: LoopConfig
  ): Promise<number> {
    const apiKey = this.getApiKey();
    if (!apiKey && process.env.MOTIVA_LLM_PROVIDER !== "ollama") {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
          "Set it with: export ANTHROPIC_API_KEY=<your-key>\n" +
          "Or use Ollama: export MOTIVA_LLM_PROVIDER=ollama"
      );
      return 1;
    }

    // Create a single readline interface for the entire loop run.
    // It is reused across all approval prompts and closed when the loop ends.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let deps: ReturnType<typeof this.buildDeps>;
    try {
      deps = this.buildDeps(apiKey, loopConfig, this.buildApprovalFn(rl));
    } catch (err) {
      rl.close();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: Failed to initialise dependencies: ${message}`);
      return 1;
    }

    const { coreLoop } = deps;

    // Validate goal exists before starting
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      rl.close();
      console.error(`Error: Goal "${goalId}" not found.`);
      return 1;
    }

    console.log(`Running Motiva loop for goal: ${goalId}`);
    console.log(`Goal: ${goal.title}`);
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      this.activeCoreLoop = null;
      rl.close();
      return 1;
    }

    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    this.activeCoreLoop = null;
    rl.close();

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
    opts: { deadline?: string; constraints?: string[] }
  ): Promise<number> {
    const apiKey = this.getApiKey();
    if (!apiKey && process.env.MOTIVA_LLM_PROVIDER !== "ollama") {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
          "Set it with: export ANTHROPIC_API_KEY=<your-key>\n" +
          "Or use Ollama: export MOTIVA_LLM_PROVIDER=ollama"
      );
      return 1;
    }

    let deps: ReturnType<typeof this.buildDeps>;
    try {
      deps = this.buildDeps(apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: Failed to initialise dependencies: ${message}`);
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

      // Persist the negotiated goal
      this.stateManager.saveGoal(goal);

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
        console.error(`Goal rejected by ethics gate: ${err.verdict.reasoning}`);
        return 1;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  private cmdGoalList(): number {
    const goalsDir = path.join(this.stateManager.getBaseDir(), "goals");

    if (!fs.existsSync(goalsDir)) {
      console.log("No goals found. Use `motiva goal add` to create one.");
      return 0;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(goalsDir);
    } catch {
      console.error("Error reading goals directory.");
      return 1;
    }

    const goalDirs = entries.filter((e) => {
      try {
        return fs.statSync(path.join(goalsDir, e)).isDirectory();
      } catch {
        return false;
      }
    });

    if (goalDirs.length === 0) {
      console.log("No goals registered. Use `motiva goal add` to create one.");
      return 0;
    }

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
    } catch {
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
        console.error(`Failed to stop daemon: ${err}`);
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
    } catch {
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

  // ─── Datasource Subcommands ───

  private async cmdDatasourceAdd(argv: string[]): Promise<number> {
    const type = argv[0];
    if (!type) {
      console.error("Error: type is required. Usage: motiva datasource add <type> [options]");
      console.error("  Types: file, http_api");
      return 1;
    }

    if (type !== "file" && type !== "http_api") {
      console.error(`Error: unsupported type "${type}". Supported: file, http_api`);
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
    } catch {
      values = {};
    }

    const id = `ds_${Date.now()}`;
    const name = values.name ?? (type === "file" ? `file:${values.path ?? id}` : `http_api:${values.url ?? id}`);

    const connection: Record<string, string> = {};
    if (type === "file") {
      if (!values.path) {
        console.error("Error: --path is required for file data source");
        return 1;
      }
      connection["path"] = values.path;
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
    } catch {
      console.error("Error reading datasources directory.");
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
      } catch {
        console.log(`(could not parse: ${file})`);
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
    } catch {
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: Failed to update character config: ${message}`);
      return 1;
    }
  }

  // ─── Main dispatch ───

  /**
   * Parse argv and run the appropriate subcommand.
   * argv should be the raw subcommand arguments (e.g. ["run", "--goal", "id"]).
   * Does NOT include "node" or script path — pure subcommand args.
   *
   * Returns an exit code: 0 (success), 1 (error), 2 (stall escalation).
   */
  async run(argv: string[]): Promise<number> {
    if (argv.length === 0) {
      printUsage();
      return 1;
    }

    const subcommand = argv[0];

    if (subcommand === "run") {
      let values: { goal?: string; "max-iterations"?: string; adapter?: string };
      try {
        ({ values } = parseArgs({
          args: argv.slice(1),
          options: {
            goal: { type: "string" },
            "max-iterations": { type: "string" },
            adapter: { type: "string" },
          },
          strict: false,
        }) as { values: { goal?: string; "max-iterations"?: string; adapter?: string } });
      } catch {
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

      return await this.cmdRun(goalId, loopConfig);
    }

    if (subcommand === "goal") {
      const goalSubcommand = argv[1];

      if (!goalSubcommand) {
        console.error("Error: goal subcommand required. Available: goal add, goal list");
        return 1;
      }

      if (goalSubcommand === "add") {
        const description = argv[2];
        if (!description) {
          console.error('Error: description is required. Usage: motiva goal add "<description>"');
          return 1;
        }

        let values: { deadline?: string | undefined; constraint?: string[] | undefined };
        try {
          ({ values } = parseArgs({
            args: argv.slice(3),
            options: {
              deadline: { type: "string" },
              constraint: { type: "string", multiple: true },
            },
            strict: false,
          }) as { values: { deadline?: string; constraint?: string[] } });
        } catch {
          values = {};
        }

        const deadline = values.deadline;
        const constraints = values.constraint ?? [];

        return await this.cmdGoalAdd(description, { deadline, constraints });
      }

      if (goalSubcommand === "list") {
        return this.cmdGoalList();
      }

      console.error(`Unknown goal subcommand: "${goalSubcommand}"`);
      console.error("Available: goal add, goal list");
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
      } catch {
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
      } catch {
        values = {};
      }

      const goalId = values.goal;
      if (!goalId || typeof goalId !== "string") {
        console.error("Error: --goal <id> is required for `motiva report`.");
        return 1;
      }

      return this.cmdReport(goalId);
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

function printUsage(): void {
  console.log(`
Motiva — AI agent orchestrator

Usage:
  motiva run --goal <id>              Run CoreLoop for a goal
  motiva goal add "<description>"     Register a new goal (interactive)
  motiva goal list                    List all registered goals
  motiva status --goal <id>           Show current status and progress
  motiva report --goal <id>           Show latest report
  motiva tui                          Launch the interactive TUI
  motiva start --goal <id>            Start daemon mode for one or more goals
  motiva stop                         Stop the running daemon
  motiva cron --goal <id>             Print crontab entry for a goal
  motiva config character             Show or update character configuration
  motiva datasource add <type>        Register a new data source (file | http_api)
  motiva datasource list              List all registered data sources
  motiva datasource remove <id>       Remove a data source by ID

Options (motiva run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli (default: claude_api)

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

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands

Examples:
  motiva goal add "Increase test coverage to 90%"
  motiva goal list
  motiva run --goal <id>
  motiva status --goal <id>
  motiva report --goal <id>
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
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
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
