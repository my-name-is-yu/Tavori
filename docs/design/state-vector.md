# State Vector Design

> `mechanism.md` defines "what is observed and how gaps are recognized." This document defines the concrete design of the **state vector** — the data structure that stores observation results and goal state.

---

## 1. What Is a State Vector?

A state vector is a data structure that represents "where we currently are with respect to a given goal" across multiple dimensions.

Rather than representing progress as a single number, it holds the current value, target threshold, confidence, and observation metadata for each dimension (aspect) that makes up a goal. Each node in the goal tree (goal or subgoal) has its own state vector, and the state vector of a parent node is aggregated from its child nodes.

---

## 2. Dimension Definition

A state vector consists of one or more **dimensions**. Each dimension has the following fields.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Identifying name for the dimension (e.g., `daily_steps`, `conversion_rate`) |
| `label` | string | Human-readable display name (e.g., `Daily Steps`, `Conversion Rate`) |
| `current_value` | numeric or categorical value | The most recent observed value |
| `threshold` | threshold definition (see below) | The condition for judging "sufficient" |
| `confidence` | 0.0–1.0 | Confidence in the current value (determined by observation method; see below) |
| `observation_method` | observation method definition (see `observation.md` §5) | How this dimension is observed. Defined as a structured schema with type / source / schedule / endpoint / confidence_tier |
| `last_updated` | ISO 8601 timestamp | The datetime the value was last updated |
| `history` | list of historical values | Past values kept for stall detection and trend analysis. Each entry references the corresponding ObservationLog entry via `source_observation_id` (see `observation.md` §8 for details) |

### Threshold Definition

A threshold is not necessarily a single number. The shape of a threshold differs depending on the semantics of the dimension.

| Threshold form | Meaning | Example |
|----------------|---------|---------|
| `min(N)` | Achieved when ≥ N | Daily steps ≥ 8000 |
| `max(N)` | Achieved when ≤ N | Error rate ≤ 0.01 |
| `range(low, high)` | Achieved when within the range | Body temperature 36.0–37.0°C |
| `present` | Achieved when the target exists | Presence of a configuration file |
| `match(value)` | Achieved when matching a specific value | Status = "approved" |

Thresholds are defined by the Advisor at goal setup and represent the satisficing conditions agreed upon for the goal.

---

## 3. Confidence Model

**Confidence is not self-reported. The observation method determines confidence.**

This is a fundamental design decision. A structure in which "how well you are doing is evaluated by yourself" cannot avoid optimism bias. Confidence is determined mechanically by the method used to observe the dimension.

### Observation Methods and Corresponding Confidence

| Observation method | Confidence level | Numeric range | Description |
|-------------------|-----------------|---------------|-------------|
| **Mechanical observation** | High | 0.85–1.0 | Test results, file existence checks, build success/failure, sensor readings, API metrics, DB query results. Evidence that cannot be falsified or misinterpreted. |
| **Independent review session** | Medium | 0.50–0.84 | An LLM session separate from the executor evaluates deliverables without the executor's context. Either a task review (confirming success criteria) or a goal review (identifying gaps from the goal perspective). |
| **Executor's self-report** | Low | 0.10–0.49 | The executor reports "what was done, what was achieved, and what wasn't." Treated as supplementary information only, with low confidence. |

### Confidence Synthesis

When multiple observation methods are used for a single dimension, **the value from the observation method with the highest confidence is adopted**. A lower-confidence observation never overrides a higher-confidence one.

However, when there is a contradiction between observation methods (e.g., mechanical observation says "success," independent review says "insufficient"), **the higher-confidence observation takes precedence**. Mechanical observation is not overridden by LLM judgment.

---

## 4. State Vectors in the Goal Tree

Each goal and subgoal node has its own state vector. The state vector of a parent node is aggregated from the state vectors of its child nodes.

```
Goal (parent)
  State vector ← aggregated from child nodes
    ├── Subgoal A
    │     State vector ← directly observed on its own dimensions
    │       Dimension A-1: current=85, threshold=min(80), confidence=0.95
    │       Dimension A-2: current=0.02, threshold=max(0.05), confidence=0.70
    └── Subgoal B
          State vector ← directly observed on its own dimensions
            Dimension B-1: current=6, threshold=min(8), confidence=0.90
```

### Aggregation Rules

The parent node's state vector is built by aggregating the states of child nodes. The aggregation method differs based on the semantics of the dimensions.

| Aggregation method | Use case | Calculation |
|-------------------|----------|-------------|
| **Minimum aggregation** | Parent cannot be achieved unless all children are achieved (AND condition) | Achievement = min(child node achievements) |
| **Weighted average aggregation** | Parent achievement is weighted by each child's importance | Achievement = Σ(child achievement × weight) / Σweights |
| **Any aggregation** | Parent is achieved if any single child is achieved (OR condition) | Achievement = max(child node achievements) |

Which aggregation method to use is specified by the Advisor when defining subgoals. If unspecified, the default is **minimum aggregation** (the most conservative judgment).

The parent node's confidence is the weighted average of child node confidences. However, if any child node has low confidence, the parent node's confidence is affected accordingly.

---

## 5. State Vector Lifecycle

### Creation

A state vector is created when the Advisor defines a goal or subgoal. At this point, `current_value` is unset (`null`) and `confidence` is 0.0.

What the Advisor defines at creation time:
- The list of dimensions (name, label)
- The threshold for each dimension
- The observation method for each dimension

### Initial Observation

Immediately after the goal or subgoal is defined, the first observation cycle runs and each dimension's `current_value` and `confidence` are set for the first time. At this point the initial gap is established and the first task discovery loop runs.

### Updates

State vector values are updated at the following times:

- **After task completion**: Execution session completes → observation cycle → value updated
- **Scheduled observation**: Re-observation on a heartbeat appropriate to the goal's nature → value updated
- **Event-driven**: External trigger (sensor threshold exceeded, external notification) → immediate re-observation → value updated

Each update appends the old value to `history`. `current_value` is managed as a rotation rather than an overwrite.

### History Retention

`history` exists for stall detection. It retains past N observation values along with corresponding timestamps and confidence levels. Each entry references the corresponding ObservationLog entry via `source_observation_id` (UUID), enabling traceability of "which observation produced this state change." The join key is `goal_id + dimension_name + timestamp` (see `observation.md` §8 for details).

Stall detection refers to this history. Judgment criteria:
- `current_value` has not changed in the threshold direction across the last N observations
- Confidence has remained consistently low (the dimension remains unverified)
- The rate of change has continuously been less than X% of the target rate of change

The depth of history to retain depends on the nature of the goal. For short-term goals, the last 10–20 observations; for long-term goals, the last 50–100 observations is a guideline.

### Retirement

When a subgoal is judged complete or cancelled, the state vector for that node is archived. Rather than deleted, it is preserved and kept available for future learning as an experience log.

---

## 6. Achievement Calculation

> **Note**: The definition of the gap calculation formula (`raw_gap`) and division guard conditions are authoritatively defined in `gap-calculation.md`. This section describes how achievement is expressed; the details of gap calculation are delegated to `gap-calculation.md`.

The achievement of an individual dimension is a value from 0.0 to 1.0, derived from the normalized gap.

### Basic Relationship

```
// Numeric types (min/max/range): conversion from normalized raw_gap
achievement = 1.0 - normalized_gap

// Binary types (present/match): conversion from raw_gap itself
achievement = 1.0 - raw_gap   // raw_gap is either 0 or 1
```

`normalized_gap` is the gap normalized to the range 0.0–1.0 (see the normalization step in `gap-calculation.md`). When raw_gap = 0, achievement = 1.0; at maximum gap, achievement = 0.0.

### Null Values (Before First Observation)

When `current_value = null`, achievement = 0.0 (consistent with the guard condition in `gap-calculation.md`).

### Achievement Characteristics Per Threshold Type

| Threshold type | How achievement changes | Condition for achievement = 1.0 |
|----------------|------------------------|--------------------------------|
| `min(N)` | Rises as current increases | current ≥ N |
| `max(N)` | Rises as current decreases | current ≤ N |
| `range(low, high)` | Rises as current approaches the range; 1.0 within the range | low ≤ current ≤ high |
| `present` | Not present: 0.0, present: 1.0 | Target exists |
| `match(value)` | Mismatch: 0.0, match: 1.0 | current = value |

### Adjustment by Confidence

The achievement of a low-confidence dimension is not used as-is. A correction is applied using confidence.

```
effective_achievement = achievement × confidence + (1 - confidence) × conservative_estimate
conservative_estimate = 0.0  // unverified is treated as "not achieved"
```

This means that even if a low-confidence dimension appears to have high achievement, its effective achievement is calculated as low. This is the numerical expression of the design philosophy: "don't treat the unknown as fine."

> **Note**: Effective achievement is a reference value for humans to understand the state of a dimension; it is not fed into the drive scoring pipeline. Confidence is reflected in scoring exclusively at `gap-calculation.md` §3 — that is the only point of application. The input to drive scoring is `normalized_weighted_gap` as defined in `gap-calculation.md`. The two are complementary perspectives, with the relationship achievement ≈ 1 - normalized_gap.

---

## 7. State Vector Examples

### Example 1: Health Monitoring Goal

Goal: "Maintain everyday health"

```
State vector:
  Dimension[0]:
    name: daily_steps
    label: Daily Steps
    current_value: 6200
    threshold: min(8000)
    confidence: 0.95  ← mechanical observation via wearable sensor
    observation_method: { type: "api_query", source: "fitbit_api", schedule: "0 23 * * *", endpoint: "https://api.fitbit.com/1/user/-/activities/date/today.json", confidence_tier: "mechanical" }
    last_updated: 2026-03-10T23:00:00Z
    history:
      - value: 7100, timestamp: 2026-03-09T23:00:00Z, confidence: 0.95, source_observation_id: "obs_b2c3d4e5"
      - value: 5800, timestamp: 2026-03-08T23:00:00Z, confidence: 0.95, source_observation_id: "obs_c3d4e5f6"
      ...

  Dimension[1]:
    name: sleep_hours
    label: Sleep Hours
    current_value: 6.5
    threshold: range(7.0, 9.0)
    confidence: 0.90  ← mechanical observation via sleep tracker
    observation_method: { type: "api_query", source: "sleep_tracker_api", schedule: "0 7 * * *", endpoint: "https://api.sleeptracker.example/v1/sleep/today", confidence_tier: "mechanical" }
    last_updated: 2026-03-10T07:00:00Z
    history: [...]

  Dimension[2]:
    name: subjective_condition
    label: Subjective Wellbeing
    current_value: "Good"
    threshold: match("Good") or match("Very Good")
    confidence: 0.20  ← user self-report
    observation_method: { type: "manual", source: "user_input", schedule: "30 8 * * *", endpoint: null, confidence_tier: "self_report" }
    last_updated: 2026-03-10T08:30:00Z
    history: [...]
```

In this example, step count and sleep hours are mechanically observed with high confidence; subjective wellbeing is self-reported with low confidence. In gap recognition, the step count gap (6,200 steps against a target of 8,000) surfaces as the gap that should be prioritized.

### Example 2: Business Metrics Goal

Goal: "Get the new service's monthly revenue on track"

```
State vector:
  Dimension[0]:
    name: monthly_revenue
    label: Monthly Revenue
    current_value: 420000
    threshold: min(1000000)
    confidence: 0.98  ← mechanical observation via accounting system DB query
    observation_method: { type: "mechanical", source: "accounting_db", schedule: "0 0 * * *", endpoint: "db://accounting/monthly_revenue", confidence_tier: "mechanical" }
    last_updated: 2026-03-10T00:00:00Z
    history: [...]

  Dimension[1]:
    name: active_customers
    label: Active Customers
    current_value: 34
    threshold: min(100)
    confidence: 0.95  ← mechanical observation via CRM system API
    observation_method: { type: "api_query", source: "crm_api", schedule: "0 0 * * *", endpoint: "https://crm.example/api/customers/active", confidence_tier: "mechanical" }
    last_updated: 2026-03-10T00:00:00Z
    history: [...]

  Dimension[2]:
    name: churn_rate
    label: Churn Rate
    current_value: 0.08
    threshold: max(0.05)
    confidence: 0.95  ← mechanical observation via CRM system API
    observation_method: { type: "api_query", source: "crm_api", schedule: "0 0 * * 1", endpoint: "https://crm.example/api/metrics/churn", confidence_tier: "mechanical" }
    last_updated: 2026-03-10T00:00:00Z
    history: [...]

  Dimension[3]:
    name: product_quality_signal
    label: Product Quality Signal
    current_value: "Room for improvement"
    threshold: match("No issues")
    confidence: 0.65  ← evaluation by independent review session
    observation_method: { type: "llm_review", source: "goal_reviewer_session", schedule: "0 9 1,15 * *", endpoint: null, confidence_tier: "independent_review" }
    last_updated: 2026-03-03T00:00:00Z
    history: [...]
```

In this example, revenue, customer count, and churn rate are mechanically observed with high confidence. Product quality signal is evaluated by an independent review session with medium confidence. Because the churn rate exceeds the threshold (5%), this gap becomes high priority in the next task discovery cycle.

---

## 8. Milestone Data Model

> Milestones presented as counter-proposals during goal negotiation (see `mechanism.md` §3) are formally positioned as intermediate nodes in the goal tree. A milestone is an "intermediate waypoint with a deadline" and is tracked and evaluated as a structural part of the goal tree.

### Milestones in the Goal Tree

Milestones are represented as intermediate nodes in the goal tree. They sit between the top-level goal and leaf-level subgoals, marking achievement checkpoints along the time axis.

```
Top-level goal (e.g., 2x Revenue)
  ├── Milestone M1 (3 months: 1.3x revenue)  ← intermediate node
  │     ├── Subgoal: Increase revenue per existing customer
  │     └── Subgoal: Develop new channels
  ├── Milestone M2 (6 months: 1.7x revenue)  ← intermediate node
  │     ├── Subgoal: Cross-sell initiatives
  │     └── Subgoal: Improve churn rate
  └── Final goal achieved (12 months: 2.0x revenue)
```

Milestones have the same data structure as regular subgoals, plus the following additional fields.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"milestone"` | Identifies the node type as a milestone |
| `target_date` | ISO 8601 timestamp | The milestone deadline |
| `origin` | `"negotiation"` \| `"decomposition"` \| `"manual"` | Source of creation (negotiation proposal / goal decomposition / user-defined) |
| `pace_snapshot` | pace evaluation record | Result of the pace evaluation when the deadline is reached (see below) |

Milestones have their own state vector and aggregate child node states according to the aggregation rules in §4. The default aggregation method is minimum aggregation, same as for regular subgoals.

### Automatic Tracking Mechanism

When a milestone's deadline is reached, PulSeed automatically runs the following evaluation.

```
on_milestone_target_date(milestone):
    1. Force observation: Immediately observe all dimensions under the milestone
    2. Achievement calculation: Compute the aggregated achievement
    3. Pace evaluation: Calculate the deviation between planned and actual (see below)
    4. Record: Save results to pace_snapshot
    5. Decision branch:
       - Achievement >= satisficing threshold → Mark milestone complete, transition to next milestone
       - Achievement < satisficing threshold → Trigger rescheduling decision (see below)
```

Even before the deadline, milestone progress is observed and tracked in regular loops the same way as for ordinary subgoals. What happens at the deadline is a forced observation of all dimensions and a formal achievement determination.

### Pace Evaluation and Rescheduling

The distinctive feature of milestones is the evaluation of pace along the time axis. This is a mechanism for evaluating the health of progress, independent from the deadline-driven score calculation in `drive-scoring.md` §2.

```
pace_evaluation(milestone):
    if total_time == 0:
        pace_ratio = 1.0  // treat as "on track" if duration is undefined
        status = "on_track"
        return
    elapsed_ratio = elapsed_time / total_time  // fraction of time elapsed
    achievement_ratio = current_achievement / target_achievement  // fraction of achievement
    pace_ratio = achievement_ratio / elapsed_ratio

    if pace_ratio >= 1.0:  // on track or ahead of schedule
        status = "on_track"
    elif pace_ratio >= 0.7:  // slightly behind but recoverable
        status = "at_risk"
    else:  // significantly behind
        status = "behind"
```

| Pace status | Response |
|------------|---------|
| `on_track` | Continue with the current strategy |
| `at_risk` | The deadline-driven score in drive scoring naturally rises, so no additional intervention. Report the situation to the user |
| `behind` | Trigger a rescheduling decision. Three options: (1) extend the milestone deadline, (2) revise the milestone target value downward, (3) trigger goal re-negotiation (see `goal-negotiation.md` §6) |

Rescheduling decisions are proposed to the user and require approval, rather than being made autonomously by PulSeed. Milestones were agreed upon in goal negotiation, and unilateral changes would damage trust.

---

## 9. Design Decisions and Rationale

**Why not self-reported confidence?**

When executors evaluate their own work, optimism bias arises structurally — the same is true for humans and LLMs alike. By mechanically determining confidence from the observation method, this bias is eliminated at the design level.

**Why does 100% achievement require evidence?**

"Did a lot of tasks" and "achieved the goal" are different things. To prevent conflating volume of activity with progress, high achievement is supported only by high-confidence evidence.

**Why retain history?**

The current value alone does not tell you whether things are improving, worsening, or stagnant. Stall detection is a judgment about trends, and judging trends requires time-series data. History is the infrastructure for stall detection.

**Why is the default aggregation minimum aggregation?**

Achieving a parent goal normally requires achieving all of its constituent elements (AND condition). Using a weighted average allows a weak dimension to be hidden by strong ones. Starting from the most conservative judgment prevents the error of "treating something as complete when a part of it is missing."
