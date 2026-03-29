# Design Documents

Overview of SeedPulse's design documentation, organized by subsystem.

## Core — Loop and State Management

| Document | Description |
|----------|-------------|
| [Drive System](core/drive-system.md) | Internal motivation and persistence mechanisms |
| [Drive Scoring](core/drive-scoring.md) | How drive intensity is calculated and prioritized |
| [Gap Calculation](core/gap-calculation.md) | Computing the gap between current state and goal thresholds |
| [State Vector](core/state-vector.md) | Multi-dimensional state representation |
| [Observation](core/observation.md) | How SeedPulse observes the current state of the world |
| [Stall Detection](core/stall-detection.md) | Detecting when progress has stalled and triggering recovery |
| [Satisficing](core/satisficing.md) | Judging when a goal is "good enough" to stop |

## Goal — Goal Lifecycle

| Document | Description |
|----------|-------------|
| [Goal Negotiation](goal/goal-negotiation.md) | How goals are negotiated with feasibility evaluation |
| [Goal Refinement Pipeline](goal/goal-refinement-pipeline.md) | Pipeline for refining raw goals into structured dimensions |
| [Goal Tree](goal/goal-tree.md) | Hierarchical goal decomposition and cross-goal orchestration |
| [Goal Ethics](goal/goal-ethics.md) | Ethics gate for goal validation and safety |
| [Execution Boundary](goal/execution-boundary.md) | Defining what SeedPulse does vs. delegates |

## Knowledge — Learning and Memory

| Document | Description |
|----------|-------------|
| [Hierarchical Memory](knowledge/hierarchical-memory.md) | Multi-tier context memory (hot/warm/cold/archival) |
| [Memory Lifecycle](knowledge/memory-lifecycle.md) | Promotion, demotion, and archival of memory entries |
| [Knowledge Acquisition](knowledge/knowledge-acquisition.md) | Autonomous capability and knowledge discovery |
| [Knowledge Transfer](knowledge/knowledge-transfer.md) | Cross-goal knowledge sharing and reuse |
| [Learning Pipeline](knowledge/learning-pipeline.md) | Outcome-based learning and pattern extraction |
| [Hypothesis Verification](knowledge/hypothesis-verification.md) | PIVOT/REFINE decision mechanism for stalled strategies |

## Execution — Task and Strategy Management

| Document | Description |
|----------|-------------|
| [Task Lifecycle](execution/task-lifecycle.md) | Task creation, execution, verification, and completion |
| [Session and Context](execution/session-and-context.md) | Session management and context injection |
| [Portfolio Management](execution/portfolio-management.md) | Strategy discovery, parallel execution, and rebalancing |
| [Multi-Agent Delegation](execution/multi-agent-delegation.md) | Delegating work to sub-agents in parallel |
| [Data Source](execution/data-source.md) | External data source integration for observations |

## Infrastructure — LLM, Plugins, and UI

| Document | Description |
|----------|-------------|
| [LLM Fault Tolerance](infrastructure/llm-fault-tolerance.md) | Resilience patterns for LLM API calls |
| [Token Optimization](infrastructure/token-optimization.md) | Strategies for reducing LLM token usage |
| [Prompt Context Architecture](infrastructure/prompt-context-architecture.md) | How hierarchical memory feeds into LLM prompts |
| [Plugin Architecture](infrastructure/plugin-architecture.md) | Plugin loading, lifecycle, and registry |
| [Plugin Development Guide](infrastructure/plugin-development-guide.md) | How to build SeedPulse plugins |
| [Reporting](infrastructure/reporting.md) | Progress reporting and visualization |
| [Web UI](infrastructure/web-ui.md) | Next.js web dashboard design |

## Personality — Character, Ethics, and Branding

| Document | Description |
|----------|-------------|
| [Character](personality/character.md) | SeedPulse personality traits and behavioral parameters |
| [Curiosity](personality/curiosity.md) | Meta-iteration and exploratory goal generation |
| [Trust and Safety](personality/trust-and-safety.md) | Trust scoring, safety boundaries, and approval flows |
| [Brand](personality/brand.md) | Visual identity, naming, and communication style |
