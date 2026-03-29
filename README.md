<div align="center">

<img src="assets/seedy.png" alt="Seedy — PulSeed mascot" width="120" />

# PulSeed

### Give your AI agents the drive to persist.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue)](https://pulseed.dev)
[![CI](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml/badge.svg)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pulseed.svg)](https://www.npmjs.com/package/pulseed)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Set a goal. PulSeed observes the world, finds the gap, generates the next task, delegates it to any AI agent, verifies the result, and loops — until done.

The project is documented for local use; follow the Quick Start steps to run PulSeed from source or as an installed CLI. For a guided walkthrough, see [Getting Started](docs/getting-started.md).

<br/>
</div>

## Quick Start

**1. Install PulSeed (Node.js 20+):**

```bash
npm install -g pulseed
```

**2. Set your API key:**

```bash
export OPENAI_API_KEY=sk-...

# Or use Anthropic
# export PULSEED_LLM_PROVIDER=anthropic
# export ANTHROPIC_API_KEY=sk-ant-...
```

**3. Set a goal and run:**

```bash
pulseed goal add "Increase test coverage to 90%"
pulseed run
pulseed status
```

That's it. PulSeed assesses feasibility, decomposes the goal into measurable dimensions, delegates tasks to agents, and tracks progress automatically.

> **Using OpenClaw?** Install the official plugin for seamless integration — see [`@pulseed/openclaw-plugin`](openclaw-plugin/README.md).

## What is PulSeed?

PulSeed is a **task discovery engine**. You give it a long-term goal — "double revenue in 6 months," "keep my dog healthy" — and it pursues it autonomously. It observes, calculates the gap, generates tasks, delegates to AI agents, and verifies results. Then it loops.

**PulSeed doesn't execute. It orchestrates.** Every action is delegated to external agents (Claude Code, OpenAI Codex, Browser Use, or your own adapter). PulSeed's only direct operations are LLM calls for reasoning and state file read/write.

**PulSeed knows when to stop.** It applies *satisficing* — when all goal dimensions cross their thresholds with sufficient evidence, the goal is complete. No runaway loops. No premature completion.

## Why PulSeed?

- **Execution boundary** — PulSeed never executes. It orchestrates and verifies. No runaway scripts.
- **Goal-driven, not prompt-driven** — Set a long-term goal with measurable thresholds. PulSeed decomposes, delegates, observes, and loops.
- **Satisficing** — Stops when "good enough." Prevents infinite loops and wasted compute.
- **Asymmetric trust** — Failure costs 3x more than success rewards. Irreversible actions always require human approval.
- **Agent-agnostic** — Works with any AI agent. Swap agents without changing goals.

## Demos

### Code Quality Goal

> Goal = "Increase test coverage to 90% across the project"

PulSeed observes current coverage, identifies untested modules, delegates test writing to a coding agent, and verifies results with actual test runs.

See [docs/usecase.md](docs/usecase.md) for full walkthroughs · [Example goal config](docs/design/goal-negotiation.md)

### Revenue Target

> Goal = "Double monthly revenue within 6 months"

PulSeed tracks revenue metrics, identifies growth opportunities, delegates research and implementation tasks, and measures real outcomes.

See [docs/usecase.md](docs/usecase.md) for full walkthroughs.

### Health Monitoring

> Goal = "Keep my dog healthy and happy"

PulSeed monitors health indicators, schedules vet checkups, tracks nutrition, and escalates to you when human judgment is needed.

See [docs/usecase.md](docs/usecase.md) for full walkthroughs.

### OpenClaw Integration

> "Migrate all source files from CommonJS to ESM with TypeScript"

PulSeed detects the goal in your OpenClaw conversation, spawns agent sessions, tracks file-by-file migration progress, and auto-completes when done.

See [docs/usecase.md](docs/usecase.md) for full walkthroughs.

## How It Works

The core loop runs at each goal node:

```
Observe → Gap → Score → Task → Execute → Verify → Loop
```

1. **Observe** — 3-layer evidence collection (mechanical checks, LLM review, self-report)
2. **Gap** — quantify how far current state is from the goal threshold
3. **Score** — prioritize by dissatisfaction, deadline urgency, and opportunity
4. **Task** — LLM generates a concrete, verifiable task
5. **Execute** — delegate to the selected agent adapter
6. **Verify** — 3-layer result verification; pass, partial, or fail

For detailed architecture, see [docs/architecture-map.md](docs/architecture-map.md).

## Loop-Stall Prevention

SeedPulse includes built-in stall detection to prevent loops from spinning without progress. When repeated cycles produce no measurable movement on a goal node, the orchestrator records the stall, changes the plan, and stops treating repetition as progress. See [Stall Detection Design](docs/design/stall-detection.md) for details.

## Supported Adapters

| Adapter | Type | Use Case |
|---------|------|----------|
| `openclaw_gateway` | OpenClaw Gateway | Goal detection, agent orchestration, progress tracking |
| `claude_code_cli` | CLI | Code execution, file operations |
| `openai_codex_cli` | CLI | Code execution, file operations |
| `browser_use_cli` | CLI | Web browsing, scraping, form filling |
| `claude_api` | LLM API | Text generation, analysis |
| `github_issue` | REST API | Issue creation, search |
| `a2a` | A2A Protocol | Remote agent delegation |

Custom adapters can be added as [plugins](docs/design/plugin-development-guide.md) in `~/.pulseed/plugins/`.

## Plugins & Integrations

| Plugin | Description | Status |
|--------|-------------|--------|
| [`@pulseed/openclaw-plugin`](openclaw-plugin/) | OpenClaw Gateway — goal detection, agent orchestration, progress tracking | ✅ Stable |
| [`@pulseed/slack-notifier`](plugins/slack-notifier/) | Slack notifications for goal events | ✅ Stable |

See [Plugin Development Guide](docs/design/plugin-development-guide.md) for creating custom plugins.

## Programmatic Usage

```typescript
import { CoreLoop, StateManager } from "pulseed";

const stateManager = new StateManager("~/.pulseed");
const loop = new CoreLoop({ stateManager, /* ...adapters */ });
await loop.runOnce();
```

## CLI

| Command | Description |
|---------|-------------|
| `pulseed goal add "<goal>"` | Negotiate and register a new goal |
| `pulseed goal list` | List all goals with status |
| `pulseed run` | Run one core loop iteration |
| `pulseed status` | Show progress, gaps, trust scores |
| `pulseed report` | Display latest report |
| `pulseed cleanup` | Archive completed goals |
| `pulseed datasource add/list/remove` | Manage data sources |

## FAQ

**How does PulSeed verify progress?**

3-layer verification: mechanical checks (test results, file diffs, metrics) first, then independent LLM review, then executor self-report. Self-report alone caps progress at 70%.

**Is it safe? Can it run dangerous commands?**

Trust is asymmetric: failure costs -10, success only +3. Irreversible actions always require human approval regardless of trust level. Every goal also passes through an ethics gate before execution begins.

**What happens when it gets stuck?**

Stall detection uses four indicators. Responses are graduated: try a different approach, pivot strategy, then escalate to human. No infinite loops.

**Can I use it for free?**

Yes. PulSeed is open source and free. You only need an LLM API key (OpenAI or Anthropic).

## Development

```bash
git clone https://github.com/my-name-is-yu/PulSeed.git
cd PulSeed
npm install
npm run build
npm test
```

State: `~/.pulseed/` · Reports: `~/.pulseed/reports/` · Ethics logs: `~/.pulseed/ethics/`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

PulSeed stores all state locally. No telemetry. No phone-home. Your LLM provider is the only external connection.

[MIT License](LICENSE)

---

**Tell your agents what to achieve, not what to do.**
