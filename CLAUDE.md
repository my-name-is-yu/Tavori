# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PulSeed — AI agent orchestrator that gives existing agents the drive to persist. PulSeed sits above agents and drives them: selecting goals, spawning agent sessions, observing results, and judging completion. PulSeed doesn't think — it makes agents think.

## Status

Implementation Phase — Stage 1-14 + Milestone 1-18 complete (4061 tests, 179 test files). Phase 3 (開発基盤整備) + OSS最適化 #112-#146 全35件完了。
See `docs/status.md` for stage-by-stage details.

## Core Concept

- 4-element model: Goal (with thresholds) → Current State (observation + confidence) → Gap → Constraints
- Orchestrator loop: observe → gap → score → task → execute → verify (NEVER STOP)
- Adapter pattern: agent-agnostic (various AI agents: CLI-type, API-type, custom adapters — e.g., Claude Code CLI, Claude API, OpenAI Codex CLI)
- PulSeed calls LLMs (for goal decomposition, observation) — it is the caller, not the callee
- Execution boundary: PulSeed always delegates. Direct actions are LLM calls (for thinking) and state read/write only

## Tech Stack

- Node.js 20+, TypeScript 5.3+
- LLM SDK（Anthropic/OpenAI等）(for LLM calls)
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

See `memory/archive/impl-roadmap-research.md` for module dependency graph and implementation order. For full stage-by-stage details, see `docs/status.md`.

## モジュール境界マップ

`docs/module-map.md` に全モジュールの責務・主要export・依存関係・対応テストファイルをまとめている。
変更対象ファイルの特定に使用すること。

## 開発基盤整備計画

`docs/design/phase3-plan.md` に残りのファイル分割計画（柱1）、テスト効率化計画（柱3）をまとめている。

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
- Layer 15: PluginLoader, NotifierRegistry, INotifier (plugin architecture — dynamic load from `~/.pulseed/plugins/`, notifier routing)

## Design Documents

- `docs/vision.md` — why PulSeed exists
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
- **LLM応答はZodパース前にサニタイズ** — LLMがenum外の値を返すことがある（例: threshold_typeに"exact"）。catchブロックでエラーを握りつぶさず、必ずログ出力すること
- **Dogfooding推奨モデル**: gpt-5.3-codex（gpt-4o-miniより観測精度・収束速度が大幅に優れる。`~/.pulseed/provider.json`で設定）
- **KEEP THE FILES SHORT**: If the code exceeds 500 lines, consider splitting it into multiple files.
- **KEEP THE CODE SIMPLE**: Do not overcomplicate it. Keep it as simple as possible.
- **バグ・改善点は即issue起票** — 作業中にバグ、セキュリティ問題、コード品質の改善点を見つけた場合、ユーザーの許可を待たずに `gh issue create` でissueを起票すること。修正は別途判断するが、記録は即座に行う