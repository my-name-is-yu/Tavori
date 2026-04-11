# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.4] - 2026-04-11

### Added
- Added resident daemon KPI reporting for process liveness, command acceptance, task execution, task success rate, retry/abandon rate, and task latency
- Added `pulseed daemon ping` as a cheap live command-acceptance probe
- Documented the resident daemon recovery model, durable state layout, KPI surface, and forced-failure verification strategy

### Changed
- Hardened the resident daemon runtime with live health probes, durable supervisor state, task outcome ledgers, startup reconciliation, schedule persistence, and memory/checkpoint recovery coverage
- Normalized npm package repository metadata for publish-time validation
- Bumped the npm package version to `0.4.4`

### Fixed
- Fixed CI regressions around partial `DriveSystem` mocks by preserving a compatibility path for activation snapshots
- Fixed concurrent atomic JSON writes to the same file by using unique temporary filenames
- Fixed a proactive scheduling E2E timeout by making the cooldown assertion stop after the first deterministic goal cycle

## [0.4.3] - 2026-04-10

### Fixed
- Added `pulseed --version` / `-v` and wired version display to shared package metadata so the CLI, TUI, and runtime stay in sync
- Tightened the first-run setup path so non-interactive launches fail clearly instead of silently skipping the setup wizard, while preserving existing env/default fallback behavior for non-TUI commands

### Changed
- Bumped the npm package version to `0.4.3`

## [0.4.2] - 2026-04-10

### Fixed
- Fixed the default `pulseed` startup path so first-run setup fails clearly in non-interactive terminals instead of silently skipping the setup wizard and falling through into the TUI
- Preserved the existing env/default fallback behavior for non-TUI commands such as `run`, `suggest`, and `chat`, while still routing true first-run interactive TUI launches into setup

### Changed
- Bumped the npm package version to `0.4.2`

## [0.4.0] - 2026-04-09

### Features
- **Durable Auto-Recovery Runtime**: completed the public auto-recovery runtime with watchdog-managed daemon startup, leader-lock ownership, heartbeat health snapshots, durable approval/outbox/runtime stores, and supervisor-managed goal execution that survives daemon restarts
- **Durable Command & Event Dispatch**: added journal-backed command and event dispatch so `goal_start`, `goal_stop`, chat messages, approval responses, cron activations, and schedule activations are accepted durably and replayed after recovery instead of being lost in memory
- **Execution Ownership Model**: introduced durable queue claims, goal leases, claim sweeping, and execution fencing to prevent duplicate workers and stale writers during crash recovery or takeover scenarios

### Changed
- **Runtime Cutover**: removed the legacy in-memory `EventBus` / `CommandBus` execution path and made the durable runtime the primary daemon path, including watchdog-first CLI daemon startup and durable health/status reporting
- **LoopSupervisor**: moved supervisor startup and maintenance onto explicit durable polling and completion callbacks so loop counts, daemon status, proactive ticks, cron processing, and schedule processing stay correct in supervisor mode
- **Release Packaging**: bumped the npm package version to `0.4.0`

### Fixed
- Restored daemon auto-recovery CI stability by hardening shutdown signaling, supervisor maintenance timing, queue completion accounting, approval persistence checks, and runtime tests that previously relied on fixed sleeps
- Fixed `LoopSupervisor` polling races where overlapping polls could hide the active poll from shutdown and leave durable claims or retries in inconsistent states under Node 22
- Fixed a Node 22-only `DriveSystem` test cleanup race by waiting for async directory initialization before teardown, eliminating intermittent `ENOTEMPTY` failures in the publish CI matrix

### Docs
- Added the public runtime auto-recovery design document under `docs/design/infrastructure/runtime-auto-recovery.md` and linked it from the design index
- Marked the older multi-channel runtime design as historical context now that the durable runtime cutover is complete

## [0.3.0] - 2026-04-07

### Features
- **Tool System**: introduced the first full tool runtime with typed schemas, registry, permission model, concurrency control, executor pipeline, builtin tool APIs, and deep CoreLoop/AgentLoop integration for observation, verification, research, and execution workflows (#459, #460, #464, #467, #469, #503, #507, #519)
- **Core Loop & Strategy Engine**: added tool-backed observation and direct measurement, workspace context caching, post-task Git diff and test verification, stall and learning evidence collection, execution feedback scoring, auto-consolidation hooks, and adaptive observation delay based on deadlines and velocity history (#474, #478, #484, #486, #525, #529, #532, #551)
- **ScheduleEngine**: delivered Probe and ChangeDetector layers, cron and GoalTrigger orchestration, plugin extensibility, reporting, and rolling-window escalation for more capable scheduled execution (#533, #534, #536)
- **Multi-Channel Runtime**: added the ingress envelope model, queue-backed daemon routing, worker-pool execution, durable state snapshots/WAL/advisory locking, and WebSocket plus Slack Events API channel adapters (#538, #541, #542)
- **Queue**: added `PriorityQueue`, `EventBus`, and `CommandBus` with TTL handling, deduplication, backpressure controls, dead-letter support, and drop callbacks
- **TUI & CLI**: moved to a daemon-first SSE/REST architecture, made the TUI the default launch path, and added `/tend`, rich delete confirmations, no-flicker rendering, IME support, clipboard toasts, pixel-art branding, bash mode, and row-based scrollback (#498, #499, #500, #504, #510, #520, #524, #560)
- **Setup Wizard**: overhauled onboarding with `@clack/prompts` and added notification configuration as a first-class setup step (#523, #555)
- **Agent Memory**: added goal-independent memory tools, active linting, and lifecycle-driven consolidation for longer-running agent workflows (#526, #531, #532)
- **WaitStrategy**: implemented the remaining WaitStrategy design gaps and connected them to runtime scheduling behavior (#547)
- **Branding**: introduced the Seedy identity system and refreshed README/product presentation (#521)

### Bug Fixes
- Hardened tool execution against malformed and unsafe calls by sanitizing LLM-planned tool invocations, blocking SSRF and shell-injection paths in verification, tightening `TestRunnerTool` allowlists, masking environment variable values, and moving Tavily auth to headers (#460, #464, #469, #470)
- Fixed tool-backed observation and measurement correctness, including null parsed-value handling, refreshed dimension persistence, 2xx verification acceptance, missing executor/context wiring, and token accumulation per CoreLoop iteration (#464, #485, #537)
- Resolved chat and TUI reliability issues including REPL hangs, missing adapter error surfacing, second-input freezes, a FlickerOverlay regression, and exact slash-command submission handling (#488, #493, #494, #558)
- Corrected queue and daemon edge cases by moving EventBus dedupe after the backpressure gate, warning on missing `goal_id`, and preventing double-processing in the event server (#539)
- Fixed WaitStrategy persistence and plateau scanning so running tasks are included correctly during target selection (#549, #550)
- Restored task lifecycle compatibility by fixing constructor overload behavior and related health-check/tool wiring regressions (#553)
- Corrected package/runtime wiring issues including the published CLI bin path and build configuration so test files stay out of release artifacts (#491)

### Refactoring
- Reorganized the codebase into clearer architectural layers under `src/base`, `src/platform`, `src/orchestrator`, and `src/interface`, while colocating tests and distributed type definitions with their owning modules
- Restructured the tools implementation into dedicated per-tool and genre-based folders, with shared exports aligned to the new module layout (#511)
- Extracted shared execution helpers from task lifecycle code and split the setup wizard into step modules to reduce file size and improve maintainability (#552, #554)
- Consolidated common tool-output parsing into shared utilities used across observation and gap-calculation flows (#474)

### Infrastructure
- Added `eslint-plugin-boundaries` to enforce layer boundaries in the new architecture
- Hardened build and packaging flows with an explicit `tsconfig.build.json` and related path/build fixes for publishable artifacts
- Improved runtime durability with advisory locking, write-ahead logging, and snapshot support in the state layer (#541)

### Docs
- Expanded the tool-system design documentation across runtime, mechanism, observation, and knowledge-acquisition docs, and added a unified shared-tools design writeup (#458, #501)
- Added dedicated design documents for `TimeHorizonEngine` and `WaitStrategy` to capture the new scheduling model (#543, #544)

## [0.2.0] - 2026-04-05

### Added
- Deep tool system integration: GitDiffTool, GlobTool, GrepTool, TestRunnerTool, and ShellTool routed through ToolExecutor across CoreLoop, ObservationEngine, StrategyManager, TaskLifecycle, and ChatVerifier (#477-#484)
- Shared `parseToolOutput` utility for consistent tool result handling across modules
- `required_tools` field in strategy schema for ToolSearch scoring (#486)
- `supportsToolCalling()` capability flag on ILLMClient interface
- ShellTool trusted mode for internal commands (#483)
- GlobTool + GrepTool integration in negotiator-context (#482)
- Post-execution GitDiff verification in TaskLifecycle
- Stale dimension refresh via `measureDirectly()` before gap calculation

### Fixed
- Chat REPL hang: removed vitest execution from `buildChatContext`, added `TERM=dumb` to Codex CLI spawn env, bypassed `executeWithTools` for CodexLLMClient (#488)
- Logged errors in `executeWithTools` catch block instead of silently swallowing them (#487, #489)
- Persisted refreshed dimension values after tool-based measurement (#485)
- Replaced literal null bytes with `String.fromCharCode(0)` in git-diff tool
- Skipped tool observation when parsedValue is null
- Removed non-existent `last_observed` field from Dimension refresh

### Refactored
- Consolidated tool output parsing into shared `parseToolOutput` utility
- Replaced raw `execFile` calls with builtin tool system across observation, gap-calculation, and chat verification

## [0.1.5] - 2026-04-03

### Added

- Added Telegram bot plugin for bidirectional chat and notifications (#421).
- Added chat grounding — PulSeed self-knowledge for chat mode (#422).
- Enriched chat context and added workspace token budget.
- Added chat verification loop with retry.
- Added self-knowledge tools — on-demand self-awareness for chat (#437).
- Added self-knowledge mutation tools with approval flow (#438).

### Fixed

- Fixed tsc build errors in context-assembler (threshold union + current_value types).
- Fixed unsafe as any[] casts in context-assembler (#423, #366).
- Fixed retry for HTTP 429 rate-limit responses with extended backoff (#433).
- Fixed CoreLoop iteration wrapped in top-level try/catch for standalone mode (#434).
- Hardened StateManager catch blocks: corrupt JSON handling, history cap, git stderr (#429–#432, #435).
- Fixed duplicate detectRepetitivePatterns/stringSimilarity methods.
- Fixed maxRetries in rmSync cleanup for Node 22 ENOTEMPTY flaky (#455).

### Changed

- Improved task execution accuracy inspired by Claude Code patterns.
- Added filtering of past strategies by dimension relevance.
- Added repetitive pattern detection to StallDetector.

### Refactored

- Reorganized src/ folder structure (Phase 1–3) (#443).
- Subdivided execution/ into task/ and context/ subfolders (Phase 4) (#444).
- Moved top-level src/ files to subfolders (Phase 5) (#445).
- Split task-verifier.ts into types + rules + llm modules (Phase 6a) (#446).
- Extracted command dispatch from cli-runner.ts (Phase 6b) (#447).
- Extracted LLM query methods from knowledge-manager.ts (Phase 6c) (#448).
- Extracted pure formatters from reporting-engine.ts (Phase 6d) (#449).
- Extracted file I/O helpers from state-manager.ts (Phase 6e) (#450).
- Extracted iteration phases from core-loop.ts (Phase 6f) (#451).
- Extracted cron/health helpers from daemon-runner.ts (Phase 6g) (#452).
- Extracted allocation helpers from portfolio-manager.ts (Phase 6h) (#453).
- Updated module-map.md for restructure (Phase 7) (#454).
- Renamed TaskHistoryEntry to StallTaskHistoryEntry in stall-detector (#436).
- Consolidated duplicate StrategyResponseSchema and StrategyArraySchema (#355).

## [0.1.4] - 2026-04-02

### Added

- Added `pulseed chat` — unified agent entry point for interactive chat mode (Phase 1) (#419).
- Added `pulseed logs` command with `--follow` (real-time tail with rotation handling), `--lines N`, and `--level` filtering (ERROR > WARN > INFO > DEBUG) (#420).
- Added `pulseed install` / `pulseed uninstall` commands for macOS launchd integration — generates plist, registers with `launchctl`, enables auto-start on boot with KeepAlive (#420).
- Added `pulseed doctor` command with 10-point health check: Node.js version, PulSeed directory, provider config, API key, goals, log directory, build artifact, daemon status, notifications, disk usage (#420).
- Added `pulseed notify add/list/remove/test` commands for notification channel management (Slack webhook, generic webhook, email) with persistent config at `~/.pulseed/notification.json` (#420).
- Enriched `pulseed daemon status` with uptime display, relative cycle times, config section (interval, adaptive sleep, iterations, proactive mode, crash recovery counter), and box-drawing formatting (#420).
- Added grep-based content matching to observation context selection for more relevant file selection (#418).
- Added structured monitoring logs to core execution path for better daemon observability (#407).
- Added forced goal decomposition on first daemon iteration for immediate tree structure (#408).
- Enriched task prompts with parent goal context, issue content, and purpose statement (#409).

### Fixed

- Fixed TS2454 build error in `session-manager.ts` by adding default case to session context switch.
- Fixed `force` flag not propagating to `goalRefiner.refine()`, breaking tree decomposition (#417).
- Fixed missing `goal.title` in observation context and added tree decomposition debug logs (#414).
- Fixed dimension-aware file selection for observation — forced tree decomposition + smarter context (#413).
- Fixed `goalRefiner` not wired to `TreeLoopOrchestrator` + widened observation context limits (MAX_CONTEXT_CHARS=16000) (#412).
- Fixed dogfood reliability issues: goalRefiner wiring, workspace auto-detection, LLM progress logging (#411).
- Fixed leaf test prompt hardening and LLM call progress logs for dogfooding (#410).
- Fixed `--check-interval-ms` and `--iterations-per-cycle` CLI flags not wired for daemon start (#405).
- Fixed daemon `start`/`stop`/`cron` subcommands not registered in cli-runner.

## [0.1.3] - 2026-04-01

### Added

- Added Phase A-C proactive AI orchestration: CronScheduler, MCP client/server, HookManager, TriggerMapper, request batching, and agent profiles (#399, #400).
- Added trigger API (`POST /triggers`) with configurable trigger-to-goal mappings and 4 actions (observe, create_task, notify, wake).
- Added `GET /goals` and `GET /goals/:id` REST endpoints to EventServer.
- Added adaptive sleep with time-of-day, urgency, and activity factors for daemon interval tuning.
- Added proactive tick with LLM-powered idle-time actions (suggest_goal, investigate, preemptive_check).
- Added 115 E2E tests covering Phase A-C features.
- Added dogfooding scripts: `dogfood-hooks.sh`, `dogfood-daemon-proactive.sh`, `dogfood-cron.sh`, `dogfood-30min-integrated.sh`.

### Fixed

- Fixed daemon blocking cron/proactive/sleep during long-running `CoreLoop.run()` — changed to interleaved 1-iteration-per-goal-per-cycle execution with configurable `iterations_per_cycle` (#401).
- Fixed cron scheduler `isDue()` bidirectional jitter pushing `adjustedPrev` into the future, causing missed and phantom firings — changed to one-sided negative jitter.
- Fixed `EventServer.isWatching()` and `getEventsDir()` incorrectly marked as `private`.
- Fixed CI build failure: added missing `@modelcontextprotocol/sdk` and `cron-parser` to package.json dependencies.
- Fixed `test_count` DataSource to search all `.ts/.js` files from workspace root (#389, #390, #391).
- Fixed shell DataSource to use `workspace_path` as cwd (#387).
- Fixed jump suppression for present/match binary dimensions (#386).
- Fixed match type gap calculation for numeric observation values (#385).
- Fixed dynamic workspace context resolution for LLM observation (#384).
- Fixed LLM observation to read workspace files when git diff is empty (#383).
- Fixed constraints inheritance in decomposed subgoals and raw goal creation paths.
- Fixed workspace path wiring through CLI, observation engine, and datasource registration.
- Fixed gap=1.00 stuck after successful task execution (#375).
- Fixed knowledge gap detection limited to first iteration only (#375).
- Fixed fallback to exact dimension name when normalization fails (#374).
- Fixed untracked file detection in post-execution change check (#373).
- Fixed Codex adapter to produce file-modifying tasks (#371).

### Added (Infrastructure)

- Added `GET /health` endpoint to EventServer.
- Added `daemon status` command and `--detach` flag (#369).
- Added `GoalLoop` guard for bounded goal execution (#368).
- Added OpenAI OAuth token support from `~/.codex/auth.json` (#370).
- Added gradual gap decrease and continuous value gap dogfooding scripts.

## [0.1.2] - 2026-03-30

### Added

- Added `ProgressPredictor` for early stall detection via linear regression on gap history, with new stall types `predicted_plateau` and `predicted_regression` (#343).
- Added difficulty-based curriculum ordering for subgoal selection — medium-complexity subgoals (0.3–0.7 band) are prioritized, with a near-complete guard to prevent task starvation (#344).
- Added PulSeed ASCII banner (Sprout Green) to setup wizard (#342).
- Added per-iteration log line in CoreLoop for timeout diagnosis (#349).

### Fixed

- Fixed `improve` / `suggest` commands hanging indefinitely on LLM timeout — added `SuggestTimeoutError` with configurable 30s default and `try/finally` cleanup (#351).
- Fixed `cleanup` command not removing orphaned datasources for deleted goals (#350).
- Fixed datasource dedup key to include `scope_goal_id`, preventing incorrect merging of scoped datasources for different goals (#350).
- Fixed Anthropic adapter ignoring `config.model` setting (#341).

## [0.1.1] - 2026-03-29

### Fixed

- Added `maxRetries` to `rmSync` for Node 22 flaky test reliability (#340).
- Parallelized dimension LLM calls in negotiate/renegotiate for faster goal setup (#338).
- Fixed `looksLikeSoftwareGoal` bypassing normalizer `isSoftwareGoal` check (#337).
- Improved OSS documentation readability — reorganized, translated, and added missing docs (#339).

## [0.1.0] - 2026-03-28

### Demo Release

First public demo release of PulSeed — an AI agent orchestrator that gives existing agents the drive to persist. PulSeed sits above agents, selecting goals, spawning sessions, observing results, and judging completion. PulSeed delegates all execution; it does not act directly.

Renamed from SeedPulse to PulSeed. Published to npm as [`pulseed`](https://www.npmjs.com/package/pulseed).

### Added

#### Core Loop and Goal Model

- Added the core orchestration loop: observe → gap → score → task → execute → verify, running autonomously until satisficing completion.
- Added the 4-element goal model: Goal (with measurable thresholds), Current State (observation + confidence), Gap, and Constraints.
- Added goal negotiation with feasibility evaluation, dimension decomposition, and counter-proposal handling.
- Added recursive goal tree for sub-goal management with concreteness scoring, decomposition quality metrics, and maxDepth enforcement.
- Added satisficing completion judgment: execution stops when the goal is "good enough" rather than continuing toward perfection.
- Added convergence detection in `SatisficingJudge` to prevent infinite iteration on plateau states.

#### Observation and Verification

- Added 3-layer observation pipeline: mechanical checks (shell/file) → LLM-powered review → self-report fallback.
- Added 3-layer verification pipeline: mechanical checks → LLM reviewer → self-report fallback.
- Added `ShellDataSourceAdapter` and `FileExistenceDataSourceAdapter` for evidence-based observation.
- Added cross-validation across observation layers to improve confidence scoring.
- Added hypothesis verification mechanism for strategy assessment.

#### Drive, Scoring, and Trust

- Added drive scoring with three components: dissatisfaction (gap magnitude), deadline urgency, and opportunity cost.
- Added asymmetric trust system: success adds +3, failure subtracts -10, bounded to [-100, +100].
- Added stall detection with graduated responses (warn → escalate → abort strategy).
- Added monotonic progress controls that prevent score backsliding during repeated evaluations.

#### Safety and Ethics

- Added 2-stage ethics gate for goal screening before execution begins.
- Added path traversal protection in `StateManager.readRaw` / `writeRaw`.
- Added shell-binary denylist enforcement in `ShellDataSourceAdapter`.
- Added sensitive-directory denylist in workspace context to prevent credential leakage.

#### Strategy and Portfolio

- Added strategy management with portfolio optimization across concurrent goals.
- Added momentum allocation with velocity and trend detection, topological dependency scheduling, and stall-triggered rebalancing.
- Added embedding-based strategy template recommendation combining tag scoring and vector similarity.
- Added cross-goal pattern sharing with persistent storage in `KnowledgeTransfer`.

#### Adapters

- Added `claude_code_cli` adapter for Claude Code CLI agent delegation.
- Added `openai_codex_cli` adapter for OpenAI Codex CLI agent delegation.
- Added `browser_use_cli` adapter for browser-automation task delegation.
- Added `claude_api` adapter for direct Anthropic API calls.
- Added `github_issue` adapter for GitHub REST API integration.
- Added `a2a` adapter for Agent-to-Agent protocol interoperability.

#### CLI

- Added `goal add`, `goal list`, and `goal archive` commands.
- Added `run` command to start the autonomous core loop.
- Added `status` and `report` commands for runtime inspection.
- Added `cleanup` command to remove stale state files.
- Added `datasource add`, `datasource list`, and `datasource remove` commands.
- Added `improve` command for LLM-powered goal suggestion.
- Added `--yes` flag (position-independent) to skip confirmation prompts in all flows.
- Added `ensure-api-key` CLI helper for interactive provider key setup.

#### Infrastructure

- Added plugin architecture for external integrations, loaded dynamically from `~/.pulseed/plugins/`.
- Added TUI dashboard built with Ink/React, including approval UI and chat interface.
- Added Web UI built with Next.js, covering Goals, Sessions, Knowledge, and Settings pages.
- Added daemon mode with PID management, graceful shutdown, and interrupted goal state restoration.
- Added event server with HTTP and file-queue (`~/.pulseed/events/`) ingestion modes.
- Added notification dispatcher with SMTP email delivery via `nodemailer`.
- Added date-based log rotation with async stream management.

#### Knowledge and Memory

- Added semantic knowledge base with `IEmbeddingClient` abstraction (OpenAI / Ollama / Mock backends).
- Added `VectorIndex` with hand-implemented cosine similarity search (no external dependencies).
- Added knowledge graph and goal dependency graph with cycle detection.
- Added learning pipeline with 4-step structural feedback recording and parameter auto-tuning suggestions.
- Added knowledge transfer with cross-goal pattern extraction and sharing.
- Added hierarchical memory with three-tier storage (core / recall / archival), LLM-driven page-in/page-out, and dynamic context budgeting.

#### Character and Curiosity

- Added curiosity engine for autonomous exploration of underobserved goal dimensions.
- Added character configuration manager for personality and ethics profile customization.
- Added Reflexion-style reflection with task-lifecycle split for iterative self-improvement.

#### Developer Experience

- Added custom Error class hierarchy for error classification and stack filtering.
- Added 4-point guardrail callbacks (before/after execution, before/after LLM call) for observability.
- Added LLM fault-tolerance guards covering enum sanitization, direction-check on `dimension_updates`, and Zod validation across 6 modules.
- Added npm publishing metadata including `exports`, license, author fields, and `.npmignore`.
- Added `SECURITY.md`, `CONTRIBUTING.md`, competitor comparison table, and OSS-quality README badges.
- Test suite: 4315 tests across 196 test files.
