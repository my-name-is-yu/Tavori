# Drive Scoring Design

How to quantify the priority judgment for "what to tackle next." PulSeed defines three drive types, each of which reads the gap vector from a different angle. This document describes the calculation structure and design decisions behind that.

As a prerequisite, see `gap-calculation.md` for the gap calculation structure.

**Normalization assumption**: The input to each drive score is `normalized_weighted_gap(dim)`. This is a value that has passed through the pipeline `raw_gap → normalized_gap ([0,1] conversion) → normalized_weighted_gap (confidence-weighted)`, which absorbs differences in units (in thousands of dollars, ratios, integers, booleans). Drive scoring makes priority decisions that are independent of each dimension's absolute scale.

---

## 1. Dissatisfaction Drive

"This gap is too large. It must be fixed."

This is the most fundamental drive force. The larger the current gap, the higher the priority. However, dimensions that have been repeatedly attempted without progress receive a temporary penalty, preventing PulSeed from endlessly hammering the same wall.

### Score Formula

```
score_dissatisfaction(dim) = normalized_weighted_gap(dim) × decay_factor(time_since_last_attempt(dim))
```

### Design of decay_factor

`decay_factor` is a coefficient that temporarily reduces the score of dimensions that were recently attempted.

```
decay_factor(t) = decay_floor + (1 - decay_floor) × (1 - exp(-t / recovery_time))
```

- `t`: Time elapsed since the last attempt
- `decay_floor`: Minimum value immediately after an attempt (e.g., 0.3 — does not drop to zero)
- `recovery_time`: Time constant for recovering to the original value (e.g., 24 hours)

#### Behavior Illustration

```
decay_factor
  1.0 ┤                             ━━━━━━━━━━━━━━
      │                     ━━━━━━━
      │              ━━━━━━━
  0.5 ┤         ━━━━━
      │      ━━━
  0.3 ┤━━━━━━
      └──────────────────────────────────────→ Time elapsed
       Immediately after attempt    12h    48h
```

Immediately after an attempt, the score drops to `decay_floor` (0.3), then recovers to 1.0 over time. The reason for not dropping to zero is to avoid the risk of completely ignoring dimensions with an extremely large gap.

### Role of the Dissatisfaction Drive

The Dissatisfaction Drive is the default drive force. When neither a deadline nor an opportunity exists, "attacking the most painful point" is the most natural action. When other drives are silent, the Dissatisfaction Drive underpins decision-making.

---

## 2. Deadline Drive

"Time is running out. It must be prioritized now."

The score rises sharply as the remaining time to the deadline shortens. It does not apply to goals or dimensions without a deadline (score = 0).

### Score Formula

```
score_deadline(dim) = normalized_weighted_gap(dim) × urgency(time_remaining(dim))
```

### Design of the urgency Function

The impact is small when the deadline is far away and rises sharply as it approaches. An exponential rise is used rather than a sigmoid.

```
urgency(T) = exp(urgency_steepness × (1 - T / deadline_horizon))
```

- `T`: Time remaining (in hours)
- `deadline_horizon`: The horizon at which the deadline begins to register (e.g., 168 hours = 1 week)
- `urgency_steepness`: Steepness of the sharp rise (e.g., 3.0)

#### Curve Shape

```
urgency
  e^3 ┤━
 (~20) │━
      │ ━
      │  ━
   1.0┤   ━━
      │      ━━━━━
      │              ━━━━━━━━━━━━━━━━━━━━
      └──────────────────────────────────────→ Time remaining
       0h    24h   72h   168h (deadline_horizon)
```

When `T >= deadline_horizon`, `urgency = 1.0` (no urgency if the deadline is sufficiently far away). When `T = 0`, `urgency = exp(urgency_steepness)` (maximum value).

### Additional Design Notes

- **Score is strictly 0 for dimensions without a deadline**: Rather than leaving `urgency` undefined, it explicitly returns 0. This ensures safe mixing in subsequent combined calculations.
- **Handling overdue (past deadline)**: When `T < 0`, the score is capped at its maximum value. Tasks that are already late should remain the top priority.
- `deadline_horizon` and `urgency_steepness` are adjustable per goal. Set `deadline_horizon` shorter for short-term projects and longer for long-term ones.

---

## 3. Opportunity Drive

"Now is the moment. This window won't last long."

It captures moments when external conditions make addressing a particular dimension particularly advantageous. Opportunities expire rapidly over time.

### Score Formula

```
score_opportunity(dim) = opportunity_value(dim) × freshness_decay(time_since_detected(dim))
```

### Elements of opportunity_value

`opportunity_value` represents the "value" of an opportunity. It is determined by considering the following.

| Element | Description | Example |
|---------|-------------|---------|
| Downstream impact | How many other dimensions does improving this one affect? | "Fixing this unblocks 3 downstream tasks" |
| External favorable condition | The external environment makes addressing this dimension easier | "A new version of a dependency was released" |
| Timing fit | Season, cycle, or availability of human resources | "This team member is free only this week" |

Rather than simply summing these, the largest downstream impact is the primary factor, with the others treated as correction coefficients.

```
opportunity_value(dim) = downstream_impact(dim) × (1 + external_bonus(dim) + timing_bonus(dim))
```

### Definition of Each Input Variable

#### downstream_impact (Downstream Impact)

**Definition**: When this dimension is improved, how many other dimensions and goals in the goal tree are affected?

**Calculation**: Computed mechanically from the structure of the goal tree, without using an LLM.

```
downstream_impact(dim) = number_of_dependent_dimensions(dim) / total_dimensions_in_tree
```

- `number_of_dependent_dimensions(dim)`: Number of downstream dimensions that depend on this dimension
- `total_dimensions_in_tree`: Total number of dimensions in the goal tree

**Scale**: 0.0 to 1.0
- 0.0: An isolated dimension that has no effect on any other dimension
- 1.0: A critical path that affects nearly every dimension

**Example**: If the goal tree has 10 dimensions and the "revenue improvement" dimension affects 3 others ("promotion budget," "hiring budget," "capital expenditure") → `downstream_impact = 3/10 = 0.3`

---

#### external_bonus (External Favorable Condition Bonus)

**Definition**: A bonus granted when the external environment makes it advantageous to address this dimension.

**Source**: Triggered from the event queue defined in `drive-system.md`. Granted to the corresponding dimension when an external event (market change, user message, arrival of new data, dependency library update, etc.) is detected.

**Scale**: 0.0 to 0.5
- 0.0: No related external event (default)
- 0.25: Mild external favorable condition (e.g., related information was updated)
- 0.5: Strong external favorable condition (e.g., a competitor dropped out, a dependency was resolved)

**Default value**: 0.0 (when no related event exists)

```
external_bonus(dim) =
  0.0   // No related event in the event queue
  0.25  // Mild external favorable condition event present
  0.5   // Strong external favorable condition event present
```

---

#### timing_bonus (Timing Fit Bonus)

**Definition**: A bonus granted when there is a time-limited favorable timing for this dimension.

**Source**: LLM evaluation at strategy selection time. Determines whether time-limited advantages — such as seasonality, a competitor gap, or a team member's availability — exist for the dimension. This is the only opportunity drive input that calls an LLM.

**Scale**: 0.0 to 0.5
- 0.0: No time-limited advantage (default)
- 0.25: Mild time-based advantage (e.g., a team member's availability this week)
- 0.5: Strong time-based advantage (e.g., seasonal peak, competitor's slow period)

**Default value**: 0.0 (when LLM evaluation determines "no special timing")

```
timing_bonus(dim) =
  0.0   // No time-limited advantage
  0.25  // Mild time-based advantage present (LLM evaluation)
  0.5   // Strong time-based advantage present (LLM evaluation)
```

---

#### Possible Range of opportunity_value

The range of `opportunity_value` combining the three variables is as follows.

| downstream_impact | external_bonus | timing_bonus | opportunity_value |
|-------------------|----------------|--------------|-------------------|
| 0.0 | 0.0 | 0.0 | 0.0 (minimum: no opportunity) |
| 0.5 | 0.0 | 0.0 | 0.5 (downstream impact only) |
| 0.5 | 0.5 | 0.5 | 1.0 (downstream impact × maximum correction) |
| 1.0 | 0.5 | 0.5 | 2.0 (maximum: critical path × all corrections) |

The upper bound of `opportunity_value` is `1.0 × (1 + 0.5 + 0.5) = 2.0`. This value is attenuated by `freshness_decay` before being used in the final score.

### Design of freshness_decay

Opportunities expire rapidly from the moment they are detected. This is modeled using a half-life.

```
freshness_decay(t) = exp(-ln(2) × t / half_life)
```

- `t`: Time elapsed since the opportunity was detected
- `half_life`: Time for freshness to halve (default: 12 hours)

#### Freshness Decay

```
freshness_decay
  1.0 ┤━
      │ ━━
  0.5 ┤    ━━━━
      │          ━━━━━━
  0.25┤                ━━━━━━━━
      │                          ━━━━━━━━━━━━
      └──────────────────────────────────────→ Time elapsed
       0h     12h    24h    36h    48h
              ↑half-life
```

The score halves after 12 hours. After 48 hours, only about 6% of the original value remains. The design assumes that many opportunities cannot wait until "I'll deal with it tomorrow."

`half_life` varies by goal or opportunity type. A dependency library update may last days; a team member's availability may last hours; a seasonal timing window may last weeks.

---

## 4. Combining Scores

How to integrate the three scores into a final priority score.

### Comparison of Options

**Option A: Max**

```
final_score(dim) = max(score_dissatisfaction(dim), score_deadline(dim), score_opportunity(dim))
```

The strongest drive force dominates the priority decision.

- Simple and easy to interpret
- When one strong drive exists, it is not dragged down by other weak drives
- Even when multiple drives are simultaneously high, the score does not exceed the maximum — this can be a problem

**Option B: Weighted Sum**

```
final_score(dim) = w_d × score_dissatisfaction + w_dl × score_deadline + w_o × score_opportunity
```

All three drives are added together.

- When multiple drives overlap, the score becomes higher ("deadline is close AND the gap is large" = top priority)
- Requires weight tuning, which makes configuration complex
- Even if one dimension excels on a single drive, it can be overtaken by another dimension that has moderate scores on all three drives

### Recommended Decision: Max + Deadline Override

**Max** is adopted as the default.

There are three reasons. First, drives are not competitive — they are alternatives. It is natural for drive force to switch in the form of "this week there's an opportunity, so..." or "next week there's a deadline, so..." Second, interpretability supports transparency in priority decisions. Third, weight configuration for a weighted sum creates a high cognitive load for users.

However, a **Deadline Override Rule** is added.

```
if urgency(time_remaining(dim)) >= urgency_override_threshold:
    final_score(dim) = score_deadline(dim)  // Ignore other drives
```

Dimensions whose deadline is extremely close (those that exceed `urgency_override_threshold`) are made the top priority, ignoring the dissatisfaction and opportunity calculations. This is a hard rule to prevent the irrational judgment of "dealing with something else because there's an opportunity, even though the deadline is tomorrow."

### Note on Value Ranges

The value ranges of each drive score differ (Deadline Drive: urgency-dependent, 1.0 to 20.0; Dissatisfaction Drive: normalized_weighted_gap-dependent, 0.0 to 1.0+; Opportunity Drive: 0.0 to 2.0). Because the final score is selected by `max(score_deadline, score_dissatisfaction, score_opportunity)`, normalization of value ranges is not required — each drive force independently expresses the "strength of the reason to act on this dimension now," and the strongest reason is adopted. However, urgency's upper bound (~20) may dwarf the others. Near deadline, this is the intended behavior, but if needed, consider setting an upper cap on urgency (e.g., 10.0).

---

## 5. Visualization of Drive Scores

Illustrating the behavior of the three drives over time.

```
Score
 ↑
 │         ━━━━ Deadline Drive (exponential rise as deadline approaches)
 │        ━
 │       ━
 │      ━
 │     ━
 │    ━  ╌╌╌╌ Dissatisfaction Drive (gentle decay, temporary dip after an attempt)
 │   ━╌╌╌
 │ ·· ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │·····  ····· Opportunity Drive (rapid freshness decay after detection)
 │
 └──────────────────────────────────────────→ Time
   t=0     t+12h  t+24h  t+72h  (deadline)
```

- The Opportunity Drive peaks immediately after detection and decays rapidly
- The Dissatisfaction Drive is relatively stable but temporarily dips immediately after an attempt
- The Deadline Drive rises sharply as the deadline approaches, overwhelming the other drives

---

## 6. Separation Principle: Scoring vs. Task Generation

**Drive scoring decides "which dimension to tackle." Task generation decides "how to tackle it." These two are clearly separated.**

| Role | Responsible | Basis for decision |
|------|-------------|-------------------|
| Which dimension to prioritize | Drive scoring (code) | Gap quantity, time, and opportunity numbers |
| What tasks to create | Task generation (LLM) | Context, constraints, and past attempts for the prioritized dimension |

Without this separation, the LLM tends to select "interesting" or "familiar" things rather than "important" things. By having the drive score determine which dimension to focus on before passing it to the LLM, the LLM can concentrate on HOW (how to achieve it).

There is no room for the LLM to interfere with the priority decision. Code determines the priority dimension; the LLM only generates the approach for that dimension.

---

## 7. Pacing Control for Open-Ended Goals

Open-ended goals (e.g., "Live happily with my dog," "Maintain health") do not have the Deadline Drive applied (score = 0). Because they run on only the Dissatisfaction Drive and Opportunity Drive, a control mechanism is needed for "when and how often to run the loop." No deadline does not mean anytime is fine. The balance must be struck: a sustainable pace that does not miss changes while also not over-reacting.

### Activity Rhythm Design

Open-ended goals have both a minimum and maximum check interval configured.

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `min_check_interval` | No loop is run at shorter intervals than this | 1 hour |
| `max_check_interval` | A loop is forcibly run if this interval is exceeded | 24 hours |
| `current_interval` | Current adaptive check interval | Starts at `min_check_interval` |

The minimum interval prevents over-reaction to noise. The maximum interval prevents neglect. Within this range, the interval adaptively stretches or contracts based on the presence or absence of change (see "Change-Based Trigger" below).

`min_check_interval` and `max_check_interval` are adjustable based on the nature of the goal. Health monitoring (`min: 15 minutes, max: 4 hours`) and business objectives (`min: 6 hours, max: 72 hours`) differ by an order of magnitude.

### Burnout Prevention

Even with a large gap, if there is no deadline, there is no need to apply continuous intensive attention. Control rules for consecutive activity are set.

```
if consecutive_actions(goal) >= max_consecutive_actions:
    enter_cooldown(goal, cooldown_duration)
```

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `max_consecutive_actions` | Maximum number of tasks that can be consecutively generated and executed | 5 |
| `cooldown_duration` | Cooldown period after reaching the consecutive limit | 6 hours |

During the cooldown period, event-driven observation is still accepted (to avoid missing emergencies). However, generation of new tasks is suppressed.

**Design intent**: The essence of an open-ended goal is "persistence." Rather than burning out through short-term intensity, what matters is maintaining a steady level of attention over the long term. Without this constraint, open-ended goals with large gaps could over-consume resources through the Dissatisfaction Drive, crowding out other goals and degrading future loop quality.

### Change-Based Trigger (Adaptive Polling)

Running the loop when nothing has changed is pointless. The check interval adapts and stretches or contracts based on the degree of change.

```
after_observation(goal):
    change = abs(current_state - previous_state)  // Amount of change in normalized gap
    if change >= significant_change_threshold:
        current_interval = min_check_interval  // Change detected → reset to shortest interval
    else:
        current_interval = min(current_interval × backoff_factor, max_check_interval)
```

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `significant_change_threshold` | Threshold for what is considered a "meaningful change" | 0.05 (5% change in normalized gap) |
| `backoff_factor` | Interval growth multiplier when no change is detected | 1.5 |

#### Adaptive Polling Behavior Illustration

```
Check interval
 24h ┤                              ━━━━━━━━━━━━ max_check_interval
     │                     ━━━━━━━━
     │              ━━━━━━━
 6h  ┤        ━━━━━━
     │   ━━━━━
 1h  ┤━━━         ━━ ← Interval reset on change detection
     └──────────────────────────────────────→ Time
      Start   No-change period    Change detected
```

When there is no change, the interval gradually lengthens until it stabilizes at the maximum. When change is detected, it immediately resets to the shortest interval for intensive observation.

### Impact on Drive Scores

Pacing control does not affect the drive score calculation itself. The scoring formulas do not change. What pacing controls is "when to compute the scores" (the loop trigger timing). The separation principle between scoring and pacing mirrors the spirit of §6.

---

## Summary of Design Decisions

| Decision item | Choice | Rationale |
|---------------|--------|-----------|
| Gap input to drive score | normalized_weighted_gap ([0,1] normalized) | Enables direct comparison of dimensions with different units |
| Dissatisfaction Drive decay | Temporary dip after an attempt, recovers over time | Prevents fixation on a wall after repeated failures |
| Deadline curve shape | Exponential rise | Naturally expresses the tension of an approaching deadline |
| Dimensions without a deadline | Score is strictly 0 | Ensures safe mixing in calculations |
| Opportunity half-life | Default 12 hours | Models the short-lived nature of opportunities |
| Score combination method | Max + Deadline Override | Balances simplicity with a safety net |
| Priority decision | Code (drive score) decides | Eliminates LLM preference bias |
| Pacing control for open-ended goals | Adaptive polling + burnout prevention | Ensures sustainable long-term operation |
| Relationship between pacing and scoring | Separated (pacing controls only "when to compute") | Consistent with the separation principle of §6 |
