# Motiva

AI agent orchestrator that gives existing agents "motivation" — goal-driven task discovery, autonomous progress observation, and satisficing completion judgment.

---

## What is Motiva?

Motiva is a **task discovery engine**. You give it a long-term goal — "double revenue in 6 months," "keep my dog healthy and happy" — and it pursues that goal autonomously, indefinitely. It observes the real world, calculates the gap between the goal and current reality, generates the next task to close that gap, delegates it to an AI agent (CLI-type, API-type, or a custom adapter — e.g., Claude Code, OpenAI Codex CLI), and verifies the result. Then it loops.

The key distinction from existing tools: Motiva doesn't execute. It orchestrates. It makes agents think, then verifies that their thinking produced real progress. Every action is delegated; Motiva's direct operations are limited to LLM calls (for reasoning) and state file read/write.

Motiva is built on a **4-element model**: a Goal (with measurable thresholds), Current State (observed with confidence scores), the Gap between them, and Constraints that govern how tasks may be executed. The **core loop** — observe → gap → score → task → execute → verify — runs until the goal is satisfied or the system escalates to a human.

Motiva knows when to stop. Rather than pursuing perfection, it applies *satisficing*: when all goal dimensions cross their thresholds with sufficient evidence, the goal is complete. No runaway loops. No premature completion on self-reported progress alone.

---

## Quick Start

**Requirements:** Node.js 18+, an OpenAI or Anthropic API key.

### Installation (npm)

```bash
# Install from npm (recommended)
npm install -g motiva

# Set your API key (OpenAI is the default provider)
export OPENAI_API_KEY=sk-...

# Or use Anthropic instead
export MOTIVA_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

### First Run

```bash
# Register a goal (launches goal negotiation — Motiva will assess feasibility
# and propose measurable dimensions)
motiva goal add "Create a comprehensive README for this project"

# Run one iteration of the core loop
motiva run

# Check current goal progress
motiva status

# List all registered goals
motiva goal list

# Display the latest report
motiva report
```

On first run, Motiva initializes its state directory at `~/.motiva/`.

### Development Installation

```bash
# Clone and build from source
git clone https://github.com/your-org/motiva.git
cd motiva
npm install
npm run build

# Set your API key
export OPENAI_API_KEY=sk-...
# or ANTHROPIC_API_KEY + MOTIVA_LLM_PROVIDER

# Run the local CLI
npx tsx src/index.ts goal add "Your goal here"
npx tsx src/index.ts run
```

---

## Programmatic Usage

```typescript
import { CoreLoop, CLIRunner } from "motiva";

// See docs/ for full API documentation
```

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User                                        │
│   Goals: "2x revenue"  "keep my dog healthy"                         │
│   Constraints: "don't share customer data"  "respect vet's judgment" │
│   Capabilities: API keys, sensor access, DB connections              │
└───────────────┬─────────────────────────────┬───────────────────────┘
                │ goal + constraints           │ reports + approval requests
                ↓                             ↑
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                    Motiva (Task Discovery Engine)                      │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │           Goal Negotiation                                    │     │
│  │  Ethics Gate (Step 0) → receive → decompose → baseline obs   │     │
│  │  → feasibility eval → accept / counter-propose / flag        │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              ↓ agreed goal                            │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │           Goal Tree (recursive)                               │     │
│  │     top-level goal                                            │     │
│  │      ├── sub-goal A ── each node holds its own state vector  │     │
│  │      │    ├── sub-goal A-1                                    │     │
│  │      │    └── sub-goal A-2                                    │     │
│  │      ├── sub-goal B                                           │     │
│  │      └── sub-goal C                                           │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              ↓ loop runs at each node                 │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                   Core Loop                                   │     │
│  │                                                               │     │
│  │  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │     │
│  │  │ Observe│─→│  Gap     │─→│  Drive   │─→│  Task    │       │     │
│  │  │ (3-layer)  │ Calc     │  │ Scoring  │  │ Generate │       │     │
│  │  └────────┘  └──────────┘  └──────────┘  └────┬─────┘       │     │
│  │      ↑                                        │              │     │
│  │      │       ┌──────────┐  ┌──────────┐       │              │     │
│  │      └───────│  Verify  │←─│ Execute  │←──────┘              │     │
│  │              │ (3-layer)│  │ (agent)  │                      │     │
│  │              └──────────┘  └──────────┘                      │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌──── Cross-cutting ────────────────────────────────────────────┐    │
│  │  Trust & Safety │ Satisficing │ Stall Detection │ Ethics Gate │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌──── Infrastructure ───────────────────────────────────────────┐    │
│  │  Drive System (4 triggers) │ Context Mgmt │ State (JSON)      │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ task delegation
                                    ↓
┌───────────────────────────────────────────────────────────────────────┐
│                     Execution Layer (existing systems)                │
│                                                                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐ │
│  │ CLI Agent  │ │ LLM API    │ │ Custom     │ │ Human              │ │
│  │ (implement) │ │ (analysis) │ │ Agents     │ │ (approve/decide)   │ │
│  └────────────┘ └────────────┘ └────────────┘ └────────────────────┘ │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Data Sources: sensors, DB, analytics, CRM, external APIs, IoT  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

### Implementation Layers

Motiva is structured in 7 layers, built bottom-up:

| Layer | Modules | Role |
|-------|---------|------|
| 0 | StateManager, AdapterLayer | Persistence and agent abstraction (no dependencies) |
| 1 | GapCalculator, DriveSystem, TrustManager | Gap computation, event scheduling, trust tracking |
| 2 | ObservationEngine, DriveScorer, SatisficingJudge, StallDetector | Observation, scoring, completion and stall judgment |
| 3 | LLMClient, EthicsGate, SessionManager, StrategyManager, GoalNegotiator | LLM interface, ethics, session context, goal negotiation |
| 4 | TaskLifecycle | Full task lifecycle: select → generate → approve → execute → verify |
| 5 | CoreLoop, ReportingEngine | Orchestration loop, report generation |
| 6 | CLIRunner | Entry point, subcommand dispatch |

---

## Core Loop

Each iteration of the core loop moves a goal closer to its thresholds:

1. **Observe** — collect evidence from the real world using 3-layer observation (mechanical checks → independent LLM review → executor self-report). Higher layers override lower ones.
2. **Gap calculation** — compute `raw_gap` per dimension, normalize to `[0,1]`, apply confidence weighting (low confidence inflates the gap estimate).
3. **Drive scoring** — score three drives: dissatisfaction (gap magnitude), deadline urgency (exponential as deadline approaches), opportunity (time-decaying value). The highest score selects the priority dimension.
4. **Task generation** — an LLM concretizes "what to do": work description, verifiable success criteria, scope boundaries, inherited constraints.
5. **Execute** — delegate to the selected adapter. Motiva does not intervene during execution; it only monitors status, timeout, and heartbeat.
6. **Verify** — 3-layer result verification: mechanical checks (tests, files, builds) → independent LLM reviewer → executor self-report. Verdict: `pass / partial / fail`. On failure: keep, discard, or escalate to human.

The loop repeats until: goal completed (SatisficingJudge), stall escalation, max iterations reached, or explicit stop.

---

## Key Design Principles

- **Evidence-based observation** — progress is never inferred from activity. Only verifiable evidence (test results, file diffs, metric readings) can advance a goal dimension. Self-report alone caps progress at 70%.
- **Satisficing** — Motiva stops when all dimensions cross their thresholds with sufficient confidence. It does not pursue perfection. Goals are declared complete; they are not abandoned.
- **Trust balance (asymmetric)** — trust score is per-domain, range `[-100, +100]`. Success: `+3`. Failure: `-10`. Irreversible actions always require human approval, regardless of trust level.
- **Execution boundary** — Motiva reasons; agents act. The only direct operations Motiva performs are LLM calls and state file read/write. Code execution, data collection, notifications — all delegated.
- **Ethics gate** — every goal passes through a two-stage ethics check before negotiation begins. Goals that cross legal or ethical lines are rejected outright. Edge cases are flagged for human review.
- **Stall detection** — four stall indicators (dimension stall, time overrun, consecutive failure, global stall) trigger graduated responses: approach change → strategy pivot → human escalation.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `motiva goal add "<description>"` | Start goal negotiation. Motiva evaluates feasibility, decomposes into measurable dimensions, and registers the agreed goal. |
| `motiva goal list` | Display all registered goals with current status. |
| `motiva run` | Execute one iteration of the core loop across active goals. |
| `motiva status` | Show current progress report: goal dimensions, gaps, trust scores, recent activity. |
| `motiva report` | Display the latest generated report (execution summary or daily). |

Exit codes: `0` normal completion, `1` error, `2` stall escalation requiring human input.

---

## Development

```bash
# Install dependencies
npm install

# Build (TypeScript → dist/)
npm run build

# Run all tests (983 tests, 18 files)
npm test

# Type check without emit
npm run typecheck

# Run tests in watch mode
npm run test:watch
```

State files are written to `~/.motiva/`. Reports are saved to `~/.motiva/reports/`. Ethics logs are at `~/.motiva/ethics/`.

---

## Project Status

**MVP complete.** All 6 implementation stages are done:

- Stage 1-2: Type system, state persistence, gap calculation, drive scoring, observation, stall detection, satisficing
- Stage 3: LLM client, ethics gate, session management, strategy management, goal negotiation
- Stage 4: Adapter layer (CLI agents, LLM APIs, custom adapters), task lifecycle
- Stage 5: Core loop, reporting engine
- Stage 6: CLI runner (5 subcommands)

**983 tests passing across 18 test files.**

**What's next:**
- Manual end-to-end testing with real goals and live LLM calls
- Phase 2 features: knowledge acquisition, portfolio management (parallel strategy execution), HTTP event ingestion, daemon/cron process model

---

## License

MIT
