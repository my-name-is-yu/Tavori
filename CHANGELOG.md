# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.2] - 2026-03-22

### Fixed

- TUI layout: resolve chat/dashboard overlap, border misalignment, and separator issues (#176)

### Changed

- TUI: hide dashboard sidebar by default; toggle with `/dashboard` command (#178)
- TUI: autocomplete now executes command on selection (single Enter, no confirmation step)
- TUI: typing `/` shows all available commands

## [0.1.1] - 2026-03-26

### Fixed

- Fixed LLM observation confidence: downgrade from 0.70 to 0.30 (`self_report` layer) when no DataSource can observe a dimension (#300)
- Fixed skip-path observation entry: uses `self_report` layer when `sourceAvailable === false` instead of hardcoded `independent_review`
- Fixed `suggest` command: skip `repo_context` injection for non-software goals (#298)
- Fixed `improve negotiate` timeout hang when LLM response is slow (#308)
- Fixed dimension name fuzzy matching in negotiate flow (#309)
- Fixed range-type dimension threshold parse error for hyphen-separated values like `7-9` (#314)
- Fixed stall detector: zero-progress early detection (#294)
- Fixed `suggest` command: README.md prompt leak in output (#297)
- Fixed `improve --max` flag propagation (#299)
- Fixed Codex CLI integration: removed deprecated `--path` argument, using `cwd` instead
- Fixed TUI intent recognizer: LLM fallback errors were silently swallowed, now logged

### Added

- Added auto goal decomposition with sub-goal tree mode switching (#295)
- Added dimension auto-inference from ambiguous goal titles (#296)

### Changed

- LLM prompt for range dimensions now uses comma-separated format (`10,20`) instead of hyphen
- Translated all TUI text from Japanese to English (status labels, input placeholder)

## [0.1.0] - 2026-03-23

### Initial Release

First public release of PulSeed — an AI agent orchestrator that gives existing agents the drive to persist. PulSeed sits above agents, selecting goals, spawning sessions, observing results, and judging completion. PulSeed delegates all execution; it does not act directly.

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
