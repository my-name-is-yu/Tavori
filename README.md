<div align="center">

# Tavori

### Give your AI agents the drive to persist.

[![CI](https://github.com/my-name-is-yu/Tavori/actions/workflows/ci.yml/badge.svg)](https://github.com/my-name-is-yu/Tavori/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tavori.svg)](https://www.npmjs.com/package/tavori)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Set a goal. Tavori observes the world, finds the gap, generates the next task, delegates it to any AI agent, verifies the result, and loops — until done.

The project is documented for local use; follow the Quick Start steps to run Tavori from source or as an installed CLI.

<br/>
</div>

## Quick Start

**1. Install Tavori (Node.js 20+):**

```bash
npm install -g tavori
```

**2. Set your API key:**

```bash
export OPENAI_API_KEY=sk-...

# Or use Anthropic
# export TAVORI_LLM_PROVIDER=anthropic
# export ANTHROPIC_API_KEY=sk-ant-...
```

**3. Set a goal and run:**

```bash
tavori goal add "Increase test coverage to 90%"
tavori run
tavori status
```

That's it. Tavori assesses feasibility, decomposes the goal into measurable dimensions, delegates tasks to agents, and tracks progress automatically.

## What is Tavori?

Tavori is a **task discovery engine**. You give it a long-term goal — "double revenue in 6 months," "keep my dog healthy" — and it pursues it autonomously. It observes, calculates the gap, generates tasks, delegates to AI agents, and verifies results. Then it loops.

**Tavori doesn't execute. It orchestrates.** Every action is delegated to external agents (Claude Code, OpenAI Codex, Browser Use, or your own adapter). Tavori's only direct operations are LLM calls for reasoning and state file read/write.

**Tavori knows when to stop.** It applies *satisficing* — when all goal dimensions cross their thresholds with sufficient evidence, the goal is complete. No runaway loops. No premature completion.

## Why Tavori?

- **Execution boundary** — Tavori never executes. It orchestrates and verifies. No runaway scripts.
- **Goal-driven, not prompt-driven** — Set a long-term goal with measurable thresholds. Tavori decomposes, delegates, observes, and loops.
- **Satisficing** — Stops when "good enough." Prevents infinite loops and wasted compute.
- **Asymmetric trust** — Failure costs 3x more than success rewards. Irreversible actions always require human approval.
- **Agent-agnostic** — Works with any AI agent. Swap agents without changing goals.

## Demos

### Code Quality Goal

> Goal = "Increase test coverage to 90% across the project"

Tavori observes current coverage, identifies untested modules, delegates test writing to a coding agent, and verifies results with actual test runs.

*Demo coming soon* · [Example goal config](docs/design/goal-negotiation.md)

### Revenue Target

> Goal = "Double monthly revenue within 6 months"

Tavori tracks revenue metrics, identifies growth opportunities, delegates research and implementation tasks, and measures real outcomes.

*Demo coming soon*

### Health Monitoring

> Goal = "Keep my dog healthy and happy"

Tavori monitors health indicators, schedules vet checkups, tracks nutrition, and escalates to you when human judgment is needed.

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

## Loop-Stall Prevention

Tavori runs the `Observe → Gap → Score → Task → Execute → Verify → Loop` cycle until the goal is complete or until the orchestrator must stop because progress cannot be made.

### Loop-Stall Prevention and Measurement

1. A **stall** is a run that exits because the orchestrator cannot make further measurable progress on the current goal node.
2. **Stall rate** is calculated as `stall_rate = stalled_runs / total_runs`, where `stalled_runs` is the number of runs that exited due to stall and `total_runs` is the number of finished runs in the same measurement window.
3. The **median observation-delegate-verify loop count for completed goals** is the median, across completed goals, of the number of `Observe → Delegate → Verify` cycles executed before each goal reaches completion.
4. The **changed-path regression rule** is: any change that affects stall behavior, loop stopping, goal-node progression, or verification outcomes must be covered by `npm run test:changed`, and that command must not introduce new stall-related failures.

The operator should stop the loop when any of these conditions is true:

1. The goal is complete, meaning the observed dimensions meet their thresholds with sufficient evidence.
2. `Verify` returns the same outcome for the same goal node after a changed task plan, and the next `Observe` still does not move the state.
3. The loop has repeated without new measurable progress for the same goal node, even after trying a different task, scope, or decomposition path.
4. The result is no longer testable or observable enough to justify another observe-delegate-verify cycle.

When a stall is detected, the orchestrator should not keep replaying the same observe/delegate/verify shape. It should record the stall, change the plan or decomposition, and stop treating repetition as progress.

### Operator Checklist

- Record the loop count for each completed goal.
- Stop after repeated no-progress observations for the same goal node.
- Run `npm run test:changed` for stall-related changes before considering the change complete.
- Treat any stall-related failure as blocking.

### Changed-Path Verification

```bash
npm run test:changed
```

## Supported Adapters

| Adapter | Type | Use Case |
|---------|------|----------|
| `claude_code_cli` | CLI | Code execution, file operations |
| `openai_codex_cli` | CLI | Code execution, file operations |
| `browser_use_cli` | CLI | Web browsing, scraping, form filling |
| `claude_api` | LLM API | Text generation, analysis |
| `github_issue` | REST API | Issue creation, search |
| `a2a` | A2A Protocol | Remote agent delegation |

Custom adapters can be added as [plugins](docs/design/plugin-development-guide.md) in `~/.tavori/plugins/`.

## Programmatic Usage

```typescript
import { CoreLoop, StateManager } from "tavori";

const stateManager = new StateManager("~/.tavori");
const loop = new CoreLoop({ stateManager, /* ...adapters */ });
await loop.runOnce();
```

## CLI

| Command | Description |
|---------|-------------|
| `tavori goal add "<goal>"` | Negotiate and register a new goal |
| `tavori goal list` | List all goals with status |
| `tavori run` | Run one core loop iteration |
| `tavori status` | Show progress, gaps, trust scores |
| `tavori report` | Display latest report |
| `tavori cleanup` | Archive completed goals |
| `tavori datasource add/list/remove` | Manage data sources |

## FAQ

**How does Tavori verify progress?**

3-layer verification: mechanical checks (test results, file diffs, metrics) first, then independent LLM review, then executor self-report. Self-report alone caps progress at 70%.

**Is it safe? Can it run dangerous commands?**

Trust is asymmetric: failure costs -10, success only +3. Irreversible actions always require human approval regardless of trust level. Every goal also passes through an ethics gate before execution begins.

**What happens when it gets stuck?**

Stall detection uses four indicators. Responses are graduated: try a different approach, pivot strategy, then escalate to human. No infinite loops.

**Can I use it for free?**

Yes. Tavori is open source and free. You only need an LLM API key (OpenAI or Anthropic).

## Development

```bash
git clone https://github.com/my-name-is-yu/Tavori.git
cd Tavori
npm install
npm run build
npm test
```

State: `~/.tavori/` · Reports: `~/.tavori/reports/` · Ethics logs: `~/.tavori/ethics/`

Regression note: `tests/refine.test.ts` now covers `refine()` normalization for supported inputs, malformed payload handling, and propagated refinement failures.
Verify it with:

```bash
npx vitest run tests/refine.test.ts
```

Regression note: `tests/unit/goalNegotiator.test.ts` covers the `gatherNegotiationContext` workspace fixture cleanup path.
Use it to verify the workspace scan fixture remains visible during cleanup-path changes.

Run the focused verification command:

```bash
npx vitest run tests/unit/goalNegotiator.test.ts
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

Tavori stores all state locally. No telemetry. No phone-home. Your LLM provider is the only external connection.

[MIT License](LICENSE)

---

**Tell your agents what to achieve, not what to do.**
