# Curiosity (Meta-Iteration) Design

> Related: `drive-system.md`, `drive-scoring.md`, `stall-detection.md`, `observation.md`, `satisficing.md`

---

## 1. The Role of Curiosity

Curiosity is a **goal-level meta-iteration**. While the three drive forces (Dissatisfaction, Deadline, Opportunity) select tasks within a goal, curiosity generates and updates goals themselves.

```
Curiosity (meta-iteration)
  │
  ├─→ Proposes new goals
  └─→ Updates the structure and definition of existing goals
       ↑
   Learning feedback (accumulated observations and result logs)

Three drive forces (Dissatisfaction, Deadline, Opportunity)
  │
  └─→ Select tasks within existing goals
```

Curiosity is not random exploration. It is **exploration directed by learning feedback** — by what happened in past loops, which approaches worked, and where blind spots exist.

### Two Functions

**a. New goal discovery**: Proposes goals that might be valuable to the user in areas not yet being pursued. The basis for proposals is always grounded in past experience (which domains had room for improvement, which patterns could transfer).

**b. Redefining existing goals**: When the current goal structure is judged to no longer match reality, it proposes revisiting the goal's decomposition, dimensions, or thresholds. Rather than retrying at the task level, it questions the goal structure itself.

---

## 2. Activation Conditions

Curiosity activates under five conditions. Multiple conditions may be satisfied simultaneously.

### 2.1 Task Queue Empty

```
Condition: All active user goals are in "achieved" or "waiting" status
Meaning: There is nothing left to do. What should be pursued next?
```

The most natural activation timing. When all user goals are satisfied (or waiting on external dependencies), PulSeed does not go idle — it enters curiosity mode. This is linked with the completion judgment in `satisficing.md`, activating "immediately after satisficing is established."

### 2.2 Unexpected Observation

```
Condition: The state vector has changed in a way that falls outside the current model's predicted range
Meaning: Something is happening that is not understood
```

When the value returned by the observation loop in `observation.md` deviates significantly from PulSeed's expected range. For example, a particular metric has improved sharply despite no active measures being in place, or a previously stable dimension has suddenly deteriorated. This is a phenomenon that cannot be explained by the existing goal structure, and it prompts a reconsideration of "what should be pursued."

Threshold guideline: deviation greater than two standard deviations from the expected value, or a change of 5% or more during a period when the model predicted "no change."

### 2.3 Repeated Failures Within a Domain

```
Condition: The consecutive_failure_count for tasks on the same dimension of the same goal exceeds the threshold
Meaning: This may be a goal-structure-level problem, not a task-level problem
```

The failure count and escalation threshold (default: 3) are managed centrally in `task-lifecycle.md` §2.7. This document does not define its own thresholds independently.

When stall detection in `stall-detection.md` detects a pattern of repeated failures on tasks of the same type, curiosity activates alongside stall resolution. While stall handling (information gathering, pivoting, escalation) attempts to resolve the issue "within the existing goal framework," curiosity raises the question: "Should the goal definition itself be changed?"

Stall types that trigger curiosity: primarily `stall-detection.md` §2.3 (consecutive failure type) and §2.4 (overall stall type). §2.1 (dimension-level stall) and §2.2 (time overrun) are addressed through strategy changes and do not trigger curiosity.

### 2.4 Goal Reviewer Discovers an Undefined Problem

```
Condition: During observation/evaluation, a significant problem surfaces that cannot be mapped to any existing dimension
Meaning: Something worth pursuing exists outside the current goal structure
```

**What is the Goal Reviewer**: A periodic review session corresponding to the session type `goal_review` defined in `session-and-context.md`. It is launched at a configured interval (default: once per week) by the schedule-driven trigger in `drive-system.md`. Its purpose is to evaluate whether "the current goals are still appropriate, sufficiently decomposed, and actionable."

When PulSeed's review process (observation integration in the gap recognition step) discovers a significant state change that does not map to any dimension in the existing goal tree — this is a sign that "the current goal structure does not cover the full observation space," and it becomes a candidate for a new goal.

### 2.5 Periodic Exploration

```
Condition: T hours have elapsed since the last curiosity activation (default: 72 hours)
Meaning: Even when things are going well, check for blind spots periodically
```

Even when user goals are progressing smoothly, PulSeed periodically checks whether there are unexplored areas or room to improve how things are being pursued. The frequency scales with the number of user goals and level of activity (longer intervals when busy, shorter when idle).

---

## 3. Curiosity Goals vs. User Goals

Goals have an origin field. How they are treated differs fundamentally based on origin.

| Attribute | User goal | Curiosity goal |
|-----------|-----------|---------------|
| origin | `user` | `curiosity` |
| Set by | User (explicitly) | Auto-generated by PulSeed |
| Nature | Command | Proposal |
| Approval | Not required (pursued immediately) | Required (user accepts/declines) |
| Priority | Always highest | Always lower than user goals |
| Closing | User only | Can expire automatically |
| Expiry | None | Auto-expires in 12 hours if not approved |
| Pursuit timing | Always | Only when all user goals are satisfied/blocked |
| Auto-close | Not permitted | Permitted if judged unproductive |

**Priority principle**: User goals > Curiosity goals (no exceptions). No matter how promising a curiosity goal appears, as long as there are active user goals, curiosity goals come second. While user goal task queues are not empty, resource investment in curiosity goals is limited to the resource budget (see 5.5).

---

## 4. Direction Provided by Learning Feedback

What curiosity proposes is determined by the accumulated experience log. Direction is provided through four patterns.

### 4.1 Prioritizing High-Impact Domains

When past loops show that interventions in a specific domain or dimension have significantly improved the state vector, curiosity explores adjacent areas of that domain.

```
Record: Approach A in Domain X produced a +30% state improvement
→ Curiosity proposal: "Another dimension Y in Domain X may also have room for improvement"
```

Impact is evaluated by ratio, not absolute value. An approach that produced a large improvement rate in a small domain is given higher priority than one that produced a small improvement rate in a large domain.

### 4.2 Reconstruction Proposals from Failure Patterns

When the same approach has repeatedly failed across different goals, this suggests a common structural problem in that group of goals. Curiosity proposes redecomposing the goals or redefining their dimensions.

```
Record: "Approach C" has failed 3+ times in both Goal A and Goal B
→ Curiosity proposal: "The decomposition of Goals A and B may be inappropriate. Consider the following reconstruction"
```

### 4.3 Cross-Goal Transfer Proposals

It evaluates whether a strategy or approach that worked for one goal could be applied to a stalling dimension in another. This is discovered by cross-referencing the strategy scoring logs in `drive-scoring.md` across goals.

```
Record: "Strategy P" reduced the gap on Dimension X of Goal A by 30%
         Dimension Y of Goal B has been stalled for 3 loops
         Dimension X and Dimension Y share the same type of challenge structure
→ Curiosity proposal: "Try applying Strategy P — which worked for Goal A — to Dimension Y of Goal B"
```

Precondition for transfer proposals: the similarity score of challenge structures (matching dimension type, gap size, and failure patterns) must exceed a threshold. Unsupported transfers to dissimilar challenges are not proposed.

**MVP implementation vs. Phase 2**

| Phase | Similarity detection method |
|-------|-----------------------------|
| **MVP** | Exact match on `dimension_name` (transfer candidates detected between goals sharing the same named dimension). No embedding computation needed. |
| **Phase 2** | Fuzzy similarity score using semantic embeddings (detects structurally similar dimensions even with different names). |

In the MVP, goals sharing a dimension with exactly the same `dimension_name` are treated as "transfer candidates." Fuzzy matching (e.g., treating "monthly_revenue" and "revenue_monthly" as identical) is deferred to Phase 2 and beyond.

### 4.4 Detecting Blind Spots

It discovers dimensions or domains that have never been observed or tracked but appear relevant to the user's overall activity area.

```
Record: The user's goals cover Domains A and B,
         but Domain C — which typically accompanies A — has never been tracked
→ Curiosity proposal: "Domain C has never been observed. Check whether it's worth tracking"
```

Basis for blind spot detection: the difference between the full dimension list across the goal set and the baseline of dimensions typically tracked in similar domains. This is not conjecture from scratch — it is based on inference from the existing goal structure.

**MVP implementation vs. Phase 2**

| Phase | Detection method | Confidence |
|-------|-----------------|------------|
| **MVP** | LLM prompting: pass the dimension list [A, B, C] for Goal X and ask "What dimensions are commonly tracked in this goal domain but absent from this list?" | `detection_method: "llm_heuristic"` / Confidence: low–medium |
| **Phase 2** | Baseline comparison against "similar-domain goal sets" using embedding similarity. | `detection_method: "embedding_similarity"` / Confidence: high |

The MVP operates without an embedding infrastructure. However, LLM heuristics are qualitative judgments and carry the risk of false positives and misses. Mark with `detection_method: "llm_heuristic"` and note the low confidence when presenting to the user.

---

## 5. Constraints on Curiosity

Unconstrained curiosity causes scope creep. The following constraints are mandatory.

### 5.1 User Goals Take Priority (Absolute Rule)

No matter how promising a curiosity goal appears, as long as there are active user goals, curiosity goals are deferred. While the user goal task queue is not empty, resource investment in curiosity goals is limited to the resource budget (see 5.5).

### 5.2 Cap on Simultaneous Proposals

```
Maximum active curiosity goals: N (default: 3)
```

No more than N curiosity goals are proposed or tracked simultaneously. When proposals exceed N, those with lower scores based on learning feedback are held back. The next candidate is proposed when the user declines one.

### 5.3 Automatic Expiry

```
Unapproved curiosity goals: auto-expire in 12 hours (default)
Approved but unproductive curiosity goals: auto-closed after N loops (default: 3) without results
```

This prevents curiosity goals from accumulating without the user noticing. Expired goals remain in the log and serve as reference when the same proposal arises again.

### 5.4 Scope Constraint

Curiosity goals must be related to the domains the user's current goals belong to. Exploration proposals in unrelated areas are not generated.

Scope definition: all dimensions and domains in the current user goal tree, plus domains one step adjacent. Areas two or more steps removed are not proposed.

### 5.5 Resource Budget

```
Maximum resource share for curiosity goals when user goals exist:
  Active user goals present    → max 20%
  All user goals "waiting"     → max 50%
  All user goals "achieved"    → unlimited (but proposal count cap is maintained)
```

Resources are measured in loop cycle count (how many task-discovery loops are spent on curiosity goals).

---

## 6. Connection to the Task Discovery Loop

Approved curiosity goals are inserted into the normal goal tree. Their behavior after insertion is identical to user goals.

### Insertion Flow

```
Curiosity engine
  │ Generates candidate goal
  ↓
Proposal to user (notification)
  │ Approve / Decline
  ↓ (on approval)
Advisor normalizes the goal
  │ - Define dimensions
  │ - Set thresholds for each dimension
  │ - Set initial state vector (based on observation)
  ↓
Inserted into goal tree (origin: curiosity is retained)
  │
  └→ Three drive forces (Dissatisfaction, Deadline, Opportunity) begin operating normally
```

Why Advisor normalization is needed: the proposal generated by the curiosity engine represents a directional sense of "worth pursuing" — specific dimensions and thresholds must be determined through observation and dialogue (see the goal-setting flow in `drive-system.md`).

### Conditions for Auto-Close

Curiosity goals can be closed without user confirmation under the following conditions:

- All dimensions have met their configured thresholds (normal completion)
- No results across N loops, and learning feedback judges there is no transfer value (unproductive)
- Addition of new user goals places it outside scope

User goals cannot be auto-closed under the same conditions.

---

## 7. Concrete Examples

### Example 1: Adjacent Proposal After Goal Achievement

> Situation: The user goal "Lose 3kg" has met its completion criteria and been completed by satisficing. The task queue is now empty.
>
> Learning feedback: The log shows that during tracking of this goal, "sleep hours" were indirectly correlated with weight change. However, sleep has never been set as a user goal.
>
> Curiosity proposal: "Looking at the log from your weight goal, weeks with 7+ hours of sleep showed a 1.4× faster rate of decrease. Would you consider tracking sleep quality and quantity as a goal?"

What matters is that the proposal's rationale is grounded in the experience log. It is not "sleep is generally important" — it is "this correlation was found in this user's observation history."

### Example 2: Goal Redefinition Proposal from Repeated Failures

> Situation: For the goal "Increase new customer acquisition to 30 per month," three types of approaches (increased ad spend, content expansion, referral campaigns) have each shown no results for 3+ loops on the "lead acquisition count" dimension. Stall detection has already flagged the stall.
>
> Curiosity judgment: This may be a goal-structure-level problem rather than a task-level problem. The dimension setting of "lead acquisition count" itself may not be covering the actual bottleneck.
>
> Curiosity proposal: "Three types of approaches have shown no effect. There may be room to revisit the goal's decomposition. Proposal: split the dimension from 'lead acquisition count' into 'lead-to-meeting conversion rate' and 'lead quality score,' and re-measure where the real gap is."

In this case, the proposal is a redefinition of an existing goal, not a new goal proposal. After redefinition, the Advisor will configure the dimensions and thresholds afresh.

### Example 3: Cross-Goal Transfer

> Situation:
> - Dimension "search hit rate" of Goal A "Organize internal documentation" has been stalled for 3 loops
> - Goal B "Improve customer support efficiency" has a record of "FAQ tag restructuring" improving the search hit rate by 40%
>
> Curiosity judgment: The FAQ tagging methodology from Goal B may be transferable to the internal document search of Goal A. The challenge structure ("low search hit rate = tag and categorization design problem") is a match.
>
> Curiosity proposal: "Would you like to generate a task to apply the FAQ tag restructuring approach that worked for Goal B to the internal document search of Goal A?"

### Example 4: Blind Spot Detection in Periodic Exploration

> Situation: The user's active goals are "Improve product development speed" and "Reduce customer churn rate." Periodic exploration timing (72 hours).
>
> Curiosity analysis: The churn rate goal tracks "onboarding completion rate" as a dimension, but "usage frequency within 30 days after onboarding completion" has never been observed. This metric is generally known to correlate highly with churn prediction, and it is one step adjacent to the user's goal structure.
>
> Curiosity proposal: "There is a metric not being observed in your churn rate goal: usage frequency within 30 days of onboarding completion. Would you like to start tracking it?"

---

## Design Notes

**Curiosity is also a safety net for the system.** Important goals the user couldn't explicitly set, blind spots that only become apparent as experience accumulates, goal structure problems visible only through task failures — these cannot be designed for in advance. The curiosity mechanism supplements them after the fact.

**Explicit rationale for proposals is mandatory.** Every curiosity goal proposal must include the basis for "why this is being proposed" (which log or pattern it is based on). A proposal without rationale not only makes it impossible for the user to approve or decline — it also erodes trust in PulSeed.

**Handling previously declined goals.** A curiosity goal that the user has once declined will not be re-proposed for at least N hours (default: 168 hours = 1 week). Repeating the same proposal ignores the user's stated preference. However, if the situation has changed significantly (e.g., a relevant metric has changed by 30% or more compared to when the goal was declined), this may be treated as an exception.
