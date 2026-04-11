<div align="center">

<img src="assets/seedy.png" alt="Seedy — PulSeed mascot" width="120" />

# PulSeed

### An AI agent system that grows your goals from seed to tree.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue)](https://pulseed.dev)
[![CI](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml/badge.svg)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pulseed.svg)](https://www.npmjs.com/package/pulseed)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Set a goal. Seedy takes it from there — observing, planning, delegating to AI agents, and tracking progress until it's done.

<br/>
</div>

## What Can Seedy Do?

- **Track long-term goals with real measurable progress** — "Increase test coverage to 90%," "Double monthly revenue," "Keep my dog healthy." Seedy decomposes goals into dimensions, measures each one, and keeps going.
- **Delegate work to AI coding agents** — Claude Code, OpenAI Codex, OpenClaw, or your own custom adapter. Swap agents without changing goals.
- **Know when to stop** — Seedy applies satisficing: when every dimension crosses its threshold with enough evidence, the goal is complete. No infinite loops. No premature exits.
- **Stay safe** — Irreversible actions always need your approval. Trust is asymmetric: one failure costs more than three successes earn.

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

**3. Plant a goal and let Seedy grow it:**

```bash
pulseed goal add "Increase test coverage to 90%"
pulseed run
pulseed status
```

Seedy assesses feasibility, breaks the goal down, delegates tasks to agents, and tracks progress automatically.

> **Using OpenClaw?** Install the official plugin for seamless integration — see [`@pulseed/openclaw-plugin`](openclaw-plugin/README.md).

## Demos

**Code Quality** — "Increase test coverage to 90%." Seedy observes current coverage, identifies untested modules, delegates test writing to a coding agent, and verifies with real test runs.

**Revenue Target** — "Double monthly revenue within 6 months." Seedy tracks revenue metrics, identifies growth opportunities, delegates research and implementation, and measures actual outcomes.

**Health Monitoring** — "Keep my dog healthy." Seedy monitors health indicators, schedules vet checkups, tracks nutrition, and escalates when human judgment is needed.

More examples in [docs/usecase.md](docs/usecase.md).

## Features

- **Goal-driven orchestration** — Set a destination, not step-by-step instructions
- **Agent-agnostic** — Swap agents without changing goals
- **Satisficing** — Knows when "good enough" is enough
- **Asymmetric trust** — Failure costs more than success; safety by default
- **Stall detection** — Detects loops and changes strategy automatically
- **Plugin system** — Extend with custom adapters, notifiers, and data sources
- **Goal trees** — Decompose large goals into sub-goals, each tracked independently
- **TUI dashboard** — Real-time terminal UI with progress, logs, and approval flow

Deep dive: [Architecture Map](docs/architecture-map.md) | [How it works](docs/mechanism.md)

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
const loop = new CoreLoop({ stateManager, /* ...adapters */ });
await loop.runOnce();
```

**CLI reference:** See [docs/getting-started.md](docs/getting-started.md) for the full command list.

**Development setup:**

```bash
git clone https://github.com/my-name-is-yu/PulSeed.git
cd PulSeed
npm install
npm run build
npm test
```

State: `~/.pulseed/` | Reports: `~/.pulseed/reports/` | Ethics logs: `~/.pulseed/ethics/`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

PulSeed stores all state locally. No telemetry. No phone-home. Your LLM provider is the only external connection.

[MIT License](LICENSE)

---

**Plant the seed. Watch it grow.**
