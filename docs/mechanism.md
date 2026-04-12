# PulSeed Mechanism

This document explains the current public mechanism of PulSeed.

The short version:

- `CoreLoop` is the long-lived controller
- `AgentLoop` is the bounded tool-using executor
- tools and Soil are first-class inputs to both

## 1. The Two Loops

PulSeed no longer fits the old "one loop does everything" explanation.

It now has two distinct loops with different jobs.

### CoreLoop

`CoreLoop` owns long-horizon control:

- is this goal complete?
- what is the next best target dimension?
- are we stalled?
- should we continue, refine, pivot, or verify?
- which goal or tree node should get the next iteration?

`CoreLoop` is persistent and stateful across many runs. It works over goals, tasks, memory, schedules, and runtime state.

### AgentLoop

`AgentLoop` owns bounded execution:

- choose a tool
- inspect the tool result
- decide the next action
- stop with a schema-valid result or a bounded failure reason

`AgentLoop` is used for:

- task execution via the native `agent_loop` adapter
- chat turns
- selected CoreLoop phases that need targeted evidence gathering

## 2. CoreLoop Flow

At a high level, a CoreLoop run looks like this:

```text
observe state
-> calculate gaps
-> score dimensions
-> decide task / refinement / pivot / verification
-> run execution
-> verify outcome
-> persist state
```

That is still true, but the implementation now contains an agentic phase layer inside the loop.

### Agentic core phases

PulSeed can run bounded AgentLoop phases inside CoreLoop:

- `observe_evidence`
- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These phases do not replace deterministic control. They are bounded evidence-gathering and decision-support steps inside deterministic orchestration.

Each phase has:

- its own tool allowlist
- required tools
- turn and time budgets
- a fail policy

## 3. Why split the loops?

The split solves two different problems cleanly.

### CoreLoop is about control

Long-running goals need durable control over:

- completion
- confidence
- priority
- stall behavior
- scheduling
- recovery

This part should not depend on a single long prompt.

### AgentLoop is about local execution

A task, a chat turn, or a bounded investigation needs:

- direct tool selection
- short feedback cycles
- stop detection
- context compaction

This part should feel closer to Codex / Claude Code style execution.

## 4. Tool-first operation

Tools are not an add-on. They are the default execution substrate for bounded agent work.

PulSeed ships built-in tools across several groups:

- filesystem: read, grep, glob, json query, edit, apply patch
- system: shell command, shell, git diff, git log, test runner, env, sleep
- query: goal state, task state, session history, progress history, memory recall, knowledge query, architecture
- network: HTTP fetch, web search
- mutation: update goal/task/config state
- schedule: create, list, pause, resume, remove schedules
- Soil: query, open, doctor, publish, rebuild

The public implication is simple: when PulSeed says it can "inspect" or "verify," that often means direct tools, not a delegated narrative.

## 5. Soil in the loop

Soil is PulSeed's readable memory surface.

It matters because the short-lived AgentLoop can still access long-lived state through:

- `soil_query`
- memory recall
- knowledge query
- session and progress history

That is how long-term resident knowledge becomes usable inside bounded task execution and chat turns.

## 6. Knowledge refresh and replanning

CoreLoop now has a more explicit path for "we need to think again before acting."

### Knowledge refresh

Triggered when the loop needs missing knowledge before a good task can be generated.

Current behavior:

- can gather evidence with bounded tools
- can auto-trigger deterministic knowledge acquisition when confidence is high enough
- can pass a next-iteration directive forward

### Replanning

Triggered when the loop needs better task framing, a different dimension focus, or a different action recommendation.

Current behavior:

- can recommend `continue`, `refine`, or `pivot`
- can emit a next-iteration directive
- can bias the next tree-node or multi-goal selection

## 7. Stall handling

PulSeed still treats stalls as a first-class control problem.

The updated behavior is:

- deterministic stall detection remains the backbone
- `stall_investigation` can gather bounded evidence before choosing the next action
- a stall can now resolve to:
  - continue
  - refine
  - pivot
  - escalate

## 8. Verification

PulSeed still separates execution from verification as a design rule.

Current verification sources include:

- direct tool evidence
- task-level structured verification
- execution command results
- optional LLM verification passes

The important change is that verification is no longer explained as "agent self-report plus review only." Direct tool evidence is now central.

## 9. Context compaction

AgentLoop supports built-in compaction for long conversations and task sessions.

Current behavior:

- pre-turn or mid-turn compaction
- summary replacement of older context
- bounded number of compactions per run

This matters most in:

- `pulseed chat`
- long-running task execution
- agentic CoreLoop phases

## 10. Tree mode and multi-goal mode

CoreLoop can operate over:

- one goal
- a goal tree
- multiple goals

The current scheduler is not purely static:

- tree mode can prefer a node that carries a next-iteration directive
- multi-goal mode can prefer a goal that carries a next-iteration directive

So bounded agentic evidence can influence the next deterministic scheduling choice.

## 11. Completion

PulSeed still uses satisficing rather than "never stop" execution.

Completion is decided from:

- dimension thresholds
- confidence
- verification state
- stall and error boundaries

The important distinction is:

- AgentLoop detects local stop for a task or chat turn
- CoreLoop detects durable stop for a goal or iteration plan

## 12. Practical reading order

If you want the public picture of the current system, read these in order:

1. [README](../README.md)
2. [Getting Started](getting-started.md)
3. [Runtime](runtime.md)
4. [Architecture Map](architecture-map.md)
5. [Module Map](module-map.md)
