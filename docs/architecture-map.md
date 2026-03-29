# PulSeed -- Architecture Map

---

## 1. In a Nutshell

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
│  ┌─────────── TUI Layer (src/tui/) ───────────────────────────────┐   │
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
```

---

## 3. Core Loop (Main Flow)

```
 ┌──────────────────────────────────────────────────────────────────┐
 │                       Drive System                                │
 │  "Is there a goal that needs attention right now?"                │
 │  Triggers: Schedule / Event / Completion / Deadline              │
 └──────────────────────────┬───────────────────────────────────────┘
                             │ Yes
                             ↓
 ┌───────────────────────────────────────────────────────────────────┐
 │ [1] Observation                                                   │
 │                                                                   │
 │   Layer 1: Mechanical observation   ── Confidence high (0.85-1.0) │
 │     Test results, sensor values, DB values, API responses         │
 │   Layer 2: Independent review       ── Confidence medium (0.50-0.84)│
 │     Task Reviewer, Goal Reviewer                                  │
 │   Layer 3: Self-report              ── Confidence low (0.10-0.49) │
 │     Executor's report (reference information only)                │
 │                                                                   │
 │   Timing: post-task / periodic / event-driven                    │
 └────────────────────────────┬──────────────────────────────────────┘
                               ↓ current_value + confidence
 ┌────────────────────────────────────────────────────────────────────┐
 │ [2] State Vector Update                                            │
 │                                                                    │
 │   Each dimension: name, current_value, threshold, confidence,      │
 │   history                                                          │
 │   Threshold types: min(N) / max(N) / range(L,H) / present /       │
 │   match(V)                                                         │
 │   Aggregation: minimum (AND) / weighted average / any (OR)        │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓
 ┌────────────────────────────────────────────────────────────────────┐
 │ [3] Gap Calculation                                                │
 │                                                                    │
 │   raw_gap        ── Per-threshold-type difference (5 types)       │
 │       ↓                                                            │
 │   normalized_gap ── Normalized to [0,1] (aligning units)          │
 │       ↓                                                            │
 │   normalized_weighted_gap ── Confidence-weighted                   │
 │                              (uncertain → estimate larger)         │
 │       ↓                                                            │
 │   gap_vector     ── Held as an N-dimensional vector               │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓ gap_vector
 ┌────────────────────────────────────────────────────────────────────┐
 │ [4] Drive Scoring                                                  │
 │                                                                    │
 │   Dissatisfaction-driven: gap × decay_factor                       │
 │     (large gap → high priority)                                    │
 │   Deadline-driven: gap × urgency                                   │
 │     (deadline approaching → exponential rise)                      │
 │   Opportunity-driven: opportunity_value × freshness_decay          │
 │     (half-life 12h)                                                │
 │                                                                    │
 │   Combined: Max + deadline override                                │
 │   Priority dimension decision: determined by code (no LLM)        │
 │                                                                    │
 │   PortfolioManager: evaluates multiple strategies in parallel,     │
 │   filters task selection by effectiveness score. Auto-rebalances   │
 │   in coordination with stall detection.                            │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓ Priority dimension confirmed
 ┌────────────────────────────────────────────────────────────────────┐
 │ [4.5] Knowledge & Capability Gating                                │
 │                                                                    │
 │   KnowledgeManager: Detects knowledge gaps and inserts research    │
 │   tasks with priority.                                             │
 │   CapabilityDetector: Detects capability deficiencies and          │
 │   escalates to user.                                               │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓
 ┌────────────────────────────────────────────────────────────────────┐
 │ [5] Task Generation                                                │
 │                                                                    │
 │   LLM concretizes "how to tackle it":                              │
 │     - Work content + approach                                      │
 │     - Success criteria (verifiable conditions)                     │
 │     - Scope boundary (in_scope / out_of_scope)                    │
 │     - Inherited constraints                                        │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓ Task
 ┌────────────────────────────────────────────────────────────────────┐
 │ [6] Session Launch → Execute                                       │
 │                                                                    │
 │   Adapter selection → Context assembly → Agent execution           │
 │   During execution: PulSeed does not intervene                     │
 │   (monitors only status / timeout / heartbeat)                     │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓ Execution result
 ┌────────────────────────────────────────────────────────────────────┐
 │ [7] Result Verification (3 layers)                                 │
 │                                                                    │
 │   Layer 1: Mechanical verification ── tests/files/build            │
 │             (highest confidence)                                   │
 │   Layer 2: Task reviewer ── independent LLM session                │
 │             (medium confidence)                                    │
 │   Layer 3: Executor self-report ── reference information only      │
 │             (low confidence)                                       │
 │                                                                    │
 │   Verdict: pass / partial / fail                                   │
 │   Failure handling: keep / discard / escalate (to human)          │
 └────────────────────────────┬───────────────────────────────────────┘
                               ↓ Verification result
                    ┌──────────────────────┐
                    │  State vector update  │
                    │  Gap recalculation    │
                    │  → return to [1]      │
                    └──────────────────────┘
```

---

## 4. Data Flow Diagram

```
                    ┌─────────────┐
                    │ Real World  │
                    │ Sensors/DB  │
                    │ API/Metrics │
                    └──────┬──────┘
                           │ Raw data
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│                       Observation System                          │
│                                                                  │
│  Mechanical observation ─→ current_value + confidence (high)     │
│  Independent review ────→ current_value + confidence (medium)    │
│  Self-report ───────────→ supplemental info + confidence (low)   │
│                                                                  │
│  Conflict resolution: higher-confidence layer takes priority     │
│  Progress cap: no evidence→70%, partial→90%, complete→100%       │
└──────────────┬───────────────────────────────────────────────────┘
               │ current_value, confidence, observation_log
               ↓
┌──────────────────────────────────────────────────────────────────┐
│                       State Vector                                │
│                                                                  │
│  Dimension[i]: current_value, threshold, confidence, history     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────┐        │
│  │ Confidence Model                                     │        │
│  │ Confidence is not self-declared. Determined          │        │
│  │ mechanically by observation means.                   │        │
│  │ Multiple observations → highest confidence adopted   │        │
│  └─────────────────────────────────────────────────────┘        │
└──────────────┬───────────────────────────────────────────────────┘
               │ state_vector (all dimensions)
               ↓
┌──────────────────────────────────────────────────────────────────┐
│                       Gap Calculation                             │
│                                                                  │
│  raw_gap(dim)                                                    │
│    │  Per threshold type: min→max(0,T-V), max→max(0,V-T),       │
│    │  range, ...                                                  │
│    ↓                                                             │
│  normalized_gap(dim)                ← Normalization [0,1]        │
│    │  Normalization basis: per-threshold-type division           │
│    ↓                                                             │
│  normalized_weighted_gap(dim)       ← Confidence weighting       │
│    │  Formula: ng × (1 + (1-confidence) × uncertainty_weight)   │
│    ↓                                                             │
│  gap_vector [dim_1, dim_2, ..., dim_N]                           │
│                                                                  │
│  Parent goal aggregation: max / weighted average /               │
│  minimum (default)                                               │
│  History: gap_history[t], gap_delta[t]                           │
└──────────────┬───────────────────────────────────────────────────┘
               │ gap_vector (normalized_weighted_gap)
               ↓
┌──────────────────────────────────────────────────────────────────┐
│                      Drive Scoring                                │
│                                                                  │
│  ┌──────────────────┐  ┌────────────────┐  ┌──────────────────┐ │
│  │ Dissatisfaction- │  │ Deadline-      │  │ Opportunity-     │ │
│  │ driven           │  │ driven         │  │ driven           │ │
│  │ gap × decay      │  │ gap × urgency  │  │ opp × freshness  │ │
│  │                  │  │                │  │                  │ │
│  │ decay_floor=0.3  │  │ exponential    │  │ half-life=12h    │ │
│  │ recovery=24h     │  │ rise           │  │                  │ │
│  │                  │  │ horizon=168h   │  │                  │ │
│  └────────┬─────────┘  └───────┬────────┘  └────────┬─────────┘ │
│           └────────────────────┼──────────────────────┘           │
│                                ↓                                  │
│                    final_score = max(3 drives)                    │
│                    + deadline override                             │
│                                ↓                                  │
│                    Priority dimension confirmed                    │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ Priority dimension + gap info
                                   ↓
┌──────────────────────────────────────────────────────────────────┐
│                      Task Lifecycle                               │
│                                                                  │
│  [Code] Dimension selection → [LLM] Task concretization          │
│       ↓                                                          │
│  Task: target_dims, work_description, success_criteria,          │
│        scope_boundary, constraints                               │
│       ↓                                                          │
│  Execute → Verify (3-layer) → pass/partial/fail                  │
│       ↓                                                          │
│  keep / discard / escalate                                       │
│       ↓                                                          │
│  State vector update → return to Observation                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Document Map

### Top-Level Documents (Concepts, Vision, Runtime)

| Document | Description | Read by | Outputs to | Status |
|---|---|---|---|---|
| `vision.md` | Vision. Definition of the world PulSeed enables | -- | All design documents | Designed |
| `mechanism.md` | Core mechanism. Conceptual definition of the task discovery loop | vision.md | All design/ documents | Designed |
| `runtime.md` | Runtime infrastructure. Orchestration, drive, and context | mechanism.md | drive-system, session-and-context, execution-boundary | Designed |

### Design Documents (design/)

| Document | Component | Read by | Outputs to | Status |
|---|---|---|---|---|
| `core/state-vector.md` | State vector (multi-dimensional goal state representation) | mechanism.md, core/observation.md | core/gap-calculation.md, core/satisficing.md | Designed |
| `core/observation.md` | Observation system (3-layer observation, progress cap rules) | runtime.md | core/state-vector.md | Designed |
| `core/gap-calculation.md` | Gap calculation (normalization, confidence weighting) | core/state-vector.md | core/drive-scoring.md, core/stall-detection.md | Designed |
| `core/drive-scoring.md` | Drive scoring (quantification of 3 drive forces) | core/gap-calculation.md | execution/task-lifecycle.md, core/drive-system.md | Designed |
| `execution/task-lifecycle.md` | Task lifecycle (generation → execution → verification → failure handling) | core/drive-scoring.md, goal/execution-boundary.md | core/state-vector.md (result reflection) | Designed |
| `goal/goal-negotiation.md` | Goal negotiation (6 steps, includes Step 0 ethics gate) | mechanism.md, goal/goal-ethics.md | core/state-vector.md (initial setup) | Designed |
| `goal/goal-ethics.md` | Ethics/legal gate (GoalNegotiator Step 0, 2-layer judgment) | goal/goal-negotiation.md | goal/goal-negotiation.md, execution/task-lifecycle.md | Designed |
| `personality/character.md` | PulSeed persona definition (4 behavioral axes, LLM prompt spec) | -- | goal/goal-negotiation.md, infrastructure/reporting.md, core/stall-detection.md | Designed |
| `core/satisficing.md` | Satisficing (completion judgment, progress cap) | core/state-vector.md, core/observation.md | personality/curiosity.md (empty task queue) | Designed |
| `core/stall-detection.md` | Stall detection (4 indicators, staged response) | core/gap-calculation.md, execution/task-lifecycle.md | core/drive-scoring.md (decay_factor), goal/goal-negotiation.md (renegotiation) | Designed |
| `personality/trust-and-safety.md` | Trust and safety (2-axis matrix, irreversible rules, ethics gate priority 0) | mechanism.md | execution/task-lifecycle.md (execution permission judgment) | Designed |
| `personality/curiosity.md` | Curiosity (meta-iteration, new goal proposals) | core/satisficing.md, core/stall-detection.md | goal/goal-negotiation.md (new goals) | Designed |
| `execution/session-and-context.md` | Session/context management (3-layer memory) | runtime.md | execution/task-lifecycle.md (context assembly) | Designed |
| `core/drive-system.md` | Drive method (4 triggers, startup judgment) | runtime.md, core/drive-scoring.md | core loop startup | Designed |
| `goal/execution-boundary.md` | Execution boundary (what PulSeed does and what it delegates) | mechanism.md | execution/task-lifecycle.md | Designed |
| `knowledge/knowledge-acquisition.md` | Knowledge acquisition (knowledge gap detection, research tasks, DomainKnowledge storage) | core/observation.md, execution/task-lifecycle.md | goal/goal-negotiation.md | Implemented |
| `execution/portfolio-management.md` | Portfolio management (PortfolioManager, parallel multi-strategy execution, effectiveness measurement, auto-rebalancing) | core/drive-scoring.md, core/stall-detection.md | execution/task-lifecycle.md | Implemented |
| `knowledge/memory-lifecycle.md` | Memory lifecycle (generation, promotion, deletion, and archival policy for memories) | execution/session-and-context.md | knowledge/knowledge-acquisition.md | Designed |
| `infrastructure/reporting.md` | Reporting (3 report types, generation and delivery, ReportingEngine) | core/state-vector.md | CLIRunner | Designed |

### Dependency Flow

```
mechanism.md ──→ core/state-vector.md ──→ core/gap-calculation.md ──→ core/drive-scoring.md
                          ↑                                                    │
                  core/observation.md                                          ↓
                                                                  execution/task-lifecycle.md
                                                                          │
                                                                          ↓
                                                              core/state-vector.md (update)
                                                                    Loop complete

Cross-cutting:
  goal/goal-negotiation.md ── At goal setting + renegotiation on stall
  core/satisficing.md ──────── Completion judgment (involved in all steps)
  core/stall-detection.md ──── gap-calculation → drive-scoring feedback
  personality/trust-and-safety.md ── Execution permission judgment in task-lifecycle
  personality/curiosity.md ────────── After satisficing completion + on stall detection
  goal/execution-boundary.md ─ Delegation model in task-lifecycle
  execution/session-and-context.md ─ Context management for all sessions
  core/drive-system.md ──────── Core loop startup timing control
```

---

## 6. Cross-Cutting Mechanisms (Outside the Core Loop)

There are 6 mechanisms that intervene in each step of the core loop.

```
Core loop steps:
  Observe → State update → Gap calculation → Drive score → Task generation → Execute → Verify
   [A]                        [B]               [C]             [D]          [E]       [F]

Intervention points:
  [A] Observation      ← Trust & Safety (source of confidence)
  [B] Gap calculation  ← Stall detection (judge stall from gap_history)
  [C] Drive score      ← Stall detection (temporarily suppress stalled dimensions with decay_factor)
  [D] Task generation  ← Execution boundary (delegation model decision)
                       ← Trust & Safety (autonomy level decision → is human confirmation needed?)
  [E] Execution        ← Trust & Safety (irreversible actions → always require human approval)
  [F] Verification     ← Satisficing (all dimensions exceed threshold + high confidence → complete)

Outside the loop:
  Goal negotiation ── Before loop start (at goal setting) + renegotiation on stall
  Curiosity        ── After loop completion (when all goals achieved) + on stall detection
  Drive system     ── Control of loop startup timing (4 triggers)
```

### Summary of Each Mechanism

**Trust & Safety (`personality/trust-and-safety`)**
Determines autonomy level with a 2-axis matrix (confidence × trust balance). Irreversible actions always require human approval. Trust is managed per domain; failure penalty > success reward (asymmetric).

**Satisficing (`core/satisficing`)**
Stop at "good enough," not "perfect." Completion only when all dimensions exceed thresholds and there is high-confidence evidence. Progress cap rule (no evidence → max 70%) prevents premature completion.

**Stall Detection (`core/stall-detection`)**
Detects by 4 indicators (dimension stall / time overrun / consecutive failures / overall stall). Staged response (1st: change approach → 2nd: strategy pivot → 3rd: human escalation). Stalled dimensions have their drive score temporarily suppressed with decay_factor.

**Curiosity (`personality/curiosity`)**
Goal-level meta-iteration. Triggered by empty task queue / unexpected observation / repeated failures / periodic exploration. Two functions: new goal proposal and existing goal redefinition. Always lower priority than user goals. Unaccepted proposals automatically expire after 12 hours.

**Goal Negotiation (`goal/goal-negotiation`)**
6 steps (ethics/legal gate (Step 0) → receive → dimension decomposition → baseline observation → feasibility evaluation → response). Hybrid evaluation (quantitative + qualitative). 3 response types (accept / counter-propose / cautionary flag). Renegotiation occurs on stall detection or premise changes.

**Execution Boundary (`goal/execution-boundary`)**
"PulSeed thinks. Agents act." PulSeed directly performs only LLM calls (for thinking) and reading/writing state files. Everything else (code implementation, data collection, notification delivery, etc.) is delegated to agents.

**Knowledge Acquisition (`knowledge/knowledge-acquisition`)**
KnowledgeManager detects knowledge gaps before and after task execution. If deficiencies exist, research tasks are generated with priority, and results are saved as DomainKnowledge. Conflicting knowledge entries are automatically detected and escalated to humans. CapabilityDetector manages the capability registry and issues capability grant requests to users when a required capability is unregistered.

**Portfolio Management (`execution/portfolio-management`)**
PortfolioManager evaluates multiple strategies (managed by StrategyManager) in parallel. Measures effectiveness scores per strategy and automatically rebalances (replaces, stops, or adjusts priority of) low-efficiency strategies. WaitStrategy suppresses unnecessary loops while waiting for external events. Task selection is handled by deterministic code (no LLM involvement).
