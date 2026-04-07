# Dream Mode Phase 1: Logging And Importance Tagging

> Phase 1 is the prerequisite for Dream Mode. Before PulSeed can analyze or consolidate experience, it must first stop losing it.

---

## 1. Overview

Phase 1 establishes raw data persistence and runtime importance tagging. It does not attempt pattern mining or consolidation yet. Its job is to make sure the loop leaves behind durable traces that later Dream phases can analyze.

This phase is intentionally foundational:

- persist iteration-level execution data that currently vanishes
- capture compact session summaries
- record a dedicated importance buffer during normal runtime
- persist a compact operational event stream
- provide rotation and watermarking so later Dream passes can process incrementally

Without this phase, Dream Mode has nothing reliable to sleep on.

---

## 2. Iteration Log Collection

### 2.1 Problem

`LoopIterationResult` in [src/orchestrator/loop/core-loop-types.ts](/Users/yuyoshimuta/Documents/dev/SeedPulse/src/orchestrator/loop/core-loop-types.ts#L150) is rich, but it is not written to disk. That means PulSeed loses one of its highest-value traces: per-iteration evidence of gap movement, strategy use, stalls, verification outcomes, skips, and runtime cost.

### 2.2 New Type: `IterationLog`

Phase 1 introduces a serializable `IterationLog` Zod schema. It is a stable subset of runtime data designed for append-only JSONL persistence.

Fields:

- `timestamp`
- `goalId`
- `iteration`
- `sessionId`
- `gapAggregate`
- `gapDimensions` (optional; per-dimension `raw_gap`, `confidence`, `uncertainty_weight`)
- `driveScores` (optional)
- `taskId`
- `taskAction`
- `strategyId`
- `verificationResult`
- `stallDetected`
- `stallSeverity`
- `tokensUsed`
- `elapsedMs`
- `skipped`
- `skipReason`
- `completionJudgment`
- `waitSuppressed`

Design intent:

- preserve the minimum needed for later pattern mining
- stay serializable without embedding full in-memory objects
- prefer references or compact summaries over bulky artifact blobs

### 2.3 Collection Point

Collection happens inside `CoreLoop` immediately after an iteration result is produced.

Planned hook:

```ts
this.logCollector?.append(goalId, iterationResult);
```

This is a one-line integration point. The collector owns conversion from `LoopIterationResult` to `IterationLog`.

### 2.4 Storage Layout

Per-goal iteration logs:

```text
~/.pulseed/goals/<goalId>/iteration-logs.jsonl
```

Append-only JSONL is chosen because it supports:

- cheap incremental writes
- streaming reads
- partial recovery after crashes
- easy watermark-based processing

### 2.5 Session Summaries

Phase 1 also writes a compact session-level log:

```text
~/.pulseed/dream/session-logs.jsonl
```

`SessionLog` schema:

- `timestamp`
- `goalId`
- `sessionId`
- `iterationCount`
- `finalGapAggregate`
- `initialGapAggregate`
- `totalTokensUsed`
- `totalElapsedMs`
- `stallCount`
- `outcome`
- `strategiesUsed`

Session summaries are intentionally coarse. They are for macro-level analysis such as outcome distributions, cost profiles, and convergence shape across sessions.

---

## 3. Runtime Importance Tagging

### 3.1 Purpose

Dream Mode should not wait until the end of the night to discover what mattered. During normal runtime, PulSeed already asks LLMs to observe, verify, reason about strategies, and interpret failures. Phase 1 adds a light salience channel to those same calls.

### 3.2 Importance Schema

Phase 1 introduces `ImportanceEntry`:

```ts
{
  id: string;
  timestamp: string;
  goalId: string;
  source: "observation" | "task" | "verification" | "strategy" | "stall";
  importance: number;
  reason: string;
  data_ref: string;
  tags: string[];
  processed: boolean;
}
```

Constraints:

- `importance` is normalized to `0-1`
- `reason` is short, human-readable, and stored as explanation metadata
- `data_ref` points to the fuller artifact rather than duplicating it
- `processed` supports incremental Dream consumption without immediate deletion

Buffer path:

```text
~/.pulseed/dream/importance-buffer.jsonl
```

Light Dream consumes this buffer more frequently than Deep Dream. The logging contract stays the same, but idle-triggered Nap runs should drain high-signal items every few hours instead of waiting for the nightly full pass.

### 3.3 Integration Points

Importance extraction is added to normal runtime paths.

#### ObservationEngine

After LLM-backed observation, PulSeed extracts importance when the observation contains surprising, anomalous, or drift-signaling data.

#### TaskLifecycle

After task verification, PulSeed extracts importance when verification reveals unexpected failure patterns, unexpected success, or a reusable lesson.

#### StrategyManager

After strategy selection, PulSeed extracts importance when the selection reasoning surfaces a novel insight, unusual pivot condition, or a high-value hypothesis.

#### StallDetector

Stall events at medium severity or higher are always tagged, even if the LLM did not explicitly emit an importance signal.

### 3.4 Prompt Addition

Phase 1 does not redesign prompts. It appends a narrow instruction to existing prompts:

> If this result contains surprising, anomalous, or particularly important information, include `importance_score` (`0.0-1.0`) and `importance_reason` in your response.

This keeps the feature additive and low-risk.

### 3.5 Automatic Non-LLM Tagging

Some events should be tagged even without model judgment. Phase 1 auto-tags:

- stalls with severity `medium` or above
- sharp trust drops
- verification failures that match known high-risk patterns

The goal is not to replace LLM importance scoring, but to guarantee that obvious operationally significant events enter the buffer.

---

## 4. Rotation & Watermark

### 4.1 Rotation Policy

Phase 1 uses a simple bounded append-only policy.

- max file size: `10MB` per goal by default
- configurable in Dream config
- when exceeded, prune oldest lines first until the file is reduced to `80%` of the limit

This keeps log files bounded without requiring immediate archival infrastructure.

### 4.2 Watermark File

Incremental Dream processing needs stable read progress markers.

Watermark path:

```text
~/.pulseed/dream/watermarks.json
```

Shape:

```json
{
  "goals": {
    "goal-123": {
      "lastProcessedLine": 120,
      "lastProcessedTimestamp": "2026-04-07T00:00:00.000Z"
    }
  },
  "importanceBuffer": {
    "lastProcessedLine": 47
  }
}
```

Watermarks are not ownership locks. They are read-progress markers used by Dream passes to avoid rescanning the entire corpus each run.

### 4.3 Date-Based Rotation Option

High-volume goals may eventually outgrow size-only rotation. Phase 1 allows a date-based rotation option in configuration so heavy goals can roll logs by date while preserving the same JSONL semantics.

---

## 5. Event Stream Persistence

### 5.1 Why This Exists

Some operational signals do not fit neatly into iteration logs. Hook events are one example: they provide a compact lifecycle stream that can later support sequencing analysis, postmortems, and cross-cutting diagnosis.
This stream also persists stall events via `StallReport`-derived `StallDetected` entries so later Dream phases have a durable stall history source.

### 5.2 Persistence Plan

Phase 1 upgrades the currently ephemeral audit path by persisting selected `HookManager` events to:

```text
~/.pulseed/dream/events/<goalId>.jsonl
```

### 5.3 Event Schema

`EventLog`:

```ts
{
  timestamp: string;
  eventType: string;
  goalId: string;
  taskId?: string;
  data: Record<string, unknown>;
}
```

The `data` field is a compact subset only. Event persistence is not intended to mirror full in-memory state.

### 5.4 Event Types

Phase 1 persists these eleven event types:

- `PreObserve`
- `PostObserve`
- `PreTaskCreate`
- `PostTaskCreate`
- `PreExecute`
- `PostExecute`
- `GoalStateChange`
- `LoopCycleStart`
- `LoopCycleEnd`
- `ReflectionComplete`
- `StallDetected`

The file remains append-only and uses the same rotation policy as iteration logs.

---

## 6. New Files

### `src/platform/dream/dream-types.ts`

Defines Zod schemas and conversion helpers for:

- `IterationLog`
- `SessionLog`
- `ImportanceEntry`
- `EventLog`

### `src/platform/dream/dream-log-collector.ts`

Provides JSONL append, read, rotation, and watermark utilities used by Phase 1 collectors.

### `src/platform/dream/dream-importance.ts`

Provides an `ImportanceBuffer` class for append, read, and `markProcessed` operations.

---

## 7. Changes To Existing Files

### `CoreLoop`

Add an optional `DreamLogCollector` dependency and the one-line append hook after each iteration result is produced.

### `ObservationEngine`

Add importance extraction from LLM observation responses and optional writes into the importance buffer.

### `TaskLifecycle`

Add importance extraction from verification results and verification-adjacent runtime signals.

### `HookManager`

Add an event persistence hook so the selected lifecycle events become durable Dream inputs instead of ephemeral runtime-only signals.

---

## 8. Configuration

Phase 1 introduces a `logCollection` section inside `dream-config.json`.

Expected controls:

- enable or disable iteration logging
- enable or disable session summaries
- enable or disable event persistence
- importance threshold for buffer writes
- max file sizes
- prune target ratio
- watermark behavior
- optional date-based rotation

The Phase 1 rule is conservative: log structure should be stable, append-only, and cheap to add without altering existing loop behavior.
