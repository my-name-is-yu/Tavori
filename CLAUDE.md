# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Motiva — AI agent orchestrator that gives existing agents "motivation." Motiva sits above agents and drives them: selecting goals, spawning agent sessions, observing results, and judging completion. Motiva doesn't think — it makes agents think.

## Status

Implementation Phase — Stage 1-8 complete.

### Stage 1 (complete)
- Type definitions: 14 Zod schema files in `src/types/`
- `src/state-manager.ts` — file-based JSON persistence (~/.motiva/, atomic writes)
- `src/gap-calculator.ts` — 5-threshold-type pipeline (raw→normalized→weighted)

### Stage 2 (complete)
- Layer 1: `src/drive-system.ts` (event queue, scheduling, activation checks), `src/trust-manager.ts` (trust balance, 4-quadrant action matrix, permanent gates)
- Layer 2: `src/observation-engine.ts` (3-layer observation, progress ceiling, contradiction resolution), `src/drive-scorer.ts` (3 drive scores: dissatisfaction/deadline/opportunity), `src/satisficing-judge.ts` (completion judgment, dimension satisfaction, threshold adjustment), `src/stall-detector.ts` (4 stall types, cause classification, escalation, decay factor)

### Stage 3 (complete)
- Layer 3: `src/llm-client.ts`, `src/ethics-gate.ts`, `src/session-manager.ts`, `src/strategy-manager.ts`, `src/goal-negotiator.ts`

### Stage 4 (complete)
- Layer 0+4: `src/adapter-layer.ts`, `src/adapters/claude-code-cli.ts`, `src/adapters/claude-api.ts`, `src/task-lifecycle.ts`

### Stage 5 (complete)
- Layer 5: `src/reporting-engine.ts` (3 report types, Markdown output, CLI display, 5 notification types), `src/core-loop.ts` (observe→gap→score→completion→stall→task→report loop)

### Stage 6 (complete)
- Layer 6: `src/cli-runner.ts` (5 subcommands: run, goal add, goal list, status, report), `src/index.ts` (full module exports)
- 983 tests passing across 18 test files

### Stage 7 (complete)
- TUI UX: sidebar layout (Dashboard left/Chat right), ReportView component, useLoop hook化, message 200-cap
- Task verification: `verifyTask()` dimension_updates now applied to goal state
- npm publish prep: package.json fields, LICENSE (MIT), .npmignore

### Stage 8 (complete)
- `src/knowledge-manager.ts` — knowledge gap detection (interpretation_difficulty, strategy_deadlock), acquisition task generation, knowledge CRUD, contradiction detection
- `src/capability-detector.ts` — capability deficiency detection, registry management, user escalation
- `src/types/knowledge.ts`, `src/types/capability.ts` — 2 new Zod schema files (total: 16)
- Integration: ObservationEngine + StrategyManager emit knowledge gap signals, SessionManager injects knowledge context, TaskLifecycle wires EthicsGate.checkMeans() + CapabilityDetector
- 1191 tests passing across 23 test files

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

See `memory/archive/impl-roadmap-research.md` for module dependency graph and implementation order.

### Implementation Layers (bottom-up)

- Layer 0: StateManager, AdapterLayer (no dependencies)
- Layer 1: GapCalculator, DriveSystem, TrustManager
- Layer 2: ObservationEngine, DriveScorer, SatisficingJudge, StallDetector
- Layer 3: SessionManager, GoalNegotiator, StrategyManager
- Layer 4: TaskLifecycle
- Layer 5: CoreLoop, ReportingEngine
- Layer 6: CLIRunner

## Design Documents

- `docs/vision.md` — why Motiva exists
- `docs/mechanism.md` — core loop and orchestration
- `docs/runtime.md` — process model and execution
- `docs/design/` — detailed design for each subsystem (14 files)

Design docs are the source of truth for implementation. When in doubt, read the relevant design doc.

## Key Constraints

- Evidence-based progress observation (never count tool calls as progress)
- Irreversible actions always require human approval regardless of trust/confidence
- Trust balance: asymmetric (failure penalty > success reward), [-100,+100], Δs=+3, Δf=-10
- Satisficing: stop when "good enough," don't pursue perfection
- Confidence adjustment applies ONLY in gap-calculation §3 (no triple-application)
