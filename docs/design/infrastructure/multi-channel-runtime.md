# PulSeed --- Multi-Channel Runtime

> Evolves docs/runtime.md § "Process Model" from daemon-only to a 4-layer architecture:
> Gateway → Queue → Executor → Eternal State.

---

## 1. Problem Statement

PulSeed is built to pursue goals for months or years. The current daemon-only model works well for a single goal and a single event source. It breaks down as soon as you add concurrency.

The immediate problem is the event loop. `daemon-runner.ts` iterates over active goals sequentially — run goal A, then goal B, then goal C, then sleep. This is fine when goals are few and loops are short. But a general-purpose persistent agent running many goals simultaneously cannot afford to let a slow goal block every other goal's activation. A dog-health goal that takes 3 minutes to observe should not delay an urgent revenue alert that arrived 2 minutes in.

The second problem is ingress. Right now, external signals reach PulSeed through exactly one path: HTTP POST to `event-server.ts` or a JSON file dropped in `~/.pulseed/events/`. A Slack message, a webhook from a monitoring service, a CLI command from the user, and an MCP tool call all need the same treatment: normalize the payload, route it to the right goal, wake the right loop. There is no unified ingress; each new channel would need to be bolted onto `EventServer` individually.

The third problem is state concurrency. `StateManager` uses atomic file writes (write to `.tmp`, then rename). That is safe for a single writer. It is not safe when N goal workers all try to write to the same goal directory at the same time. Today this doesn't happen because the daemon runs goals sequentially. The moment workers run in parallel, the current persistence model becomes a source of corruption.

The fourth problem is backpressure. When events flood in — a monitoring system starts firing every second, or a user sends a burst of messages — there is no mechanism to absorb the load. Events either pile up on disk or get processed immediately, starving goal loops of their normal execution budget.

These are not hypothetical problems. They are the predictable failure modes of the current architecture once PulSeed reaches the scale its vision requires: multiple goals, multiple channels, months of continuous operation.

---

## 2. Architecture Overview

The solution is a 4-layer architecture that separates concerns cleanly. Each layer has a single job.

```
Channels
  HTTP · WebSocket · CLI stdin · MCP · Slack Events API · webhook · TUI · Web UI
    │
    ▼
┌──────────────────────────────────┐
│          Gateway Layer           │
│  Protocol abstraction, routing,  │
│  auth, Envelope normalization    │
└──────────────────┬───────────────┘
                   │ Envelope
                   ▼
┌──────────────────────────────────┐
│           Queue Layer            │
│  CommandBus + EventBus,          │
│  priority, backpressure, DLQ,    │
│  retry, dead-letter              │
└──────────────────┬───────────────┘
                   │ prioritized messages
                   ▼
┌──────────────────────────────────┐
│         Executor Layer           │
│  LoopSupervisor, GoalWorker pool,│
│  cooperative concurrency,        │
│  crash isolation per worker      │
└──────────────────┬───────────────┘
                   │ reads / writes
                   ▼
┌──────────────────────────────────┐
│       Eternal State Layer        │
│  Per-goal directories, advisory  │
│  locking, WAL, compaction,       │
│  crash recovery                  │
└──────────────────────────────────┘
```

A message enters at the top and flows down. It is never possible for a Slack message to write to the state layer directly; it must pass through the gateway, be normalized into an Envelope, flow through the queue, and be consumed by a goal worker which then interacts with state. This unidirectional flow makes the system auditable and makes failure modes predictable.

The four layers replace and subsume existing modules rather than add on top of them. `EventServer` becomes a ChannelAdapter inside the Gateway. `DaemonRunner`'s main loop becomes the LoopSupervisor. `StateManager` gains locking and WAL. Nothing is thrown away; everything is reorganized around a common backbone.

---

## 3. Gateway Layer

The Gateway's job is to make all channels look the same to the rest of the system. It doesn't know what goals exist or how to run loops. It knows how to receive messages from the outside world and convert them into a normalized form.

That normalized form is an `Envelope`:

```typescript
interface Envelope {
  id: string;                  // UUID, unique message ID for deduplication and tracing
  type: "command" | "event";   // imperative vs. reactive
  name: string;                // e.g. 'goal_activated', 'user_command', 'approval_request'
  source: string;              // "http", "slack", "cli", "mcp", "webhook"
  goal_id?: string;            // target goal (optional for system-wide messages)
  correlation_id?: string;     // links request-response pairs (e.g. approval flow)
  dedupe_key?: string;         // for coalescing duplicate events
  priority: "critical" | "high" | "normal" | "low";
  payload: unknown;            // raw content, further parsed downstream
  reply: ReplyChannel;         // how to send a response back (if any)
  reply_channel_id?: string;   // explicit channel to route replies through
  created_at: number;          // Unix timestamp (ms)
  ttl_ms?: number;             // time-to-live (default: 300000 = 5 min)
  auth?: AuthContext;           // who sent this
}
```

Every `ChannelAdapter` receives protocol-specific input and emits Envelopes. The Gateway collects Envelopes from all adapters and forwards them to the Queue.

The existing modules that become ChannelAdapters:

- **`event-server.ts`** — HTTP adapter. Already accepts POST `/events` and POST `/triggers`; it gets wrapped in the ChannelAdapter interface. The SSE `/stream` endpoint remains and becomes the Gateway's outbound path back to HTTP clients.
- **`daemon-client.ts`** — already implements the client side of SSE. The server side (the SSE broadcaster inside `EventServer`) becomes the HTTP channel's reply mechanism.
- **`event-subscriber.ts`** — the chat/TUI subscriber wraps the same SSE stream. It becomes a read-only channel that receives Envelopes from the Gateway's outbound path.
- **MCP server** (future) — an MCP ChannelAdapter normalizes tool-call payloads into Envelopes.
- **Slack Events API** (future) — a webhook receiver verifies the Slack signature and converts the payload into an Envelope.

Auth and rate-limiting live at the Gateway level. Internal channels (CLI stdin, TUI) bypass auth. External channels (HTTP, Slack, webhook) validate tokens or signatures before the Envelope enters the system. A rate-limited channel drops or delays Envelopes before they reach the Queue; the Queue never sees traffic it shouldn't process.

The Gateway is stateless. It holds no goal state. If it crashes and restarts, it simply reconnects its adapters. Envelopes that were in flight but not yet queued are lost, which is acceptable: external senders retry on error, and the Queue's DLQ and idempotent producers protect in-flight work.

### Request-Response Flows (Approval)

Approval is a **two-way interaction** that does not fit the unidirectional Envelope model. An Executor worker needs to pause, wait for a human decision, and resume -- potentially after minutes.

The Gateway hosts an **ApprovalBroker** that owns this flow:

1. A GoalWorker emits an `approval_request` Envelope (type `"command"`) onto the CommandBus outbound path. The Envelope carries a `correlation_id` and a `reply_channel_id`.
2. The ApprovalBroker receives the request and broadcasts it to all registered approval channels (TUI, Web UI, Slack, chat).
3. The first `accept` or `reject` response received within the configurable timeout (default: 5 minutes) is wrapped in a new Envelope with the matching `correlation_id`.
4. The ApprovalBroker routes the response back to the requesting GoalWorker via the CommandBus, using the `correlation_id` to match the pending request.
5. If no response arrives within the timeout, the ApprovalBroker emits a synthetic `reject` response -- preserving the current default-reject behavior.

The `approvalQueue` map currently held inside `event-server.ts` migrates to the ApprovalBroker. The GoalWorker does not know which channel the human responded from; it only sees the response Envelope.

---

## 4. Queue Layer

The Queue is the traffic controller between the Gateway and the Executor. It does three things: prioritize, absorb load spikes, and protect work from process crashes.

There are two buses.

The **CommandBus** carries imperative messages: user commands from the CLI or TUI, API calls from the Web UI, approval responses. Commands expect a reply. They are processed in order of arrival within their priority tier.

The **EventBus** carries reactive messages: state change notifications from external services, scheduled activations from `ScheduleEngine`, loop completion notifications. Events are fire-and-forget from the sender's perspective.

Both buses share a priority scheme with four levels:

- **CRITICAL** — emergency signals, deadline breaches, ethics-gate triggers. Processed immediately, no backpressure applied.
- **HIGH** — user commands, approval requests, imminent deadlines. Processed before normal work.
- **NORMAL** — scheduled loop activations, external event notifications, progress updates.
- **LOW** — curiosity engine suggestions, proactive tick outputs, background knowledge acquisition.

The priority model directly mirrors PulSeed's drive model from `design/core/drive-system.md`. A goal with a high gap score generates HIGH-priority events; a passive monitoring goal with low drive generates NORMAL-priority events. Priority is not a hack; it is the queue-layer expression of the same urgency judgment that already exists in the system.

Backpressure is simple: configure a high-water mark (e.g., 1,000 pending items per bus). When the queue is saturated, incoming LOW-priority items are dropped and logged to the dead-letter queue. NORMAL items are held until space opens. HIGH and CRITICAL items are always accepted. This prevents a flood of low-urgency events from crowding out important work.

The dead-letter queue (DLQ) is a file: `~/.pulseed/dlq.jsonl`. Failed messages — those that were retried the maximum number of times and still could not be processed — are appended there. The DLQ is not processed automatically; it is a human-readable log for debugging. `pulseed dlq inspect` shows recent failures.

Retry behavior is configurable per message type. The default is three attempts with exponential backoff (1s, 3s, 9s). CRITICAL messages are retried immediately (no backoff). Commands retry at most once; if the first retry fails, the error is returned to the caller rather than filling the DLQ.

The `ScheduleEngine` already produces time-based activations. In the new architecture, those activations become NORMAL-priority events on the EventBus. The `ScheduleEngine` does not push directly to the Executor; it pushes to the Queue, and the Executor pulls when a worker is ready. This decouples scheduling from execution, which means a busy Executor does not cause the ScheduleEngine to block.

The Queue is implemented entirely in-process. No Redis, no external broker. In-process queues are sufficient for a single-machine deployment and have zero operational overhead.

### Durability

The Queue is **in-process and ephemeral**. On a process crash, all in-flight messages are lost. There is **no Queue-level WAL**.

This is intentional and acceptable because recovery is handled at the producer level:

- **ScheduleEngine** deterministically reproduces scheduled activations on the next tick after restart. No message needs to be stored to recover them.
- **External event senders** (HTTP clients, Slack, webhooks) are expected to retry on connection timeout. The Gateway's ChannelAdapters signal errors to senders rather than silently dropping.
- **Completion events** are derived from goal state, which survives crashes via the **State WAL** in section 6.

The **State WAL** (section 6) records intent and commit for every goal state write. It is exclusively for state persistence -- not for queue messages. These two concerns are kept separate by design: conflating them would require the Queue to understand goal state semantics.

---

## 5. Executor Layer

The Executor replaces the sequential goal loop in `daemon-runner.ts` with a supervised pool of concurrent workers.

The **LoopSupervisor** is the entry point. It starts when the daemon starts and stops when the daemon stops. Its responsibilities: maintain the worker pool, pull activation events from the Queue, assign events to workers, restart crashed workers, and report health.

A **GoalWorker** wraps exactly one `CoreLoop` instance running against one goal. When the LoopSupervisor assigns a `goal_activated` event to a worker, the worker calls `coreLoop.run(goalId)` and waits for the result. While the worker is running, it is unavailable for other events. When it finishes, it signals readiness back to the Supervisor, which assigns the next pending activation.

### Goal Exclusivity Invariant

**Invariant**: At most one GoalWorker may execute for a given `goal_id` at any time.

**Enforcement**: The LoopSupervisor maintains an `activeGoals: Map<string, GoalWorker>` keyed by `goal_id`. When a `goal_activated` event is dequeued, the Supervisor checks this map before spawning. If the goal is already active, the spawn request is rejected -- the event is not processed.

**Coalescing**: If a `goal_activated` event arrives for an already-running goal, the event is coalesced: the existing worker is notified to extend its run (e.g., reset its iteration cap), rather than a duplicate worker being spawned. The event is not re-queued.

This invariant is distinct from the per-goal advisory locks in the State layer (section 6). The State locks protect concurrent file writes within a single goal's directory. The Goal Exclusivity Invariant prevents a higher-level problem: two CoreLoop instances issuing conflicting decisions about the same goal simultaneously.

GoalWorkers are **pool-allocated**: the Supervisor spawns a generic worker and assigns it a goal at activation time. When the goal's loop iteration completes and no immediate re-activation is pending, the worker is returned to the pool. There is no persistent affinity between a worker instance and a goal.

Workers are cooperative, not threads. Node.js is single-threaded; workers are async tasks that yield at every `await`. Concurrency is achieved through interleaving, not parallelism. This means two workers running simultaneously are actually taking turns at every I/O boundary — which is the right model for PulSeed, where most work is I/O-bound (LLM calls, file reads, HTTP requests).

The concurrency limit controls how many workers run simultaneously. The default is 4 (configurable). Setting it to 1 replicates the current sequential behavior. Setting it to 16 allows 16 goal loops to interleave. The right number depends on LLM rate limits and how many goals are actively running.

The `goal-loop.ts` module (`GoalLoop` class) already implements the iteration logic with wall-time and iteration caps. In the new architecture, `GoalLoop` becomes the inner loop that each `GoalWorker` runs. The `GoalWorker` adds supervision: it catches crashes, reports them to the Supervisor, and ensures the worker slot is released even if the loop panics.

When a GoalWorker crashes:

1. The Supervisor logs the crash with full context.
2. The worker slot is released (other workers continue unaffected).
3. If the crash count for that goal is below the threshold (default: 3), the Supervisor re-queues a `goal_activated` event with a backoff delay.
4. If the threshold is exceeded, the goal is suspended and an escalation notification is dispatched.

The Supervisor keeps a simple state table in memory: worker ID, goal ID, started-at timestamp, iteration count, crash count. This table is also written to `~/.pulseed/supervisor-state.json` on each update, so it survives restarts.

The thin bootstrap that remains of `daemon-runner.ts` is responsible for: PID file management, signal handling (SIGTERM → Supervisor.shutdown()), EventServer startup, and DI wiring. Everything else moves into the Supervisor or the workers.

---

## 6. Eternal State Layer

"Eternal" is intentional. PulSeed's state must outlive any individual process crash, operating system restart, or Node.js upgrade. The files in `~/.pulseed/` are the ground truth.

The current `StateManager` in `src/base/state/state-manager.ts` already does atomic writes (write to `.tmp`, then rename). That is safe for a single writer. The Eternal State layer adds two things on top: advisory locking and a write-ahead log.

**Advisory locking** prevents two GoalWorkers from writing to the same goal's directory simultaneously. When a worker begins a write, it acquires a lockfile (`~/.pulseed/goals/<id>/.lock`). If the lock is held, the worker waits with exponential backoff (max 500ms total). This is a per-goal lock, so goal A's write never blocks goal B's write. The lock is released when the write completes or the process exits (lockfile package handles stale locks via PID checking).

The **write-ahead log (WAL)** protects against partial writes. Before modifying any goal file, the worker appends an intent record to `~/.pulseed/goals/<id>/wal.jsonl`:

```
{ "op": "save_goal", "data": { ... }, "ts": "2026-04-06T..." }
```

After the atomic write succeeds, a commit record is appended:

```
{ "op": "commit", "ref_ts": "2026-04-06T...", "ts": "2026-04-06T..." }
```

On startup, the StateManager scans each goal's WAL. An intent without a matching commit indicates a crash mid-write. The StateManager replays the intent (the atomic write is idempotent) and appends the missing commit. This brings the state back to a consistent point before the crash.

WAL entries accumulate over time. Periodic compaction (every 100 writes, or on daemon startup) merges committed WAL entries into the main state files and truncates the WAL. Compaction is itself a WAL operation: it writes a `compaction_start` entry, performs the merge, then writes `compaction_complete`. A crash during compaction is detected on next startup and the merge is re-run.

Goal directories continue to be per-goal, as they already are:

```
~/.pulseed/goals/<goal_id>/
├── goal.json           — goal definition and status
├── observations.json   — observation log
├── gap-history.json    — gap calculation history
├── wal.jsonl           — write-ahead log (advisory)
├── .lock               — advisory lock file
└── snapshots/
    └── <timestamp>.json — periodic state snapshots
```

Snapshots are written every N writes (default: 50) as a recovery baseline. If the WAL replay fails for any reason, the system falls back to the most recent snapshot and logs a warning. The goal resumes from the snapshot's state rather than the most recent write. Human-readable JSON remains the source of truth throughout. Nothing here requires a database.

---

## 7. Migration Path

The existing system is working and tested. The migration is incremental: each phase delivers a standalone improvement, and the system remains functional throughout.

**Phase A: Extract IngressGateway interface**

Introduce the `ChannelAdapter` interface and `IngressGateway` class. Wrap `EventServer` behind a `HttpChannelAdapter` that implements the interface. The Gateway forwards Envelopes to the existing `DriveSystem.writeEvent()` call — no Queue yet. Nothing changes from the outside; the internal structure is cleaner.

Files changed: `src/runtime/event-server.ts` (thin wrapper), new `src/runtime/gateway/ingress-gateway.ts`, new `src/runtime/gateway/channel-adapter.ts`, new `src/runtime/gateway/http-channel-adapter.ts`.

**Phase B: Add in-process EventBus**

Introduce `CommandBus` and `EventBus` with priority queuing. Route `ScheduleEngine.tick()` output through the EventBus instead of direct invocation from `daemon-runner.ts`. Route incoming Envelopes from the Gateway through the appropriate bus. The daemon loop now pulls from the bus instead of calling `processScheduleEntries()` inline.

Both `processScheduleEntries()` (which calls `ScheduleEngine.tick()`) and `processCronTasks()` (which processes cron-based triggers) must route their output through the EventBus. These are currently separate call paths in `daemon-runner.ts` (lines ~357 and ~361) and both need migration.

Files changed: `src/runtime/daemon-runner.ts` (pull from bus), new `src/runtime/queue/command-bus.ts`, new `src/runtime/queue/event-bus.ts`, new `src/runtime/queue/priority-queue.ts`.

**Phase C: Refactor daemon-runner into LoopSupervisor + GoalWorker**

Extract the goal-iteration logic from `daemon-runner.ts`'s `runLoop()` into a `GoalWorker` class. Create `LoopSupervisor` to manage the worker pool. `DaemonRunner` becomes thin bootstrap only. This is the largest change; it should be done on a feature branch with the full test suite running.

Files changed: `src/runtime/daemon-runner.ts` (gutted to bootstrap), new `src/runtime/executor/loop-supervisor.ts`, new `src/runtime/executor/goal-worker.ts`.

**Phase D: Add advisory locking to StateManager**

Add lockfile acquisition and WAL append to `src/base/state/state-manager.ts` and `src/base/state/state-persistence.ts`. The locking is a no-op when there is only one writer (the normal case today), so existing behavior is unchanged. Tests can be written against the WAL recovery logic independently.

Files changed: `src/base/state/state-manager.ts`, `src/base/state/state-persistence.ts`, new `src/base/state/wal.ts`, new `src/base/state/state-lock.ts`.

**Phase E: Add remaining ChannelAdapters**

With the Gateway in place, adding channels is mechanical: implement `ChannelAdapter`, register with `IngressGateway`. WebSocket adapter (for real-time Web UI), Slack Events API adapter (Slack signature verification + event routing), and additional webhook receivers all follow the same pattern.

New files: `src/runtime/gateway/websocket-channel-adapter.ts`, `src/runtime/gateway/slack-channel-adapter.ts`.

The existing Slack channel in `src/runtime/channels/slack-channel.ts` is an outbound channel (notifications sent to Slack). The new Slack Events API adapter is inbound (messages from Slack routed into PulSeed). Both coexist.

---

## 8. Failure Modes and Recovery

Each layer fails independently. A failure in one layer does not cascade to others.

**Gateway layer.** If an individual ChannelAdapter crashes (e.g., the WebSocket server drops), only that channel is affected. Other adapters continue. The Supervisor monitors adapter health and restarts crashed adapters with exponential backoff. Messages in flight when the adapter crashed are lost; senders receive a connection error and retry at the protocol level. The Gateway itself does not crash unless all adapters crash simultaneously, which is handled by the process supervisor (systemd, launchd, or the PIDManager restart logic).

**Queue layer.** The in-process queue is lost on process crash. In-flight messages are lost. This is acceptable because: (a) ScheduleEngine deterministically reproduces scheduled activations on restart, (b) external event senders are expected to retry on timeout, (c) completion events are derived from goal State which survives via its own WAL in the Eternal State layer. The Queue does not have its own WAL; recovery is the responsibility of idempotent producers and the State layer. The DLQ file persists across restarts; failed messages are not re-enqueued automatically.

**Executor layer.** A GoalWorker crash does not affect the LoopSupervisor or other workers. The Supervisor detects the crash (the worker's Promise rejects), logs it, releases the worker slot, and decides whether to re-queue the activation or suspend the goal. The Supervisor's own state table is persisted to `supervisor-state.json` on each update, so a Supervisor restart can resume from its last known state.

**Eternal State layer.** A crash mid-write leaves a WAL intent without a matching commit. On next startup, `StateManager.init()` scans all goal WALs and replays uncommitted intents. This is the same idempotent atomic write that already exists; the WAL adds auditability. If a goal's WAL is corrupted (rare), the system falls back to the most recent snapshot and logs a warning. The goal resumes from the snapshot's state rather than the most recent write.

---

## 9. Observability

PulSeed already has `logger.ts` for structured logging and `daemon-health.ts` for health checks. The 4-layer architecture extends these without replacing them.

The health endpoint at `GET /health` (already in `EventServer`) gains per-layer status:

```json
{
  "status": "ok",
  "layers": {
    "gateway": { "status": "ok", "adapters": ["http", "cli"] },
    "queue": { "commandBus": { "depth": 2, "saturated": false }, "eventBus": { "depth": 14, "saturated": false } },
    "executor": { "workers": 3, "capacity": 4, "activeGoals": ["goal-abc", "goal-def", "goal-ghi"] },
    "state": { "walPendingOps": 0, "lastCompactionAt": "2026-04-06T12:00:00Z" }
  }
}
```

Metrics to track over time (emitted as structured log entries, digestible by any log aggregator):

- Queue depth per bus and priority level, sampled every 30 seconds.
- Worker utilization: fraction of slots occupied, rolling 1-minute average.
- Event throughput: Envelopes accepted per minute, per channel.
- State write latency: time from lock acquisition to WAL commit, p50/p95.
- GoalWorker crash rate: crashes per goal per hour.

Lifecycle events are emitted on the EventBus with source `"system"`, making them available to the Web UI, TUI, and any registered notifier plugin:

- `worker_started` — a GoalWorker began a loop for a goal.
- `worker_completed` — a GoalWorker finished a loop, with result status.
- `worker_crashed` — a GoalWorker crashed, with error and crash count.
- `queue_saturated` — a bus crossed its high-water mark.
- `gateway_adapter_restarted` — a ChannelAdapter was restarted after a crash.

These events are LOW priority on the EventBus; they do not compete with goal work.

---

## 10. Future Considerations

**External queue (Redis Streams).** The in-process EventBus is sufficient for a single machine with up to ~20 concurrently active goals. If PulSeed needs to scale beyond that — or if the queue must survive host reboots without WAL replay — Redis Streams is the natural next step. The `CommandBus` and `EventBus` interfaces are designed to be backed by either an in-process or an external implementation. Switching is a matter of injecting a different backend; the Executor and Gateway layers do not change.

**Multi-machine operation.** Running multiple PulSeed instances against the same goal set requires a shared state layer and leader election. SQLite (embedded, file-based) or Turso (libSQL over the network) could replace the per-file JSON approach while preserving the human-readable audit trail. Leader election (using a TTL-based lock in the shared database) would allow one machine to be the primary Executor while others hot-standby. This is not needed until a single machine's I/O or LLM rate limits become the bottleneck — likely years away for most deployments.

**WebSocket push for real-time Web UI.** The SSE stream in `EventServer` already gives the Web UI real-time updates. WebSocket would allow bidirectional communication: the Web UI could send commands (goal start/stop, chat messages, approvals) through the same connection that receives updates. In the Gateway architecture this is a new ChannelAdapter that wraps a WebSocket server; the rest of the system sees it as another source of Envelopes. The outbound path (broadcasting events back to the Web UI) uses the same `reply` field on the Envelope to route responses through the WebSocket connection rather than a REST response.

---

## 11. Deferred Design Decisions

These are implementation-time decisions that are intentionally left open in this design document. Each item should be resolved when the relevant phase is implemented.

**1. Queue-level coalescing, deduplication, and TTL.** Policy for same-goal `goal_activated` dedup, external webhook retry handling, and stale scheduled tick expiry. The `dedupe_key` and `ttl_ms` fields on Envelope provide the mechanism; the specific policy (e.g., which event types are coalesced, how long stale ticks are valid) should be specified when implementing the Queue layer.

**2. Gateway "stateless" definition precision.** The document states the Gateway is stateless, but the Gateway does hold ephemeral operational state: reply handles, auth context, rate-limit counters, dedupe bloom filter, and adapter health. What it does NOT hold is goal state, queue state, or execution state. Document this distinction explicitly in the Gateway implementation to avoid misinterpretation.

**3. CommandBus / EventBus physical separation.** Whether these are two physical priority queues or logical partitions on a single shared PriorityQueue. Current design: conceptual split only. Decide at implementation time based on performance profiling and whether priority inversion between buses is observed in practice.

**4. Snapshot / WAL replay alignment conditions.** Snapshot header format (version, last_wal_offset, checksum), replay-from-offset semantics, and compaction boundary rules are not specified here. Define these when implementing the Eternal State layer (Phase D) to ensure consistent recovery behavior.

**5. event-subscriber.ts role clarification.** `src/interface/chat/event-subscriber.ts` exists and is referenced in section 3 as the chat/TUI subscriber. Verify its exact migration path when implementing Gateway ChannelAdapters in Phase A/E: confirm whether it becomes a read-only ChannelAdapter or is replaced by the Gateway's outbound broadcast path.
