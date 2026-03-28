# Reporting Design

> PulSeed reports to the user proactively — without being asked. It delivers the status of goal pursuit at the right time and at the right level of detail.
> This document defines the types of reports, triggers, content, delivery channels, and verbosity control.

---

## 1. The Role of Reporting

PulSeed autonomously pursues user goals. But being autonomous does not mean operating in silence. As defined in vision.md, "PulSeed reports proactively, at the right time, at the right level of detail" — this is the essential behavior of an autonomous partner.

Reporting is a core function of PulSeed, not an optional one. Whether the user can trust PulSeed depends on transparency (see trust-and-safety.md §8). Trust is built on transparency, and reporting is the implementation of transparency.

### Reporting and the Execution Boundary

Generating reports (deciding on content and structure) is done directly by PulSeed. This is part of PulSeed's reasoning process and corresponds to LLM calls for analyzing and summarizing goal state.

Delivering reports (writing to files, sending notifications) is delegated (see execution-boundary.md §3). PulSeed decides "what to report," and "how to deliver it" is left to existing systems.

---

## 2. Three Types of Reports

Reporting is divided into three categories. Each has different triggers, different granularity, and different urgency.

### 2.1 Periodic Report

**Purpose**: Regularly convey the overall picture of goal pursuit. This is the foundational information for users to get a bird's-eye view of PulSeed's activity.

**Content**:

| Section | Information Included |
|---------|----------------------|
| Goal summary | Current overall progress rate for each goal and the change since the last report |
| Dimension-level progress | Current value, threshold, Gap, and observation confidence for each dimension |
| Execution summary | Number of tasks executed during the period, breakdown by success/failure/pending |
| Strategy evaluation | Effectiveness of the current strategy (Gap reduction rate), rationale for continuing or changing strategy |
| Risks and concerns | Dimensions trending toward stall, low-confidence observations, deadline risks |
| Next actions | Tasks PulSeed plans to work on in the next period |

**Default report frequency**:

| Report Type | Default Frequency | Adjustment Condition |
|-------------|-------------------|----------------------|
| Daily summary | Daily (at user-specified time, default: 09:00) | When there are active goals |
| Weekly report | Every Monday (default: 09:00) | Always (including when all goals are satisfied) |

The daily summary prioritizes brevity. The weekly report includes detailed analysis and strategy retrospective.

**Generation method**: LLM is used to compose the report. Observation data, Gap calculation results, and task execution logs are used as input to generate a narrative that is easy for the user to read. Numeric data itself is aggregated by code; the LLM's role is to interpret and summarize it.

### 2.2 Immediate Notification

**Purpose**: Convey important state changes in real time. Deliver what the user needs to know without delay.

Immediate notifications are alerts, not reports. They are concise, action-oriented, and contain only the minimum necessary information.

**Types and content of immediate notifications**:

| Notification Type | Trigger Condition | Information Included |
|-------------------|-------------------|----------------------|
| Urgent alert | Sensor threshold exceeded, external system failure, sudden change in health metric | What happened, scope of impact, recommended action |
| Approval request | Before executing an irreversible action (see trust-and-safety.md §4) | Action content, trust/confidence levels, PulSeed's assessment, approval button |
| Stall escalation | Stage 3 of stall detection (see stall-detection.md §4) | Description of the stall, list of strategies attempted, available options |
| Goal completion notification | When all dimensions of a goal exceed their thresholds and completion is confirmed | Summary of the achieved state, observation evidence, recommended next steps |
| Capability deficit escalation | Required capability (permission, tool, data source) is missing | What is needed, alternatives, scope of impact |

### 2.3 Strategy Change Report

**Purpose**: When PulSeed changes strategy, convey the rationale for that decision to the user.

Strategy changes happen autonomously, but "explaining why" is directly tied to user trust. PulSeed does not pivot silently.

**Content**:

| Section | Information Included |
|---------|----------------------|
| Previous strategy | What was being done, over what period |
| Reason for change | Why it is being changed (stall, insufficient effect, new information, discovered opportunity) |
| New strategy | What will be done, expected effect |
| Risk assessment | Risks and uncertainties of the new strategy |
| Impact on user | Whether additional approvals or resources are needed |

---

## 3. Trigger Conditions

The decision of when each report is generated is composed of three trigger models.

### 3.1 Time-Based Trigger (for Periodic Reports)

Periodic reports are generated at the time configured by the user. This uses the same timing model as the scheduled activation in `drive-system.md`.

```
reporting_schedule: {
  daily_summary: {
    enabled: true,
    time: "09:00",           // Local time
    timezone: "Asia/Tokyo",
    skip_if_no_activity: true  // Skip if there was no activity
  },
  weekly_report: {
    enabled: true,
    day: "monday",
    time: "09:00",
    timezone: "Asia/Tokyo",
    skip_if_no_activity: false  // Generate even if there was no activity
  }
}
```

The `skip_if_no_activity` flag allows suppression of the daily summary when all goals are waiting and nothing has changed. The weekly report is generated regardless of activity. "Nothing happened" is itself a meaningful report.

### 3.2 Threshold-Based Trigger (for Immediate Notifications)

Fires when a state change exceeds a threshold. Thresholds are defined per notification type.

```
notification_thresholds: {
  health_alert: {
    metric_change_rate: 0.20,  // 20%+ sudden change from previous observation
    absolute_threshold: null   // Set per dimension when the goal is defined
  },
  stall_escalation: {
    stage: 3                   // 3rd detection in stall-detection.md §4
  },
  goal_completion: {
    all_dimensions_above_threshold: true,
    confidence_minimum: 0.50   // All dimensions have confidence >= 0.50
  }
}
```

### 3.3 Event-Based Trigger (for Strategy Change Reports)

Triggered by PulSeed's internal decisions. Not by external input, but fired when a strategy change is determined in the strategy selection step of the core loop (`mechanism.md §2.3`).

```
strategy_change_trigger: {
  pivot: true,           // On strategy pivot
  new_hypothesis: true,  // When a new hypothesis is added
  strategy_retirement: true,  // When a strategy is retired
  resource_reallocation: true  // When resource allocation changes significantly
}
```

---

## 4. Integration with the Core Loop

Reporting decisions are integrated with each step of the core loop (`mechanism.md §2`) as follows.

```
Observation
  │
  ├─ [Immediate notification check] Does the observation result show a sudden change?
  │     → Yes: Generate urgent alert
  │
  ↓
Gap recognition
  │
  ├─ [Completion notification check] Have all dimensions exceeded their thresholds?
  │     → Yes: Generate goal completion notification
  │
  ↓
Strategy selection
  │
  ├─ [Strategy change notification check] Did a strategy pivot occur?
  │     → Yes: Generate strategy change report
  │
  ↓
Task materialization
  │
  ├─ [Approval request check] Does the generated task contain an irreversible action?
  │     → Yes: Generate approval request notification
  │
  ↓
(Loop continues)
  │
  ├─ [Periodic report check] Is this a scheduled reporting time?
  │     → Yes: Generate periodic report
```

Reporting decisions operate as **side effects** relative to the loop. They do not alter the main processing flow of the loop. Report generation is executed asynchronously after each loop step completes.

### Integration with Stall Detection

Stall detection (`stall-detection.md`) stages and reporting are integrated as follows:

| Stall Stage | Reporting Behavior |
|-------------|-------------------|
| 1st detection | No report (PulSeed handles autonomously) |
| 2nd detection | Include stall status in the next periodic report |
| 3rd detection | Generate immediate notification (escalation) |

The reason for not notifying the user at the 1st and 2nd detections is to prevent notifications from arriving every time there is a temporary stall (same design decision as stall-detection.md §6).

---

## 5. Delivery Channels

### 5.1 MVP (Phase 1): File Output + CLI Log

The MVP uses delivery methods with no infrastructure dependencies.

**Report files**:

```
~/.pulseed/
├── reports/
│   ├── daily/
│   │   ├── 2026-03-10.md
│   │   └── 2026-03-09.md
│   ├── weekly/
│   │   └── 2026-W11.md
│   └── notifications/
│       ├── 20260310-143022-alert-health.md
│       └── 20260310-091500-strategy-change.md
└── reports/archive/
    └── ...
```

- Reports are output in Markdown format. Human-readable and manageable with git
- File names are timestamp-based. Periodic reports use date/week number; immediate notifications use timestamp + type
- Archives are moved to `archive/` monthly

**CLI log**:

When running `pulseed run`, unread reports and unprocessed notifications are displayed in the console.

```
$ pulseed run

[Report] Daily Summary (2026-03-10)
  Goal "Revenue 2x": Progress 42% → 45% (+3%)
  Goal "Dog health": Progress 88% (stable)
  Details: ~/.pulseed/reports/daily/2026-03-10.md

[Notification] Strategy Change (2026-03-10 14:30)
  Goal "Revenue 2x": Pivoted from "UI improvements" → "Support enhancement"
  Details: ~/.pulseed/reports/notifications/20260310-143022-strategy-change.md
```

### 5.2 Phase 2: External Notification Channels

Phase 2 adds push notifications. Information reaches the user without them having to check in on PulSeed.

| Channel | Purpose | Configuration |
|---------|---------|---------------|
| Slack | All report and notification types | Webhook URL |
| Email | Periodic reports, urgent alerts | SMTP settings or email API |
| Webhook | External system integration | Custom URL |

**Channel configuration schema**:

```
delivery_channels: [
  {
    type: "file",          // MVP: always enabled
    path: "~/.pulseed/reports/"
  },
  {
    type: "slack",         // Phase 2
    webhook_url: "https://hooks.slack.com/...",
    report_types: ["daily_summary", "immediate_notification"],
    format: "compact"      // Compact format for Slack
  },
  {
    type: "email",         // Phase 2
    address: "user@example.com",
    report_types: ["weekly_report", "urgent_alert"],
    format: "full"
  }
]
```

The file output channel remains always enabled in Phase 2. Local files are always written in addition to external channels. Files are the only persistent record and also serve as a fallback when external channels fail.

---

## 6. Verbosity Control

Users can control the frequency and level of detail of reporting.

### 6.1 Verbosity Levels

Report verbosity is set at three levels.

| Level | Name | Content |
|-------|------|---------|
| 1 | `minimal` | Goal progress rate and change only. One-line summary |
| 2 | `standard` | Dimension-level progress, execution summary, next actions (default) |
| 3 | `detailed` | All information. Strategy evaluation, risk analysis, observation data details, learning log |

```
reporting_verbosity: {
  daily_summary: "standard",   // Standard for daily
  weekly_report: "detailed",   // Detailed for weekly
  notifications: "standard"    // Standard for notifications
}
```

### 6.2 Notification Frequency Control

A frequency control mechanism is in place to prevent notification fatigue.

**Cooldown**: Immediate notifications of the same type have a minimum interval between them.

```
notification_cooldown: {
  urgent_alert: "0m",           // No cooldown for urgent alerts
  approval_request: "0m",       // No cooldown for approval requests
  stall_escalation: "60m",      // 60-minute interval for stall escalations
  strategy_change: "30m",       // 30-minute interval for strategy changes
  goal_completion: "0m"         // No cooldown for completion notifications
}
```

**Batching**: Notifications of the same type that occur during a cooldown period are batched together and delivered all at once when the cooldown expires.

**Do Not Disturb**: Notifications are suppressed during time windows specified by the user. Urgent alerts and approval requests are exceptions.

```
do_not_disturb: {
  enabled: true,
  hours: ["22:00", "07:00"],   // Suppress notifications during this period
  exceptions: ["urgent_alert", "approval_request"]
}
```

### 6.3 Per-Goal Reporting Configuration

Reporting settings can be overridden on a per-goal basis.

```
goal_reporting_override: {
  goal_id: "goal_health_01",
  daily_summary: "detailed",      // Also detailed for daily on health goals
  notification_cooldown: {
    urgent_alert: "0m"            // Health alerts are immediate
  }
}
```

This allows the same system to appropriately handle high-frequency, high-urgency goals like health monitoring alongside low-frequency long-term project goals.

---

## 7. LLM Involvement

The division of responsibilities between LLM and code in report generation is made explicit.

### Handled by Code (Deterministic)

| Process | Content |
|---------|---------|
| Data aggregation | Current values, thresholds, and Gaps for each dimension; task success/failure counts; changes over the period |
| Trigger evaluation | Threshold breach determination, schedule determination, cooldown determination |
| Report structure assembly | Section selection, embedding data into templates |
| Delivery control | Channel selection, format conversion, file output |

### Handled by LLM (Interpretation and Generation)

| Process | Content |
|---------|---------|
| Narrative generation | Converting numeric data into human-readable prose |
| Strategy evaluation in prose | Explaining "why this strategy is / is not working" |
| Risk analysis | Reading patterns from observation data and articulating risks |
| Recommended action proposals | Proposing next actions for the user to take (if any) |
| Rationale for strategy changes | Explaining the reasoning behind a pivot in terms the user can understand |

### Separation Principle

**Numbers always come from code. Interpretation always comes from LLM.**

Do not have the LLM calculate numbers. When the LLM says "progress 45%," that number must be a value calculated by code. The LLM's role is to interpret "what 45% means" and "how fast +3% from the previous 42% is," and to explain it.

---

## 8. Report Formats

### 8.1 Daily Summary Format

```markdown
# Daily Summary — 2026-03-10

## Goal: Revenue 2x
- Overall progress: 42% → 45% (+3%) [Confidence: 0.78]
- Focus dimension: Churn rate improvement (Gap: 35%)
- Today's execution: 3 tasks completed, 1 failed
- Tomorrow's plan: Onboarding flow redesign (delegated to agent)

## Goal: Dog health
- Overall progress: 88% (no change) [Confidence: 0.92]
- Status: Stable. Next scheduled observation: 3/12.
- Notes: None

---
Generated: 2026-03-10T09:00:00+09:00
Next report: 2026-03-11T09:00:00+09:00
```

### 8.2 Immediate Notification Format

```markdown
# [Urgent Alert] Dog health — Abnormal respiration rate

Occurred: 2026-03-10 14:30:22 JST
Goal: Dog health
Dimension: Respiration rate
Observed value: 42 breaths/min (normal range: 15–30 breaths/min)
Confidence: 0.95 (direct sensor measurement)

## PulSeed's Assessment
Sharp rise from 28 breaths/min at the previous observation (12:00).
Based on past patterns, this level warrants consulting a veterinarian.

## Recommended Actions
1. Check on the dog directly
2. Contact a veterinarian if necessary
3. Re-measurement scheduled in 30 minutes

---
Notification ID: notif_x7y8z9
```

### 8.3 Strategy Change Report Format

```markdown
# [Strategy Change] Revenue 2x — Pivot

Occurred: 2026-03-10 14:30:22 JST
Goal: Revenue 2x

## Previous Strategy
"Onboarding UI improvements" (Period: 2026-02-20 – 2026-03-10)
Effect: Churn rate -2% (Target: -10%)

## Reason for Change
After 3 weeks, churn rate improvement has stalled at 20% of the target.
Determined that UI improvements alone are insufficient to achieve the goal.

## New Strategy
Switching to "Strengthen support channels."
Expected effect: Churn rate -5% to -8% (based on industry benchmarks)

## Impact on User
No additional resources required. Leverages existing support systems.

---
Notification ID: notif_a1b2c3
```

---

## 9. MVP vs Phase 2

### MVP (Phase 1)

| Item | MVP Specification |
|------|------------------|
| Report types | Daily summary, weekly report, immediate notifications (all types), strategy change reports |
| Delivery channels | File output (Markdown) + CLI log |
| Triggers | Time-based (evaluated when `pulseed run` is executed), threshold-based, event-based |
| Verbosity control | Verbosity levels (3 tiers), notification cooldown |
| LLM involvement | Narrative generation, strategy evaluation in prose |
| Report storage | Saved as Markdown files in `~/.pulseed/reports/` |
| Unread management | File-based (unread reports displayed when `pulseed run` is executed) |

MVP constraint: Report delivery is pull-only (only when `pulseed run` is executed). There are no real-time push notifications. Even urgent alerts are displayed the next time `pulseed run` is executed. This is a constraint of the MVP process model (CLI-based), not of the reporting design itself.

### Phase 2

| Item | Phase 2 Additions |
|------|------------------|
| Delivery channels | Slack, email, Webhook (push-based) |
| Real-time notifications | Immediate delivery via daemon mode |
| Do Not Disturb | Time-based notification suppression |
| Channel-specific formats | Compact format for Slack, HTML format for email |
| Interactive notifications | Approval responses via Slack buttons |
| Custom report templates | User-defined report templates |
| Per-goal reporting settings | Override frequency and verbosity per goal |

Phase 2 priorities: Slack integration > Email > Webhook > Custom templates. Starting with the channel that most users interact with daily.

---

## 10. Design Decisions and Boundaries

**Too many vs. too few reports**: Too many reports and users start ignoring them. Too few and users lose sight of what PulSeed is doing. The default configuration uses a conservative setup — "daily summary + immediate notifications for urgent events" — with users able to increase or decrease as needed.

**Managing LLM costs**: Using LLM for every report would make costs non-negligible. The `minimal` level of the daily summary can be generated using only template embedding (no LLM required); LLM is used for `standard` and above. The weekly report always uses LLM (acceptable cost due to low frequency).

**Report persistence**: Reports are also part of PulSeed's activity log. "When and what was reported" is the foundation of PulSeed's transparency and auditability. Therefore, report files are archived rather than deleted.

**Relationship between periodic reports and observation cycles**: Periodic report generation is independent of the observation cycle (`observation.md §3`). Reports are generated using the latest observation results, but no additional observations are performed specifically for report generation. A report is a snapshot of "what is currently known," not "what was newly investigated."

**Are approval requests reporting**: Approval requests (trust-and-safety.md §4) are positioned as a type of immediate notification. The format is as defined in `trust-and-safety.md`, and only the delivery channel follows this design.
