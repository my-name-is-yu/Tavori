// ─── CLI Shared Utilities ───

export async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    process.stdout.write(question);
    rl.once("line", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }
  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

export function printUsage(): void {
  console.log(`
PulSeed — AI agent orchestrator

Usage:
  pulseed run --goal <id>              Run CoreLoop for a goal
  pulseed improve [path]               Analyze path, suggest goals, and optionally run improvement loop
  pulseed suggest "<context>"          Suggest improvement goals for a project context
  pulseed goal add --title "<t>" --dim "name:type:val"  Register a goal (raw mode, no LLM)
  pulseed goal add "<description>"                      Register a goal via GoalRefiner (default)
  pulseed goal add "<description>" --no-refine          Register a goal via legacy LLM negotiation
  pulseed goal list                    List all registered goals
  pulseed goal list --archived         Also list archived goals
  pulseed goal archive <id>            Archive a completed goal (moves state to ~/.pulseed/archive/)
  pulseed goal remove <id>             Remove a goal by ID
  pulseed goal show <id>               Show goal details (dimensions, constraints, deadline)
  pulseed goal reset <id>              Reset goal state for re-running
  pulseed cleanup                      Archive all completed goals and remove stale data
  pulseed status --goal <id>           Show current status and progress
  pulseed report --goal <id>           Show latest report
  pulseed log --goal <id>              View observation and gap history log
  pulseed tui                          Launch the interactive TUI
  pulseed start --goal <id>            Start daemon mode for one or more goals
  pulseed stop                         Stop the running daemon
  pulseed cron --goal <id>             Print crontab entry for a goal
  pulseed config character             Show or update character configuration
  pulseed datasource add <type>        Register a new data source (file | http_api)
  pulseed datasource list              List all registered data sources
  pulseed datasource remove <id>       Remove a data source by ID
  pulseed capability list              List all registered capabilities
  pulseed capability remove <name>     Remove a capability by name
  pulseed knowledge list               List all shared knowledge entries
  pulseed knowledge search <query>     Search knowledge entries by keyword
  pulseed knowledge stats              Show knowledge base statistics
  pulseed plugin list                  List installed plugins
  pulseed plugin install <path>        Install a plugin from a local directory
  pulseed plugin remove <name>         Remove an installed plugin
  pulseed setup                        Interactive setup wizard (first-time configuration)
  pulseed provider show                Show current provider config
  pulseed provider set                 Set LLM provider and/or default adapter

Options (pulseed run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (pulseed improve):
  --auto                              Full auto mode (select best suggestion, run loop)
  --yes                               Auto-approve (select first suggestion, run loop)
  --max, -n <n>                       Max suggestions (default: 3)

Options (pulseed suggest):
  --max, -n <n>                       Max number of suggestions (default: 5)
  --path, -p <dir>                    Repo path to scan for additional context

Options (pulseed goal add):
  --title <title>                     Goal title (raw mode)
  --dim <name:type:value>             Dimension spec, repeatable (raw mode, e.g. "tsc_error_count:min:0")
  --no-refine                         Skip GoalRefiner, use legacy negotiate() instead
  --negotiate                         Alias: same as default (refine mode)
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (pulseed config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (pulseed datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (pulseed provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  PULSEED_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  pulseed goal add --title "tsc zero" --dim "tsc_error_count:min:0"
  pulseed goal add --title "clean code" --dim "todo_count:max:0" --dim "fixme_count:max:0"
  pulseed goal add "Increase test coverage to 90%"
  pulseed goal add "Increase test coverage to 90%" --no-refine
  pulseed goal list
  pulseed goal show <id>
  pulseed goal reset <id>
  pulseed run --goal <id>
  pulseed status --goal <id>
  pulseed report --goal <id>
  pulseed log --goal <id>
  pulseed config character --show
  pulseed config character --caution-level 3
  pulseed datasource add file --path /path/to/metrics.json --name "My Metrics"
  pulseed datasource add http_api --url https://api.example.com/metrics --name "API"
  pulseed datasource list
  pulseed datasource remove ds_1234567890
`.trim());
}

export function printCharacterConfig(config: {
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
