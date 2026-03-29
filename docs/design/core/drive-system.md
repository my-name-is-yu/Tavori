# Drive System

> The decision structure for when and why PulSeed acts. Design of scheduling and triggers.

---

## 1. The Central Question

The PulSeed drive system reduces to a single question.

**"Is there a goal that deserves attention right now?"**

This question is evaluated at every potential activation moment. If the answer is Yes, the task discovery loop runs. If No, nothing happens.

This judgment itself must be lightweight. It checks the state of each goal and determines only whether attention is needed. Deep analysis happens within the loop. If the judgment is expensive, frequent checks become impractical.

---

## 2. Four Trigger Types

There are four types of triggers that activate PulSeed. Each has a different timing and a different level of urgency.

### Scheduled

Periodic checks based on the nature of the goal. This is the most fundamental drive mode.

The interval varies by goal type — not a fixed value, but dynamically adjusted based on goal state and phase.

| Goal type | Base interval | Adjustment condition |
|-----------|--------------|----------------------|
| Health monitoring | 30 min – 1 hour | Shortened when an anomaly is detected |
| Business metrics | Several hours – 1 day | Shortened right after a measure is taken, extended during stable periods |
| Long-term projects | 1 day – 1 week | Shortened as the deadline approaches |

Scheduled triggers also serve as a "safety net against blind spots." While other triggers are functioning, low frequency is sufficient.

### Event-Driven

Reacts to change notifications from external sources. When something changes, there is no reason to wait. It activates immediately.

- Sensor alerts (threshold exceeded, anomalous values)
- Sudden metric changes (deviation from baseline)
- Messages or instructions from the user
- Notifications from external systems (webhooks, API callbacks)

Event-driven triggering is a reaction to the fact that "something changed." Unlike scheduled triggering, it fires based on state changes rather than clock time.

How events are received varies by phase of the process model (see "3. Event Reception Mechanism" for details).

### Completion-Driven

Re-evaluation immediately after a task completes. This is the most frequent trigger during active work phases.

When a task completes, PulSeed automatically executes the following sequence.

```
Task completion notification
    │
    ↓ Observation
Re-evaluate state (confirm deliverables, re-measure metrics)
    │
    ↓ Gap recalculation
Discover next task or make completion judgment
    │
    ↓ Action
Execute next task or transition to waiting state
```

Completion-driven triggering is the "natural starting point of the loop." When a task finishes, thinking about the next action is the natural flow.

### Deadline-Driven

The approach of a deadline itself becomes a trigger. It functions as a complement to scheduled triggering.

The characteristic of deadline-driven triggering is gradual escalation. Rather than a sudden spike in frequency, the check frequency rises gradually in proportion to proximity to the deadline.

```
More than 1 month to deadline   → Scheduled trigger only
1 month to deadline             → Increase check frequency by 1.5×
2 weeks to deadline             → Increase check frequency by 2×, add progress alert
1 week to deadline              → Increase check frequency by 3×, add risk assessment
2 days to deadline              → Daily check, prioritize blocker removal
```

This gradual escalation operates in concert with the Deadline Drive score in `drive-scoring.md`. Goals with higher scores are checked more frequently.

---

## 3. Event Reception Mechanism — How to Receive External Triggers

Event-driven triggering requires a mechanism to receive events. If PulSeed cannot receive events, event-driven triggering does not function. The reception mechanism is designed in stages according to the phase of the process model.

### Event Format

Regardless of phase, events are expressed in a unified format.

```json
{
  "type": "external",
  "source": "github-actions",
  "timestamp": "2026-03-10T09:00:00Z",
  "data": {
    "event": "build_failed",
    "repo": "myapp",
    "branch": "main"
  }
}
```

- `type`: `"external"` (external event) or `"internal"` (PulSeed internal trigger)
- `source`: Origin of the event (system name, sensor name, etc.)
- `timestamp`: UTC time in ISO 8601 format
- `data`: Event-specific payload (schema depends on source)

### MVP (Phase 1): File-Based Event Queue

The **`~/.pulseed/events/`** directory is used as an event queue. External systems write JSON files to this directory. When `pulseed run` is executed, PulSeed reads this directory, processes the events, and archives them.

```
~/.pulseed/
├── events/
│   ├── 20260310-090000-github-build-failed.json   ← Unprocessed event
│   └── 20260310-085500-sensor-alert.json
└── events/archive/
    └── 20260309-120000-build-success.json          ← Processed event
```

Processing flow:
1. On `pulseed run` launch, read `~/.pulseed/events/`
2. Process in timestamp order of filename
3. Evaluate each event as a trigger for the corresponding goal
4. Move processed events to `archive/`

No infrastructure required. External systems only need to be able to write files. Shell scripts, webhook servers, cron jobs — anything works.

> **Integration with the observation cycle**: Writes to this event queue function as triggers for event-driven observation (Event-driven) defined in `observation.md` §3. Upon receiving an event, PulSeed immediately launches the observation cycle for the corresponding goal and re-evaluates the state vector.

**Polling fallback**: External data sources without push notification (APIs, web pages, etc.) are checked directly by PulSeed at the configured URL/API during the observation step. This is implemented as an integration into the observation step, not as event-driven.

### Phase 2 (Daemon Mode): In-Memory Queue + File Watcher

When the daemon is running persistently, more real-time event processing becomes possible.

**In-memory queue**: The daemon maintains an event queue in memory and executes trigger evaluation immediately when an event arrives.

**File watcher**: Watches the `~/.pulseed/events/` directory and begins processing the instant a new file is written. Faster response than the MVP polling approach. Maintains file format compatibility with the MVP.

**Local HTTP endpoint**: The daemon accepts HTTP requests on a local port (default: `127.0.0.1:41700`). External systems can then send webhooks to this endpoint.

```
POST http://127.0.0.1:41700/events
Content-Type: application/json

{ "type": "external", "source": "zapier", ... }
```

This endpoint binds to localhost only. It is not exposed to external networks.

---

## 4. Active and Waiting

PulSeed has two operating states.

### Active State

A task is executing, or the task discovery loop is evaluating. PulSeed is doing something.

Transitions from active to waiting:
- A task completed and the next task was judged unnecessary
- Waiting on an external dependency became necessary
- All goals have reached a satisfied state

### Waiting State

No immediate action is needed. PulSeed is monitoring but not acting.

There are three patterns of waiting.

**Waiting for effect**: Immediately after a measure was taken. Changes take time to materialize. PulSeed decides when to measure and waits. In the meantime, it either turns attention to other goals or waits quietly.

**Waiting on external dependency**: Someone else's approval, a response from an external service, a market reaction. There are timings that PulSeed cannot control. Knowing when to wait is the same as not taking unnecessary action.

**All goals satisfied**: All goals have met their completion criteria. Only periodic monitoring checks are conducted; the system re-activates when it detects a state change.

Waiting is not "forgotten." Goals in waiting are still subject to periodic checks. Situations change. The minimum monitoring to avoid missing changes continues.

---

## 5. Lightweight Activation Check

A low-cost pre-check is inserted before running the full task discovery loop.

```
Activation check sequence:

1. Are there unprocessed events in the event queue?  → Yes → Activate
2. Are there overdue scheduled checks?               → Yes → Activate
3. Has a completion notification been received?      → Yes → Activate
4. If all are No:
   - Are all goals in a satisfied or waiting state?  → Yes → Continue sleeping
   - Otherwise                                       → Activate
```

This check involves no LLM calls. It completes with only a read of state files and simple condition evaluation. This avoids running expensive evaluations when nothing has changed.

---

## 6. Multi-Goal Scheduling

When PulSeed is pursuing multiple goals, each goal has its own drive rhythm.

### Independent Scheduling

- Goal A's schedule and Goal B's schedule are independent
- An event-driven trigger for one goal does not trigger evaluation of another goal
- Each goal's trigger history is recorded independently

### Priority-Based Processing

When multiple goals simultaneously require attention, the processing order is determined based on the scores from `drive-scoring.md`.

```
Sort all activated goals by score
  │
  ↓
Run task discovery loop starting from the highest-scoring goal
  │
  ↓
Check whether parallel execution is possible
  ├── Possible → Launch sessions for multiple goals in parallel
  └── Not possible → Process sequentially in score order
```

### Resolving Resource Contention

If it is not possible to run multiple agent sessions simultaneously due to resource constraints, serialize them. The serialization order is highest drive score first. Goals that are deferred are queued and processed after the currently executing session completes.

---

## 7. Handling Duplicate Triggers

Multiple triggers may fire simultaneously.

- A deadline trigger + a scheduled trigger fire at the same time
- A task completion notification + a sensor alert arrive simultaneously

Duplicate triggers are merged into a single evaluation cycle. Even if multiple triggers fire for the same goal, the task discovery loop runs only once. Duplicate execution is wasteful and can in some cases create race conditions.

PulSeed records "why this activation occurred." When multiple triggers converge, all of them are retained as context and passed to the task discovery loop. A compound situation — "the deadline is approaching AND a sensor alert came in" — may be treated with higher priority than a single trigger.

---

## Summary of Design Principles

| Principle | Content |
|-----------|---------|
| Central question | Reduced to "Is there a goal that deserves attention right now?" |
| Lightweight activation judgment | Eliminates wasteful evaluation with LLM-free pre-checks |
| Goal-specific rhythm | Each goal has its own schedule and triggers |
| Waiting is normal | "Doing nothing" is not a failure — it is the correct judgment |
| Gradual escalation | Deadline-driven triggering increases frequency progressively, not suddenly |
| Priority-based serialization | Drive score determines processing order when resources contend |
