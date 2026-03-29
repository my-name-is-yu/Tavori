# Observation System Design

> `runtime.md` defines that "result verification is performed across 3 layers." This document provides a concrete design for that 3-layer observation system. The observation system is PulSeed's only window into the current state of the world.

---

## 1. Role of the Observation System

The observation system is responsible for reading the state of the real world and updating `current_value` and `confidence` in the state vector.

It answers a single question: **"What is the current state of this dimension, and how much can we trust that assessment?"**

Observation is an independent activity — it is not part of task execution. By designing observation as a separate cycle from execution, we ensure that the fact of "having executed" does not contaminate the judgment of "having achieved."

---

## 2. Three-Layer Observation Architecture

Observation is composed of three layers. Each layer has a different level of trust and a different role. Results from a higher layer are not overridden by a lower layer.

```
Layer 1: Mechanical observation (highest trust)
  ↓ supplements dimensions lacking evidence
Layer 2: Independent review session (medium trust)
  ↓ supplements qualitative signals
Layer 3: Executor self-report (low trust)
  ↓ recorded only as supplementary information
```

### Layer 1: Mechanical Observation

**Trust level: High (0.85–1.0)**

Observations executed automatically by code or the system. These produce evidence that leaves no room for interpretation and cannot be tampered with.

Types of observations in scope:

| Observation type | Examples |
|-----------------|---------|
| Test execution | Results of automated test suite runs (pass/fail/count) |
| File existence check | Whether required files or directories exist |
| Build success/failure | Whether a build command returned a success exit code |
| Sensor data retrieval | Measurements from IoT sensors or wearable devices |
| API metrics query | Retrieving metric values from external services via API |
| Database query | Result set from SQL queries against a DB |
| System metrics | CPU usage, memory usage, response time |

Mechanical observations run automatically. No human intervention or judgment is required. The observation method (which command to run, which API to call) is defined by the Advisor at goal-setting time, and PulSeed executes it autonomously on each observation cycle.

**Layer 1 constraint**: Dimensions for which mechanical observation cannot be configured fall back to Layer 2 or Layer 3. It is not always possible to configure mechanical observation for every dimension (e.g., qualitative quality assessments, human emotions).

### Layer 2: Independent Review Session

**Trust level: Medium (0.50–0.84)**

A **different LLM session** from the executor evaluates artifacts without holding the executor's context. Independence is the source of trust here.

There are two types of independent review sessions.

**Task Reviewer Session**

Question: "Was this task completed correctly?"

Information provided:
- Task definition and success criteria
- Access to artifacts

Information withheld:
- Execution session context
- Executor's self-report

Judgment basis: Whether success criteria are met, and if not, what is missing. This is an observation focused specifically on task completion.

**Goal Reviewer Session**

Question: "From the goal's perspective, what is missing from the current state?"

Information provided:
- Goal definition and thresholds for all dimensions
- Current values per dimension (results from mechanical observation)
- Goal constraints

Information withheld:
- Details of execution sessions
- Context from past failures (to avoid bias)

Judgment basis: From the perspective of goal achievement, discover gaps, contradictions, or risks that mechanical observation cannot surface. This is a goal-level evaluation, not a task-level one.

Independent review sessions run automatically, but their timing depends on task completion or the periodic observation cycle. They are not running constantly — only triggered at the right moments.

### Layer 3: Executor Self-Report

**Trust level: Low (0.10–0.49)**

The agent or human who executed the task reports "what was done, what succeeded, and what failed."

Purposes:
- Supplements **execution context information** that mechanical observation cannot detect (e.g., "tried approach A but got an error, so substituted B")
- Used as a **hint** for the next task generation
- Used as an **auxiliary signal** to detect contradictions with Layer 1 and 2

Not used for:
- As the primary basis for calculating achievement level
- As the primary basis for completion determination

The content of self-reports is not directly reflected in `current_value` in the state vector. It is recorded in the observation log and feeds into PulSeed's decision-making alongside Layer 1 and 2 results, but always has the lowest priority.

---

## 3. Observation Timing

Observation occurs at three points in time.

### Post-task Observation

Runs immediately after a task execution session ends.

Purpose: Confirm whether task execution changed the state. On success, the gap should have narrowed. On failure, it should be unchanged (or worsened).

Observation scope: Only dimensions the task affected. Unrelated dimensions are not observed (to save cost and reduce observation noise).

### Periodic Observation

Runs independently of task execution at intervals appropriate to the goal's nature.

Purpose: Detect external changes that happen outside of task execution — market shifts, external service state changes, natural variation over time.

Interval determination: Specified by the Advisor at goal-setting time. The goal's nature determines the interval.

| Goal nature | Suggested periodic observation interval |
|------------|----------------------------------------|
| Requires real-time awareness (alert-type) | 1 minute to 1 hour |
| Varies daily (health, business KPIs) | 1 day |
| Varies weekly (project progress) | 1 week |
| Varies monthly (long-term business strategy) | 1 month |

Periodic observation covers all dimensions — a comprehensive snapshot of the goal's current position.

### Event-Driven Observation

Runs immediately in response to an external trigger.

Triggers include:
- A sensor value crosses a configured threshold (above or below)
- An alert notification received from an external service
- The user manually requests an observation
- A dependency where another goal's state change affects this goal

Event-driven observation does not wait for the periodic observation schedule. It observes the moment a change occurs.

Event-driven observation is triggered via the event reception mechanism in `drive-system.md` §3 (MVP: file queue at `~/.pulseed/events/`).

---

## 4. Progress Ceiling Rule

> **Data quality gate**: The progress ceiling rule is an input filter that constrains the **maximum progress value that can be recorded** in the state vector. It is not a scoring adjustment. Confidence-based scoring adjustments are handled centrally in `gap-calculation.md`. The observation layer manages only the recordable progress ceiling.

The amount of evidence gathered from observation constrains the upper bound of achievement in the state vector.

**"Having done a lot" does not mean "the goal has been achieved."**

| Evidence state | Achievement ceiling |
|---------------|-------------------|
| No evidence (self-report only) | 70% |
| Partial evidence (mechanical observation for some dimensions) | 90% |
| Full evidence (mechanical observation for all dimensions) | 100% |

### Application logic

```
// For each dimension
evidence_level = the highest-trust observation method applied to the dimension

if evidence_level == "mechanical":
    progress_ceiling = 1.0  // no ceiling
elif evidence_level == "independent_review":
    progress_ceiling = 0.90
else:  // self_report only
    progress_ceiling = 0.70

// Effective achievement
effective_progress = min(calculated_progress, progress_ceiling)
```

### Why 70% ceiling

The risk of judging "achieved" based on self-report alone is high. The 70% ceiling acts as a continuous signal of "probably heading in the right direction, but confirmation is needed."

The 70% value is not fixed — the Advisor can adjust it at goal-setting time. However, the default is 70%.

### Evidence gate and verification task generation

For dimensions where achievement has reached the threshold based only on low-confidence observation, PulSeed automatically generates a **verification task**.

```
if effective_progress >= threshold AND confidence < 0.85:
    → Automatically generate and queue a task:
      "Verify this dimension by mechanical means"
```

This ensures that a state of "self-reported as complete but no evidence" is resolved internally, rather than escaping from the loop.

---

## 5. Observation Method Schema (`observation_method`)

The `observation_method` field for each dimension is defined using the structured schema below. This is not a free-form string — it is a machine-processable definition.

```
observation_method: {
  type: "mechanical" | "llm_review" | "api_query" | "file_check" | "manual",
  source: string,           // identifier for the observation source (e.g., "fitbit_api", "git_log", "user_input")
  schedule: string | null,  // cron expression (for periodic observation). null for event-driven
  endpoint: string | null,  // URL or file path (for automated observation). null for manual
  confidence_tier: "mechanical" | "independent_review" | "self_report"
}
```

Field descriptions:

| Field | Type | Description |
|-------|------|-------------|
| `type` | enum | How the observation is executed. `mechanical` (automated script), `llm_review` (independent LLM session), `api_query` (HTTP request to external API), `file_check` (filesystem check), `manual` (human input) |
| `source` | string | Identifier for the observation source. Used for logging, debugging, and fallback resolution |
| `schedule` | string or null | Cron expression (e.g., `"0 23 * * *"` = daily at 23:00). `null` for event-driven or manual |
| `endpoint` | string or null | API URL or local file path. `null` for `manual` or `llm_review` |
| `confidence_tier` | enum | The trust layer this method belongs to. Used by the progress ceiling rule |

### `observation_method` examples

**Example 1: Step count from wearable API (api_query)**

```json
{
  "type": "api_query",
  "source": "fitbit_api",
  "schedule": "0 23 * * *",
  "endpoint": "https://api.fitbit.com/1/user/-/activities/date/today.json",
  "confidence_tier": "mechanical"
}
```

**Example 2: Git repository commit history check (file_check)**

```json
{
  "type": "file_check",
  "source": "git_log",
  "schedule": null,
  "endpoint": "/Users/user/projects/myapp/.git/COMMIT_EDITMSG",
  "confidence_tier": "mechanical"
}
```

**Example 3: Code quality evaluation by independent LLM session (llm_review)**

```json
{
  "type": "llm_review",
  "source": "goal_reviewer_session",
  "schedule": "0 9 * * 1",
  "endpoint": null,
  "confidence_tier": "independent_review"
}
```

**Example 4: User's subjective wellness input (manual)**

```json
{
  "type": "manual",
  "source": "user_input",
  "schedule": "30 8 * * *",
  "endpoint": null,
  "confidence_tier": "self_report"
}
```

---

## 6. Observation Method Selection

The observation method for each dimension is defined by the Advisor at goal-setting time. Observation methods are not static — they can be added dynamically as capabilities become available.

### Selection principles

**Use the highest-trust method available**: Use mechanical observation for dimensions that support it. Use independent review for dimensions where mechanical observation cannot be configured. Self-report is a last resort.

**Balance observation cost and frequency**: Mechanical observation is low-cost and can run at high frequency. Independent review sessions carry the startup cost of an LLM session and should be used infrequently.

### Combining multiple methods

Multiple observation methods can be configured for a single dimension. In that case:

- **Primary method**: The method used on a regular basis. The highest-trust one is chosen.
- **Secondary method**: Used when the primary method fails or additional confirmation is needed.

```
Dimension: code quality
  Primary method: automated test suite (mechanical) → confidence 0.92
  Secondary method: independent code review session (independent review) → confidence 0.70
```

### When observation method is unavailable

If the primary method fails (API error, sensor disconnected, etc.):
1. Fall back to the secondary method
2. If no secondary method exists, significantly lower `confidence`
3. Log the unobservable state and notify PulSeed

---

## 7. Contradiction Resolution

When observations from different layers conflict, they are resolved using the following rules.

### Basic rule: Higher-trust layer takes precedence

```
Mechanical observation > Independent review session > Executor self-report
```

If mechanical observation says "all tests passed (achieved)" and independent review says "quality is insufficient (not achieved)," treat it as a contradiction and **adopt the mechanical observation result (achieved)**. However, the independent review's judgment is recorded as input to the goal review session and used to generate new tasks (e.g., improve test coverage).

### Contradictions within mechanical observation

If multiple mechanical observation methods conflict (e.g., unit tests pass, E2E tests fail):
- **Record both**
- Use the more pessimistic result for achievement (minimum principle)
- Notify PulSeed of the contradiction and generate a resolution task

### Contradiction between self-report and mechanical observation

If the executor reports "completed" but mechanical observation shows "not achieved":
- Adopt the mechanical observation
- Record the self-report content in the execution log, but do not use it to update the state vector
- If contradictions recur repeatedly, PulSeed considers escalation

---

## 8. Observation Log Structure

All observations are recorded as logs in a persistent file. The format is human-readable and can be managed with git.

Each observation log entry has the following fields:

| Field | Description |
|-------|-------------|
| `observation_id` | UUID uniquely identifying this entry (e.g., `"obs_a1b2c3d4"`). Acts as the join key referenced by each entry in `Dimension.history` |
| `timestamp` | Date and time the observation ran (ISO 8601) |
| `trigger` | What triggered the observation (post_task / periodic / event_driven) |
| `goal_id` | Identifier of the target goal or sub-goal |
| `dimension_name` | The dimension that was observed |
| `layer` | Observation layer (mechanical / independent_review / self_report) |
| `method` | Details of the observation method used (see `observation_method` schema §5) |
| `raw_result` | Raw result of the observation |
| `extracted_value` | The value extracted as `current_value` |
| `confidence` | Confidence assigned to this observation |
| `notes` | Notes from the observation process (errors, fallbacks, etc.) |

### Joining ObservationLog and Dimension.history

ObservationLog and `Dimension.history` are separate entities, joined by an explicit key.

- **Join key**: `goal_id + dimension_name + timestamp` (unique as a tuple)
- **ObservationLog's role**: Records the raw observation event (who observed, by what method, what was observed, what the raw data was)
- **Dimension.history's role**: Records state changes derived from observations (before/after values, change in gap)
- **Reference direction**: Each entry in `Dimension.history` references the corresponding ObservationLog entry via a `source_observation_id` field

```
ObservationLog entry                     Dimension.history entry
─────────────────────────────            ──────────────────────────────────
observation_id: "obs_a1b2c3d4"  ←────── source_observation_id: "obs_a1b2c3d4"
goal_id: "goal_health_01"                value_before: 7100
dimension_name: "daily_steps"            value_after: 6200
timestamp: "2026-03-10T23:00:00Z"        confidence: 0.95
raw_result: { steps: 6200 }              timestamp: "2026-03-10T23:00:00Z"
extracted_value: 6200
confidence: 0.95
```

The observation log is a detailed record of "what was observed by what method." The `history` is a summary of "how the value changed." Without `source_observation_id`, it is impossible to trace the evidentiary basis of a `history` entry.

---

## 9. Design Decisions and Rationale

**Why separate execution from observation**

If the executor evaluates the results of their own execution, optimistic bias is unavoidable. By designing observation as a separate cycle from execution, we ensure that the fact of "having executed" does not contaminate the "observation result." This separation is the observation-system-level implementation of the `runtime.md` principle "execution and verification are structurally separated."

**Why mechanical observation is not overridden by LLM judgment**

Mechanical observation deals in facts: "the test passed or didn't," "the file exists or doesn't." LLMs handle the ambiguity of natural language, but mechanical methods are more accurate for determining facts. Allowing LLM judgment to overwrite mechanical facts means invalidating high-trust evidence with low-trust judgment. That is not acceptable.

**Why the progress ceiling rule is necessary**

The feeling of "having completed a lot of tasks" can lead both LLMs and humans to falsely believe "it's been achieved." The progress ceiling rule is a structural mechanism to prevent this false belief. It expresses as a number the constraint that achievement cannot be declared without evidence.
