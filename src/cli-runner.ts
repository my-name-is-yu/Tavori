#!/usr/bin/env node
// ─── CLIRunner ───
//
// Motiva CLI entry point. Wires all dependencies and exposes subcommands:
//   motiva run --goal <id>            Run CoreLoop once for a given goal
//   motiva goal add "<description>"   Negotiate and register a new goal (interactive)
//   motiva goal list                  List all registered goals
//   motiva status --goal <id>         Show current progress report
//   motiva report --goal <id>         Show latest report

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";

import { StateManager } from "./state-manager.js";
import { LLMClient } from "./llm-client.js";
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
import * as GapCalculator from "./gap-calculator.js";
import * as DriveScorer from "./drive-scorer.js";
import type { GapCalculatorModule, DriveScorerModule, LoopConfig } from "./core-loop.js";
import type { Task } from "./types/task.js";

// ─── CLIRunner ───

export class CLIRunner {
  private readonly stateManager: StateManager;
  private activeCoreLoop: CoreLoop | null = null;

  constructor(baseDir?: string) {
    this.stateManager = new StateManager(baseDir);
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

  private buildDeps(apiKey: string, config?: LoopConfig, approvalFn?: (task: Task) => Promise<boolean>) {
    const stateManager = this.stateManager;
    const llmClient = new LLMClient(apiKey);
    const trustManager = new TrustManager(stateManager);
    const driveSystem = new DriveSystem(stateManager);
    const observationEngine = new ObservationEngine(stateManager);
    const stallDetector = new StallDetector(stateManager);
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

    const reportingEngine = new ReportingEngine(stateManager);

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
      observationEngine
    );

    return { coreLoop, goalNegotiator, reportingEngine };
  }

  // ─── Subcommands ───

  private async cmdRun(
    goalId: string,
    loopConfig?: LoopConfig
  ): Promise<number> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
          "Set it with: export ANTHROPIC_API_KEY=<your-key>"
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
    if (!apiKey) {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
          "Set it with: export ANTHROPIC_API_KEY=<your-key>"
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

Options (motiva run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli (default: claude_api)

Options (motiva goal add):
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands

Examples:
  motiva goal add "Increase test coverage to 90%"
  motiva goal list
  motiva run --goal <id>
  motiva status --goal <id>
  motiva report --goal <id>
`.trim());
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
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli-runner.js") || process.argv[1].endsWith("cli-runner.ts"));

if (isMain) {
  main();
}
