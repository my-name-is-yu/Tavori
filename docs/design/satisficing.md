# Satisficing Design — Judging "Good Enough"

> PulSeed does not chase perfection. It judges "good enough" and stops.
> This document defines the logic for determining "when and what constitutes good enough."

---

## 1. Core Principle

Satisficing is a decision strategy of stopping at a state that is "good enough" rather than pursuing the "best possible" outcome.

### Why Not Chase Perfection

Systems that aim for perfection diverge. "More tests." "More refactoring." "More documentation." — they get stuck in an endless improvement cycle. As AutoGPT demonstrated, agents that keep running without a goal are harmful.

PulSeed solves this problem structurally. **Stop when the threshold is exceeded.** That is the rule.

### When Satisficing Works

Satisficing works when the definition of "good enough" is established in advance. Without a clear definition, satisficing cannot work — because there is no way to know when "enough" has been reached.

In PulSeed, when a goal is set, the advisor consults with the user to set thresholds. These thresholds become the definition of "good enough."

---

## 2. Completion Decision Flow

### Goal-Level Completion Decision

```
Check the current value of each dimension
    │
    ↓
Have all dimensions exceeded their thresholds?
    ├─ No  → Direct attention to dimensions still with a Gap (continue loop)
    └─ Yes → Completion candidate
                │
                ↓
           Is the observation confidence sufficient for each dimension?
                ├─ All dimensions high confidence → Complete
                └─ Some dimensions low confidence → Generate verification tasks
                                                          │
                                                          ↓
                                                    Verification tasks complete
                                                          │
                                                          ↓
                                                    Re-evaluate (return to top)
```

Exceeding a threshold alone does not constitute completion. If observation confidence is low, declaring completion means declaring it on weak evidence. Completion decisions with low confidence are **prohibited**.

### Confidence Thresholds

| Confidence | Effect on Completion Decision |
|------------|-------------------------------|
| High (primarily mechanical verification) | Can be used for completion decision as-is |
| Medium (primarily independent review) | Can be used for completion decision (but recorded) |
| Low (primarily self-reported or estimated) | Cannot be used for completion decision. Execute verification tasks first |

### Progress Ceiling Rule (Preventing Premature Completion)

To prevent completing based on weak evidence, a progress ceiling is applied based on confidence level.

```
reported_progress = min(actual_evidence_score, ceiling(confidence_level))

confidence_level | ceiling
high             | 1.00 (no ceiling)
medium           | 0.85
low              | 0.60
```

Example: Even if self-reported evaluation shows "95% complete," if confidence is low, progress is treated as a maximum of 60%. Until the evidence for the remaining 40% is gathered, completion does not occur.

---

## 3. Task-Level Satisficing

Satisficing is not just a goal-level concern. Individual tasks (iterations) also require the judgment of "this is as far as we go this time."

### Do Not Attack All Gaps at Once

Even when multiple Gaps exist, PulSeed selects a **manageable subset** to address.

There are three reasons.

**Context focus**: Attacking many Gaps simultaneously scatters the attention of the executor (including LLMs), leaving every dimension half-finished.

**Verification clarity**: The smaller the task scope, the clearer the judgment of "is it done or not?"

**Failure localization**: If one task fails, the impact on other dimensions is minimized.

### Per-Iteration Constraints

```
iteration_constraints {
  max_dimensions: number        // Maximum number of dimensions to target in one iteration
  uncertainty_threshold: number // Dimensions with confidence below this are observed before action
  divergence_filter: string     // Exclude tasks that are semantically too distant from the goal
}
```

**Resource constraint**: Dimensions exceeding `max_dimensions` are deferred to the next iteration. Do not simultaneously target more than N dimensions (default: 2–3).

**Uncertainty constraint**: For dimensions whose confidence is at or below `uncertainty_threshold`, generate observation tasks first. Do not generate action tasks for "poorly understood dimensions." Observation first, action second.

**Divergence prevention filter**: Filter generated tasks by semantic distance from the goal. This prevents "interesting but inessential" tasks from sneaking through gaps in the drive score.

---

## 4. Multi-Dimensional Threshold Design

### The Danger of a Single Metric

A single progress metric is dangerous.

Example: Suppose a single threshold of "progress: 90%" is used. Writing 20 files might bring it to "90%." The metric may be high while having nothing to do with actually achieving the goal.

### Setting Thresholds Across Multiple Dimensions

PulSeed manages multiple dimensions **each with independent thresholds**.

```
example_goal_thresholds {
  feature_completeness: 0.80   // Degree of feature completion
  test_coverage: 0.90          // Test coverage
  stability: 0.95              // Stability (no crashes or critical bugs)
  documentation: 0.70          // Degree of documentation completion
}
```

Completion condition: **All dimensions independently exceed their respective thresholds.**

Even if one dimension reaches 1.0, if another dimension has not reached its threshold, completion does not occur. This closes the loophole of "over-optimizing one aspect and declaring completion."

### No Compensation Between Dimensions

`test_coverage: 1.0` does not compensate for `stability: 0.5`. Each dimension is evaluated against its own criteria. No completion decision is made through compromise or compensation.

---

## 5. Threshold Negotiation and Adjustment

### Setting Initial Thresholds

When a goal is set, the advisor consults with the user to set thresholds (corresponding to mechanism.md §3 "Goal Negotiation").

The advisor assesses feasibility. "Is this threshold realistic?" "Is it appropriate given the resources and time?" If a threshold is unrealistic, it proposes an adjustment along with the reasoning.

### User Adjustments

The user can change thresholds at any time. However, PulSeed makes the impact of the change explicit.

```
Lowering a threshold (relaxing):
  → Check whether the current state already exceeds the threshold
  → If so, notify: "This change will satisfy the completion condition"

Raising a threshold (tightening):
  → Estimate and present the additional work needed to reach the new threshold
```

### PulSeed's Adjustment Proposals

If PulSeed judges from observation that "this threshold is unrealistic" or "it's actually too low," it can propose an adjustment to the user.

It only proposes — it does not change thresholds autonomously. Threshold changes always require user approval.

Conditions that trigger a proposal:
- The same dimension has failed 3 or more times with no sign of approaching the threshold
- All other dimensions have exceeded their thresholds while one is significantly below, creating a bottleneck for the entire goal
- The threshold was exceeded with significantly fewer resources than originally estimated (suggesting the threshold was too low)

---

## 6. Preventing Premature Completion

Satisficing means "stopping at the right time," not "stopping too early."

### Main Causes of Premature Completion

**Overestimating confidence**: Placing excessive trust in self-reported or estimated data. Remedy: Progress ceiling rule (see §2).

**Optimism bias**: Executors (including LLMs) tend to assess their own results optimistically. Remedy: Separation of execution and verification, independent review sessions (see task-lifecycle.md §5).

**Partial satisfaction misidentification**: Mistaking the fact that some dimensions have exceeded their thresholds for overall completion. Remedy: Independent evaluation with multi-dimensional thresholds (see §4).

### Completion Declaration Gating

```
Items to verify before declaring completion:

□ Current values of all dimensions exceed their thresholds
□ Observation confidence for each dimension is "high" or "medium"
□ Mechanical verification (Layer 1) is complete
□ Independent review session (Layer 2) is complete
□ Based on observations within the past 48 hours (prevents completion based on stale data)
```

If any single item is not met, completion is deferred. When deferred, tasks are generated to complete the missing verification.

---

## 7. Subgoal Completion and Propagation to Parent Goals

In a goal tree (mechanism.md §3 "Goal Decomposition"), subgoal completion propagates to the parent goal's state.

### Propagation Rules

```
Subgoal completes
    │
    ↓
Update the corresponding dimension in the parent goal
    │
    ↓
Check whether all dimensions in the parent goal exceed their thresholds
    ├─ No  → Continue the parent goal's loop
    └─ Yes → Proceed to the parent goal's completion decision flow
```

A subgoal's completion does not automatically complete the parent goal. The parent goal has its own dimensions and thresholds, which are evaluated independently.

### Dimension Mapping Rules

Which dimension in the parent goal a subgoal dimension propagates to is explicitly defined when goal decomposition occurs (when the parent goal is decomposed into subgoals).

**Mapping method 1: Direct mapping (name matching)**

When a subgoal's dimension name matches a parent goal's dimension name, it propagates directly.

```
Subgoal dimension revenue_increase → Parent goal dimension revenue_increase (name match)
```

**Mapping method 2: Aggregation mapping (multiple → 1 dimension)**

Multiple subgoal dimensions are aggregated and reflected into one parent goal dimension.

```
Subgoal A dimension feature_a_completion
Subgoal B dimension feature_b_completion
           ↓ aggregated
Parent goal dimension product_readiness
```

Aggregation method is selected from the following:

| `aggregation` value | Meaning |
|--------------------|---------|
| `min` | Reflect the minimum value of subgoal dimensions in the parent dimension (aligns with the most delayed) |
| `avg` | Reflect the average value |
| `max` | Reflect the maximum value |
| `all_required` | Parent dimension is treated as complete only when all subgoal dimensions exceed their thresholds |

**Mapping data structure**

Mappings are stored within the goal tree structure in the following format:

```
dimension_mapping: {
  parent_dimension: string,       // Dimension name in the parent goal
  aggregation: "min" | "avg" | "max" | "all_required"
}
```

By attaching this field to each subgoal dimension, the propagation target and aggregation method are uniquely determined.

**MVP implementation vs Phase 2**

| Phase | Scope |
|-------|-------|
| **MVP** | Direct mapping by name matching only. Subgoals without a defined `dimension_mapping` propagate their completion status (binary: 0 or 1) as one dimension of the parent goal. |
| **Phase 2** | Full support for all aggregation mapping types, and automatic mapping suggestions based on semantic similarity. |

In the MVP, when there is no explicit mapping definition, the overall completion of the subgoal (`goal_status: completed`) propagates as one dimension of the parent goal. The parent goal receives only the fact "whether this subgoal is complete."

---

## Summary of Design Principles

| Problem | PulSeed's Solution |
|---------|-------------------|
| Divergence from perfectionism | Stop when the threshold is exceeded (completion ≠ perfection) |
| Premature completion on insufficient evidence | Progress ceiling rule based on confidence level |
| Loopholes from single-metric indicators | Independently evaluate multiple dimensions |
| Attacking all Gaps at once | Per-iteration dimension count constraint |
| Hasty action on uncertain dimensions | Generate observation tasks first for low-confidence dimensions |
| Unrealistic thresholds | Negotiation by advisor, dynamic adjustment proposals |
