# PulSeed Configuration Reference

---

## 1. Environment Variables

All variables are optional unless marked **required**.

### LLM Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `PULSEED_LLM_PROVIDER` | `openai` | Active provider: `openai`, `anthropic`, or `ollama` |
| `OPENAI_API_KEY` | — | **Required** when provider is `openai` |
| `OPENAI_MODEL` | `gpt-5.4-mini` | OpenAI model name. Note: `gpt-4o-mini` is not compatible with the `openai_codex_cli` adapter — use `gpt-5.4-mini` instead |
| `OPENAI_BASE_URL` | OpenAI default | Override for Azure OpenAI or a proxy (e.g., `https://<endpoint>.openai.azure.com/`) |
| `ANTHROPIC_API_KEY` | — | **Required** when provider is `anthropic`. Set to `dummy` when using Ollama to bypass the TUI startup check |

### Ollama (local LLM)

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL. Override when Ollama is running on another machine |

### Plugin / Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `PULSEED_CLI_PATH` | `pulseed` | Full path to the PulSeed CLI binary. Used by the `@pulseed/openclaw-plugin` when `pulseed` is not in `$PATH` |

### Notes

- The `o1` / `o3` / `o4` OpenAI reasoning model families do not accept a `temperature` parameter. PulSeed omits it automatically when calling these models.
- Reasoning models (`o3`, `o4-mini`) can be set via `OPENAI_MODEL` or `provider.json`. They tend to produce higher-quality goal decomposition at higher cost.
- You can also use a `.env` file at the project root. Confirm it is listed in `.gitignore` before committing.

```bash
# .env example — source with: set -a; source .env; set +a
PULSEED_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-5.4-mini
```

---

## 2. ~/.pulseed/ Directory Layout

All PulSeed runtime state lives under `~/.pulseed/`. The directory is created automatically on first run.

```
~/.pulseed/
├── provider.json            # LLM provider config (optional, see §3)
├── goals/                   # Active goal state (one file per goal)
├── reports/                 # Loop reports (Markdown)
├── ethics/                  # Ethics gate decision logs
├── plugins/                 # User-installed plugins (loaded at startup)
├── logs/
│   └── cron.log             # Output from cron-scheduled runs
└── memory/
    ├── short-term/
    │   └── goals/<goal_id>/
    │       ├── experience-log.json   # Raw experience log
    │       ├── observations.json     # Observation history
    │       ├── strategies.json       # Strategy history
    │       └── tasks.json            # Task history
    ├── long-term/
    │   ├── lessons/
    │   │   ├── by-goal/<goal_id>.json
    │   │   ├── by-dimension/<name>.json
    │   │   └── global.json
    │   └── statistics/<goal_id>.json
    └── archive/<goal_id>/   # Completed or cancelled goals
```

To wipe all state and start fresh:

```bash
rm -rf ~/.pulseed
```

---

## 3. provider.json

`~/.pulseed/provider.json` is an optional file that sets the LLM provider persistently. When present, its values are used as defaults; environment variables override them.

### Format

```json
{
  "provider": "openai | anthropic | ollama",
  "model": "<model-name>",
  "apiKey": "<your-api-key>"
}
```

### OpenAI example

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "apiKey": "sk-..."
}
```

### Anthropic example

```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-5",
  "apiKey": "sk-ant-..."
}
```

### Ollama (local LLM) example

No API key is needed. The `baseUrl` field overrides the default `http://localhost:11434`.

```json
{
  "provider": "ollama",
  "model": "qwen3:4b"
}
```

To connect to Ollama on a remote machine:

```json
{
  "provider": "ollama",
  "model": "qwen3:4b",
  "baseUrl": "http://192.168.1.50:11434"
}
```

### Model recommendations

| Use case | Recommended model |
|----------|------------------|
| Default / everyday use | `gpt-5.4-mini` (OpenAI) |
| Higher-quality reasoning | `gpt-4.1` or `o4-mini` (OpenAI) |
| Anthropic users | `claude-opus-4-5` |
| Local / offline | `qwen3:4b` via Ollama |

---

## 4. Plugin Configuration

Plugins extend PulSeed with new adapters, notifiers, and integrations. They are loaded from `~/.pulseed/plugins/` at startup.

### Installing a plugin

```bash
# Official plugin via npm
npm install -g @pulseed/slack-notifier

# Copy or symlink the plugin directory into ~/.pulseed/plugins/
# (plugins installed globally are auto-discovered if they follow the naming convention)
```

### Plugin directory structure

```
~/.pulseed/plugins/
└── my-plugin/
    ├── package.json
    └── index.js     # Must export a default function conforming to IPlugin
```

### Notable plugins

| Plugin | Description |
|--------|-------------|
| `@pulseed/openclaw-plugin` | OpenClaw Gateway — goal detection, agent orchestration, progress tracking |
| `@pulseed/slack-notifier` | Slack notifications for goal events |

The OpenClaw plugin reads `PULSEED_CLI_PATH` if `pulseed` is not in `$PATH`.

For building your own plugin, see [docs/design/plugin-development-guide.md](design/plugin-development-guide.md).

---

## 5. CLI Flags

Common flags available across multiple commands. Run `pulseed <command> --help` for the full flag list for any specific command.

### Global flags

| Flag | Description |
|------|-------------|
| `--goal <id>` | Goal ID to operate on. Required by `run`, `status`, `report`, `log`, `start`, `cron` |
| `--yes`, `-y` | Auto-approve all task prompts (non-interactive mode). Also auto-selects the first suggestion in `pulseed suggest` |
| `--adapter <type>` | Override the default adapter for this run. Valid: `claude_api`, `claude_code_cli`, `openai_codex_cli`, `openai_api`, `github_issue` |
| `--provider <name>` | Override the LLM provider for this run: `openai`, `anthropic`, `ollama` |
| `--model <name>` | Override the LLM model for this run |
| `--tree` | Run in goal-tree mode (used with multi-level goals) |

### Command reference

| Command | Description |
|---------|-------------|
| `pulseed goal add "<text>"` | Negotiate and register a new goal |
| `pulseed goal list` | List all goals with status |
| `pulseed goal show <id>` | Show goal details and dimensions |
| `pulseed goal archive <id>` | Archive a completed or abandoned goal |
| `pulseed suggest [path]` | Suggest goals based on the given path or current directory |
| `pulseed run --goal <id>` | Run one core loop iteration |
| `pulseed status --goal <id>` | Show progress, gaps, and trust scores |
| `pulseed report --goal <id>` | Display the latest report |
| `pulseed log --goal <id>` | View observation and gap history |
| `pulseed start --goal <id>` | Start daemon mode for continuous looping |
| `pulseed stop` | Stop the running daemon |
| `pulseed cron --goal <id>` | Print a crontab entry for scheduled runs |
| `pulseed tui` | Launch the interactive terminal UI |
| `pulseed setup` | Interactive provider and adapter setup wizard |
| `pulseed datasource add/list/remove` | Manage data sources |
| `pulseed task list --goal <id>` | List tasks for a goal |
| `pulseed task show <taskId> --goal <id>` | Show task details |
| `pulseed cleanup` | Archive all completed goals |

### setup wizard flags

```bash
pulseed setup --provider openai --model gpt-5.4-mini --adapter openai_codex_cli
```

Use `--provider`, `--model`, and `--adapter` to run setup non-interactively (useful in CI or scripts).
