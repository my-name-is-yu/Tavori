// ─── CLI Shared Utilities ───

export function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }
  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

export function printUsage(): void {
  console.log(`
SeedPulse — AI agent orchestrator

Usage:
  seedpulse run --goal <id>              Run CoreLoop for a goal
  seedpulse improve [path]               Analyze path, suggest goals, and optionally run improvement loop
  seedpulse suggest "<context>"          Suggest improvement goals for a project context
  seedpulse goal add --title "<t>" --dim "name:type:val"  Register a goal (raw mode, no LLM)
  seedpulse goal add "<description>"                      Register a goal via GoalRefiner (default)
  seedpulse goal add "<description>" --no-refine          Register a goal via legacy LLM negotiation
  seedpulse goal list                    List all registered goals
  seedpulse goal list --archived         Also list archived goals
  seedpulse goal archive <id>            Archive a completed goal (moves state to ~/.seedpulse/archive/)
  seedpulse goal remove <id>             Remove a goal by ID
  seedpulse goal show <id>               Show goal details (dimensions, constraints, deadline)
  seedpulse goal reset <id>              Reset goal state for re-running
  seedpulse cleanup                      Archive all completed goals and remove stale data
  seedpulse status --goal <id>           Show current status and progress
  seedpulse report --goal <id>           Show latest report
  seedpulse log --goal <id>              View observation and gap history log
  seedpulse tui                          Launch the interactive TUI
  seedpulse start --goal <id>            Start daemon mode for one or more goals
  seedpulse stop                         Stop the running daemon
  seedpulse cron --goal <id>             Print crontab entry for a goal
  seedpulse config character             Show or update character configuration
  seedpulse datasource add <type>        Register a new data source (file | http_api)
  seedpulse datasource list              List all registered data sources
  seedpulse datasource remove <id>       Remove a data source by ID
  seedpulse capability list              List all registered capabilities
  seedpulse capability remove <name>     Remove a capability by name
  seedpulse knowledge list               List all shared knowledge entries
  seedpulse knowledge search <query>     Search knowledge entries by keyword
  seedpulse knowledge stats              Show knowledge base statistics
  seedpulse plugin list                  List installed plugins
  seedpulse plugin install <path>        Install a plugin from a local directory
  seedpulse plugin remove <name>         Remove an installed plugin
  seedpulse setup                        Interactive setup wizard (first-time configuration)
  seedpulse provider show                Show current provider config
  seedpulse provider set                 Set LLM provider and/or default adapter

Options (seedpulse run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (seedpulse improve):
  --auto                              Full auto mode (select best suggestion, run loop)
  --yes                               Auto-approve (select first suggestion, run loop)
  --max, -n <n>                       Max suggestions (default: 3)

Options (seedpulse suggest):
  --max, -n <n>                       Max number of suggestions (default: 5)
  --path, -p <dir>                    Repo path to scan for additional context

Options (seedpulse goal add):
  --title <title>                     Goal title (raw mode)
  --dim <name:type:value>             Dimension spec, repeatable (raw mode, e.g. "tsc_error_count:min:0")
  --no-refine                         Skip GoalRefiner, use legacy negotiate() instead
  --negotiate                         Alias: same as default (refine mode)
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (seedpulse config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (seedpulse datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (seedpulse provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  SEEDPULSE_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  seedpulse goal add --title "tsc zero" --dim "tsc_error_count:min:0"
  seedpulse goal add --title "clean code" --dim "todo_count:max:0" --dim "fixme_count:max:0"
  seedpulse goal add "Increase test coverage to 90%"
  seedpulse goal add "Increase test coverage to 90%" --no-refine
  seedpulse goal list
  seedpulse goal show <id>
  seedpulse goal reset <id>
  seedpulse run --goal <id>
  seedpulse status --goal <id>
  seedpulse report --goal <id>
  seedpulse log --goal <id>
  seedpulse config character --show
  seedpulse config character --caution-level 3
  seedpulse datasource add file --path /path/to/metrics.json --name "My Metrics"
  seedpulse datasource add http_api --url https://api.example.com/metrics --name "API"
  seedpulse datasource list
  seedpulse datasource remove ds_1234567890
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
