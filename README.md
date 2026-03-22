<div align="center">

# Conatus

### Give your AI agents the drive to persist.

[![CI](https://github.com/my-name-is-yu/Conatus/actions/workflows/ci.yml/badge.svg)](https://github.com/my-name-is-yu/Conatus/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/conatus.svg)](https://www.npmjs.com/package/conatus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Set a goal. Conatus observes the world, finds the gap, generates the next task, delegates it to any AI agent, verifies the result, and loops — until done.

<!-- TODO: Replace with actual demo recording -->
<br/>

*Demo video coming soon*

<br/>
</div>

## Quick Start

**1. Install Conatus (Node.js 20+):**

```bash
npm install -g conatus
```

**2. Set your API key:**

```bash
export OPENAI_API_KEY=sk-...

# Or use Anthropic
# export CONATUS_LLM_PROVIDER=anthropic
# export ANTHROPIC_API_KEY=sk-ant-...
```

**3. Set a goal and run:**

```bash
conatus goal add "Increase test coverage to 90%"
conatus run
conatus status
```

That's it. Conatus assesses feasibility, decomposes the goal into measurable dimensions, delegates tasks to agents, and tracks progress automatically.

## What is Conatus?

Conatus is a **task discovery engine**. You give it a long-term goal — "double revenue in 6 months," "keep my dog healthy" — and it pursues it autonomously. It observes, calculates the gap, generates tasks, delegates to AI agents, and verifies results. Then it loops.

**Conatus doesn't execute. It orchestrates.** Every action is delegated to external agents (Claude Code, OpenAI Codex, Browser Use, or your own adapter). Conatus's only direct operations are LLM calls for reasoning and state file read/write.

**Conatus knows when to stop.** It applies *satisficing* — when all goal dimensions cross their thresholds with sufficient evidence, the goal is complete. No runaway loops. No premature completion.

## Why Conatus?

- **Execution boundary** — Conatus never executes. It orchestrates and verifies. No runaway scripts.
- **Goal-driven, not prompt-driven** — Set a long-term goal with measurable thresholds. Conatus decomposes, delegates, observes, and loops.
- **Satisficing** — Stops when "good enough." Prevents infinite loops and wasted compute.
- **Asymmetric trust** — Failure costs 3x more than success rewards. Irreversible actions always require human approval.
- **Agent-agnostic** — Works with any AI agent. Swap agents without changing goals.

## Demos

### Code Quality Goal

> Goal = "Increase test coverage to 90% across the project"

Conatus observes current coverage, identifies untested modules, delegates test writing to a coding agent, and verifies results with actual test runs.

*Demo coming soon* · [Example goal config](docs/design/goal-negotiation.md)

### Revenue Target

> Goal = "Double monthly revenue within 6 months"

Conatus tracks revenue metrics, identifies growth opportunities, delegates research and implementation tasks, and measures real outcomes.

*Demo coming soon*

### Health Monitoring

> Goal = "Keep my dog healthy and happy"

Conatus monitors health indicators, schedules vet checkups, tracks nutrition, and escalates to you when human judgment is needed.

*Demo coming soon*

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

## Supported Adapters

| Adapter | Type | Use Case |
|---------|------|----------|
| `claude_code_cli` | CLI | Code execution, file operations |
| `openai_codex_cli` | CLI | Code execution, file operations |
| `browser_use_cli` | CLI | Web browsing, scraping, form filling |
| `claude_api` | LLM API | Text generation, analysis |
| `github_issue` | REST API | Issue creation, search |
| `a2a` | A2A Protocol | Remote agent delegation |

Custom adapters can be added as [plugins](docs/design/plugin-development-guide.md) in `~/.conatus/plugins/`.

## Programmatic Usage

```typescript
import { CoreLoop, StateManager } from "conatus";

const stateManager = new StateManager("~/.conatus");
const loop = new CoreLoop({ stateManager, /* ...adapters */ });
await loop.runOnce();
```

## CLI

| Command | Description |
|---------|-------------|
| `conatus goal add "<goal>"` | Negotiate and register a new goal |
| `conatus goal list` | List all goals with status |
| `conatus run` | Run one core loop iteration |
| `conatus status` | Show progress, gaps, trust scores |
| `conatus report` | Display latest report |
| `conatus cleanup` | Archive completed goals |
| `conatus datasource add/list/remove` | Manage data sources |

## FAQ

**How does Conatus verify progress?**

3-layer verification: mechanical checks (test results, file diffs, metrics) first, then independent LLM review, then executor self-report. Self-report alone caps progress at 70%.

**Is it safe? Can it run dangerous commands?**

Trust is asymmetric: failure costs -10, success only +3. Irreversible actions always require human approval regardless of trust level. Every goal also passes through an ethics gate before execution begins.

**What happens when it gets stuck?**

Stall detection uses four indicators. Responses are graduated: try a different approach, pivot strategy, then escalate to human. No infinite loops.

**Can I use it for free?**

Yes. Conatus is open source and free. You only need an LLM API key (OpenAI or Anthropic).

## Development

```bash
git clone https://github.com/my-name-is-yu/Conatus.git
cd Conatus
npm install
npm run build
npm test
```

State: `~/.conatus/` · Reports: `~/.conatus/reports/` · Ethics logs: `~/.conatus/ethics/`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

Conatus stores all state locally. No telemetry. No phone-home. Your LLM provider is the only external connection.

[MIT License](LICENSE)

---

**Tell your agents what to achieve, not what to do.**
