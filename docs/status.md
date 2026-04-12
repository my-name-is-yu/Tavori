# Status

<<<<<<< HEAD
Current repository snapshot as of 2026-04-12.

This document now tracks the current runtime shape and the codebase surfaces that are actively in use. Older stage-by-stage implementation history has been retained in `docs/archive/`.

## Current Baseline

- Runtime model: `CoreLoop` for long-lived control, `AgentLoop` for bounded execution
- Primary code split: `src/base/`, `src/orchestrator/`, `src/platform/`, `src/interface/`, `src/tools/`, `src/runtime/`
- Current implementation-facing design reference: [docs/design/current-baseline.md](design/current-baseline.md)

## What Exists Now

- Goal orchestration and tree handling under `src/orchestrator/goal/`
- Core loop control under `src/orchestrator/loop/`
- Task lifecycle, verification, sessions, and adapter layer under `src/orchestrator/execution/`
- Observation, drive, Soil, memory, runtime, and traits support under `src/platform/`
- CLI, chat, TUI, and MCP surfaces under `src/interface/`
- Built-in tool surfaces under `src/tools/`

## User-Facing Surfaces

- CLI entrypoint: `dist/interface/cli/cli-runner.js`
- Chat runtime: `src/interface/chat/`
- TUI runtime: `src/interface/tui/`
- Long-lived runtime and scheduling: `src/runtime/`

## Documentation Status

- Public docs in `docs/` describe the current runtime and usage model
- `docs/design/current-baseline.md` is the implementation-facing source of truth for runtime shape
- Some detailed design docs still include proposal or historical material; when they conflict with code, prefer code and update the docs
- Historical implementation progress is archived under `docs/archive/`

## Validation

Recommended validation for current changes:

```bash
npm run build
npm test
```

CI remains the authoritative integration check for pull requests.
=======
Current public status as of 2026-04-12.

This page is intentionally capability-focused rather than milestone-count focused.

## Implemented and in active use

### CoreLoop

Implemented:

- goal-state driven loop execution
- gap calculation and drive scoring
- task lifecycle integration
- completion and stall handling
- goal-tree execution
- multi-goal scheduling
- iteration budgeting
- next-iteration directives

### AgentLoop

Implemented:

- native `agent_loop` adapter path
- task-oriented bounded execution
- chat-oriented bounded execution
- tool routing and tool policy
- completion schema
- repeated tool loop protection
- context compaction
- command result capture
- optional worktree execution

### Agentic CoreLoop phases

Implemented:

- `observe_evidence`
- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These phases are bounded and tool-policy driven. They do not replace deterministic loop control.

### Tools

Implemented categories:

- filesystem
- shell and system
- git and test runner
- query and runtime state
- network
- schedule
- mutation
- Soil

### Runtime surfaces

Implemented:

- CLI
- chat mode
- TUI
- daemon / cron

## Recommended current path

For most users:

- configure with `pulseed setup`
- use `agent_loop` as the default adapter
- use chat and TUI on top of the same native AgentLoop runtime
- use daemon mode for resident operation

## Important architectural reality

PulSeed is no longer best described as a single flat "observe -> gap -> score -> task -> execute -> verify" loop.

The current implementation is:

- a long-lived `CoreLoop`
- plus a bounded `AgentLoop`
- plus a shared tool and Soil substrate

## Still evolving

These areas are active and expected to keep changing:

- scheduler heuristics
- public documentation in lower-level historical design docs
- provider-specific defaults
- native AgentLoop quality and prompt/model policy

## Source of truth

When docs disagree, prefer:

1. `src/`
2. tests under `src/**/__tests__/`
3. the top-level public docs:
   - [README](../README.md)
   - [Getting Started](getting-started.md)
   - [Mechanism](mechanism.md)
   - [Runtime](runtime.md)
   - [Architecture Map](architecture-map.md)
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
