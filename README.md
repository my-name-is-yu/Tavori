<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

### Goal-driven orchestration with a long-lived CoreLoop and a tool-using AgentLoop.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue)](https://pulseed.dev)
[![CI](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml/badge.svg)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pulseed.svg)](https://www.npmjs.com/package/pulseed)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<<<<<<< HEAD
Set a goal. Seedy takes it from there with a long-lived `CoreLoop` for goal control and a bounded `AgentLoop` for tool-using task execution.

<br/>
=======
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
</div>

PulSeed is an AI agent orchestrator for long-running goals.

It separates two loops:

- `CoreLoop`: long-lived control over goals, completion, prioritization, stall handling, replanning, goal trees, and multi-goal scheduling
- `AgentLoop`: bounded tool-using execution for tasks, chat turns, and selected CoreLoop phases

The result is a system that can keep pursuing a goal over time without reducing everything to a single chat session.

## What PulSeed Does

- Tracks goals as measurable dimensions instead of ad hoc prompts
- Chooses what to do next from evidence, gaps, and drive scores
- Runs task execution through adapters or the native `agent_loop`
- Uses tools directly for observation, verification, knowledge refresh, and chat
- Stores persistent state, memory, reports, schedules, and runtime health locally
- Supports tree mode, multi-goal mode, daemon mode, TUI, and chat mode

## Architecture in One Page

PulSeed now runs on four layers:

1. Goal state and persistence: goals, tasks, schedules, memory, runtime store
2. CoreLoop: observe, score, decide, detect stalls, trigger agentic phases, judge completion
3. AgentLoop: model chooses tools, sees tool results, compacts context when needed, and returns a bounded result
4. Tools and adapters: filesystem, shell, git, test runner, web fetch/search, Soil, schedule, state mutation, external agents

The native `agent_loop` is the default direction for both task execution and chat when the configured model supports tool calling.

## Quick Start

Node.js 20+ is required.

```bash
npm install -g pulseed
```

Run setup once:

```bash
pulseed setup
```

Create a goal:

```bash
pulseed goal add "Increase test coverage to 90%"
```

<<<<<<< HEAD
Seedy assesses feasibility, breaks the goal down, runs the core loop, and uses bounded agent execution where it needs tool-driven work.

> **Using OpenClaw?** Install the official plugin for seamless integration — see [`@pulseed/openclaw-plugin`](openclaw-plugin/README.md).

## Demos

**Code Quality** — "Increase test coverage to 90%." Seedy observes current coverage, identifies untested modules, delegates test writing to a coding agent, and verifies with real test runs.

**Revenue Target** — "Double monthly revenue within 6 months." Seedy tracks revenue metrics, identifies growth opportunities, delegates research and implementation, and measures actual outcomes.

**Health Monitoring** — "Keep my dog healthy." Seedy monitors health indicators, schedules vet checkups, tracks nutrition, and escalates when human judgment is needed.

More examples in [docs/usecase.md](docs/usecase.md).

## Features

- **Dual-loop runtime** — `CoreLoop` for long-lived control, `AgentLoop` for bounded execution
- **Goal-driven orchestration** — Set a destination, not step-by-step instructions
- **Agent-agnostic** — Swap agents without changing goals
- **Satisficing** — Knows when "good enough" is enough
- **Asymmetric trust** — Failure costs more than success; safety by default
- **Stall detection** — Detects loops and changes strategy automatically
- **Plugin system** — Extend with custom adapters, notifiers, and data sources
- **Goal trees** — Decompose large goals into sub-goals, each tracked independently
- **TUI dashboard** — Real-time terminal UI with progress, logs, and approval flow

Deep dive: [Architecture Map](docs/architecture-map.md) | [How it works](docs/mechanism.md) | [Current Design Baseline](docs/design/current-baseline.md)

## Adapters

| Adapter | Type | Use Case |
|---------|------|----------|
| `openclaw_gateway` | OpenClaw Gateway | Goal detection, agent orchestration |
| `claude_code_cli` | CLI | Code execution, file operations |
| `openai_codex_cli` | CLI | Code execution, file operations |
| `claude_api` | LLM API | Text generation, analysis |
| `github_issue` | REST API | Issue creation, search |
| `a2a` | A2A Protocol | Remote agent delegation |

Custom adapters: [Plugin Development Guide](docs/design/infrastructure/plugin-development-guide.md)

## Plugins

| Plugin | Description |
|--------|-------------|
| [`@pulseed/openclaw-plugin`](openclaw-plugin/) | OpenClaw Gateway — goal detection, agent orchestration, progress tracking |
| [`@pulseed/slack-notifier`](plugins/slack-notifier/) | Slack notifications for goal events |

## Getting Started (Developers)

**Programmatic usage:**

```typescript
import { CoreLoop, StateManager } from "pulseed";

const stateManager = new StateManager("~/.pulseed");
const loop = new CoreLoop({ stateManager, /* ...deps */ });
await loop.run("goal_abc123", { maxIterations: 1 });
```

**CLI reference:** See [docs/getting-started.md](docs/getting-started.md) for the full command list.

**Development setup:**
=======
Run one loop:
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)

```bash
pulseed run --goal <goal-id>
```

Check state:

```bash
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
```

Start the resident runtime:

```bash
pulseed start --goal <goal-id>
pulseed stop
```

Open chat mode:

```bash
pulseed chat
```

Open the TUI:

```bash
pulseed tui
```

## Current Loop Model

### CoreLoop

`CoreLoop` is the long-lived controller. It decides whether a goal is done, stalled, needs refinement, or should keep going.

Important behavior already wired in:

- evidence-driven observation and verification
- gap aggregation and drive scoring
- task lifecycle integration
- tree-mode node selection
- multi-goal scheduling
- stall analysis and refine/pivot decisions
- agentic core phases:
  - `observe_evidence`
  - `knowledge_refresh`
  - `replanning_options`
  - `stall_investigation`
  - `verification_evidence`
- next-iteration directives that bias the next tree or multi-goal selection toward the right node/goal

### AgentLoop

`AgentLoop` is the short-to-mid horizon executor.

It is used in:

- task execution via the native `agent_loop` adapter
- `pulseed chat`
- selected CoreLoop phases that need bounded tool use

Important behavior already wired in:

- tool calling with allow/require policy
- bounded turns, tool calls, wall clock, and repeated-call guards
- completion gating
- context compaction
- optional worktree execution
- trace/session persistence
- command result capture for later verification

## Soil and Memory

PulSeed exposes Soil as a readable memory surface for both humans and agents.

- `soil_query` is available to AgentLoop and CoreLoop phases
- Soil pages are derived, publishable views over local state and memory
- Agents can use Soil alongside runtime state, task history, knowledge, and memory recall

This is the main path that lets the resident system's long-term memory stay usable inside short-lived agent turns.

## Main Commands

```bash
pulseed setup
pulseed goal add "<description>"
pulseed goal list
pulseed goal show <id>
pulseed run --goal <id>
pulseed start --goal <id>
pulseed stop
pulseed cron --goal <id>
pulseed status --goal <id>
pulseed report --goal <id>
pulseed task list --goal <id>
pulseed chat
pulseed tui
```

## Programmatic Usage

```ts
import { CLIRunner } from "pulseed";

const runner = new CLIRunner();
await runner.run(["goal", "add", "Increase test coverage to 90%"]);
await runner.run(["run", "--goal", "goal-id"]);
```

For direct `CoreLoop` construction, use PulSeed's DI assembly in the CLI/TUI setup path rather than manually wiring every dependency.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Mechanism](docs/mechanism.md)
- [Runtime](docs/runtime.md)
- [Architecture Map](docs/architecture-map.md)
- [Module Map](docs/module-map.md)
- [Configuration](docs/configuration.md)
- [Status](docs/status.md)

## Notes

- State is local-first under `~/.pulseed/`
- The only external network calls are the providers, plugins, and tools you configure
- Historical design docs remain under `docs/design/`; current implementation truth is in `src/`

## License

[MIT License](LICENSE)
