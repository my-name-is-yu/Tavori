# Module Map

<<<<<<< HEAD
Implementation-facing baseline: [docs/design/current-baseline.md](design/current-baseline.md)

> This document is a guide for Claude Code to immediately determine "which files to touch."
> Use it to quickly identify target files based on the type of change needed.
>
> Note: the detailed tables below predate parts of the current `src/base` / `src/orchestrator` / `src/platform` / `src/interface` split. Use `docs/design/current-baseline.md` and the live code layout as the source of truth when a path here disagrees with the repository.
=======
This is the current public module map for the reorganized codebase.
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)

It is intentionally oriented around stable directories and major entry points rather than an exhaustive per-file inventory.

## 1. Public entry points

### Library exports

- `src/index.ts`

Main exported surfaces include:

- `CoreLoop`
- `TaskLifecycle`
- `TaskAgentLoopRunner`
- `ChatAgentLoopRunner`
- `StateManager`
- `ToolRegistry`
- `ToolExecutor`
- provider and adapter builders

### CLI entry

- `src/interface/cli/cli-runner.ts`

### TUI entry

- `src/interface/tui/entry.ts`

### Chat entry

- `src/interface/chat/chat-runner.ts`
- `src/interface/cli/commands/chat.ts`

## 2. Directory guide

### `src/base`

Use this area for:

- core types
- provider config
- LLM client abstractions
- persistent state manager
- shared utilities

Important modules:

- `src/base/llm/provider-config.ts`
- `src/base/llm/provider-factory.ts`
- `src/base/state/state-manager.ts`

### `src/platform`

Use this area for domain services that are not tied to one interface surface.

Important modules:

- `src/platform/drive/`
- `src/platform/observation/`
- `src/platform/knowledge/`
- `src/platform/soil/`
- `src/platform/traits/`

Typical responsibilities:

- gap calculation
- drive scoring
- satisficing
- observation
- knowledge and memory
- Soil publishing and querying
- ethics and trust

### `src/orchestrator`

Use this area for long-lived orchestration and control.

#### `src/orchestrator/loop`

CoreLoop and scheduling logic.

Important files:

- `core-loop.ts`
- `tree-loop-runner.ts`
- `iteration-budget.ts`
- `loop-result-types.ts`
- `core-loop/iteration-kernel.ts`
- `core-loop/decision-engine.ts`
- `core-loop/phase-policy.ts`
- `core-loop/phase-runtime.ts`

#### `src/orchestrator/execution`

Task execution and native AgentLoop runtime.

Important areas:

- `task/`
- `agent-loop/`
- `session-manager.ts`
- `adapter-layer.ts`

#### `src/orchestrator/goal`

Goal negotiation and tree orchestration.

Important files:

- `goal-negotiator.ts`
- `goal-tree-manager.ts`
- `tree-loop-orchestrator.ts`
- `state-aggregator.ts`

#### `src/orchestrator/strategy`

Strategy and portfolio logic.

Important files:

- `strategy-manager.ts`
- `portfolio-manager.ts`
- `cross-goal-portfolio.ts`

### `src/tools`

Use this area for built-in tool definitions and execution infrastructure.

Important modules:

- `src/tools/index.ts`
- `src/tools/builtin/index.ts`
- `src/tools/executor.ts`
- `src/tools/registry.ts`

Main tool groups:

- `fs/`
- `system/`
- `query/`
- `network/`
- `mutation/`
- `schedule/`
- `execution/`
- `interaction/`
- `media/`

### `src/interface`

Use this area for user-facing surfaces.

Important subdirectories:

- `cli/`
- `chat/`
- `tui/`
- `mcp-server/`

### `src/runtime`

Use this area for resident runtime support.

Important subdirectories:

- `daemon/`
- `queue/`
- `gateway/`
- `schedule/`
- `store/`

## 3. Where to look by feature

### CoreLoop behavior

- `src/orchestrator/loop/core-loop.ts`
- `src/orchestrator/loop/core-loop/`
- `src/orchestrator/loop/tree-loop-runner.ts`

### AgentLoop behavior

- `src/orchestrator/execution/agent-loop/`

Start with:

- `bounded-agent-loop-runner.ts`
- `task-agent-loop-runner.ts`
- `chat-agent-loop-runner.ts`
- `agent-loop-compactor.ts`
- `task-agent-loop-factory.ts`

### Task generation and verification

- `src/orchestrator/execution/task/task-lifecycle.ts`
- `src/orchestrator/execution/task/task-generation.ts`
- `src/orchestrator/execution/task/task-verifier.ts`
- `src/orchestrator/execution/task/task-verifier-llm.ts`
- `src/orchestrator/execution/task/task-verifier-rules.ts`

### Goal tree and multi-goal scheduling

- `src/orchestrator/goal/tree-loop-orchestrator.ts`
- `src/orchestrator/goal/goal-tree-manager.ts`
- `src/orchestrator/strategy/cross-goal-portfolio.ts`
- `src/orchestrator/strategy/portfolio-manager.ts`
- `src/orchestrator/loop/tree-loop-runner.ts`

### Soil

- `src/platform/soil/`
- `src/tools/query/SoilQueryTool/`
- `src/tools/execution/SoilDoctorTool/`
- `src/tools/execution/SoilOpenTool/`
- `src/tools/execution/SoilPublishTool/`
- `src/tools/execution/SoilRebuildTool/`

### Chat

- `src/interface/chat/chat-runner.ts`
- `src/interface/chat/chat-history.ts`
- `src/interface/chat/cross-platform-session.ts`
- `src/interface/cli/commands/chat.ts`

### CLI setup and provider wiring

- `src/interface/cli/setup.ts`
- `src/interface/cli/commands/setup.ts`
- `src/base/llm/provider-config.ts`
- `src/base/llm/provider-factory.ts`

## 4. Where tests live

Most implementation areas keep colocated tests in `__tests__/`.

High-signal suites for current architecture:

- `src/orchestrator/loop/__tests__/`
- `src/orchestrator/execution/__tests__/`
- `src/orchestrator/execution/agent-loop/__tests__/`
- `src/interface/chat/__tests__/`
- `src/interface/cli/__tests__/`
- `src/tools/**/__tests__/`

## 5. Current naming conventions

- `CoreLoop` means long-lived control
- `AgentLoop` means bounded tool-using execution
- `TaskLifecycle` is the task generation/execution/verification pipeline
- `Soil` means the readable derived memory surface

If a document elsewhere still explains the system only in terms of one flat loop, treat that as historical.
