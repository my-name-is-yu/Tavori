# Schedule Engine Design

> PulSeed does not wait to be asked — it acts on time. The ScheduleEngine adds proactive, time-based triggers to the daemon,
> enabling PulSeed to monitor, report, and pursue goals on a schedule rather than only reacting to user commands.

> Related: `plugin-architecture.md`, `reporting.md`, `daemon-client-architecture.md`, `docs/design/core/observation.md`, `docs/design/execution/data-source.md`

> Current implementation note: scheduling now coexists with the dual-loop architecture. A scheduled activation may ultimately drive CoreLoop, which in turn may invoke bounded AgentLoop phases and native task execution. Read "full CoreLoop" in this document as "long-lived control path," not as a single flat sequence without internal agentic phases.

---

## §1 Overview and Positioning

### Why ScheduleEngine

PulSeed already has a CoreLoop that runs continuously when the daemon is active. But "continuously" is not the same as "proactively." The CoreLoop processes goals that are already active — it does not initiate new observations, generate unprompted reports, or monitor external systems on a cadence.

The ScheduleEngine fills this gap. It introduces time-based triggers that cause PulSeed to act at specific moments: checking email every 30 minutes, generating a morning summary at 8am, running a weekly code quality review, or pinging a health endpoint every minute.

### PulSeed vs OpenClaw cron / system crontab

In system crontab and OpenClaw's cron, scheduled tasks are "fire and forget" — a command runs at a time, produces output, and the system does not reason about whether to escalate, suppress, or adapt. The schedule is static.

PulSeed's ScheduleEngine is different in three ways:

```
System crontab / OpenClaw cron:
  Schedule -> Execute command -> Output (always)
  No conditional logic. No escalation. No cost awareness.

PulSeed ScheduleEngine:
  Schedule -> Layer-appropriate check -> Conditional escalation
  Layer decides: zero-cost mechanical check? LLM analysis? Full goal pursuit?
  Escalation: Heartbeat failure -> Probe investigation -> GoalTrigger pursuit
  Cost model: most executions cost zero LLM tokens
```

The key insight is that not all scheduled actions require the same weight of processing. A health check does not need an LLM. An email check only needs an LLM when something important arrives. A morning summary always needs an LLM. A weekly code review needs the full CoreLoop. The 4-layer architecture matches processing weight to the task.

### "Thin core, extend with plugins" principle

The ScheduleEngine core handles scheduling mechanics (when to fire) and layer dispatch (which processing weight to apply). External schedule sources (Google Calendar, webhook-driven schedules) are plugins implementing the `IScheduleSource` interface — they are not part of the core.

| Criterion | Location | Example |
|-----------|----------|---------|
| Scheduling mechanics (fire timing, jitter, overlap prevention) | Core | ScheduleEngine |
| Layer dispatch (Heartbeat/Probe/Cron/GoalTrigger routing) | Core | LayerDispatcher |
| Built-in time expressions (cron, interval) | Core | CronExpression, IntervalExpression |
| External schedule sources (calendar, webhook) | Plugin | GoogleCalendarSource, WebhookScheduleSource |
| Custom check functions for Heartbeat/Probe | Plugin | HttpHealthCheck, SlackMonitor |

---

## §2 Architecture

### 2.1 Position in the runtime stack

```
DaemonRunner
  |-- CoreLoop (existing -- goal pursuit)
  |-- CronScheduler (existing -- reflection/consolidation tasks)
  +-- ScheduleEngine (new -- proactive scheduling)
       |-- GoalTrigger  -> CoreLoop.run(goal)
       |-- Probe        -> DataSource.fetch() -> conditional LLM -> maybe escalate
       |-- Cron         -> LLM processing every time (human rhythm)
       +-- Heartbeat    -> mechanical check only -> escalate on failure
```

The existing `CronScheduler` handles simple prompt-based tasks (reflection, consolidation). The ScheduleEngine supersedes it for all new scheduling needs and provides a migration path for existing CronScheduler tasks.

### 2.2 Relationship to existing CronScheduler

The existing `CronScheduler` (`src/runtime/cron-scheduler.ts`) supports three task types: `reflection`, `consolidation`, and `custom`. These map cleanly to ScheduleEngine layers:

| Existing CronTask type | ScheduleEngine layer | Rationale |
|------------------------|---------------------|-----------|
| `reflection` | Cron | Always produces LLM output |
| `consolidation` | Cron | Always produces LLM output |
| `custom` | Cron or GoalTrigger | Depends on whether full CoreLoop is needed |

Migration strategy: CronScheduler remains operational during the transition. New schedule entries use ScheduleEngine exclusively. A future milestone deprecates CronScheduler and migrates existing tasks.

---

## §3 The 4 Layer Types

### 3.1 GoalTrigger (Heavy)

**Weight**: Full CoreLoop execution. High LLM cost.

**Behavior**: Triggers `CoreLoop.run(goal)` on schedule. The goal must be pre-defined in PulSeed's goal store. The GoalTrigger simply activates it at the scheduled time.

**Use cases**:
- Weekly code quality review ("Run code quality review every Monday at 9am")
- Periodic refactoring assessment ("Evaluate refactoring opportunities every Friday")
- Scheduled large tasks that need full observe-gap-score-task-execute-verify cycle

**Execution flow**:
```
Schedule fires
  -> Load goal definition from StateManager
  -> CoreLoop.run(goalId, { maxIterations })
  -> LoopResult recorded in goal history
  -> NotificationDispatcher.dispatch(goal_progress event)
```

**Configuration fields specific to GoalTrigger**:
```typescript
{
  layer: "goal_trigger",
  goal_id: string,              // existing goal to activate
  max_iterations: number,       // cap CoreLoop iterations (default: 10)
  skip_if_active: boolean,      // skip if goal is already being pursued (default: true)
}
```

**Cost**: 5,000-50,000+ tokens per execution (full CoreLoop with LLM observation, gap analysis, task generation).

### 3.2 Probe (Medium, conditional)

**Weight**: Mechanical check first, LLM only on change detection. Most executions cost zero tokens.

**Behavior**: Runs `IDataSourceAdapter.query()` on schedule. Compares the result against a baseline or threshold. If a change is detected, escalates to LLM analysis. If no change, silently records the check and moves on.

This is the "watchdog" pattern — silent unless triggered.

**Use cases**:
- Email monitoring ("Check email every 30min, notify only if important mail detected")
- Slack channel monitoring ("Watch #incidents channel, escalate if new incident posted")
- API health degradation ("Check response time every 5min, alert if p99 > 500ms")
- Repository monitoring ("Check for new PRs every hour, summarize if any found")

**Execution flow**:
```
Schedule fires
  -> DataSourceAdapter.query(params)           # mechanical, zero LLM cost
  -> ChangeDetector.compare(result, baseline)  # mechanical comparison
  -> No change? -> record check timestamp, done (zero tokens)
  -> Change detected?
      -> LLM analysis: "Is this change significant?"  # first LLM cost
      -> Not significant? -> record, done
      -> Significant?
          -> NotificationDispatcher.dispatch(event)
          -> Optionally escalate to GoalTrigger
```

**Configuration fields specific to Probe**:
```typescript
{
  layer: "probe",
  data_source_id: string,         // registered IDataSourceAdapter to query
  query_params: DataSourceQuery,  // parameters for the query
  change_detector: {
    mode: "threshold" | "diff" | "presence",
    threshold?: number,           // for threshold mode: trigger if value exceeds
    baseline_window?: number,     // number of recent results to compare against
  },
  escalate_to?: {
    type: "goal_trigger",
    goal_id: string,              // goal to activate on significant change
  },
  notification_on_change: boolean, // send notification when change detected (default: true)
}
```

**Cost**: 0 tokens for most executions. 500-2,000 tokens when change is detected (LLM significance analysis). Full CoreLoop cost if escalated to GoalTrigger.

### 3.3 Cron (Medium, guaranteed execution)

**Weight**: Always invokes LLM processing. Designed for human-rhythm-aligned operations.

**Behavior**: Runs LLM processing every time the schedule fires. Unlike Probe, there is no conditional check — the LLM always produces output. This is the "secretary" pattern: always produces a briefing, summary, or report.

**Use cases**:
- Morning summary ("Every morning at 8am, summarize today's calendar + unread emails")
- Daily report generation ("Generate end-of-day progress report at 6pm")
- Weekly digest ("Every Sunday at 9pm, compile weekly goal progress")
- Periodic briefing ("Brief me on market trends every Monday")

**Execution flow**:
```
Schedule fires
  -> Gather context (DataSource queries, goal states, recent history)
  -> LLM processing with prompt template
  -> Format output (report, summary, notification)
  -> Deliver via NotificationDispatcher and/or ReportingEngine
```

**Configuration fields specific to Cron**:
```typescript
{
  layer: "cron",
  prompt_template: string,        // LLM prompt (supports {{variable}} interpolation)
  context_sources: string[],      // data source IDs to gather context from
  output_format: "notification" | "report" | "both",
  report_type?: string,           // for ReportingEngine integration
}
```

**Cost**: 1,000-10,000 tokens per execution (LLM processing with context).

### 3.4 Heartbeat (Lightest)

**Weight**: Pure mechanical check. Zero LLM calls under normal operation.

**Behavior**: Runs a simple mechanical check (HTTP ping, process liveness, disk capacity, port response) at high frequency. No LLM is involved. On failure detection, escalates to Probe or GoalTrigger.

This is the "pulse check" — the lightest possible monitoring.

**Use cases**:
- Service health ("Check service health every 1 minute")
- Disk capacity ("Alert if disk usage > 90%, check every 5 minutes")
- Process liveness ("Verify daemon subprocess is alive every 30 seconds")
- Port response ("Check if port 8080 responds every 1 minute")

**Execution flow**:
```
Schedule fires
  -> Run mechanical check function
  -> Pass? -> record timestamp, done (zero cost)
  -> Fail?
      -> Increment failure counter
      -> Below failure_threshold? -> record, done
      -> Exceeded failure_threshold?
          -> Escalate to Probe or GoalTrigger
          -> NotificationDispatcher.dispatch(heartbeat_failure event)
```

**Configuration fields specific to Heartbeat**:
```typescript
{
  layer: "heartbeat",
  check_type: "http" | "tcp" | "process" | "disk" | "custom",
  check_config: {
    url?: string,                 // for http check
    host?: string,                // for tcp check
    port?: number,                // for tcp check
    pid_file?: string,            // for process check
    path?: string,                // for disk check
    threshold?: number,           // for disk check (percentage)
    custom_command?: string,      // for custom check (shell command, exit 0 = pass)
  },
  failure_threshold: number,      // consecutive failures before escalation (default: 3)
  escalate_to?: {
    type: "probe" | "goal_trigger",
    schedule_entry_id?: string,   // existing Probe to activate
    goal_id?: string,             // existing goal to activate
  },
}
```

**Cost**: 0 tokens always. Escalation cost depends on target layer.

---

## §4 ScheduleEntry Schema

### 4.1 Core schema

```typescript
// src/types/schedule.ts

import { z } from "zod";

// --- Schedule Expression ---

const CronExpressionSchema = z.object({
  type: z.literal("cron"),
  expression: z.string(),        // standard cron: "0 9 * * 1" (Monday 9am)
  timezone: z.string().default("UTC"),
});

const IntervalExpressionSchema = z.object({
  type: z.literal("interval"),
  seconds: z.number().int().positive(),
  jitter_factor: z.number().min(0).max(0.5).default(0.05), // +/-5% randomization
});

const ScheduleExpressionSchema = z.discriminatedUnion("type", [
  CronExpressionSchema,
  IntervalExpressionSchema,
]);

export type ScheduleExpression = z.infer<typeof ScheduleExpressionSchema>;

// --- Layer Configs ---

const GoalTriggerConfigSchema = z.object({
  layer: z.literal("goal_trigger"),
  goal_id: z.string(),
  max_iterations: z.number().int().positive().default(10),
  skip_if_active: z.boolean().default(true),
});

const ProbeConfigSchema = z.object({
  layer: z.literal("probe"),
  data_source_id: z.string(),
  query_params: z.record(z.unknown()).default({}),
  change_detector: z.object({
    mode: z.enum(["threshold", "diff", "presence"]),
    threshold: z.number().optional(),
    baseline_window: z.number().int().positive().default(5),
  }),
  escalate_to: z.object({
    type: z.literal("goal_trigger"),
    goal_id: z.string(),
  }).optional(),
  notification_on_change: z.boolean().default(true),
});

const CronConfigSchema = z.object({
  layer: z.literal("cron"),
  prompt_template: z.string(),
  context_sources: z.array(z.string()).default([]),
  output_format: z.enum(["notification", "report", "both"]).default("notification"),
  report_type: z.string().optional(),
});

const HeartbeatConfigSchema = z.object({
  layer: z.literal("heartbeat"),
  check_type: z.enum(["http", "tcp", "process", "disk", "custom"]),
  check_config: z.record(z.unknown()).default({}),
  failure_threshold: z.number().int().positive().default(3),
  escalate_to: z.object({
    type: z.enum(["probe", "goal_trigger"]),
    schedule_entry_id: z.string().optional(),
    goal_id: z.string().optional(),
  }).optional(),
});

const LayerConfigSchema = z.discriminatedUnion("layer", [
  GoalTriggerConfigSchema,
  ProbeConfigSchema,
  CronConfigSchema,
  HeartbeatConfigSchema,
]);

export type LayerConfig = z.infer<typeof LayerConfigSchema>;

// --- ScheduleEntry ---

export const ScheduleEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),

  // When to fire
  schedule: ScheduleExpressionSchema,

  // What to do (layer determines processing weight)
  config: LayerConfigSchema,

  // Runtime state
  last_fired_at: z.string().datetime().nullable().default(null),
  next_fire_at: z.string().datetime().nullable().default(null),
  consecutive_failures: z.number().int().default(0),
  total_executions: z.number().int().default(0),
  total_tokens_used: z.number().int().default(0),

  // Metadata
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  tags: z.array(z.string()).default([]),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const ScheduleEntryListSchema = z.array(ScheduleEntrySchema);
```

### 4.2 ScheduleResult (execution record)

```typescript
export const ScheduleResultSchema = z.object({
  entry_id: z.string().uuid(),
  fired_at: z.string().datetime(),
  layer: z.enum(["goal_trigger", "probe", "cron", "heartbeat"]),
  status: z.enum(["success", "failure", "escalated", "skipped"]),
  tokens_used: z.number().int().default(0),
  duration_ms: z.number().int(),
  escalated_to: z.string().uuid().optional(),  // entry_id or goal_id of escalation target
  error_message: z.string().optional(),
  output_summary: z.string().optional(),       // one-line summary of result
});

export type ScheduleResult = z.infer<typeof ScheduleResultSchema>;
```

---

## §5 Escalation Mechanics

### 5.1 Escalation paths

Escalation flows strictly upward through layers. Lower layers can trigger higher layers, but never the reverse.

```
Heartbeat --(failure_threshold exceeded)--> Probe
Heartbeat --(failure_threshold exceeded)--> GoalTrigger
Probe     --(significant change detected)--> GoalTrigger
Cron      --(no escalation path)--> (standalone)
```

Cron does not escalate because it always produces output. It has no "trigger condition" — it fires unconditionally.

### 5.2 Escalation process

When a layer decides to escalate:

1. **Record the escalation** in `ScheduleResult` with `status: "escalated"`
2. **Resolve the target**: look up the target ScheduleEntry or Goal by ID
3. **Execute the target immediately** (out of its normal schedule)
4. **Link the results**: the target's `ScheduleResult` references the originating entry

```typescript
interface EscalationEvent {
  source_entry_id: string;       // the Heartbeat/Probe that triggered escalation
  source_layer: "heartbeat" | "probe";
  target_type: "probe" | "goal_trigger";
  target_id: string;             // ScheduleEntry ID or Goal ID
  reason: string;                // human-readable escalation reason
  timestamp: string;             // ISO 8601
}
```

### 5.3 Escalation safeguards

To prevent escalation storms (e.g., a failing health check triggering GoalTrigger every minute):

| Safeguard | Mechanism |
|-----------|-----------|
| Cooldown period | After escalation, source entry enters cooldown (default: 15 minutes). No re-escalation during cooldown |
| Max escalations per hour | Global limit on escalations per source entry (default: 4/hour) |
| Deduplication | If the target GoalTrigger is already running (`skip_if_active: true`), escalation is recorded but not executed |
| Circuit breaker | After N consecutive escalation failures (default: 10), the source entry is auto-disabled with a warning notification |

---

## §6 Integration with Existing Modules

### 6.1 DaemonRunner

`DaemonRunner` is the host process for `ScheduleEngine`. It initializes the engine at startup and ticks it on each daemon cycle.

```typescript
// In DaemonRunner.start()
this.scheduleEngine = new ScheduleEngine({
  stateManager: this.stateManager,
  coreLoop: this.coreLoop,
  observationEngine: this.observationEngine,
  notificationDispatcher: this.notificationDispatcher,
  reportingEngine: this.reportingEngine,
  llmClient: this.llmClient,
  logger: this.logger,
  baseDir: this.baseDir,
});
await this.scheduleEngine.loadEntries();

// In daemon loop iteration
const dueEntries = await this.scheduleEngine.getDueEntries();
for (const entry of dueEntries) {
  await this.scheduleEngine.execute(entry);
}
```

### 6.2 CoreLoop

GoalTrigger invokes `CoreLoop.run(goalId, { maxIterations })` directly. No changes to CoreLoop are required — it already accepts a `goalId` and options.

### 6.3 ObservationEngine and DataSourceAdapter

Probe reuses `ObservationEngine`'s data source infrastructure. It calls `IDataSourceAdapter.query()` directly through the `DataSourceRegistry`, the same way ObservationEngine does for goal observation.

No changes to ObservationEngine or IDataSourceAdapter are required. Probe is a new consumer of the existing data source pipeline.

### 6.4 NotificationDispatcher

ScheduleEngine dispatches notifications through the existing `NotificationDispatcher` for:

- Probe: change detection notifications
- Cron: report delivery notifications
- Heartbeat: failure and escalation notifications
- GoalTrigger: goal progress notifications (handled by CoreLoop internally)

New notification event types added:

```typescript
type NotificationEventType =
  | /* existing types */
  | "schedule_change_detected"    // Probe detected a change
  | "schedule_heartbeat_failure"  // Heartbeat check failed
  | "schedule_escalation"         // Layer escalated to higher layer
  | "schedule_report_ready";      // Cron report generated
```

### 6.5 ReportingEngine

Cron layer integrates with `ReportingEngine` when `output_format` is `"report"` or `"both"`. The Cron prompt generates structured content, and ReportingEngine formats and persists it.

### 6.6 Module integration summary

| Module | Changes required | Integration method |
|--------|-----------------|-------------------|
| `DaemonRunner` | Add ScheduleEngine initialization and tick | Direct dependency injection |
| `CoreLoop` | No change | Called by GoalTrigger via `coreLoop.run()` |
| `ObservationEngine` | No change | Probe queries data sources through DataSourceRegistry |
| `DataSourceAdapter` | No change | Probe calls `query()` on registered adapters |
| `NotificationDispatcher` | Add 4 new event types | Called by all layers for notifications |
| `ReportingEngine` | No change | Called by Cron layer for report formatting |
| `StateManager` | No change | ScheduleEngine persists its own state to `~/.pulseed/schedules.json` |
| `LLMClient` | No change | Called by Probe (conditional) and Cron (always) |

---

## §7 Plugin Extension: IScheduleSource

### 7.1 Interface definition

External schedule sources allow plugins to inject schedule entries from external systems (Google Calendar, webhooks, etc.).

```typescript
// src/types/schedule-source.ts

interface IScheduleSource {
  /** Unique identifier for this source */
  readonly sourceId: string;

  /** Human-readable name */
  readonly sourceName: string;

  /**
   * Fetch schedule entries from the external source.
   * Called periodically by ScheduleEngine to sync external schedules.
   * Returns entries that should be active. Entries not returned are deactivated.
   */
  fetchEntries(): Promise<ExternalScheduleEntry[]>;

  /**
   * Check if the source is reachable and authenticated.
   */
  healthCheck(): Promise<boolean>;
}

interface ExternalScheduleEntry {
  external_id: string;           // ID in the external system
  name: string;
  description?: string;
  schedule: ScheduleExpression;
  layer: "goal_trigger" | "probe" | "cron" | "heartbeat";
  config: Record<string, unknown>;  // layer-specific config
}
```

### 7.2 Plugin manifest for schedule sources

```yaml
# ~/.pulseed/plugins/google-calendar-source/plugin.yaml
name: google-calendar-source
version: "1.0.0"
type: schedule_source          # new plugin type
capabilities:
  - calendar_scheduling
  - event_driven_triggers
description: "Syncs PulSeed schedules from Google Calendar events"
config_schema:
  calendar_id:
    type: string
    required: true
    description: "Google Calendar ID to sync from"
  sync_interval_minutes:
    type: number
    default: 15
    description: "How often to sync calendar events"
  tag_prefix:
    type: string
    default: "pulseed:"
    description: "Calendar event title prefix to identify PulSeed schedules"
dependencies:
  - "googleapis@^120.0.0"
entry_point: "dist/index.js"
min_pulseed_version: "2.0.0"
```

### 7.3 Sync lifecycle

```
ScheduleEngine startup
  -> Load IScheduleSource plugins from PluginLoader
  -> For each source: source.fetchEntries()
  -> Merge external entries with local entries (external_id used for dedup)
  -> External entries are tagged with source_id for tracking

Periodic sync (configurable interval, default: 15 minutes)
  -> Re-fetch from all sources
  -> Add new entries, update changed entries, deactivate removed entries
  -> Log sync results
```

---

## §8 Configuration Format

### 8.1 File location

Schedule entries are persisted to `~/.pulseed/schedules.json`. This file is managed by ScheduleEngine and should not be edited manually (use CLI commands instead).

### 8.2 Configuration example

```json
{
  "version": "1.0.0",
  "entries": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "weekly-code-review",
      "description": "Run code quality review every Monday at 9am",
      "enabled": true,
      "schedule": {
        "type": "cron",
        "expression": "0 9 * * 1",
        "timezone": "Asia/Tokyo"
      },
      "config": {
        "layer": "goal_trigger",
        "goal_id": "code-quality-review",
        "max_iterations": 10,
        "skip_if_active": true
      },
      "last_fired_at": "2026-03-31T09:00:02Z",
      "next_fire_at": "2026-04-07T09:00:00Z",
      "consecutive_failures": 0,
      "total_executions": 4,
      "total_tokens_used": 142000,
      "created_at": "2026-03-10T12:00:00Z",
      "updated_at": "2026-03-31T09:00:02Z",
      "tags": ["code-quality"]
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "name": "email-monitor",
      "description": "Check email every 30 minutes, notify if important",
      "enabled": true,
      "schedule": {
        "type": "interval",
        "seconds": 1800,
        "jitter_factor": 0.05
      },
      "config": {
        "layer": "probe",
        "data_source_id": "gmail-datasource",
        "query_params": { "label": "INBOX", "unread_only": true },
        "change_detector": {
          "mode": "presence",
          "baseline_window": 1
        },
        "escalate_to": {
          "type": "goal_trigger",
          "goal_id": "process-important-email"
        },
        "notification_on_change": true
      },
      "last_fired_at": "2026-04-06T10:30:12Z",
      "next_fire_at": "2026-04-06T11:00:00Z",
      "consecutive_failures": 0,
      "total_executions": 312,
      "total_tokens_used": 8500,
      "created_at": "2026-03-15T08:00:00Z",
      "updated_at": "2026-04-06T10:30:12Z",
      "tags": ["email", "communication"]
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440003",
      "name": "morning-briefing",
      "description": "Daily morning summary at 8am",
      "enabled": true,
      "schedule": {
        "type": "cron",
        "expression": "0 8 * * *",
        "timezone": "Asia/Tokyo"
      },
      "config": {
        "layer": "cron",
        "prompt_template": "Summarize the following for today's briefing:\n1. Calendar events from {{calendar}}\n2. Unread emails from {{email}}\n3. Active goal progress from {{goals}}\nProvide a concise morning briefing.",
        "context_sources": ["google-calendar", "gmail-datasource", "goal-state"],
        "output_format": "both",
        "report_type": "daily_briefing"
      },
      "last_fired_at": "2026-04-06T08:00:03Z",
      "next_fire_at": "2026-04-07T08:00:00Z",
      "consecutive_failures": 0,
      "total_executions": 22,
      "total_tokens_used": 88000,
      "created_at": "2026-03-15T08:00:00Z",
      "updated_at": "2026-04-06T08:00:03Z",
      "tags": ["daily", "briefing"]
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440004",
      "name": "service-health",
      "description": "Check API service health every minute",
      "enabled": true,
      "schedule": {
        "type": "interval",
        "seconds": 60,
        "jitter_factor": 0
      },
      "config": {
        "layer": "heartbeat",
        "check_type": "http",
        "check_config": {
          "url": "https://api.example.com/health",
          "timeout_ms": 5000,
          "expected_status": 200
        },
        "failure_threshold": 3,
        "escalate_to": {
          "type": "probe",
          "schedule_entry_id": "550e8400-e29b-41d4-a716-446655440005"
        }
      },
      "last_fired_at": "2026-04-06T10:59:01Z",
      "next_fire_at": "2026-04-06T11:00:01Z",
      "consecutive_failures": 0,
      "total_executions": 43200,
      "total_tokens_used": 0,
      "created_at": "2026-03-20T00:00:00Z",
      "updated_at": "2026-04-06T10:59:01Z",
      "tags": ["health", "monitoring"]
    }
  ]
}
```

### 8.3 CLI commands

```bash
# List all schedule entries
pulseed schedule list

# Add a new entry (interactive or from JSON)
pulseed schedule add --name "morning-briefing" --layer cron --cron "0 8 * * *"

# Enable/disable
pulseed schedule enable <id>
pulseed schedule disable <id>

# Remove
pulseed schedule remove <id>

# Show execution history
pulseed schedule history <id> --limit 10

# Show cost summary
pulseed schedule cost --period 7d
```

---

## §9 Cost Model

### 9.1 Per-layer cost breakdown

| Layer | Tokens per execution | Frequency | Monthly cost estimate (single entry) |
|-------|---------------------|-----------|--------------------------------------|
| Heartbeat | 0 | every 1min | $0.00 |
| Probe (no change) | 0 | every 30min | $0.00 |
| Probe (change detected) | 500-2,000 | ~5% of checks | ~$0.15 |
| Cron | 1,000-10,000 | daily | ~$3.00-$30.00 |
| GoalTrigger | 5,000-50,000+ | weekly | ~$5.00-$50.00 |

### 9.2 Cost tracking

ScheduleEngine tracks cumulative token usage per entry in `total_tokens_used`. The `pulseed schedule cost` command reports:

- Per-entry token usage over a time period
- Total schedule-driven token usage vs. user-initiated usage
- Projected monthly cost based on recent usage

### 9.3 Cost controls

| Control | Mechanism |
|---------|-----------|
| Token budget per entry | Optional `max_tokens_per_day` field prevents runaway costs |
| Global schedule budget | `~/.pulseed/config.json` field `schedule_token_budget_daily` caps total schedule-driven token usage |
| Auto-disable on budget exceeded | Entry is disabled with notification when budget is hit |
| Cost-aware scheduling | Entries can specify `cost_priority: "low"` to defer execution to off-peak times |

---

## §10 Implementation Order

### Phase 1: Core infrastructure + Heartbeat (lightest layer first)

**Scope**:
- `ScheduleEntry` Zod schema and persistence (`src/types/schedule.ts`)
- `ScheduleEngine` core class: load, save, getDueEntries, execute dispatch
- Heartbeat layer: HTTP, TCP, process, disk checks
- Heartbeat escalation to notification
- DaemonRunner integration (tick ScheduleEngine in daemon loop)
- CLI: `pulseed schedule list`, `pulseed schedule add`, `pulseed schedule remove`

**Rationale**: Heartbeat is the simplest layer (zero LLM, pure mechanical checks). Building it first validates the core scheduling infrastructure without any LLM dependency.

**Completion criteria**:
- Heartbeat entries fire on schedule and record results
- Failure detection works with configurable threshold
- DaemonRunner ticks ScheduleEngine alongside existing CronScheduler

### Phase 2: Probe layer + escalation

**Scope**:
- Probe layer: DataSourceAdapter.query() integration
- ChangeDetector: threshold, diff, and presence modes
- Conditional LLM analysis on change detection
- Escalation mechanics: Heartbeat to Probe, Probe to GoalTrigger
- Escalation safeguards (cooldown, max rate, circuit breaker)
- 4 new NotificationDispatcher event types

**Completion criteria**:
- Probe queries data sources and detects changes mechanically
- LLM is invoked only when change is detected
- Escalation from Heartbeat to Probe works
- Escalation from Probe to GoalTrigger works
- Safeguards prevent escalation storms

### Phase 3: Cron + GoalTrigger layers

**Scope**:
- Cron layer: prompt template interpolation, context gathering, LLM execution
- Cron + ReportingEngine integration
- GoalTrigger layer: CoreLoop.run() invocation
- GoalTrigger skip_if_active logic
- Cost tracking and budget controls
- CLI: `pulseed schedule history`, `pulseed schedule cost`

**Completion criteria**:
- Cron produces LLM-generated output on schedule
- GoalTrigger activates CoreLoop for a goal on schedule
- Cost tracking accurately reflects token usage per entry
- Budget limits auto-disable entries when exceeded

### Phase 4: Plugin extension + migration

**Scope**:
- `IScheduleSource` interface and plugin type
- PluginLoader extension for `schedule_source` type
- External schedule sync lifecycle
- CronScheduler migration path (convert existing tasks to ScheduleEntries)
- Google Calendar reference plugin

**Completion criteria**:
- External schedule source plugins can inject entries
- Sync lifecycle correctly adds, updates, and removes external entries
- Existing CronScheduler tasks can be migrated to ScheduleEngine

---

## Design Principles Summary

| Principle | Concrete design decision |
|-----------|------------------------|
| PulSeed acts on time, not just on demand | ScheduleEngine adds proactive time-based triggers to the daemon |
| Match processing weight to the task | 4 layers: Heartbeat (zero cost) to Probe (conditional) to Cron (always LLM) to GoalTrigger (full CoreLoop) |
| Most checks cost nothing | Heartbeat and Probe (no change) use zero LLM tokens |
| Escalation, not duplication | Lower layers escalate to higher layers rather than reimplementing their logic |
| Reuse existing infrastructure | Probe uses DataSourceAdapter, GoalTrigger uses CoreLoop, notifications use NotificationDispatcher |
| Extend with plugins | External schedule sources (calendar, webhook) are plugins, not core |
| Cost transparency | Per-entry token tracking, budget controls, cost reporting CLI |
| Failures do not stop PulSeed | Schedule entry failures are logged and retried, not fatal |
