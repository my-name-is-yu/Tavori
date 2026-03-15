# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Motiva — AI agent orchestrator that gives existing agents "motivation." Motiva sits above agents and drives them: selecting goals, spawning agent sessions, observing results, and judging completion. Motiva doesn't think — it makes agents think.

## Status

Implementation Phase — Stage 1-14 complete (2663 tests, 53 test files).
See `docs/status.md` for stage-by-stage details.

## Core Concept

- 4-element model: Goal (with thresholds) → Current State (observation + confidence) → Gap → Constraints
- Orchestrator loop: observe → gap → score → task → execute → verify (NEVER STOP)
- Adapter pattern: agent-agnostic (Claude Code CLI, Claude API, custom adapters)
- Motiva calls LLMs (for goal decomposition, observation) — it is the caller, not the callee
- Execution boundary: Motiva always delegates. Direct actions are LLM calls (for thinking) and state read/write only

## Tech Stack

- Node.js 18+, TypeScript 5.3+
- Anthropic SDK (for LLM calls)
- Zod (schema validation)
- State persistence: file-based JSON (~/.motiva/)
- Test: vitest

## Build & Test

```bash
npm install
npm run build
npx vitest run
```

## Architecture

See `memory/archive/impl-roadmap-research.md` for module dependency graph and implementation order. For full stage-by-stage details, see `docs/status.md`.

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
- Layer 11: CuriosityEngine, CharacterConfigManager (好奇心・倫理強化・キャラクター, cross-cutting)
- Layer 12: EmbeddingClient, VectorIndex, KnowledgeGraph, GoalDependencyGraph (semantic embedding infrastructure, cross-cutting)
- Layer 13: CapabilityDetector (extended), DataSourceAdapter (Stage 13 autonomous capability acquisition, cross-cutting)
- Layer 14: GoalTreeManager, StateAggregator, TreeLoopOrchestrator, CrossGoalPortfolio, StrategyTemplateRegistry, LearningPipeline, KnowledgeTransfer (cross-goal portfolio, learning, knowledge transfer)

## Design Documents

- `docs/vision.md` — why Motiva exists
- `docs/mechanism.md` — core loop and orchestration
- `docs/runtime.md` — process model and execution
- `docs/design/` — detailed design for each subsystem (23 files)

Design docs are the source of truth for implementation. When in doubt, read the relevant design doc.

## Key Constraints

- **テスト失敗時はコードのバグを先に疑う** — テストが落ちたとき、テストを修正する前に必ずプロダクションコード側にバグがないか検証すること。テストは仕様の表現であり、安易にテストを書き換えると本物のバグを見逃す
- Evidence-based progress observation (never count tool calls as progress)
- Irreversible actions always require human approval regardless of trust/confidence
- Trust balance: asymmetric (failure penalty > success reward), [-100,+100], Δs=+3, Δf=-10
- Satisficing: stop when "good enough," don't pursue perfection
- Confidence adjustment applies ONLY in gap-calculation §3 (no triple-application)
