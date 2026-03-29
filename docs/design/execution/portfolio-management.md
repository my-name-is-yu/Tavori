# Portfolio Management Design — Strategy Discovery, Parallel Execution, and Rebalancing

> This document defines the mechanism for managing "strategies" — the means of closing a Goal's Gap — as explicit entities,
> and for running multiple strategies in parallel as a portfolio, measuring their effectiveness, and rebalancing resources.

> This is the concrete design of the "Strategy Engine" and "Portfolio Management" described in vision.md,
> and it elaborates on mechanism.md §2.3 "Strategy Selection."

---

## 1. Strategy Data Model

A strategy is a **hypothesis** about how to close a Gap, modeled as an explicit entity. "If we improve onboarding, churn rate will drop." "If we revise pricing, ARPU will increase." Each such hypothesis becomes a single strategy.

### 1.1 Strategy Structure

```
Strategy {
  id: string                        // Unique identifier (e.g., "strat-churn-onboarding-v1")
  goal_id: string                   // ID of the Goal this strategy belongs to
  target_dimensions: string[]       // Dimensions this strategy targets (one or more)
  primary_dimension: string         // Primary dimension (main axis for effectiveness measurement)

  hypothesis: string                // Hypothesis (natural language)
  expected_effect: {
    dimension: string               // Dimension where effect is expected
    direction: "increase" | "decrease"
    magnitude: "small" | "medium" | "large"  // Qualitative estimate by LLM
  }[]

  resource_estimate: {
    sessions: number                // Expected number of agent sessions
    duration: Duration              // Expected duration
    llm_calls: number | null        // Expected number of LLM calls (null = unknown)
  }

  state: StrategyState              // Current state (§1.2)
  allocation: number                // Resource allocation ratio (0.0–1.0) (§4)

  created_at: DateTime
  started_at: DateTime | null
  completed_at: DateTime | null

  gap_snapshot_at_start: number | null    // normalized_weighted_gap of primary_dimension at start
  tasks_generated: string[]               // IDs of tasks generated from this strategy
  effectiveness_score: number | null      // Effectiveness score (calculated in §5)
  consecutive_stall_count: number         // Number of consecutive stall detections (default: 0)
}
```

### 1.2 Strategy State Transitions

```
candidate → active → (evaluating → active | suspended | terminated)
                   → completed
                   → terminated
```

| State | Meaning |
|-------|---------|
| `candidate` | Generated but not yet running. Awaiting resource allocation |
| `active` | Running. Tasks are being generated and delegated |
| `evaluating` | Measuring effectiveness. Task generation is paused to observe results |
| `suspended` | Paused. Resources have been shifted to other strategies |
| `completed` | Successfully closed the Gap in the target dimension |
| `terminated` | Deemed ineffective and discontinued |

The `evaluating` state works in conjunction with `plateau_until` from task-lifecycle.md §2.6. It is a deliberate waiting period for effectiveness measurement and suppresses stall detection.

---

## 2. Strategy Generation

Strategies are generated automatically from a Goal's Gap. Following the separation principle from drive-scoring.md §6 ("which dimension to target" is decided by code, "how to target it" is decided by LLM), the LLM generates strategy candidates **after** the priority dimension has been determined.

### 2.1 Generation Flow

```
Drive Scoring (code)
    │ Determines priority dimension
    ↓
Strategy generation prompt (LLM)
    │ Input:
    │   - Priority dimension and its Gap
    │   - Goal context (constraints, domain information)
    │   - Previously attempted strategies and their results (including failures)
    │   - Available capabilities (Capability Registry)
    │ Output:
    │   - 1–3 strategy candidates (hypothesis + expected effect + resource estimate)
    ↓
Strategy registration (state: candidate)
```

### 2.2 Input Constraints for LLM

When requesting strategy generation from the LLM, explicitly include the following.

**Required inputs**:
- The `normalized_weighted_gap` value and threshold type of the priority dimension
- The `hypothesis` and `effectiveness_score` of previously `terminated` strategies (to avoid repeating the same failures)
- The Goal's constraint list (`constraints`)

**Prohibited**:
- Do not let the LLM choose the priority dimension (already determined by code)
- Do not request more than 3 candidates in a single generation (too many options increases evaluation cost)

### 2.3 Initial Generation and Subsequent Generation

**Initial generation**: Executed on the first loop after goal negotiation completes. Looks at the full Gap vector and generates strategy candidates for the most important set of dimensions.

**Triggers for subsequent generation**:
- All existing `active` strategies have been `terminated`
- A strategy pivot was determined by stall detection (stall-detection.md §4 second detection)
- A new dimension was discovered (dynamic change in the goal tree)
- Rebalancing (§6) resulted in unallocated capacity

---

## 3. Portfolio Structure

### 3.1 Managing Strategies Within a Single Goal

A portfolio is the unit that manages all strategies within a single Goal.

```
Portfolio {
  goal_id: string
  strategies: Strategy[]            // All strategies (regardless of state)
  active_strategies: Strategy[]     // Strategies in state active | evaluating
  total_allocation: number          // Sum of allocations for active_strategies (= 1.0)
  rebalance_interval: Duration      // Rebalancing frequency (§6)
  last_rebalanced_at: DateTime
}
```

**Constraints**:
- The sum of `allocation` across `active_strategies` is always 1.0
- If a Goal has 0 `active` strategies, strategy generation is triggered immediately (a strategy-less state is not permitted)

### 3.2 Parallel Execution Model

Parallel execution means multiple strategies are simultaneously `active`, each generating and delegating tasks.

```
Portfolio (Goal: halve churn rate)
    │
    ├── Strategy A: Improve onboarding (allocation: 0.5)
    │     └── Task: Redesign tutorial flow
    │
    ├── Strategy B: Strengthen support (allocation: 0.3)
    │     └── Task: Build FAQ auto-responder
    │
    └── Strategy C: Revise pricing (allocation: 0.2)
          └── Task: Competitive pricing research
```

In each iteration of the task discovery loop, the portfolio selects which strategy's task to execute next. Selection is not probabilistic based on `allocation`; instead it follows these deterministic rules.

### 3.3 Task Selection Rules

```
1. Sort active_strategies by allocation descending
2. For each strategy, calculate "time since last task completion / allocation"
   → The strategy with the highest value is "most starved"
   → On first selection (no task completion history), use portfolio creation time as the initial "last task completion time"
3. Generate the next task from the most starved strategy
```

This rule ensures that a strategy with `allocation: 0.5` generates tasks at 2.5 times the frequency of a strategy with `allocation: 0.2`. Because selection is deterministic rather than probabilistic, the behavior is reproducible.

---

## 4. Resource Allocation

### 4.1 Definition of Resources

"Resources" in portfolio management refers to three types:

| Resource Type | Unit | Constraint |
|---------------|------|------------|
| Agent sessions | Count | Upper limit on concurrent sessions (see drive-system.md §6 for resource contention resolution) |
| Time | Hours / day | Back-calculated from the Goal's deadline |
| LLM calls | Count | Cost ceiling (user-configured) |

### 4.2 Initial Allocation

When a strategy transitions from `candidate` to `active`, its initial allocation is determined.

**Single strategy**: `allocation = 1.0` (all resources invested)

**Multiple strategies**: The LLM evaluates each strategy's `expected_effect` and `resource_estimate` and proposes an initial allocation.

Initial allocation constraints:
- Minimum allocation: 0.1 (allocations below 10% are effectively non-functional and are prohibited)
- Maximum allocation: 0.7 (to prevent excessive concentration on a single strategy; 1.0 is allowed when there is only one strategy)
- Total: 1.0

### 4.3 Interpreting Allocation

`allocation` functions as the ratio of task generation frequency (see §3.3 task selection rules). A strategy with `allocation: 0.5` will generate tasks in approximately 50% of portfolio iterations.

---

## 5. Effectiveness Measurement

### 5.1 The Attribution Problem

When multiple strategies are running simultaneously, attributing Gap changes to specific strategies is inherently difficult. When both "improved onboarding" and "strengthened support" are running and churn rate drops, which strategy was responsible?

**PulSeed's approach: do not seek complete attribution.**

Complete causal attribution requires the level of control found in scientific experiments, which is impossible in real-world goal pursuit. Instead, the following heuristics are used to obtain **attribution signals**.

### 5.2 Effectiveness Measurement Methods

#### Method 1: Time-series Correlation (Primary)

Compare each strategy's task completion timing against Gap changes in the target dimension over time.

```
Strategy A task completions: t1, t3, t5
Strategy B task completions: t2, t4

Dimension X Gap changes:
  t1→t2: -0.05 (improvement)  ← Strategy A task completed just before
  t2→t3: -0.01 (slight improvement) ← Strategy B task completed just before
  t3→t4: -0.08 (improvement)  ← Strategy A task completed just before
  t4→t5: +0.02 (worsening)    ← Strategy B task completed just before
```

If the Gap narrows immediately after a task is completed, that task's strategy is provisionally credited. This is not strict causation, but it is sufficient as input for rebalancing decisions.

#### Method 2: Dimension Target Matching

Changes in the Gap of a dimension that a strategy has declared as a `target_dimension` are attributed to that strategy.

```
Strategy A.target_dimensions = ["churn_rate"]
→ Gap changes in churn_rate are attributed to Strategy A
```

When multiple strategies target the same dimension, Method 1 (time-series correlation) supplements the attribution.

#### Method 3: Qualitative LLM Evaluation (Supplementary)

When time-series correlation alone is insufficient, the LLM is given the following inputs and asked to perform a qualitative attribution assessment:

- The hypothesis and executed tasks for each strategy
- Time-series data of Gap changes
- Changes in the external environment (event queue logs)

LLM evaluations are treated as reference information and are not used directly for automated rebalancing decisions (automation is planned for Phase 2).

### 5.3 Calculating Effectiveness Score

```
effectiveness_score(strategy) =
  gap_delta_attributed(strategy) / sessions_consumed(strategy)
```

- `gap_delta_attributed`: Total Gap reduction provisionally attributed to this strategy (change in normalized_weighted_gap)
- `sessions_consumed`: Number of agent sessions consumed by this strategy

The effectiveness score represents "Gap reduction per session." A higher score means better resource efficiency.

**Note**: Measurement requires at least 3 task completions. Before that, `effectiveness_score = null` (insufficient data) and it is not used as input for rebalancing decisions.

---

## 6. Rebalancing

### 6.1 What Is Rebalancing

Rebalancing is the operation of revisiting the resource allocation among strategies based on effectiveness measurement results. It concentrates resources on strategies that are working and scales back or discontinues those that are not. This is the concrete design of the "investment allocation optimization" described in vision.md.

### 6.2 Rebalancing Frequency

Rebalancing is performed at the following times.

**Periodic rebalancing**: Executed every `rebalance_interval`. The default depends on the nature of the Goal.

| Goal Type | Default rebalance_interval |
|-----------|---------------------------|
| Short-term (within 1 month) | 3 days |
| Medium-term (1–6 months) | 1 week |
| Long-term (6+ months) | 2 weeks |

**Event-driven rebalancing**: Immediately executed when any of the following occur:
- A strategy is `terminated` (reallocation of its share is needed)
- Stall detection triggers a rebalance (see stall-detection.md §4)
- `effectiveness_score` changes significantly (50%+ shift from the previous rebalance)

### 6.3 Rebalancing Decision Criteria

```
Rebalancing triggered
    │
    ↓
Compare effectiveness_score across all active strategies
    │
    ├── All strategies null (insufficient data)
    │     → Do not change allocation. Wait for data to accumulate
    │
    ├── Some null, some not
    │     → Perform relative comparison only among non-null strategies; maintain allocation for null strategies
    │
    └── All strategies have scores
          │
          ↓
     Calculate ratio of highest to lowest score
          │
          ├── Ratio < 2.0 → No significant difference. Do not change allocation
          │
          └── Ratio >= 2.0 → Adjust allocation
                │
                ↓
          Increase allocation for high-performing strategies,
          decrease allocation for low-performing strategies
          (but maintain minimum allocation of 0.1)
                │
                ↓
          If the lowest-scoring strategy's allocation is still 0.1 after adjustment,
          proceed to termination decision (§6.4)
```

### 6.4 Termination Conditions

A strategy is `terminated` when any of the following conditions are met:

**Condition 1: No effect** — `effectiveness_score` has been the lowest across 3 consecutive rebalancing cycles, and `allocation` has remained at the minimum value (0.1).

**Condition 2: Consecutive stalls** — `consecutive_stall_count` is 3 or more (stall detection has triggered 3 times).

**Condition 3: Resource overrun** — Resources consumed have exceeded 2x the `resource_estimate` (similar logic to the time overrun concept in stall-detection.md §2.2).

The `allocation` of a terminated strategy is redistributed to the remaining `active` strategies in proportion to their `effectiveness_score`. If all strategies are terminated, new strategy generation is triggered (see §2.3).

---

## 7. The "Wait" Strategy

This formalizes the "actively do nothing" decision referenced in vision.md.

### 7.1 Definition of a Wait Strategy

"Waiting" is not laziness. It is a strategic decision based on a clear hypothesis.

```
WaitStrategy extends Strategy {
  wait_reason: string               // Why we are waiting (natural language)
  wait_until: DateTime              // How long we will wait
  measurement_plan: string          // What will be measured after the wait
  fallback_strategy_id: string | null  // Fallback strategy if no effect is observed after waiting
}
```

### 7.2 Conditions for Generating a Wait Strategy

Conditions under which the LLM may propose "waiting" as a candidate strategy:

- When effect from a recently completed strategy task takes time to materialize (e.g., A/B test results, campaign effects, external API propagation delays)
- When there is an external dependency (corresponding to "external dependencies" in stall-detection.md §3.4)
- When all dimensions have small Gaps and there is a risk of over-optimization

### 7.3 Executing a Wait Strategy

When a wait strategy is `active`, no tasks are generated. Instead:

1. Set `wait_until` as `plateau_until` (see task-lifecycle.md §2.6)
2. Suppress stall detection (see stall-detection.md §2.5)
3. After `wait_until` is reached, start an observation cycle to measure Gap changes
4. Determine the next action based on measurement results

```
wait_until reached
    │
    ↓
Re-measure Gap in target dimension
    │
    ├── Gap narrowed → "Wait" decision was correct. Evaluate and rebalance
    ├── No Gap change → Switch to fallback_strategy_id if available
    └── Gap worsened → Immediately trigger rebalancing
```

### 7.4 Resource Allocation for Wait Strategies

A wait strategy has an `allocation`, but since it generates no tasks, it consumes no resources in practice. The `allocation` reserved for a wait strategy is treated as "reserved" and is **not** automatically redistributed to other strategies.

Rationale: A wait strategy is "a time window for observing effect materialization." Reallocating its resources to other strategies risks having those strategies alter the state during the wait, making attribution of effects even more difficult.

That said, in the MVP, treating a wait strategy's `allocation` as 0 — allowing all other `active` strategies to use full resources — is also acceptable (see §9).

---

## 8. Integration with Existing Design

### 8.1 Relationship with Drive Scoring

`drive-scoring.md` determines "which dimension to target." Portfolio management determines "which strategy to use for that dimension."

```
Drive Scoring → Determines priority dimension
    ↓
Portfolio Management → Selects and allocates strategies for the priority dimension
    ↓
Task Lifecycle → Generates and executes tasks from the selected strategy
```

Drive scoring results are upstream of strategies. Portfolio management does not modify drive scores.

### 8.2 Relationship with Task Lifecycle

A strategy ID field is added to the task structure in `task-lifecycle.md`.

```
// Additional field for task-lifecycle.md §2
strategy_id: string | null          // ID of the strategy this task belongs to (null = task not tied to a strategy)
```

Task verification results (3-layer verification from §5) feed back into the strategy's `effectiveness_score` calculation. If a task `fail`s, the strategy's `consecutive_stall_count` may increase.

### 8.3 Relationship with Stall Detection

The impact of `stall-detection.md` detection results on portfolio management:

| Stall Stage | Effect on Portfolio |
|-------------|---------------------|
| 1st detection | Try a different approach within the current strategy (task-level change; no portfolio change) |
| 2nd detection | Strategy pivot. Terminate current strategy and generate a new one |
| 3rd detection | Escalate to human. Propose a full portfolio review |

### 8.4 Relationship with Gap Calculation

The Gap history from `gap-calculation.md` §8 serves as the input data for the time-series correlation in effectiveness measurement (§5). The calculation of `gap_delta` uses the definitions from `gap-calculation.md` directly.

---

## 9. MVP vs Phase 2

### MVP (Phase 1): Sequential Execution + Manual Rebalancing

The MVP avoids the complexity of parallel execution and is limited to the following:

| Item | MVP Specification |
|------|------------------|
| Concurrent active strategies | 1 (sequential execution) |
| Strategy generation | LLM generates 1–2 candidates. Top candidate is auto-selected |
| Rebalancing | Manual (user switches via `pulseed strategy switch`) |
| Effectiveness measurement | Gap history is recorded only. `effectiveness_score` is for display purposes |
| Termination | Automatic pivot on 2nd stall detection |
| Wait strategy | Only `plateau_until` is set (no dedicated WaitStrategy type needed) |
| Strategy data storage | Stored as `current_strategy` and `strategy_history` within the goal state file |

Even in the MVP, strategies are recorded as explicit entities. Even with sequential execution, a history of "what was tried and what didn't work" accumulates, making the data available when transitioning to Phase 2.

### Phase 2: Automatic Rebalancing + Parallel Execution

| Item | Phase 2 Specification |
|------|----------------------|
| Concurrent active strategies | 2–4 (adjusted based on Goal scale and resources) |
| Strategy generation | LLM generates 1–3 candidates. Multiple are made `active` simultaneously |
| Rebalancing | Automatic (periodic and event-driven rebalancing based on §6 rules) |
| Effectiveness measurement | Time-series correlation + dimension target matching + LLM qualitative evaluation |
| Termination | Automatic based on §6.4 termination conditions |
| Wait strategy | Formalized as WaitStrategy type with `fallback_strategy_id` support |
| Automatic allocation optimization | Dynamic allocation adjustment based on `effectiveness_score` |

### Phase 3 (Future Vision)

- Dependency modeling between strategies (cases where Strategy A's success is a prerequisite for Strategy B)
- Cross-goal strategy portfolio (optimizing resource allocation across multiple Goals)
- Strategy template recommendations from past Goals and domains

---

## Phase 3 (Stage 14D)

### Cross-Goal Resource Allocation

When multiple Goals are simultaneously active, resource allocation across Goals is optimized.

**Priority calculation using 4 factors**:

| Factor | Description | Related Component |
|--------|-------------|------------------|
| `deadline_urgency` | Deadline-driven score | DriveScorer |
| `gap_severity` | Severity of the largest Gap (maximum normalized_weighted_gap) | GapCalculator |
| `dependency_weight` | Dependency on other Goals (how many Goals depend on this one) | GoalDependencyGraph |
| `user_priority` | User-specified priority (integer 1–5) | User settings |

**Integrated priority**:

```
goal_priority_score =
  w1 × deadline_urgency +
  w2 × gap_severity +
  w3 × dependency_weight_normalized +
  w4 × user_priority_normalized

→ Normalized to [0, 1]

Default weights: w1=0.35, w2=0.25, w3=0.25, w4=0.15
```

**Bonuses and penalties from dependencies**:

- Goal pairs with `synergy` dependency → +0.1 bonus to both goals' priority_score (encourages synergistic effects)
- Goal pairs with `conflict` dependency → -0.15 penalty to the lower-priority goal's priority_score (suppresses resource contention)

### Dynamic Priority Adjustment

**Adjustment triggers**:

| Trigger | Description |
|---------|-------------|
| `periodic` | Weekly rebalancing (default) |
| `goal_completed` | Allocation released upon goal completion |
| `goal_added` | Re-adjustment upon addition of a new goal |
| `priority_shift` | `deadline_urgency` or `gap_severity` changed significantly (30%+ from previous) |

**Concurrency control**:

```
active_goals.length > max_concurrent_goals (default: 5)
    │
    ↓
Move the goal with the lowest priority_score to waiting state
    │
    └── Automatically activate waiting goals when higher-priority goals complete or are suspended
```

**Minimum resource guarantee**:

Goals with allocations below `min_goal_share` (default: 0.1) are guaranteed a minimum of 10% of resources. This ensures that no goal is completely ignored, even when its priority is low.

### Strategy Template Recommendations

Successful strategies from past Goals are generalized and proposed as candidates for application to new Goals.

**Conditions for template creation**:

```
Target: strategies with effectiveness_score >= 0.5 and state = "completed"
    │
    ↓
LLM generalizes hypothesis patterns
    │ - Abstracts goal-specific domain expressions
    │ - Makes prerequisites and applicability conditions explicit
    │ - Retains resource_estimate as a reference value
    ↓
Registered as StrategyTemplate
    │
    └→ Embedding generated and registered in VectorIndex (with domain_tags)
```

**Recommendation flow**:

```
Strategy generation for a new Goal (§2.1)
    │
    ↓ (before building the strategy generation prompt)
Search VectorIndex for templates similar to the Goal definition
    │ Filter: domain_tags overlap >= 1
    │
    ↓
Include top 3 templates in the strategy generation prompt
    │ LLM judges "can this template be applied to this Goal?"
    ↓
Generate strategy candidates based on applicable templates
```

### Inter-Strategy Dependencies

GoalDependencyGraph is extended to additionally manage **inter-strategy dependencies**.

**New dependency types**:

```
// Addition to types/dependency.ts
Add "strategy_dependency" to DependencyTypeEnum

StrategyDependencyEdge {
  source_strategy_id: string      // Prerequisite strategy
  target_strategy_id: string      // Dependent strategy (waits for source to complete)
  goal_id: string                 // Only intra-goal dependencies (in Phase 3)
  dependency_type: "prerequisite" | "enhances"
}
```

**Meaning of dependency types**:

| Type | Meaning | Effect on Task Generation |
|------|---------|--------------------------|
| `prerequisite` | Do not generate tasks for the target strategy until the source strategy completes | Puts target strategy in `suspended` state |
| `enhances` | Results from the source strategy amplify the effect of the target strategy (soft dependency) | Task generation is allowed, but a rebalance is triggered after source completes |

**Alignment with existing design**:

`prerequisite` dependencies are incorporated into the task selection rules in portfolio-management.md §3.2. `suspended` strategies are treated as `allocation = 0` and excluded from selection.

---

## Summary of Design Principles

| Principle | Concrete Design Decision |
|-----------|--------------------------|
| Strategies as explicit entities | Managed as data structures with hypotheses, expected effects, and resource estimates |
| Separation from drive scoring | "Which dimension to target" is decided by code; "how to target it" is managed by the portfolio |
| No complete causal attribution | Use heuristics to obtain attribution signals and use them as input for rebalancing |
| Minimum allocation guarantee | Allocations below 0.1 are prohibited. Non-functional strategies are terminated |
| "Waiting" is a strategy | Formalized as a strategic decision with a clear hypothesis, deadline, and measurement plan |
| MVP is sequential; Phase 2 is parallel | Complexity is added incrementally while managing risk |
| Integration with stall detection | The stage of stall detection determines the intensity of portfolio operations |
