# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PulSeed — AI agent orchestrator that gives existing agents the drive to persist. PulSeed sits above agents and drives them: selecting goals, spawning agent sessions, observing results, and judging completion. PulSeed doesn't think — it makes agents think.

## Status

Implementation Phase — Stage 1-14 + Milestone 1-18 complete (4061 tests, 179 test files). Phase 3 (dev infrastructure) + OSS optimization #112-#146 all 35 items complete.
See `docs/archive/status.md` for stage-by-stage details.

## Core Concept

- 4-element model: Goal (with thresholds) → Current State (observation + confidence) → Gap → Constraints
- Orchestrator loop: observe → gap → score → task → execute → verify (NEVER STOP)
- Adapter pattern: agent-agnostic (various AI agents: CLI-type, API-type, custom adapters — e.g., Claude Code CLI, Claude API, OpenAI Codex CLI)
- PulSeed calls LLMs (for goal decomposition, observation) — it is the caller, not the callee
- Execution boundary: PulSeed always delegates. Direct actions are LLM calls (for thinking) and state read/write only

## Tech Stack

- Node.js 20+, TypeScript 5.3+
- LLM SDK (Anthropic/OpenAI etc.) (for LLM calls)
- Zod (schema validation)
- State persistence: file-based JSON (~/.pulseed/)
- Test: vitest

## Build & Test

```bash
npm install
npm run build
npx vitest run
```

## Architecture

See `memory/archive/impl-roadmap-research.md` for module dependency graph and implementation order. For full stage-by-stage details, see `docs/archive/status.md`.

## Module Boundary Map

`docs/archive/module-map.md` contains all module responsibilities, primary exports, dependencies, and corresponding test files.
Use it to identify files affected by a change.

## Dev Infrastructure Plan

`docs/archive/phase3-plan.md` contains the remaining file splitting plan (pillar 1) and test efficiency plan (pillar 3).

### Implementation Layers (bottom-up)

- Layer 0: StateManager, AdapterLayer (no dependencies)
- Layer 1: GapCalculator, DriveSystem, TrustManager
- Layer 2: ObservationEngine, DriveScorer, SatisficingJudge, StallDetector
- Layer 3: SessionManager, GoalNegotiator, StrategyManager
- Layer 4: TaskLifecycle
- Layer 5: CoreLoop, ReportingEngine
- Layer 6: CLIRunner
- Layer 7: TUI (src/tui/ — Ink/React dashboard, approval UI, chat)
- Layer 8: KnowledgeManager (cross-cutting, injected into Layer 3-4)
- Layer 9: PortfolioManager (orchestrates parallel strategies between DriveScorer and TaskLifecycle)
- Layer 10: DaemonRunner, PIDManager, Logger, EventServer, NotificationDispatcher, MemoryLifecycleManager
- Layer 11: CuriosityEngine, CharacterConfigManager (curiosity, ethics, character — cross-cutting)
- Layer 12: EmbeddingClient, VectorIndex, KnowledgeGraph, GoalDependencyGraph (semantic embedding infrastructure, cross-cutting)
- Layer 13: CapabilityDetector (extended), DataSourceAdapter (Stage 13 autonomous capability acquisition, cross-cutting)
- Layer 14: GoalTreeManager, StateAggregator, TreeLoopOrchestrator, CrossGoalPortfolio, StrategyTemplateRegistry, LearningPipeline, KnowledgeTransfer (cross-goal portfolio, learning, knowledge transfer)
- Layer 15: PluginLoader, NotifierRegistry, INotifier (plugin architecture — dynamic load from `~/.pulseed/plugins/`, notifier routing)

## Design Documents

- `docs/vision.md` — why PulSeed exists
- `docs/mechanism.md` — core loop and orchestration
- `docs/runtime.md` — process model and execution
- `docs/design/` — detailed design for each subsystem, organized by category:
  - **core/**: drive-system, drive-scoring, gap-calculation, state-vector, observation, stall-detection, satisficing
  - **goal/**: goal-negotiation, goal-refinement-pipeline, goal-tree, goal-ethics, execution-boundary
  - **knowledge/**: hierarchical-memory, memory-lifecycle, knowledge-acquisition, knowledge-transfer, learning-pipeline, hypothesis-verification
  - **execution/**: task-lifecycle, session-and-context, portfolio-management, multi-agent-delegation, data-source
  - **infrastructure/**: llm-fault-tolerance, token-optimization, prompt-context-architecture, plugin-architecture, plugin-development-guide, reporting, web-ui
  - **personality/**: character, curiosity, trust-and-safety, brand

Design docs are the source of truth for implementation. When in doubt, read the relevant design doc.

## Key Constraints

- **When tests fail, suspect production code first** — before modifying a failing test, always verify whether the production code has a bug. Tests express the spec; casually rewriting tests hides real bugs
- Evidence-based progress observation (never count tool calls as progress)
- Irreversible actions always require human approval regardless of trust/confidence
- Trust balance: asymmetric (failure penalty > success reward), [-100,+100], Δs=+3, Δf=-10
- Satisficing: stop when "good enough," don't pursue perfection
- Confidence adjustment applies ONLY in gap-calculation §3 (no triple-application)
- **Sanitize LLM responses before Zod parsing** — LLMs may return values outside defined enums (e.g., "exact" for threshold_type). Never swallow errors in catch blocks; always log them
- **Recommended dogfooding model**: gpt-5.3-codex (significantly better observation accuracy and convergence speed than gpt-4o-mini; configure in `~/.pulseed/provider.json`)
- **KEEP THE FILES SHORT**: If the code exceeds 500 lines, consider splitting it into multiple files.
- **KEEP THE CODE SIMPLE**: Do not overcomplicate it. Keep it as simple as possible.
- **File issues immediately for bugs and improvements** — when you find bugs, security issues, or code quality problems during work, create a GitHub issue with `gh issue create` without waiting for user permission. Fixes are decided separately, but recording is immediate