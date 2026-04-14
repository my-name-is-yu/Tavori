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

Important `agent_loop` field:

- `agent_loop.worktree`: worktree policy for native task execution

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

## 8. Main command

```bash
pulseed
```

The default workflow is natural language. Ask PulSeed to configure providers, show current settings, create goals, check progress, or keep work running.

## 9. Scriptable CLI surface

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

## 10. Practical guidance

- Start with `agent_loop` unless you specifically want an external agent CLI
- Start from `pulseed` after pulling new versions, because provider defaults may evolve
- Treat `src/` and `provider.json` as the implementation truth when deeper docs disagree
