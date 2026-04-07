# Dream Mode Design

> PulSeed's normal loop is built for waking cognition: observe, decide, act, verify. Dream Mode adds the missing sleep cycle: collect raw experience, compress it, discover patterns, and turn it into reusable knowledge.

---

## 1. Overview & Motivation

Human sleep does not merely store the day. It transforms raw experiences into structured knowledge, stable memories, and better future responses. Dream Mode is the PulSeed equivalent of that process.

Today PulSeed operates without sleep. The live loop produces rich outputs such as `LoopIterationResult`, verification outcomes, strategy pivots, stall diagnoses, and observation traces, but much of that material is transient. In particular, `LoopIterationResult` is never persisted. Valuable iteration-level evidence vanishes after the session, which means PulSeed often remembers conclusions but loses the path that produced them.

Dream Mode fills that gap through four pillars:

1. **Log Collection**: persist raw operational traces that currently disappear.
2. **Analysis Pipeline**: mine patterns, recurrences, and schedules from accumulated logs.
3. **Consolidation**: compress many low-level events into durable higher-level knowledge.
4. **Knowledge Activation**: route consolidated knowledge back into runtime systems that can use it.

This is not just persistence. Many agent frameworks already persist memory, messages, or checkpoints. What they usually do not do is **consolidation**: the conversion of operational history into reusable strategy knowledge, reflection products, and policy-shaping summaries. That gap is where Dream Mode becomes a PulSeed differentiator.

Key inspirations:

- **Generative Agents**: importance-triggered reflection and salience accumulation.
- **Voyager**: procedural consolidation into reusable skills and heuristics.
- **SOAR**: consolidation that changes future policy, not just stored facts.
- **OpenClaw**: pre-compaction flush of working artifacts before compression.
- **MemGPT**: tiered memory, where not all knowledge belongs in the active context.

---

## 2. Runtime Importance Tagging

Dream Mode is not only an offline batch process. During normal operation, PulSeed already makes LLM calls for observation, task work, verification, and strategy decisions. Those calls can emit salience signals in real time.

When the LLM judges something as important during observation, task execution, verification, strategy reasoning, or stall analysis, PulSeed should:

1. Tag the result with an importance score in the range `0.0-1.0`.
2. Record a short reason for why the item matters.
3. Write high-importance items (`>= 0.5`) to a dedicated importance buffer at `~/.pulseed/dream/importance-buffer.jsonl`.

Base schema:

```json
{
  "timestamp": "2026-04-07T00:00:00.000Z",
  "goalId": "goal-123",
  "source": "observation",
  "importance": 0.78,
  "reason": "First cross-session verification failure with the same criterion",
  "data_ref": "~/.pulseed/goals/goal-123/iteration-logs.jsonl#L42"
}
```

Allowed `source` values:

- `observation`
- `task`
- `verification`
- `strategy`
- `stall`

Dream Mode processes the importance buffer **first**. High-signal items are reviewed before bulk log mining so the system can prioritize surprising, anomalous, or policy-relevant events.

This is directly inspired by Generative Agents' importance scoring model: accumulate salience during normal cognition, and trigger deeper reflection when the threshold justifies it.

---

## 3. Architecture Overview

`DreamEngine` orchestrates the first three Dream Mode phases:

1. Log Collection
2. Analysis Pipeline
3. Consolidation

Phase 4, Knowledge Activation, is separate. It modifies `CoreLoop` and context-building paths so runtime systems can consume Dream outputs after Phases 1-3 have produced them.

Integration map:

```text
CLI / ScheduleEngine / DaemonRunner idle / Importance threshold
  -> DreamEngine.run({ tier })
    -> Light Dream (Nap)
      -> importance buffer pass
      -> active-goal memory tidy
      -> agent memory lint
      -> recent-iteration quick scan
      -> stale knowledge flags
    -> Deep Dream
      -> full importance buffer pass
      -> log readers
      -> analyzers
      -> consolidators
      -> knowledge outputs
        -> state files
        -> archives
        -> strategy knowledge
        -> schedule hints

Phase 4 runtime consumers
  -> CoreLoop / context builder / task + strategy paths
  -> consume Dream outputs during normal execution
```

Dependency direction is intentionally one-way:

```text
existing runtime systems -> emit data / trigger DreamEngine
DreamEngine -> reads logs, writes consolidated outputs
existing runtime systems do not depend on dream internals
```

This keeps Dream Mode a clean addition. Nothing existing should need to depend on `src/platform/dream/` in order to function.

## 3.1 Execution Tiers

Dream Mode has two execution tiers with different triggers, budgets, and scope.

### Light Dream (Nap)

- Triggered by idle detection (`30m+` with no activity) or importance buffer threshold crossing
- Runs every few hours when enabled
- Uses a small token budget, defaulting to about `15k`
- Processes the importance buffer first, but only for high-signal items
- Runs lightweight memory tidy through retention policy for active goals only
- Runs a quick agent memory lint pass with auto-fix for high-confidence findings
- Runs a quick pattern scan over only the most recent `N` iterations, default `50`
- Flags stale knowledge for later revalidation, but does not perform full revalidation
- Target duration is about `30-60s`

### Deep Dream

- Triggered by nightly schedule or manual CLI invocation
- Runs daily or weekly depending on config
- Uses a much larger token budget, defaulting to about `200k`
- Runs the full Phase A-F pipeline, including all eleven categories plus schedule discovery, archive postmortems, cross-goal transfer, and full report generation
- Target duration is about `5-10m`

`DreamEngine.run()` becomes a dispatcher: `runLight()` for Nap runs and `runDeep()` for full runs.

---

## 4. Dream Targets

Dream Mode consolidates eleven categories of operational history.

### 4.1 Iteration Logs

`LoopIterationResult` is the most important missing raw trace today. Dream Mode stores and mines iteration-level evidence so PulSeed can later analyze strategy transitions, verification outcomes, stall onset, and convergence shape. It also treats iteration logs as a managed dataset: rotate old logs, archive completed-goal traces, and preserve searchable indexing for later analysis and consolidation.

### 4.2 Decision History

Decision history records why a strategy or task path was chosen. Dream Mode consolidates trends such as strategy win rates, recurring decision contexts, and when a reasoning style tends to succeed or fail.

### 4.3 Stall History

Stall events are more than transient alarms. Dream Mode keeps them as an event ledger and looks for cross-session recurrence, root-cause clusters, and repeated environmental blockers.

### 4.4 Session Data

Sessions provide the macro view that iteration logs alone cannot. Dream Mode mines outcome distributions, session cost profiles, and long-running trajectory shapes, then cold-archives the bulky raw session traces.

### 4.5 Gap History

Gap values over time reveal convergence behavior. Dream Mode analyzes convergence curves, plateau signatures, false progress, and dimensions that appear active but do not actually reduce the real gap.

### 4.6 Observation Logs

Observation history is a record of how PulSeed perceives the world. Dream Mode consolidates method reliability, source drift, changing confidence patterns, and observation modes that systematically overstate or understate reality.

### 4.7 Reports

Reports capture structured summaries produced during normal operation. Dream Mode mines them across goals and time to extract recurring themes, reusable findings, and candidates for cold storage when they are no longer hot context.

### 4.8 Trust Scores

Trust is more useful as a trajectory than as a point estimate. Dream Mode logs score movement, identifies volatility patterns, and links trust shifts to strategy changes, verification failures, or observation instability.

### 4.9 Strategy History

Strategy history preserves what was tried and in what order. Dream Mode looks for effective sequences, pivot ladders, preconditions for success, and anti-patterns that tend to repeat before stalls.

### 4.10 Verification Artifacts

Verification outputs are one of the highest-signal sources in the system. Dream Mode consolidates verdict patterns, recurring criterion failures, and reusable failure taxonomies that can shape future task generation.

### 4.11 Archive

Completed goals are not dead data. Dream Mode uses the archive for postmortems, cross-goal lessons, and durable long-horizon knowledge that should survive beyond the active execution window.

**Out of scope**: Token Usage is explicitly excluded from Dream Mode scope. It may be logged as supporting telemetry, but Dream Mode does not treat token accounting as a consolidation target.

---

## 5. Phase Overview

Dream Mode is delivered in four phases. This overview stays conceptual; see the phase docs for implementation details, file paths, CLI wiring, config, and rollout stages.

### Phase 1: Log Collection + Importance Tagging

Persist raw traces that currently vanish, and introduce runtime importance tagging so high-signal events are buffered immediately.

### Phase 2: Analysis Pipeline

Build analyzers that mine patterns, discover timing regularities, and extract candidate structures from the collected logs. Stage 2 rollout implements both Light Dream and Deep Dream entry points: Light Dream runs a reduced analysis pass, while Deep Dream runs the full pipeline.

### Phase 3: Consolidation

Batch-process the eleven Dream targets into durable summaries, learned heuristics, archives, and compressed knowledge products.

### Phase 4: Knowledge Activation

Wire Dream outputs back into eight capabilities: six existing underutilized runtime capabilities plus two new Dream-generated consumers. Phase 4 is separate from `DreamEngine`; it consists of runtime changes that consume outputs from Phases 1-3.

---

## 6. Trigger Modes

Dream Mode can start through four trigger paths, but each path maps to a tier:

### 6.1 CLI

Manual execution through the Dream command.

- `pulseed dream` runs Deep Dream
- `pulseed dream --light` runs Light Dream
- `pulseed dream --dry-run` analyzes without writing for either tier
- `pulseed dream status` shows the last light and deep run times plus pending importance buffer size

### 6.2 ScheduleEngine

A cron-backed schedule entry runs Deep Dream nightly by default at `0 3 * * *`. This remains configurable so scheduled activation is still an explicit choice.

### 6.3 DaemonRunner Idle Activation

When the daemon detects a sufficiently idle window, it can opportunistically run Light Dream instead of leaving unused compute time empty.

### 6.4 Importance Threshold

When accumulated importance in the runtime buffer exceeds a configured threshold `N`, Light Dream can trigger early to process unusually salient events before the next Deep Dream cycle.

---

Implementation details, module structure, CLI syntax, config layout, and staging are specified in the individual phase documents.

---

## 9. Configuration

Dream Mode configuration is intentionally light at the overview level. Full schema belongs in the phase docs.

Expected configuration areas:

- enable or disable Dream Mode globally
- `lightDream.enabled`
- `lightDream.tokenBudget`
- `lightDream.recentIterationWindow`
- `lightDream.importanceThreshold`
- `deepDream.schedule.expression`
- `deepDream.tokenBudget`
- enable or disable trigger modes independently
- thresholds for importance-triggered activation
- log retention and rotation limits
- per-category consolidation toggles
- schedule settings for nightly or periodic runs
- activation targets for downstream runtime systems

The guiding rule is conservative default behavior: Dream Mode should be installable as a clean addition, with scheduled activation disabled unless explicitly enabled.
