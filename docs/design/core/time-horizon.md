# Time Horizon Engine Design

How PulSeed develops temporal awareness: evaluating whether goal progress is on pace relative to deadlines, projecting completion dates, and emitting signals that influence drive scoring and strategy selection. TimeHorizonEngine is the bridge between "how far are we from the goal?" (gap) and "do we have enough time?" (temporal budget).

> Current implementation note: TimeHorizonEngine now influences a CoreLoop that may also run bounded agentic phases and native AgentLoop task execution. The temporal model still applies, but the surrounding orchestration is no longer a single flat loop body.

As a prerequisite, see `drive-scoring.md` for the drive scoring structure and `stall-detection.md` for stall detection.

---

## 1. Why Time Horizon Awareness Is Necessary

DriveScorer already has a Deadline Drive that raises urgency as a deadline approaches. But this is a purely time-based signal — it does not consider whether progress is actually happening fast enough.

Consider:
- A 6-month goal at the 3-month mark with 80% gap remaining. Deadline is far away (low urgency), but the pace is catastrophically behind
- A 1-week goal at the 5-day mark with only 10% gap remaining. Deadline is close (high urgency), but progress is well ahead

The Deadline Drive gets both of these wrong. TimeHorizonEngine corrects this by comparing **required velocity** against **actual velocity**.

Without temporal pacing:
- PulSeed cannot distinguish "on schedule" from "falling behind" until the deadline is imminent
- Strategy switches happen too late (only when urgency spikes)
- No burn-down visibility for the user
- Perpetual goals (no deadline) have no pace tracking at all

### Relationship to MilestoneEvaluator

`MilestoneEvaluator` (in `src/orchestrator/goal/milestone-evaluator.ts`) already provides `evaluatePace()`, which returns a `PaceSnapshot` with a `pace_ratio` and status (`on_track` / `at_risk` / `behind`). This is **not** replaced by TimeHorizonEngine. The responsibilities are distinct:

| Module | Responsibility |
|--------|---------------|
| `MilestoneEvaluator.evaluatePace()` | Per-milestone pass/fail based on achievement vs. elapsed ratio (achievement-centric) |
| `TimeHorizonEngine` | Velocity projection, burn-down, adaptive intervals, WaitStrategy budget, DriveScorer integration (time-centric) |

TimeHorizonEngine **may** consume `MilestoneEvaluator.evaluatePace()` internally as a cross-check, or operate independently using the velocity-based approach described here. The key addition is the **DriveScorer/StrategyManager signal pathway** that MilestoneEvaluator lacks.

---

## 2. Core Concepts

### 2.1 Pacing Status

Every goal with sufficient observation history receives a pacing status:

| Status | Pacing Ratio | Meaning |
|--------|-------------|---------|
| `ahead` | < 0.8 | Progress faster than needed |
| `on_track` | 0.8 - 1.2 | Healthy pace |
| `behind` | 1.2 - 2.0 | Falling behind, attention needed |
| `critical` | > 2.0 | Unlikely to meet deadline at current pace |
| `no_deadline` | n/a | Perpetual goal, velocity-only tracking |

**Pacing ratio** = required velocity / actual velocity. A ratio of 1.5 means you need to go 1.5x faster than you currently are.

### 2.2 Progress Velocity

Rate of gap reduction over recent observations, calculated as an exponential moving average (EMA):

```
velocity_ema(n) = alpha * velocity(n) + (1 - alpha) * velocity_ema(n-1)
```

Where:
- `velocity(n) = (gap[n-1] - gap[n]) / time_between_observations`
- `alpha`: smoothing factor (default 0.3 — responsive but not noisy)

EMA weights recent observations more heavily, adapting quickly to velocity changes without overreacting to single outliers.

### 2.3 Burn-down Projection

```
projected_remaining_hours = remaining_gap / velocity_ema
projected_completion = now + projected_remaining_hours
```

A confidence interval is derived from velocity variance:
- Optimistic: completion at `velocity_ema + 1 stddev`
- Pessimistic: completion at `max(velocity_ema - 1 stddev, epsilon)`

### 2.4 Time Budget

A structured view of how time has been spent and what remains:

```
total_hours     = deadline - start_time
elapsed_hours   = now - start_time
remaining_hours = deadline - now
percent_elapsed = elapsed_hours / total_hours
percent_gap_remaining = current_gap / initial_gap
```

The time budget is the interface for WaitStrategy (future module): "Can I afford to wait N hours?"

---

## 3. Interface Design

### 3.1 TimeHorizonEngine

```typescript
interface ITimeHorizonEngine {
  evaluatePacing(
    goalId: string,
    currentGap: number,
    deadline: string | null,
    history: GapObservation[]
  ): PacingResult;

  projectCompletion(
    velocity: number,
    velocityStddev: number,
    remainingGap: number
  ): CompletionProjection;

  suggestObservationInterval(
    pacingResult: PacingResult,
    baseIntervalMs: number
  ): number;

  getTimeBudget(
    goalId: string,
    deadline: string | null,
    startTime: string,
    currentGap: number,
    initialGap: number
  ): TimeBudget;
}
```

### 3.2 PacingResult

```typescript
interface PacingResult {
  status: "ahead" | "on_track" | "behind" | "critical" | "no_deadline";
  velocityPerHour: number;
  velocityStddev: number;
  projectedCompletionDate: string | null;
  timeRemainingHours: number | null;
  pacingRatio: number | null;
  confidence: number; // 0-1, based on observation count
  recommendation: PacingRecommendation;
}

type PacingRecommendation =
  | "maintain_course"
  | "increase_effort"
  | "consider_strategy_change"
  | "escalate_to_user"
  | "sustainable_pace_ok"
  | "sustainable_pace_declining";
```

### 3.3 TimeBudget

```typescript
interface TimeBudget {
  totalHours: number | null;
  elapsedHours: number;
  remainingHours: number | null;
  percentElapsed: number | null;
  percentGapRemaining: number;

  canAffordWait(waitHours: number): boolean;
}
```

`canAffordWait` returns true if, after subtracting `waitHours` from remaining time, the required velocity at the current gap is still achievable (within 2x current velocity).

**Negative velocity case**: When `velocityPerHour <= 0` (regression or stall), `canAffordWait` always returns `false` regardless of remaining time. A negative or zero velocity means the gap is not closing — any wait only makes the situation worse, and projecting completion is meaningless.

### 3.4 CompletionProjection

```typescript
interface CompletionProjection {
  estimatedDate: string | null;
  confidenceInterval: {
    optimistic: string;
    pessimistic: string;
  } | null;
  isAchievable: boolean;
}
```

### 3.5 GapObservation (input data)

```typescript
interface GapObservation {
  timestamp: string; // ISO 8601
  normalizedGap: number; // 0-1
}
```

---

## 4. Pacing Algorithm

### 4.1 Velocity Calculation

```
Given observations: [(t0, g0), (t1, g1), ..., (tn, gn)]
For each consecutive pair:
  point_velocity(i) = (g[i-1] - g[i]) / (t[i] - t[i-1])  // gap reduction per hour

EMA:
  v_ema(0) = point_velocity(0)
  v_ema(i) = alpha * point_velocity(i) + (1 - alpha) * v_ema(i-1)

Stddev: rolling standard deviation of last window_size point velocities
```

Negative velocity (gap increasing) is preserved — it means regression.

### 4.2 Pacing Ratio

```
required_velocity = remaining_gap / remaining_hours
pacing_ratio = required_velocity / max(velocity_ema, epsilon)
```

`epsilon` prevents division by zero when velocity is near zero.

### 4.3 Status Classification

```
if no deadline:           status = "no_deadline"
elif pacing_ratio < 0.8:  status = "ahead"
elif pacing_ratio < 1.2:  status = "on_track"
elif pacing_ratio < 2.0:  status = "behind"
else:                     status = "critical"
```

### 4.4 Confidence

```
confidence = min(1.0, observation_count / min_observations_for_projection)
```

Below `min_observations_for_projection` (default: 3), projections are unreliable. PacingResult is still emitted but with low confidence, and consumers should weight it accordingly.

### 4.5 Recommendation Mapping

| Status | Confidence >= 0.6 | Confidence < 0.6 |
|--------|-------------------|-------------------|
| `ahead` | `maintain_course` | `maintain_course` |
| `on_track` | `maintain_course` | `maintain_course` |
| `behind` | `consider_strategy_change` | `increase_effort` |
| `critical` | `escalate_to_user` | `consider_strategy_change` |
| `no_deadline` (velocity declining) | `sustainable_pace_declining` | `sustainable_pace_declining` |
| `no_deadline` (velocity stable) | `sustainable_pace_ok` | `sustainable_pace_ok` |

---

## 5. Integration Points

### 5.1 DriveScorer

TimeHorizonEngine augments the existing Deadline Drive. The current `scoreDeadline()` uses raw time remaining. TimeHorizonEngine adds a **pacing bonus** on top of the existing urgency.

**DriveContext schema extension**: A new `pacing` field is added to `DriveContext` (the existing `deadlines` field is not modified):

```typescript
DriveContextSchema = z.object({
  time_since_last_attempt: z.record(z.string(), z.number()),
  deadlines: z.record(z.string(), z.number().nullable()),  // unchanged
  opportunities: z.record(z.string(), z.object({
    value: z.number(),
    detected_at: z.string(),
  })),
  pacing: z.record(z.string(), z.object({
    pacingRatio: z.number().nullable(),
    pacingStatus: z.enum(["ahead", "on_track", "behind", "critical", "no_deadline"]),
  })).default({}),
})
```

**scoreDeadline signature extension**: An optional `pacingRatio` parameter is added:

```typescript
scoreDeadline(
  normalizedWeightedGap: number,
  timeRemainingHours: number | null,
  config?: DriveConfig,
  pacingRatio?: number | null   // new optional parameter
): DeadlineScore
```

**Additive pacing bonus formula**:

```
pacing_bonus = max(0, (pacing_ratio - 1.0)) * pacing_urgency_weight
effective_urgency = base_urgency(T) + pacing_bonus
```

Where `pacing_urgency_weight` (default: 0.5) controls how strongly pacing affects urgency.

- When `pacingRatio <= 1.0` (on track or ahead): `pacing_bonus = 0`, no change to urgency
- When `pacingRatio > 1.0` (behind or critical): a positive bonus is added to the existing urgency
- The bonus is **additive**, not multiplicative — it preserves the existing urgency curve shape and compounds naturally when both time and pace are unfavorable

When `pacingRatio` is not provided (no deadline or insufficient history), `scoreDeadline` behaves exactly as before.

### 5.2 StrategyManager

When `PacingResult.recommendation` is `consider_strategy_change`, TimeHorizonEngine emits a signal:

```typescript
interface PacingAlert {
  type: "PACING_ALERT";
  goalId: string;
  status: PacingStatus;
  pacingRatio: number;
  currentStrategy: string | null;
}
```

StrategyManager listens for `PACING_ALERT` and triggers strategy re-evaluation. This replaces the current approach of waiting until urgency is already high.

### 5.3 StallDetector

TimeHorizonEngine does **not** modify StallDetector directly. Instead, it provides the `TimeBudget` interface that the future WaitStrategy module will use to distinguish stalls from waits.

The connection point: StallDetector flags a stall -> WaitStrategy (future) checks `timeBudget.canAffordWait(estimatedEffectDelay)` -> if affordable, suppress the stall signal.

### 5.4 CoreLoop

TimeHorizonEngine is called in the **drive-scoring phase**, after gap calculation but before task generation:

```
observe -> gap calculation -> [TIME HORIZON] -> drive scoring -> task generation -> execute -> verify
```

The CoreLoop passes:
1. Current gap (from gap calculation)
2. Goal deadline
3. Recent observation history

And receives:
1. PacingResult (forwarded to DriveScorer context)
2. Suggested observation interval (used for next loop scheduling)

### 5.5 GoalTreeManager

For hierarchical goals, pacing is evaluated per-leaf goal and aggregated to the parent:

```
parent_pacing_ratio = max(child_pacing_ratios)  // bottleneck aggregation
```

This follows the existing bottleneck aggregation pattern used in gap calculation. The parent is only as on-track as its most-behind child.

---

## 6. Perpetual Goals (No Deadline)

Goals without deadlines cannot have a pacing ratio. Instead, TimeHorizonEngine tracks velocity trends:

### 6.1 Sustainability Check

```
recent_velocity = EMA of last N observations
historical_velocity = EMA of all observations

if recent_velocity < historical_velocity * (1 - decline_threshold):
  recommendation = "sustainable_pace_declining"
else:
  recommendation = "sustainable_pace_ok"
```

Default `decline_threshold`: 0.3 (30%).

### 6.2 What Perpetual Goals Get

- Velocity tracking (trend direction)
- Sustainability alerts (pace declining)
- No burn-down projection
- No pacing ratio
- No urgency amplification in DriveScorer

---

## 7. Adaptive Observation Frequency

Based on pacing status, TimeHorizonEngine suggests adjusting the loop interval:

| Status | Interval Multiplier (×base) | Rationale |
|--------|----------------------------|-----------|
| `critical` | 1.0 | Maximum attention — observe every cycle |
| `behind` | 0.5 | Increased frequency to detect recovery |
| `on_track` | 1.0 | Normal pace |
| `ahead` | 2.0 | Reduce cost — things are going well |
| `no_deadline` | 1.5 | Slightly relaxed |

> **Note**: Values < 1.0 shorten the interval (more frequent observations). Values > 1.0 lengthen it (less frequent). The multiplier is applied to the base observation interval configured for the goal. This is a suggestion — CoreLoop may override based on other factors.

---

## 8. Configuration

```typescript
interface TimeHorizonConfig {
  /** Observation count for EMA window. Default: 10 */
  velocity_window_size: number;

  /** EMA smoothing factor. Higher = more responsive. Default: 0.3 */
  velocity_ema_alpha: number;

  /** Pacing ratio thresholds */
  pacing_thresholds: {
    ahead: number;    // default: 0.8
    behind: number;   // default: 1.2
    critical: number; // default: 2.0
  };

  /** Minimum observations before projections are emitted. Default: 3 */
  min_observations_for_projection: number;

  /** Velocity decline % that triggers sustainable_pace_declining. Default: 0.3 */
  sustainable_pace_decline_threshold: number;

  /** How strongly pacing amplifies urgency (0 = disabled). Default: 0.5 */
  pacing_urgency_weight: number;

  /** Observation interval multipliers by status */
  observation_interval_multipliers: {
    critical: number;   // default: 1.0
    behind: number;     // default: 0.5
    on_track: number;   // default: 1.0
    ahead: number;      // default: 2.0
    no_deadline: number; // default: 1.5
  };
}
```

All values have sensible defaults. Configuration is per-engine instance (not per-goal), but individual goals can override `pacing_thresholds` via goal metadata in future iterations.

---

## 9. Module Location

| Item | Path |
|------|------|
| Source | `src/platform/time/time-horizon-engine.ts` |
| Types | `src/base/types/time-horizon.ts` |
| Tests | `src/platform/time/__tests__/time-horizon-engine.test.ts` |
| Config | Merged into `DriveConfig` or standalone `TimeHorizonConfig` |

Injected via DI into CoreLoop, following the same pattern as DriveScorer and StallDetector.

---

## 10. Future: WaitStrategy Hook

TimeHorizonEngine exposes `getTimeBudget()` which the future WaitStrategy module will consume.

The interaction:
1. A task executes (e.g., a marketing campaign)
2. StallDetector flags: "no gap improvement in N iterations"
3. WaitStrategy (future) asks TimeHorizon: `canAffordWait(estimatedEffectDelayHours)`?
4. TimeHorizon checks: remaining_hours minus wait_hours, can required velocity still be met?
5. If yes -> suppress stall, enter wait mode
6. If no -> stall is real, escalate

This separation keeps responsibilities clean:
- **TimeHorizonEngine**: "How much time do we have?" (accounting)
- **WaitStrategy**: "Should we wait or act?" (decision)
- **StallDetector**: "Is progress happening?" (detection)

---

## 11. Design Decisions

### Why EMA instead of simple average?

Simple average weights all observations equally. A goal that was stuck for weeks but started moving yesterday would still show low velocity. EMA with alpha=0.3 gives ~86% weight to the last 5 observations, making it responsive to recent changes while smoothing noise.

### Why pacing ratio instead of time-remaining only?

Time-remaining (the current Deadline Drive) is a countdown timer. It says "deadline is soon" but not "you're behind." Pacing ratio connects the gap (how much work) with the clock (how much time), which is what the user actually needs to know.

### Why bottleneck aggregation for parent goals?

A parent goal with 5 children, 4 ahead and 1 critical, is effectively critical. The ahead children cannot compensate for the behind one. This matches the existing gap aggregation pattern and reflects reality: a project is as delayed as its most delayed component.

### Why not replace scoreDeadline?

The existing Deadline Drive is well-tested and serves its purpose: raw time urgency. TimeHorizonEngine adds a pacing dimension on top of it. Replacing would break the three-drive model (dissatisfaction/deadline/opportunity). Instead, pacing amplifies the deadline signal when pace data is available, and falls back to pure time urgency when it isn't.

---

## Summary of Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Velocity method | EMA (alpha=0.3) | Responsive to recent changes, smooths noise |
| Pacing thresholds | 0.8/1.2/2.0 | Conservative band; avoids false alarms |
| DriveScorer integration | Additive pacing_bonus | Preserves existing urgency curve, compounds when both signals fire |
| Perpetual goals | Velocity trend only | No artificial urgency without deadline |
| Parent pacing | Bottleneck (max ratio) | Matches existing gap aggregation pattern |
| canAffordWait with negative velocity | Always false | Cannot project completion when regressing |
| Existing MilestoneEvaluator | Complement, not replace | MilestoneEvaluator handles milestone pass/fail; TimeHorizon handles pace projection |
