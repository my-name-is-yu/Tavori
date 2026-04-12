# Architecture Map

<<<<<<< HEAD
Implementation-facing baseline: [docs/design/current-baseline.md](design/current-baseline.md)

---
=======
This is the public architecture map for the current codebase.
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)

## 1. Top-level picture

<<<<<<< HEAD
PulSeed is a **task discovery engine**. It takes on the user's long-term goals ("I want to double revenue," "I want to live happily with my dog"), observes the real world, and keeps discovering "what should be done next" from the gap with the goal. PulSeed itself executes nothing. It delegates discovered tasks to AI agents, verifies the results, and runs the loop again. Until the goal is achieved — days or years, however long it takes.

---

## 2. Overall Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                              User                                    │
│   Goals: "Double revenue" / "Live happily with my dog"               │
│   Constraints: "Don't share customer data" / "Respect vet's judgment"│
│   Capability grants: API keys, sensors, DB access, permissions       │
└───────────────┬─────────────────────────────┬───────────────────────┘
                │ Goal setting, constraints,   │ Reports, approval requests
                │ capability grants            │
                ↓                               ↑
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                      PulSeed (Task Discovery Engine)                  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │              Goal Negotiation                                 │     │
│  │   Ethics Gate (Step 0) → Receive goal → Dimension            │     │
│  │   decomposition → Baseline observation                       │     │
│  │   → Feasibility evaluation → Accept / Counter-propose /      │     │
│  │     Cautionary flag                                           │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              ↓ Agreed-upon goal                       │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │              Goal Tree (Recursive Goal Tree)                  │     │
│  │     Top-level goal                                            │     │
│  │      ├── Sub-goal A ── Each node holds its own state vector  │     │
│  │      │    ├── Sub-goal A-1                                    │     │
│  │      │    └── Sub-goal A-2                                    │     │
│  │      ├── Sub-goal B                                           │     │
│  │      └── Sub-goal C                                           │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              ↓ Loop runs at each node                 │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Core Loop                                  │     │
│  │                                                               │     │
│  │   ┌────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐ │     │
│  │   │Observe │──→│  Gap     │──→│  Drive   │──→│  Task    │ │     │
│  │   │(3-layer│    │Calculation│   │ Scoring  │   │Generation│ │     │
│  │   └────────┘    └──────────┘    └──────────┘    └────┬─────┘ │     │
│  │       ↑                                               │       │     │
│  │       │         ┌──────────┐    ┌──────────┐          │       │     │
│  │       └─────────│  Result  │←───│ Session  │←─────────┘       │     │
│  │                 │Verification│   │Execution │                  │     │
│  │                 │ (3-layer) │    └──────────┘                  │     │
│  │                 └──────────┘                                   │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌─────────── Knowledge / Capability Layer ───────────────────────┐   │
│  │  KnowledgeManager (knowledge acquisition, conflict detection)  │   │
│  │  CapabilityDetector                                            │   │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌─────────── Portfolio Management ───────────────────────────────┐   │
│  │  PortfolioManager (parallel multi-strategy execution,          │   │
│  │  effectiveness measurement, automatic rebalancing)             │   │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌─────────── Cross-Cutting Mechanisms ───────────────────────────┐   │
│  │  Trust & Safety │ Satisficing │ Stall Detection │ Curiosity    │   │
│  │  │ Execution Boundary                                          │   │
│  │  CharacterConfigManager (Layer 11, 4-axis parameter injection) │   │
│  │  CuriosityEngine (Layer 11, 5 trigger conditions,              │   │
│  │    autonomous curiosity goal generation)                       │   │
│  │  EmbeddingClient, VectorIndex, KnowledgeGraph,                 │   │
│  │  GoalDependencyGraph (Layer 12, semantic embedding infra)      │   │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌─────────── External Connections / Goal Tree Layer ─────────────┐   │
│  │  Layer 13: CapabilityDetector (autonomous capability           │   │
│  │            acquisition)                                        │   │
│  │            DataSourceAdapter (external world connection)       │   │
│  │  Layer 14: GoalTreeManager (N-level goal decomposition,        │   │
│  │            aggregation, pruning)                               │   │
│  │            StateAggregator (child node state aggregation,      │   │
│  │            completion cascade)                                 │   │
│  │            TreeLoopOrchestrator (parallel node loop execution) │   │
│  │            CrossGoalPortfolio (cross-goal priority and         │   │
│  │            resource allocation)                                │   │
│  │            StrategyTemplateRegistry (strategy template mgmt)  │   │
│  │            LearningPipeline (4-trigger learning, cross-goal    │   │
│  │            pattern sharing)                                    │   │
│  │            KnowledgeTransfer (cross-goal knowledge and         │   │
│  │            strategy transfer)                                  │   │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌─────────── Infrastructure ──────────────────────────────────────┐  │
│  │  Drive System (4 triggers) │ Context Management │ State         │  │
│  │  Persistence (JSON)                                             │  │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌─────────── TUI Layer (src/interface/tui/) ─────────────────────┐   │
│  │  App │ Dashboard │ Chat │ ApprovalOverlay │ HelpOverlay │       │   │
│  │  ReportView │ IntentRecognizer                                  │   │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ Task delegation
                                    ↓
┌───────────────────────────────────────────────────────────────────────┐
│                        Execution Layer (Existing Systems)             │
│                                                                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐ │
│  │ CLI Agents │ │ LLM API    │ │ Custom     │ │ Humans             │ │
│  │(code impl) │ │(analysis/  │ │ Agents     │ │ (approval/judgment)│ │
│  │            │ │ summaries) │ │            │ │                    │ │
│  └────────────┘ └────────────┘ └────────────┘ └────────────────────┘ │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Data Sources: sensors, DB, Analytics, CRM, external APIs, IoT  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
=======
```text
user / daemon / chat / tui
          |
          v
    interface layer
          |
          v
      CoreLoop
          |
    +-----+-------------------+
    |                         |
    v                         v
agentic core phases      task lifecycle
    |                         |
    v                         v
 AgentLoop               adapter / agent_loop
    |                         |
    +-----------+-------------+
                |
                v
              tools
                |
                v
   state / memory / Soil / external world
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
```

## 2. Directory-level map

### `src/base`

Foundation types and infrastructure:

- provider config
- LLM client abstractions
- state manager
- common types and utilities

### `src/platform`

Cross-cutting domain services:

- drive and satisficing
- observation
- knowledge and memory
- Soil
- traits such as trust and ethics
- time and tool-facing platform services

### `src/orchestrator`

Long-lived orchestration logic:

- `loop/`: CoreLoop, iteration kernel, tree/multi-goal runners
- `execution/`: task lifecycle, session management, native AgentLoop runtime
- `goal/`: goal negotiation, tree orchestration, aggregation
- `strategy/`: strategy and portfolio management
- `knowledge/`: orchestration-facing transfer helpers

### `src/tools`

Built-in tool system:

- filesystem
- system
- query
- mutation
- schedule
- network
- Soil tools

### `src/interface`

User-facing runtime surfaces:

- `cli/`
- `chat/`
- `tui/`
- `mcp-server/`

### `src/runtime`

Resident runtime support:

- daemon
- queue
- gateway
- schedule engine
- runtime health store

## 3. CoreLoop map

CoreLoop is the main long-lived controller.

Important public subparts:

- `src/orchestrator/loop/core-loop.ts`
- `src/orchestrator/loop/core-loop/iteration-kernel.ts`
- `src/orchestrator/loop/tree-loop-runner.ts`
- `src/orchestrator/goal/tree-loop-orchestrator.ts`

What CoreLoop owns:

- observation to completion flow
- tree-mode and multi-goal scheduling
- stall and refine/pivot decisions
- bounded agentic core phases
- next-iteration directives

## 4. AgentLoop map

AgentLoop is the bounded execution engine.

Important public subparts:

- `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts`
- `src/orchestrator/execution/agent-loop/task-agent-loop-runner.ts`
- `src/orchestrator/execution/agent-loop/chat-agent-loop-runner.ts`
- `src/orchestrator/execution/agent-loop/agent-loop-compactor.ts`
- `src/orchestrator/execution/agent-loop/task-agent-loop-worktree.ts`

What AgentLoop owns:

- tool-driven turn execution
- stop conditions
- completion schema
- context compaction
- repeated tool loop detection
- task/chat session traces

## 5. How CoreLoop and AgentLoop connect

CoreLoop uses AgentLoop in two ways.

### Task execution path

When the active adapter is `agent_loop`, `TaskLifecycle` routes execution through the native AgentLoop runtime.

### Core phase path

CoreLoop can run bounded agentic phases such as:

- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These phases use strict tool policy and bounded budgets.

## 6. Tool and Soil layer

The tool layer is a shared substrate.

Important public capabilities:

- file inspection and editing
- shell command execution
- test running
- task and goal state queries
- knowledge and memory queries
- Soil read and maintenance tools

`soil_query` is especially important because it gives bounded agent runs access to PulSeed's readable long-term memory surface.

## 7. Runtime surfaces

### CLI

Good for:

- setup
- one-shot loop execution
- goal and task inspection
- daemon control

### Chat

Good for:

- bounded interactive work
- tool-driven conversations
- operating CoreLoop through tools

### TUI

Good for:

- live inspection
- approvals
- chat plus goal progress in one surface

### Daemon

Good for:

- long-lived execution
- schedules
- background runtime health and recovery

## 8. Persistence map

PulSeed persists local-first state under `~/.pulseed/`.

Publicly relevant buckets:

- goals
- tasks
- reports
- runtime state
- schedules
- checkpoints
- memory
- Soil projections

## 9. Source of truth

For the public picture:

- this file is the architectural overview
- [Module Map](module-map.md) is the code navigation companion
- `src/` is the implementation truth

Historical deep design docs remain in `docs/design/`, but some describe earlier stages or alternatives rather than the exact current runtime path.
