# Module Categories

This document groups the modules in `src/` into distinct functional types so the codebase is easier to scan and reason about.

## 1. Core Orchestration Modules

These modules coordinate the main runtime flow, decide what happens next, and connect lower-level subsystems into the end-to-end loop.

- `core-loop.ts`
- `tree-loop-orchestrator.ts`
- `cli-runner.ts`
- `daemon-runner.ts`
- `index.ts`

## 2. Goal and Planning Modules

These modules define, decompose, prioritize, and manage goals, dependencies, and strategy selection.

- `goal-negotiator.ts`
- `goal-tree-manager.ts`
- `goal-dependency-graph.ts`
- `strategy-manager.ts`
- `strategy-template-registry.ts`
- `taskSelection.js`
- `portfolio-manager.ts`
- `cross-goal-portfolio.ts`

## 3. Observation and Evaluation Modules

These modules observe the current state, measure gaps, score urgency, detect stalls, and determine whether a goal is complete enough.

- `observation-engine.ts`
- `state-aggregator.ts`
- `gap-calculator.ts`
- `drive-scorer.ts`
- `drive-system.ts`
- `stall-detector.ts`
- `satisficing-judge.ts`
- `trust-manager.ts`
- `ethics-gate.ts`
- `capability-detector.ts`

## 4. Task Execution Lifecycle Modules

These modules generate tasks, manage execution sessions, delegate work to adapters, and verify results.

- `task-lifecycle.ts`
- `session-manager.ts`
- `adapter-layer.ts`
- `reporting-engine.ts`
- `notification-dispatcher.ts`
- `pid-manager.ts`
- `event-server.ts`

## 5. Knowledge and Learning Modules

These modules acquire knowledge, store reusable context, transfer learning across goals, and support semantic retrieval.

- `knowledge-manager.ts`
- `knowledge-transfer.ts`
- `knowledge-graph.ts`
- `learning-pipeline.ts`
- `memory-lifecycle.ts`
- `vector-index.ts`
- `curiosity-engine.ts`

## 6. State and Configuration Modules

These modules persist runtime state and centralize provider, character, and runtime configuration.

- `state-manager.ts`
- `provider-factory.ts`
- `provider-config.ts`
- `character-config.ts`
- `logger.ts`

## 7. LLM and Embedding Client Modules

These modules provide direct integrations with language models and embedding services used by higher-level logic.

- `llm-client.ts`
- `openai-client.ts`
- `codex-llm-client.ts`
- `ollama-client.ts`
- `embedding-client.ts`

## 8. External Adapter and Data Source Modules

These modules connect PulSeed to external execution environments and external observation sources.

### Agent adapters

- `adapters/openai-codex.ts`
- `adapters/claude-code-cli.ts`
- `adapters/claude-api.ts`
- `adapters/github-issue.ts`

### Data source adapters

- `data-source-adapter.ts`
- `adapters/github-issue-datasource.ts`
- `adapters/file-existence-datasource.ts`

## 9. User Interface Modules

These modules power the terminal UI, interaction flow, rendering, and approval surfaces.

- `tui/app.tsx`
- `tui/chat.tsx`
- `tui/dashboard.tsx`
- `tui/report-view.tsx`
- `tui/approval-overlay.tsx`
- `tui/help-overlay.tsx`
- `tui/markdown-renderer.ts`
- `tui/intent-recognizer.ts`
- `tui/use-loop.ts`
- `tui/actions.ts`
- `tui/entry.ts`

## 10. Shared Type Definition Modules

These modules define the shared data contracts used across the system. They do not usually contain orchestration logic themselves.

- `types/*.ts`

