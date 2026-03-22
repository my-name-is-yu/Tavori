// ─── CLI Shared Utilities ───

export function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }
  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

export function printUsage(): void {
  console.log(`
Conatus — AI agent orchestrator

Usage:
  conatus run --goal <id>              Run CoreLoop for a goal
  conatus improve [path]               Analyze path, suggest goals, and optionally run improvement loop
  conatus suggest "<context>"          Suggest improvement goals for a project context
  conatus goal add --title "<t>" --dim "name:type:val"  Register a goal (raw mode, no LLM)
  conatus goal add "<description>" --negotiate          Register a goal via LLM negotiation
  conatus goal list                    List all registered goals
  conatus goal list --archived         Also list archived goals
  conatus goal archive <id>            Archive a completed goal (moves state to ~/.conatus/archive/)
  conatus goal remove <id>             Remove a goal by ID
  conatus goal show <id>               Show goal details (dimensions, constraints, deadline)
  conatus goal reset <id>              Reset goal state for re-running
  conatus cleanup                      Archive all completed goals and remove stale data
  conatus status --goal <id>           Show current status and progress
  conatus report --goal <id>           Show latest report
  conatus log --goal <id>              View observation and gap history log
  conatus tui                          Launch the interactive TUI
  conatus start --goal <id>            Start daemon mode for one or more goals
  conatus stop                         Stop the running daemon
  conatus cron --goal <id>             Print crontab entry for a goal
  conatus config character             Show or update character configuration
  conatus datasource add <type>        Register a new data source (file | http_api)
  conatus datasource list              List all registered data sources
  conatus datasource remove <id>       Remove a data source by ID
  conatus capability list              List all registered capabilities
  conatus capability remove <name>     Remove a capability by name
  conatus plugin list                  List installed plugins
  conatus plugin install <path>        Install a plugin from a local directory
  conatus plugin remove <name>         Remove an installed plugin
  conatus provider show                Show current provider config
  conatus provider set                 Set LLM provider and/or default adapter

Options (conatus run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (conatus improve):
  --auto                              Full auto mode (select best suggestion, run loop)
  --yes                               Auto-approve (select first suggestion, run loop)
  --max, -n <n>                       Max suggestions (default: 3)

Options (conatus suggest):
  --max, -n <n>                       Max number of suggestions (default: 5)
  --path, -p <dir>                    Repo path to scan for additional context

Options (conatus goal add):
  --title <title>                     Goal title (raw mode)
  --dim <name:type:value>             Dimension spec, repeatable (raw mode, e.g. "tsc_error_count:min:0")
  --negotiate                         Use LLM negotiation instead of raw mode
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (conatus config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (conatus datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (conatus provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  CONATUS_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  conatus goal add --title "tsc zero" --dim "tsc_error_count:min:0"
  conatus goal add --title "clean code" --dim "todo_count:max:0" --dim "fixme_count:max:0"
  conatus goal add "Increase test coverage to 90%" --negotiate
  conatus goal list
  conatus goal show <id>
  conatus goal reset <id>
  conatus run --goal <id>
  conatus status --goal <id>
  conatus report --goal <id>
  conatus log --goal <id>
  conatus config character --show
  conatus config character --caution-level 3
  conatus datasource add file --path /path/to/metrics.json --name "My Metrics"
  conatus datasource add http_api --url https://api.example.com/metrics --name "API"
  conatus datasource list
  conatus datasource remove ds_1234567890
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
