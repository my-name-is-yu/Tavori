# Getting Started

This guide reflects the current public surface of PulSeed as of the `CoreLoop + AgentLoop` architecture.

## 1. Install

Node.js 20+ is required.

```bash
npm install -g pulseed
```

## 2. Run setup

Use the setup wizard first.

```bash
pulseed setup
```

What setup does:

- chooses provider and model
- selects the default adapter
- writes `~/.pulseed/provider.json`
- can enable the native `agent_loop` path, which is now the recommended default when your model supports tool calling

## 3. Create a goal

```bash
<<<<<<< HEAD
git clone https://github.com/my-name-is-yu/PulSeed.git
cd PulSeed
npm install
npm run build
node dist/interface/cli/cli-runner.js --help
=======
pulseed goal add "Increase test coverage to 90%"
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
```

This stores a goal with measurable dimensions and enough state for the CoreLoop to continue later.

Useful follow-ups:

```bash
pulseed goal list
pulseed goal show <goal-id>
```

## 4. Run one iteration

```bash
pulseed run --goal <goal-id>
```

`pulseed run` executes one CoreLoop run for the goal. Inside that run, PulSeed may:

1. observe evidence
2. calculate gaps and drive scores
3. decide whether to continue, refine, pivot, or verify
4. run bounded agentic core phases such as knowledge refresh or stall investigation
5. generate and execute a task
6. verify the result and persist the outcome

If the selected adapter is `agent_loop`, task execution is performed by PulSeed's native AgentLoop rather than an external CLI agent wrapper.

## 5. Check progress

```bash
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
pulseed task list --goal <goal-id>
```

Use these to inspect the current goal state, latest report, and task history.

## 6. Use chat mode

<<<<<<< HEAD
`pulseed run` starts PulSeed's core loop for the selected goal and keeps iterating until completion, stall, explicit stop, or the active iteration budget is exhausted:

The current runtime combines:

- **CoreLoop** — long-lived control for observation, prioritization, completion checks, stall handling, and re-planning
- **AgentLoop** — bounded execution where the model chooses tools, reads results, and works toward a final answer or task outcome

The exact step shape varies by goal and execution path, but the common flow is:

1. **Observe and refresh evidence**
2. **Calculate gaps and priorities**
3. **Choose the next task or bounded execution step**
4. **Execute with adapters or tools**
5. **Verify outcomes and update persisted state**
=======
```bash
pulseed chat
```

Chat mode is no longer just a command router. It can run through the native AgentLoop with tools when the configured provider supports it.
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)

Current chat characteristics:

- tool-using bounded turns
- context compaction when history grows
- approval flow for restricted actions
- ability to operate PulSeed through tools instead of direct internal calls

## 7. Use the TUI

```bash
pulseed tui
```

The TUI sits on the same runtime and orchestration stack as the CLI. It is the main interactive view for:

- goal progress
- reports
- approvals
- chat
- loop control

## 8. Run continuously

Start the resident runtime:

```bash
pulseed start --goal <goal-id>
pulseed stop
```

Or print a cron entry:

```bash
pulseed cron --goal <goal-id>
```

The daemon and cron paths still feed the same CoreLoop and TaskLifecycle.

## 9. Recommended adapter choices

Default recommendation:

- OpenAI or Anthropic with `agent_loop`

When to use external adapters instead:

- `openai_codex_cli` or `claude_code_cli` when you want the provider's own CLI behavior
- `github_issue` when execution should be an issue handoff rather than a local agent session

## 10. What PulSeed stores locally

PulSeed writes local state under `~/.pulseed/`, including:

- goals
- tasks
- reports
- runtime state
- schedules
- memory
- Soil projections

## 11. Next docs

- [README](../README.md)
- [Mechanism](mechanism.md)
- [Runtime](runtime.md)
- [Configuration](configuration.md)
- [Architecture Map](architecture-map.md)
- [Module Map](module-map.md)
