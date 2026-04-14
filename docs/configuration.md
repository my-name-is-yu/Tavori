# Configuration

This document reflects the current public configuration surface.

## 1. First-run recommendation

Use the main entry point:

```bash
pulseed
```

PulSeed guides configuration from the interactive flow when needed.
The configuration flow chooses:

- provider
- model
- default adapter
- native `agent_loop` options such as worktree behavior

PulSeed stores the persistent result in `~/.pulseed/provider.json`.

## 2. Recommended default

For most users, the recommended default is:

- provider: OpenAI or Anthropic
- adapter: `agent_loop`

That enables PulSeed's native bounded AgentLoop runtime for task execution and chat when the chosen model supports tool calling.

## 3. `~/.pulseed/provider.json`

Typical shape:

```json
{
  "provider": "openai",
  "model": "gpt-5.4-mini",
  "adapter": "agent_loop",
  "api_key": "sk-...",
  "agent_loop": {
    "worktree": {
      "enabled": true,
      "base_dir": "~/.pulseed/worktrees",
      "keep_for_debug": false,
      "cleanup_policy": "on_success"
    }
  }
}
```

Important top-level fields:

- `provider`: `openai`, `anthropic`, or `ollama`
- `model`: provider-specific model name
- `adapter`: `agent_loop`, `openai_codex_cli`, `claude_code_cli`, `openai_api`, `claude_api`, or other registered adapters
- `api_key`: when required by the provider
- `base_url`: optional provider override
- `terminal_backend`: optional backend for supported CLI execution adapters

Important `agent_loop` field:

- `agent_loop.worktree`: worktree policy for native task execution

Optional `terminal_backend` shape for CLI adapters:

```json
{
  "adapter": "openai_codex_cli",
  "terminal_backend": {
    "type": "docker",
    "docker": {
      "image": "node:22",
      "network": "none",
      "workdir": "/workspace"
    }
  }
}
```

When omitted, PulSeed uses the local process backend. The Docker backend wraps supported CLI adapters in `docker run`, mounts the task cwd at the configured workdir, and defaults network access to `none`.

## 4. Environment variables

Environment variables override file config.

### Provider selection

| Variable | Meaning |
|---|---|
| `PULSEED_LLM_PROVIDER` | Provider override: `openai`, `anthropic`, `ollama` |
| `OPENAI_API_KEY` | OpenAI key |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible endpoint override |
| `OLLAMA_BASE_URL` | Optional Ollama endpoint override |

### Notes

- Native `agent_loop` is supported by both OpenAI-backed and Anthropic-backed tool-calling models in the current implementation
- Some models are usable through API adapters but not a CLI adapter, or vice versa
- interactive configuration through `pulseed` is safer than editing config by hand because it validates provider and adapter combinations

## 5. Adapter choices

Current public adapter choices:

| Adapter | Meaning |
|---|---|
| `agent_loop` | PulSeed's native bounded tool-using agent runtime |
| `openai_codex_cli` | External Codex CLI adapter |
| `claude_code_cli` | External Claude Code CLI adapter |
| `openai_api` | API-based execution path |
| `claude_api` | API-based execution path |
| `github_issue` | Issue-handoff style execution |

When to prefer `agent_loop`:

- you want one runtime model for chat and task execution
- you want bounded tool use, compaction, and traces inside PulSeed
- you want worktree support through native task execution

## 6. Worktree configuration

Native `agent_loop` task execution can prepare a dedicated worktree.

Public knobs:

- `enabled`
- `base_dir`
- `keep_for_debug`
- `cleanup_policy`

Operational meaning:

- when enabled, task execution can run in a separate worktree instead of mutating the primary workspace directly
- when `keep_for_debug` is true, PulSeed leaves the worktree behind for inspection

## 7. Local state layout

PulSeed stores runtime state under `~/.pulseed/`.

Common directories:

- `goals/`
- `tasks/`
- `reports/`
- `runtime/`
- `schedules.json`
- `memory/`
- `chat/`
- `plugins/`

Depending on the features in use, you may also see:

- checkpoints
- runtime health snapshots
- Soil projections and indexes
- schedule suggestions and approval state

## 8. Skills

PulSeed discovers local skills from:

- `~/.pulseed/skills/**/SKILL.md`
- `<workspace>/skills/**/SKILL.md`

Scriptable commands:

| Command | Purpose |
|---|---|
| `pulseed skills list` | List discovered skills |
| `pulseed skills search <query>` | Search skill name, id, description, or path |
| `pulseed skills show <id>` | Print one skill file |
| `pulseed skills install <path>` | Copy a local `SKILL.md` into `~/.pulseed/skills/imported/` |

The runtime also exposes `skill_search` as a read-only built-in tool.

## 9. Channel security and routing

Bundled chat plugins accept allow/deny and route settings while preserving their existing config fields.

Common fields:

- `allowed_sender_ids` / `denied_sender_ids`
- `allowed_conversation_ids` / `denied_conversation_ids` for group or channel transports
- `runtime_control_allowed_sender_ids`
- `conversation_goal_map`, `sender_goal_map`, and `default_goal_id`

Telegram keeps its numeric legacy fields and adds numeric equivalents:

- `allowed_user_ids`, `denied_user_ids`
- `allowed_chat_ids`, `denied_chat_ids`
- `runtime_control_allowed_user_ids`
- `chat_goal_map`, `user_goal_map`, and `default_goal_id`

## 10. Main command

```bash
pulseed
```

The default workflow is natural language. Ask PulSeed to configure providers, show current settings, create goals, check progress, or keep work running.

## 11. Scriptable CLI surface

Lower-level commands exist for automation, diagnostics, and compatibility. They are not the primary user path.

Common scriptable commands:

| Command | Purpose |
|---|---|
| `pulseed setup` | Configure provider, model, and adapter |
| `pulseed goal add "<text>"` | Create a goal |
| `pulseed run --goal <id>` | Execute CoreLoop for one goal |
| `pulseed status --goal <id>` | Inspect goal state |
| `pulseed report --goal <id>` | Read the latest report |
| `pulseed task list --goal <id>` | Inspect tasks |
| `pulseed tui` | Start the terminal UI |
| `pulseed start --goal <id>` | Start the daemon |
| `pulseed stop` | Stop the daemon |
| `pulseed cron --goal <id>` | Print a cron entry |
| `pulseed schedule list` | List schedule entries |
| `pulseed schedule show <id>` | Inspect one schedule entry |
| `pulseed schedule edit <id>` | Edit a schedule entry's name, trigger, enabled state, or layer config |
| `pulseed schedule pause <id>` | Pause a schedule without deleting it |
| `pulseed schedule resume <id>` | Resume a paused schedule |
| `pulseed schedule run <id>` | Run a schedule entry immediately, using the resident daemon when it is running |
| `pulseed schedule history <id>` | Show recent schedule execution history |
| `pulseed skills list` | List discovered skills |
| `pulseed skills install <path>` | Install a local skill file |

## 12. Practical guidance

- Start with `agent_loop` unless you specifically want an external agent CLI
- Start from `pulseed` after pulling new versions, because provider defaults may evolve
- Treat `src/` and `provider.json` as the implementation truth when deeper docs disagree
