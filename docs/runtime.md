# Runtime

<<<<<<< HEAD
Implementation-facing baseline: [docs/design/current-baseline.md](design/current-baseline.md)

> The foundational design for "running" the task discovery engine (mechanism.md).
> While mechanism.md defines "what PulSeed thinks about," this document defines "how PulSeed runs."
=======
This document describes how PulSeed runs today.
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)

The key runtime idea is:

- the same orchestration stack is reused by CLI, TUI, chat, and daemon flows
- `CoreLoop` remains the long-lived controller
- `AgentLoop` is the bounded executor used inside task, chat, and selected core-phase flows

## 1. Runtime surfaces

PulSeed currently exposes four main ways to run:

- CLI commands
- chat mode
- TUI
- daemon / cron

All of them share the same underlying state and orchestration modules.

## 2. CLI

The CLI entry point is `pulseed`.

Common commands:

<<<<<<< HEAD
Execution means are abstracted through adapters. Various AI agents (Claude Code CLI, Claude API, OpenAI Codex CLI, etc.), API calls, human requests. The most suitable execution means is chosen based on the nature of the task. The orchestration layer does not depend on the type of adapter.

### Result Verification

PulSeed does not trust an executor's self-report. This is not suspicion — it is a structural design decision.

Performing execution and verification in the same session makes self-evaluation bias unavoidable. The structure of "evaluating your own work" tends toward optimism in humans and AI alike. That's why execution and verification are structurally separated.

The separation is now: **PulSeed (with read-only tools for perception) vs. agents (for mutations and complex work)**. PulSeed itself can directly observe the world — reading files, running queries, fetching HTTP responses — but all state mutations, code execution with side effects, and complex multi-step work are delegated to agents.

**Tool execution in the runtime model**: Tool invocations are synchronous within the CoreLoop iteration. Read-only tools execute in-process with configurable concurrency (max 10 parallel). Tool results are cached per-iteration to avoid redundant calls.

Verification is performed in three layers.

**Mechanical verification**: Test results, file existence, build success, API response status codes. Evidence that cannot lie. This is the most trustworthy.

**Independent review session**: A separate session (different context) from execution evaluates the deliverable. Precisely because it doesn't share the execution context, it can render an unbiased judgment. Task-level verification checks whether the deliverable meets the task's success criteria; goal-level verification looks for oversights and inconsistencies from the perspective of the overall goal.

**Executor self-report**: A report of what was done, what could be done, and what couldn't. Treated as reference information only. Completion is never judged solely on self-report.

By combining these three layers of verification, each observation is assigned a confidence level. Confidence is fed directly into gap recognition in mechanism.md. "Completion" based on low-confidence observations generates additional verification tasks.

### Failure Handling

Tasks fail. Verification can result in rejection. The problem is not failure itself, but how to deal with it.

**keep**: When partial results are moving in the direction of the goal. Retain the results and generate the remaining portion as a new task. For example, if 7 out of 10 are complete, retain those 7 and make the remaining 3 the next task.

**discard**: When the direction itself is wrong. Discard the results and regenerate the task with a different approach. To avoid hitting the same wall repeatedly, information about the failed approach is passed to the next task generation.

**escalate**: When the same kind of failure repeats. Determined to be a problem that cannot be resolved through PulSeed's autonomous handling, and human intervention is requested. "No matter how many times we try, it doesn't work" suggests either a capability limit or a flawed premise.

The judgment criteria are simple: if results are heading in the goal direction, keep. If the direction is wrong, discard. If failure repeats, escalate.

### Scope Control

Each session receives a strictly scoped task. "Do everything" is never passed.

There are three reasons to narrow scope.

First, to prevent context pollution. Packing multiple tasks into one session causes interference between tasks, degrading the quality of both.

Second, verification becomes easier. The clearer the question "was this task completed?", the more accurate the verification. Vague scope only allows for vague verification.

Third, the blast radius of failure is limited. If one session fails, other tasks are unaffected. Keep the blast radius small.

Note that tasks of category `knowledge_acquisition` are scoped even more strictly than regular tasks. They are read-only execution units that only gather information, and are not permitted to modify state, write to files, or perform operations with side effects on external services.

### Portfolio Orchestration

When tracking multiple goals simultaneously, `PortfolioManager` sits between task discovery and task execution.

`DriveScorer` calculates drive scores (dissatisfaction, deadline, opportunity) per dimension for each goal, and those scores are received by `PortfolioManager`. `PortfolioManager` determines resource allocation and prioritization across goals and passes the combination of goals and strategies to execute to `TaskLifecycle`. This allows parallel management of multiple goals while passing through the same core loop code path as a single-goal loop.

`PortfolioManager` also handles automatic rebalancing across goals. If a goal's drive score spikes sharply (e.g., a deadline is imminent, an obstacle has occurred), it dynamically adjusts resource allocation to other goals.

---

## 2. Process Model --- How to Start and Keep Running

PulSeed's orchestration loop itself is a pure function. A single processing unit that cycles through "observe → gap → scoring → task discovery → execute → verify." The question of the process model is "who calls this function and when."

The startup method changes by phase, but the core loop does not. CLI, daemon, and cron are all merely thin wrappers that call this core loop.

```
CLI wrapper   ─┐
TUI wrapper   ─┤→  Core loop (observe→gap→score→task→execute→verify)
Daemon        ─┤
cron wrapper  ─┘
```

### MVP (Phase 1): CLI Mode

**`pulseed run`** executes one core loop, reports the results, and exits.

- User runs manually (or external cron runs periodically)
- Start → 1 loop completes → display results in terminal → exit
- State is written to persistent files, so the next `pulseed run` can continue
- No infrastructure needed. Only dependency is the core loop

```
$ pulseed run
Observing... [dog health management]
Gap detected: meal log not updated for 3 days
Task executed: please update the log
Done. Recommended next check: 1 day from now
```

In MVP, "scheduling" is the user's (or system cron's) responsibility. PulSeed doesn't manage schedules. It runs when called. That's it.

### Phase 1b: TUI Mode

**`pulseed tui`** launches an Ink-based terminal UI, allowing interactive control of the core loop while viewing a dashboard.

- Entry point is `src/interface/tui/entry.ts` (`startTUI()`)
- Dependencies chain: `entry.ts` → `App` (`app.tsx`) → `useLoop` hook (`use-loop.ts`) → `CoreLoop`
- Loop startup, stop, and configuration changes are all managed internally by the `useLoop` hook, tied to the React component lifecycle
- The core loop itself requires no changes. TUI uses the same `CoreLoop` instance as the CLI
- Users approve/reject tasks via the approval overlay (`ApprovalOverlay`) on screen. Approval decisions are returned to `TaskLifecycle`'s `approvalFn` via a Promise (same interface as the CLI version's readline reading)

```
=======
```bash
pulseed setup
pulseed goal add "<description>"
pulseed run --goal <id>
pulseed status --goal <id>
pulseed report --goal <id>
pulseed chat
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
pulseed tui
pulseed start --goal <id>
pulseed stop
```

`pulseed run --goal <id>` is the direct way to execute one CoreLoop run.

## 3. Chat mode

`pulseed chat` is now a real bounded agent runtime, not just a command router.

When the configured provider supports native tool calling, chat uses the native AgentLoop path.

Important runtime behavior:

- persistent chat session history
- streaming tool events
- approvals for restricted actions
- context compaction
- ability to operate CoreLoop through tools rather than direct internal calls

The design rule is explicit in the implementation: chat should manipulate long-lived control through tools, not by bypassing runtime boundaries.

## 4. TUI

The TUI is the interactive terminal shell around the same runtime.

It combines:

- goal progress
- reports
- approvals
- chat
- loop control

The TUI can also wire native chat and task AgentLoop runners when the active provider config enables `agent_loop`.

## 5. Daemon and cron

Daemon mode is the resident host for continuous operation.

```bash
pulseed start --goal <id>
pulseed stop
```

Cron is still available for users who do not want a resident daemon:

```bash
pulseed cron --goal <id>
```

Both paths ultimately drive the same CoreLoop and TaskLifecycle.

## 6. Native AgentLoop runtime

PulSeed has a first-class native `agent_loop` adapter.

This adapter is not a separate external executable. It is a selection marker that routes task execution through PulSeed's internal AgentLoop runtime.

Current AgentLoop runtime properties:

- bounded turns
- bounded tool calls
- bounded wall-clock time
- repeated tool-loop detection
- schema-validated completion
- context compaction
- trace and session state capture
- optional worktree preparation for task execution

This is the path intended to close the gap with Codex-style tool-using execution while keeping PulSeed's persistent architecture.

## 7. CoreLoop inside the runtime

Runtime surfaces do not replace CoreLoop. They host it.

CoreLoop currently coordinates:

- observation
- gap calculation
- drive scoring
- task lifecycle execution
- tree mode
- multi-goal mode
- stall handling
- completion
- agentic core phases

Agentic core phases currently include:

- `observe_evidence`
- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These are bounded sub-runs, not unbounded inner loops.

## 8. Scheduling and directives

CoreLoop can emit next-iteration directives from bounded agentic phases.

Those directives are now consumed by runtime scheduling:

- tree mode can prioritize a child node with a pending directive
- multi-goal mode can prioritize a goal with a pending directive

This is the current bridge between local bounded agent reasoning and long-lived control.

## 9. Tools in the runtime

Tools are part of the runtime substrate.

Important examples:

- filesystem and git inspection
- shell command execution
- test execution
- task and goal state queries
- knowledge and memory recall
- Soil query and maintenance tools
- schedule management tools

Both CoreLoop phases and AgentLoop sessions run on top of this tool layer with explicit policy.

## 10. Soil and memory in runtime behavior

The runtime exposes long-lived knowledge to bounded runs through:

- state manager data
- task and session history
- knowledge manager
- memory recall
- `soil_query`

This matters because PulSeed is designed to survive beyond one prompt window.

## 11. Persistence

PulSeed persists local runtime state under `~/.pulseed/`.

Important runtime areas include:

- goals
- tasks
- reports
- schedules
- runtime health and queue state
- approvals
- checkpoints
- memory
- Soil projections

The runtime also uses write-ahead-log style durability for parts of state management and health tracking.

## 12. Provider and adapter defaults

The public default direction is now:

- provider selected through `pulseed setup`
- adapter set to `agent_loop` when the chosen model supports native tool calling

External adapters still matter, but they are no longer the only story for execution.

## 13. Reading order

For the public runtime picture:

1. [README](../README.md)
2. [Getting Started](getting-started.md)
3. [Mechanism](mechanism.md)
4. [Configuration](configuration.md)
5. [Architecture Map](architecture-map.md)
