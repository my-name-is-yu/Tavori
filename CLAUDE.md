# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Motiva — AI agent orchestrator that gives existing agents "motivation." Motiva sits above agents and drives them: selecting goals, spawning agent sessions, observing results, and judging completion. Motiva doesn't think — it makes agents think.

## Status

Implementation Phase — Stage 1-9 complete (1266 tests, 24 test files).
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

See `memory/archive/impl-roadmap-research.md` for module dependency graph and implementation order. For Stage 7-9 details, see `docs/status.md`.

### Implementation Layers (bottom-up)

- Layer 0: StateManager, AdapterLayer (no dependencies)
- Layer 1: GapCalculator, DriveSystem, TrustManager
- Layer 2: ObservationEngine, DriveScorer, SatisficingJudge, StallDetector
- Layer 3: SessionManager, GoalNegotiator, StrategyManager
- Layer 4: TaskLifecycle
- Layer 5: CoreLoop, ReportingEngine
- Layer 6: CLIRunner
- Layer 7: TUI (src/tui/ — Ink/React dashboard, approval UI, chat)
- Layer 8: KnowledgeManager, CapabilityDetector (cross-cutting, injected into Layer 3-4)
- Layer 9: PortfolioManager (orchestrates parallel strategies between DriveScorer and TaskLifecycle)

## Design Documents

- `docs/vision.md` — why Motiva exists
- `docs/mechanism.md` — core loop and orchestration
- `docs/runtime.md` — process model and execution
- `docs/design/` — detailed design for each subsystem (19 files)

Design docs are the source of truth for implementation. When in doubt, read the relevant design doc.

## Key Constraints

- Evidence-based progress observation (never count tool calls as progress)
- Irreversible actions always require human approval regardless of trust/confidence
- Trust balance: asymmetric (failure penalty > success reward), [-100,+100], Δs=+3, Δf=-10
- Satisficing: stop when "good enough," don't pursue perfection
- Confidence adjustment applies ONLY in gap-calculation §3 (no triple-application)
