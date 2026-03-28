# Gap Calculation Design

This document describes how the gap between a goal's current state and its target state is quantified, along with the structure and design decisions behind gap calculation.

---

## 1. Raw Gap

The raw gap for each dimension is calculated differently depending on the threshold type. See `state-vector.md` section 2 for threshold type definitions.

### Raw Gap Formulas by Threshold Type

#### `min(N)` type (achieved when value >= N)

```
raw_gap(dim) = max(0, threshold - current_value)
```

- 0 if the current value meets or exceeds the threshold (achieved)
- The further below the threshold, the larger the raw_gap

#### `max(N)` type (achieved when value <= N)

```
raw_gap(dim) = max(0, current_value - threshold)
```

- 0 if the current value is at or below the threshold (achieved)
- The further above the threshold, the larger the raw_gap

#### `range(low, high)` type (achieved when value is within range)

```
raw_gap(dim) = max(0, low - current_value) + max(0, current_value - high)
```

- 0 if the current value is within the range (achieved)
- Below the lower bound: `low - current_value`
- Above the upper bound: `current_value - high`
- Deviations on either side are additive (amount depends on direction and distance from range)

#### `present` type (achieved when value exists)

```
raw_gap(dim) = 0  // when present
raw_gap(dim) = 1  // when absent
```

- Binary gap (0.0 or 1.0)

#### `match(value)` type (achieved when value matches a specific value)

```
raw_gap(dim) = 0  // when current == value
raw_gap(dim) = 1  // when current != value
```

- Binary gap (0.0 or 1.0)

### Guard Conditions

**Null values (initial state)**: When `current_value` is `null` (before the first observation), the raw_gap is treated as the maximum value.

```
When current_value is null:
  Numeric types (min/max/range) → raw_gap = maximum gap, treating the full threshold as unmet
  Binary types (present/match)  → raw_gap = 1
```

**Division by zero**: No division occurs in the `min`/`max`/`range` types (only addition/subtraction). However, if division is needed in the subsequent normalization step (`normalize_gap`), and the divisor is 0, the normalized gap is set to 1.0 (maximum unmet).

### Examples

| Dimension | Threshold type | Threshold | Current value | raw_gap |
|-----------|---------------|-----------|---------------|---------|
| Monthly revenue (¥10k) | `min(200)` | 200 | 120 | 80 |
| Churn rate | `max(0.05)` | 0.05 | 0.08 | 0.03 |
| Body temperature (°C) | `range(36.0, 37.0)` | 36.0–37.0 | 35.5 | 0.5 |
| Config file | `present` | — | exists | 0 |
| Status | `match("approved")` | "approved" | "pending" | 1 |
| Monthly revenue (before first observation) | `min(200)` | 200 | null | 200 (maximum gap) |

The raw gap is not yet a "trustworthy number" because it does not reflect observation accuracy.

---

## 2. Normalization

Each dimension's gap has a different unit (¥10k, ratio, integer, binary). Feeding gaps with mismatched units into drive scoring would directly compare "a ¥800k revenue gap" with "a 0.03 churn gap," always giving priority to the dimension with the larger absolute value. Normalization converts all dimension gaps to **[0, 1]** before passing them downstream.

### Normalization Formulas by Threshold Type

#### `min(N)` type

```
normalized_gap(dim) = raw_gap(dim) / threshold
```

- Expresses the gap as a fraction of the target value N
- **Guard condition**: If `threshold = 0`, set `normalized_gap = 1.0` when `raw_gap > 0`, and `0.0` when `raw_gap = 0`

#### `max(N)` type

```
normalized_gap(dim) = raw_gap(dim) / threshold
```

- Expresses the gap as a fraction of the upper bound N
- **Guard condition**: If `threshold = 0`, use `raw_gap` directly, capped at 1.0

#### `range(low, high)` type

```
normalized_gap(dim) = min(1.0, raw_gap(dim) / ((high - low) / 2))
```

- Expresses the gap as a fraction of the "half-width of the range" (the half-range is the reference scale)
- Capped at 1.0 (deviations beyond half the range width still return 1.0)

#### `present` type

```
normalized_gap(dim) = raw_gap(dim)   // already 0 or 1
```

- No normalization needed. raw_gap becomes normalized_gap directly.

#### `match(value)` type

```
normalized_gap(dim) = raw_gap(dim)   // already 0 or 1
```

- No normalization needed. raw_gap becomes normalized_gap directly.

#### Null values (before first observation)

```
When current_value is null:
  normalized_gap = 1.0   // maximum gap
```

Corresponds to the guard condition in section 1.

### Note on Binary Dimensions

`present` / `match` types produce jump values of 0 or 1. This causes binary dimensions in drive scoring to behave as "total domination at the moment they appear" or "complete disappearance at the moment of achievement."

In v1, this is left as-is (0/1). If biased prioritization is observed in practice, consider adding an option to apply a `binary_dampening_factor` (e.g., 0.5) to binary dimensions in the future.

### Normalized Gap Examples

| Dimension | Threshold type | raw_gap | Normalization basis | normalized_gap |
|-----------|---------------|---------|--------------------|--------------:|
| Monthly revenue (¥10k) | `min(200)` | 80 | ÷200 | 0.40 |
| Churn rate | `max(0.05)` | 0.03 | ÷0.05 | 0.60 |
| Body temperature (°C) | `range(36.0, 37.0)` | 0.5 | ÷((37.0–36.0)/2)=0.5 | 1.00 (capped) |
| Config file | `present` | 0 | — | 0.00 |
| Status | `match("approved")` | 1 | — | 1.00 |

The revenue gap (¥800k) has a normalized_gap of 0.40, which is smaller than the churn gap (0.03) at 0.60. Only by aligning units can we conclude "churn rate is the higher-priority issue right now."

---

## 3. Confidence-Weighted Gap

> **The only place confidence adjustment is applied**: This section applies the effect of confidence **exactly once** throughout the scoring pipeline. The progress ceiling in the observation layer (`observation.md` §4) is a quality gate on input data, and the effective achievement in `state-vector.md` §6 is a reference value for display purposes — this does not constitute triple-application. The pipeline order is: **raw observation (with progress ceiling applied) → state vector (values stored as-is) → gap calculation (confidence weighting applied here, once) → drive scoring**.

When observation confidence is low, the gap is estimated conservatively (i.e., inflated). This is applied after the normalization step.

### Full Pipeline

```
raw_gap → normalized_gap → normalized_weighted_gap
```

Definition of each step:

```
// Step 1: Calculate raw_gap using the formula from section 1
raw_gap(dim) = ...  (formula by threshold type)

// Step 2: Normalize using the formula from section 2
normalized_gap(dim) = raw_gap(dim) / normalize_denominator(dim)

// Step 3: Apply confidence weighting (on the normalized gap)
normalized_weighted_gap(dim) = normalized_gap(dim) × (1 + (1 - confidence(dim)) × uncertainty_weight)
```

- `confidence(dim)`: Observation confidence (0.0–1.0)
- `uncertainty_weight`: Parameter controlling how much uncertainty is amplified (see below)

This formula applies to all threshold types. For both numeric (`min`/`max`/`range`) and binary (`present`/`match`) types, if normalized_gap is 0, normalized_weighted_gap is also 0 (achieved status is unaffected). When normalized_gap > 0, lower confidence results in a larger penalty.

**However, confidence weighting is not applied when `current_value = null`.** In the null case, the guard condition from section 1 applies, locking normalized_gap at 1.0 (maximum). normalized_weighted_gap uses that maximum value directly — no double inflation from confidence weighting.

### Intuition

| confidence | uncertainty_weight | Amplification factor |
|------------|-------------------|---------------------|
| 1.0 (fully certain) | any | 1.0 (no change) |
| 0.5 (moderate) | 1.0 | 1.5× |
| 0.0 (completely unknown) | 1.0 | 2.0× |
| 0.0 (completely unknown) | 0.5 | 1.5× |

Dimensions with low confidence are treated as "possibly worse than we think," nudging the system to generate investigation tasks first. This is **intentionally conservative design**. Overestimating a problem is safer for task discovery than underestimating it.

### Design Rationale

The risk of treating something poorly understood as "no problem" is high. Especially for long-term goals, overlooked issues can become costly later. PulSeed should be designed to "fear what it cannot see."

---

## 4. The `uncertainty_weight` Parameter

`uncertainty_weight` controls how aggressively uncertainty is treated as a penalty.

### Global vs. Per-dimension

**Global setting** (a single value applied to all dimensions):
- Simple and consistent
- The overall "degree of conservatism" for the entire goal can be adjusted with one lever
- Recommended default: `uncertainty_weight = 1.0`

**Per-dimension setting** (different values per dimension):
- Allows higher values for high-stakes dimensions (security, cost, legal requirements, etc.)
- Higher configuration cost and cognitive load for the user
- Risk of encouraging overly fine-grained tuning

**Recommended decision**: Use global as the default, with per-dimension overrides as an option. Global is sufficient for most goals, but per-dimension settings are useful in domains where risk management is critical.

### Reference Values

| uncertainty_weight | Character | Use case |
|-------------------|-----------|---------|
| 0.5 | Mild | When reduced sensitivity to uncertainty is desired |
| 1.0 | Standard | Recommended default |
| 2.0 | Aggressive | Low-risk-tolerance goals (health, compliance, etc.) |

---

## 5. Multi-Dimensional Gap Representation (Gap Vector)

A goal has N dimensions, and the gap is represented as an N-dimensional vector.

```
gap_vector = [normalized_weighted_gap(dim_1), normalized_weighted_gap(dim_2), ..., normalized_weighted_gap(dim_N)]
```

This vector is the complete picture of "what is lacking." Every element is normalized to [0, 1], enabling direct cross-dimensional comparison. By keeping the vector form rather than collapsing it into a single scalar, each dimension can be addressed individually.

### Completion Determination

A goal is considered complete when the gap of every dimension is zero (`normalized_weighted_gap(dim) = 0` for all dim). This is the common completion condition for all threshold types (binary types indicate achievement when raw_gap = 0; numeric types produce raw_gap = 0 when the threshold is met). Dimensions where achievement was determined solely from low-confidence observations will have a verification task inserted before completion.

---

## 6. Gap Aggregation to Parent Goals

Goals have a tree structure. How child goal gaps are rolled up to the parent is an important design decision.

### Comparison of Options

All aggregation operates on **normalized gaps** (`normalized_weighted_gap`). Since normalization brings all child goal gaps into [0, 1], aggregation across child goals with different units is meaningful.

**Max**: The child with the largest gap determines the parent's gap.

```
parent_gap = max(normalized_weighted_gap(child_1), ..., normalized_weighted_gap(child_K))
```

- "The weakest link determines the overall strength" approach
- Fits sequentially dependent goals where a single failure collapses the parent goal
- Improvements in small child goals are less likely to be reflected in the parent score, which can reduce motivation

**Weighted Average**: Children are averaged with weights applied.

```
parent_gap = Σ(weight_k × normalized_weighted_gap(child_k)) / Σ(weight_k)
```

- Fits parallel goals where multiple contributions accumulate independently
- Weights make it clear which child goal to improve for the greatest effect

**Sum**: Simple sum of child gaps.

```
parent_gap = Σ(normalized_weighted_gap(child_k))
```

- Goal size is amplified by the number of child goals, making comparison difficult
- Weighted average is generally more manageable

### Recommended Decision

**The default is bottleneck aggregation (worst-dimension priority)**, which takes the **maximum (Max)** among child goal gaps. This is the "weakest link determines the overall strength" approach.

> **Terminology note**: `state-vector.md` §4 uses the term "min aggregation," but this refers to the achievement (not gap) space. Taking the "maximum gap (Max)" in gap space is equivalent to taking the "minimum achievement (Min)" in achievement space. Both documents refer to the same bottleneck-priority approach; only the representation of the space differs.

Rationale: The most lagging child goal is the bottleneck for achieving the parent goal, making this conservative judgment consistent with the satisficing principle.

"Only achievable when all pieces are in place" type goals (e.g., a product release — can't ship without code, QA, deployment infrastructure, and documentation all ready) are exactly where bottleneck aggregation is appropriate. For parallel-independent goals (where multiple contributions complement each other), consider using weighted average. The aggregation method should be configurable at goal definition time.

---

## 7. Connecting the Gap Vector to Drive Scores

The gap vector feeds directly into three drive score calculations. Each drive type reads the gap differently.

**Important**: All gap values fed into drive scoring are `normalized_weighted_gap` (normalized and confidence-weighted). Intermediate values `raw_gap` and `normalized_gap` are used only for internal calculations and are never passed to drive scoring.

| Drive type | How gap is interpreted | Input value |
|-----------|----------------------|-------------|
| Dissatisfaction-driven | Relative magnitude of gap (0–1, larger = higher priority) | `normalized_weighted_gap(dim)` |
| Deadline-driven | Relative gap amount × remaining time (more urgent = higher priority) | `normalized_weighted_gap(dim)` |
| Opportunity-driven | Efficiency of addressing gap (amplified by spillover effects) | `normalized_weighted_gap(dim)` |

Normalization enables "a ¥800k revenue shortfall" and "a 0.03 churn excess" to be compared on the same scale (0.40 vs 0.60), so drive scores make priority decisions independent of dimension units.

The gap vector itself is a neutral factual record. It only shows "what is lacking"; "what to do now" is determined by drive scores. This separation allows different prioritization decisions from the same gap information depending on context.

See `drive-scoring.md` for details.

---

## 8. Gap History and Change Tracking

A snapshot of the gap vector is recorded at the end of each iteration (one loop).

```
gap_history[t] = gap_vector at iteration t
gap_delta[t]   = gap_history[t-1] - gap_history[t]   // positive means improvement
```

### What Is Recorded

| Field | Content |
|-------|---------|
| `iteration` | Loop number |
| `timestamp` | Time of recording |
| `gap_vector` | normalized_weighted_gap for each dimension |
| `confidence_vector` | Confidence snapshot for each dimension |

### Uses

- **Input for stall detection**: If `gap_delta` is near zero for N consecutive iterations, a stall is declared. The threshold and N are managed by the stall detection module (see `stall-detection.md`).
- **Strategy evaluation**: Assess whether the gap narrowed before and after adopting a particular strategy.
- **Learning**: Accumulate patterns about which dimensions are easy to improve and which are stubborn.

Gap history is persisted as part of the goal state file in a file-based format.

---

## Summary of Design Decisions

| Decision | Choice | Rationale |
|---------|--------|-----------|
| Raw gap calculation | 5 formulas by threshold type | "Achievement" means something different per type; a uniform subtraction cannot express this |
| Null values (initial state) | Treated as maximum gap (normalized_gap = 1.0) | Eliminates the risk of treating an unobserved state as "no problem" |
| Division-by-zero guard | Return normalized gap = 1.0 when divisor = 0 at normalization | Return maximum unmet as a safe default |
| Normalization | Convert to [0, 1] per-type formula (raw_gap → normalized_gap) | Enables direct comparison across dimensions with different units |
| Pipeline order | raw_gap → normalized_gap → normalized_weighted_gap | Normalize first, then apply confidence weighting to the normalized value |
| Binary dimension normalization | No normalization needed (remain 0/1); no dampening in v1 | Prioritize simplicity; add dampening option if problems are observed |
| Handling uncertainty | Inflate conservatively (null excluded) | The cost of overlooking is higher |
| uncertainty_weight | Global default + per-dimension override | Balance simplicity with flexibility |
| Gap representation | Keep as a vector (elements are normalized_weighted_gap) | Enables both per-dimension handling and cross-unit comparison |
| Parent goal aggregation | Default is bottleneck aggregation = Max gap (aggregating normalized_weighted_gap) | Weakest dimension is the bottleneck; consistent with the satisficing principle |
| History recording | Snapshot every iteration | Foundation for stall detection and learning |
