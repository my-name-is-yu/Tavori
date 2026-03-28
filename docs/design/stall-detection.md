# Stall Detection Design

---

## 1. Why Stall Detection Is Necessary

PulSeed's loop never stops. It keeps running until a goal is achieved or the user intervenes. This "never stopping" quality is normally a strength. Even if one loop iteration is imperfect, the next corrects it.

However, for certain types of problems, this same quality becomes a flaw.

- Hitting the same wall over and over with the same approach
- Pouring all resources into an unsolvable problem
- Spinning the loop uselessly when what is needed is to wait for an external change

Stall detection is a **circuit breaker**. It detects when the loop is spinning meaninglessly and triggers an intervention. Without stall detection, PulSeed would keep making the same moves forever in front of an unsolvable problem.

---

## 2. Detection Metrics

There are four types of stalls. Each is detected independently.

### 2.1 Dimension-Level Stall

The gap on a specific dimension has not narrowed over N consecutive loop iterations.

```
Dimension: Revenue
Loop 1: Gap = 80
Loop 2: Gap = 79
Loop 3: Gap = 80
Loop 4: Gap = 81
Loop 5: Gap = 79
→ No meaningful change in gap
```

**Design note**: N is configurable per dimension. Some dimensions (e.g., organizational structure, market position) naturally move slowly. Applying the same N as a fast-moving dimension would cause false positives.

| Dimension type | Recommended N (consecutive loops) |
|----------------|----------------------------------|
| Immediately reflected (test results, API responses) | 3 |
| Medium-term (revenue, customer satisfaction) | 5 |
| Long-term (organization, market) | 10 |

Whether a gap has "narrowed" is judged by percentage, not absolute value. A small decrease in a large gap is not considered a stall.

### 2.2 Time Overrun

The actual time taken for a task or goal has exceeded twice its estimated duration.

```
Task: "Improve Onboarding Flow"
Estimate: 3 days
Actual: 6 days elapsed → Detected as 2x overrun
```

A time overrun signals "this approach may not be working." The estimate itself may have been wrong, but that too is treated as a signal that "the situation needs to be re-evaluated."

The baseline threshold for time overrun is 2x, but this is adjusted based on the goal's domain and past performance. Exploratory tasks (research tasks) are given more leeway; routine tasks (known fixes) are held to a stricter standard.

**Fallback when `estimated_duration` is `null`** (see `task-lifecycle.md` §2.7): Tasks without an estimate use absolute time thresholds based on their domain.

| Task domain | Default threshold |
|------------|------------------|
| Coding / implementation | 2 hours |
| Research / investigation | 4 hours |
| Other / unknown | 3 hours |

These values can be overridden at goal definition time. Giving `null` tasks a default of "no time overrun" is prohibited (to prevent infinite waiting).

### 2.3 Consecutive Failures

The same type of task has failed consecutive Task Reviewer verifications.

```
Task type: "Performance Improvement"
Attempt 1: Executed → Verification failed (improvement not achieved)
Attempt 2: Executed → Verification failed (improvement not achieved)
Attempt 3: Executed → Verification failed (improvement not achieved)
→ Consecutive failure detected
```

"Same type" is determined by the combination of task category and target dimension. A different-category task produced by a completely different strategy resets the consecutive failure count.

**The failure count and escalation threshold are centrally managed in the task structure (`task-lifecycle.md` §2.8 `consecutive_failure_count` field).** Refer there for the default value (3) and the configurable parameter `failure_escalation_threshold`.

The threshold of 3 is what prevents the irrational behavior of "doing the same thing and expecting a different result." One failure can be accidental. Two warrants caution. Three is a strategy problem.

### 2.4 Global Stall

**All** dimensions show no improvement in the gap across the last N loop iterations. This indicates not an individual dimension stall, but that the goal as a whole has stopped moving.

```
Loops N-4 to N:
  Revenue dimension: no change
  Satisfaction dimension: no change
  Structure dimension: no change
  Infrastructure dimension: no change
→ Global stall detected
```

A global stall is the most serious state. Something fundamental is likely wrong — perhaps the goal definition itself, an execution environment failure, or a collapse of preconditions.

### 2.5 Suppressing Stall Detection During Intentional Waits (plateau_until)

When the `plateau_until` field (see `task-lifecycle.md` §2.6) is set, stall detection behavior changes as follows.

**Suppression condition**: A task or dimension has `plateau_until` set, and the current time is before `plateau_until`.

```
plateau_until is set AND current_time < plateau_until
  → Suppress all stall detection for this dimension
  → None of the detection types from §2.1–§2.4 are triggered
```

**Lifting suppression**: Normal stall detection resumes the moment `plateau_until` becomes a past datetime. Gap changes that accumulated during the suppression period are evaluated in the first loop after suppression is lifted.

**Preventing misuse**: `plateau_until` is a field for intentional waiting. Using it to "hide a stall" is prohibited. Only the strategy layer (the LLM when generating tasks) can set it; executors cannot change it ad hoc.

**Relationship to §6's plateau concept**: The "intentional 'waiting' strategy" described in §6 ("Stall vs. Plateau") is formalized through `plateau_until`. If `plateau_until` is set, suppression is applied mechanically. If a stall occurs without it being set, the graduated response in §4 applies normally.

---

## 3. Stall Classification and Response

When a stall is detected, its cause is classified and a response is taken based on that classification.

### 3.1 Insufficient Information

**Diagnosis**: A stall has occurred in a dimension with low observation confidence. Because the current position is not accurately known, there is no way to determine what should be done.

**Response**: Generate an investigation or verification task in a new session.

```
Stall cause: Insufficient information
Generated task: "Investigate actual customer churn — conduct 5 interviews, identify 3 reasons for churn"
```

Investigation tasks are tracked separately from regular tasks. The completion of an investigation task directly affects strategy selection in the next loop.

### 3.2 Approach Failure

**Diagnosis**: There is sufficient information (high observation confidence), but the gap is not narrowing. The current strategy is not working.

**Response**: Switch to a different strategy. If alternative strategy candidates remain, select the next one. If none remain, generate a new hypothesis.

```
Stall cause: Approach failure
Current strategy: "Improve Onboarding UI"
Next strategy candidates: "Strengthen Support Channels", "Revise Pricing Plans"
→ Switch to "Strengthen Support Channels"
```

Hypothesis generation uses an LLM. The LLM is given "a list of strategies tried so far and their results" as input and asked to propose "strategies that have not yet been tried."

### 3.3 Capability Limitation

**Diagnosis**: The task requirements exceed the tools, permissions, or knowledge currently available to PulSeed. No matter what is tried, the task cannot be executed in the first place.

**Response**: Escalate to a human and request the provision of new capabilities.

```
Stall cause: Capability limitation
Situation: "Query analysis of the production database is needed, but there is no read access to the production environment"
Escalation content:
  - What is needed: Read access to the production database
  - Alternative: Provision of an anonymized dump
  - Impact: Without this access, it is impossible to narrow the gap in this dimension
```

A capability limitation is not a failure. It is evidence that PulSeed accurately recognizes its own boundaries. Escalation should be concrete. Not "I can't do this" but "I can do this if I have that."

### 3.4 External Dependency

**Diagnosis**: The task's preconditions are waiting on an external change. PulSeed cannot make progress no matter what it does.

**Response**: Pause this goal and switch to other goals. Set a trigger to resume when the external dependency is resolved.

```
Stall cause: External dependency
Situation: "Waiting for a third-party API version upgrade — the new feature is required for implementation"
Response:
  - Mark this goal's state as "waiting"
  - Resumption condition: "When the API provides v3.0 or higher"
  - What can be done now: Redirect resources to another goal during the wait
```

Without detecting external dependencies, PulSeed would spin in an empty loop forever, expecting "the API might support it eventually."

### 3.5 Goal Infeasibility

**Diagnosis**: A global stall continues despite multiple pivots. The goal definition itself may be the problem.

**Response**: Escalate to a human with an honest assessment.

```
Stall cause: Goal infeasibility (suspected)
Situation:
  - Strategy has been pivoted 3 times
  - No improvement on any dimension (last 8 loops)
  - No further strategy hypotheses can be generated
PulSeed's assessment:
  "Achieving this goal under the current constraints appears to be difficult.
   I suggest redefining the goal, narrowing the scope, or revisiting the preconditions.
   Specifically: [list of possible options]"
```

This escalation is not a failure report. It is an active proposal by PulSeed — recognizing its limits and inviting the user into a more productive conversation.

---

## 3.6 Diagnostic Mapping: Stall Type → Cause Classification

There are empirical associations between the four stall types and the five cause classifications. These are **diagnostic hints**, not rigid rules. Actual judgment is made by combining observation confidence, context, and past logs.

| Stall type | More likely causes | Less likely causes |
|------------|-------------------|-------------------|
| Dimension-level stall (§2.1) | Approach failure, capability limitation | Goal infeasibility, external dependency |
| Time overrun (§2.2) | External dependency, approach failure (wrong estimate) | Capability limitation, goal infeasibility |
| Consecutive failures (§2.3) | Approach failure, capability limitation, goal infeasibility | Insufficient information, external dependency |
| Global stall (§2.4) | Goal infeasibility, external dependency | Insufficient information, approach failure (alone rarely leads to global stall) |

**How to use the mapping**: Once the stall type is confirmed, use the table above as a starting point and check the judgment criteria for the corresponding cause classifications (§3.1–§3.5) in order. Begin with the "more likely causes" and move to the next candidate if none match.

**Note**: Multiple stall types can occur simultaneously (e.g., a dimension-level stall alongside consecutive failures). In that case, prioritize the cause classification indicated by the more severe stall type (global stall > consecutive failures > time overrun > dimension-level).

---

## 4. Graduated Response

When a stall is detected, do not immediately apply the maximum response. Respond in stages.

```
1st detection (first occurrence of the same stall)
  → Try a different approach within the same strategy
    e.g.: Within strategy "UI Improvement," target a different UI element

2nd detection (second occurrence of the same stall)
  → Switch to a different strategy
    e.g.: Pivot from "UI Improvement" to "Strengthen Support"

3rd detection (third occurrence of the same stall)
  → Escalate to a human
    e.g.: Explain the situation and present possible options
```

The purpose of graduated responses is to distinguish temporary stalls (plateaus) from genuine ones. New initiatives take time to show results. Judging "it's a stall" without waiting for that time would cause PulSeed to abandon a strategy that is actually working.

Reset condition for stages: When meaningful improvement (gap reduction above the threshold) is observed in a stalled dimension, reset the stage count for that dimension to zero.

---

## 5. Feedback to Scoring

The results of stall detection are fed back into the dissatisfaction-driven score in `mechanism.md`.

**Handling stalled dimensions**: Dimensions with a detected stall have a `decay_factor` applied to their dissatisfaction-driven score, temporarily reducing it.

```
Dissatisfaction score (normal) = gap_size × urgency_weight
Dissatisfaction score (stalled) = gap_size × urgency_weight × decay_factor
  where decay_factor < 1.0 (e.g., 0.6)
```

**Why this is necessary**: Leaving a stalled dimension at high priority causes PulSeed to keep hitting the same wall. The `decay_factor` temporarily redirects attention to other dimensions. When the stall is resolved, the `decay_factor` returns to normal.

**Recovery of `decay_factor`**: When recovery from a stall is confirmed (when improvement is observed after countermeasures are applied), the factor is restored on the following schedule.

```
decay_factor recovery schedule:
  Immediately after stall resolved: 0.6 → 0.75
  After 2 loops:                   0.75 → 0.9
  After 4 loops:                   0.9 → 1.0 (normal)
```

Avoid an abrupt recovery. Return to normal mode gradually, leaving some uncertainty about "whether it might stall again."

---

## 6. Design Decisions and Boundaries

**Stall vs. plateau**: A stall means "there is a problem." A plateau means "it's not moving right now, but that's not a problem." The distinguishing factor is whether an intentional "wait" strategy has been selected. If a strategy of "measure in N days" is explicitly stated, that is a plateau, and the stall count does not advance.

**Cost of false positives vs. false negatives**: The cost of missing a stall and the cost of a false positive are not asymmetric — both are high. Missing a stall results in wasteful loops. A false positive causes an effective strategy to be cut short. To prevent both, detection is configured conservatively (with a higher N), and responses are applied gradually.

**Scope of stall detection**: Stall detection operates at both the goal level and the task level. Task-level stalls (consecutive failures) accumulate into goal-level stalls (global stalls).

**User notification**: Stall detection itself runs silently. The 1st and 2nd detections are handled autonomously by PulSeed. Only the 3rd detection (escalation) triggers a user notification. This prevents users from being notified every time a temporary stall occurs.
