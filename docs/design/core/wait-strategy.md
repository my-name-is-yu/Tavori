# Wait Strategy Design

How PulSeed distinguishes "waiting for an effect to materialize" from "stalled with no progress." WaitStrategy sits between action execution and observation, estimating how long an effect takes to become observable, suppressing false stall detections during that window, and adaptively scheduling re-observation.

As a prerequisite, see `time-horizon.md` for temporal budget accounting, `stall-detection.md` for stall detection mechanics, and `task-lifecycle.md` for `plateau_until`.

---

## 1. Why Wait Strategy Is Necessary

After PulSeed executes an action (e.g., tells an agent to write code, deploys a change, submits a PR), there is a latency before the effect is observable. The current system has three blind spots:

1. **Wasteful observation**: CoreLoop observes every iteration. When an agent is still writing code, observing accomplishes nothing except burning tokens on LLM calls that will report "no change."

2. **False stall detection**: StallDetector sees N iterations of no gap improvement and flags a stall. But the lack of progress is expected -- the action's effect has not had time to materialize. The graduated response (strategy switch, escalation) fires prematurely.

3. **No latency model**: PulSeed has no way to estimate "this type of action typically takes X minutes before results appear." Every action is treated as instantaneous.

The existing `plateau_until` field (stall-detection.md SS2.5) partially addresses this: if set, stall detection is suppressed. But `plateau_until` requires the strategy layer to set it explicitly at task generation time. WaitStrategy automates this by estimating effect latency based on action type, adapter characteristics, and historical data.

### Relationship to plateau_until

| Mechanism | Who sets it | When | Scope |
|-----------|------------|------|-------|
| `plateau_until` | Strategy layer (LLM at task generation) | Before execution | Specific task/dimension |
| WaitStrategy | Automatic (post-execution) | After execution | Per-action, goal-wide |

WaitStrategy does not replace `plateau_until`. It complements it: `plateau_until` is the explicit "I know this will take time" signal from the strategy layer; WaitStrategy is the automatic "this action type historically takes N seconds" signal from execution history. When both are present, the longer window wins.

---

## 2. Core Concepts

### 2.1 Wait State Lifecycle

An action moves through a lifecycle after execution:

```
EXECUTED -> WAITING -> OBSERVABLE -> (observed)
         |          |             |
         |          |             +-- Effect has materialized, observe now
         |          +-- Within estimated latency window
         +-- Action just completed, wait begins
```

**State transitions**:

| From | To | Trigger |
|------|-----|---------|
| EXECUTED | WAITING | Action completes, WaitStrategy sets estimated wait |
| WAITING | OBSERVABLE | Estimated wait expires OR early signal detected |
| WAITING | OBSERVABLE | TimeHorizonEngine says cannot afford to wait longer |
| OBSERVABLE | (exit) | CoreLoop observes, wait state cleared |

### 2.2 Effect Latency

The time between executing an action and when its effect becomes observable. This varies by:

- **Action type**: A code change is observable in seconds (run tests). A deployment takes minutes. A marketing campaign takes days.
- **Adapter type**: CLI adapters complete synchronously (low latency). API adapters may be asynchronous (higher latency). Human-in-the-loop has unbounded latency.
- **Historical performance**: Past actions of the same type provide empirical latency data.

### 2.3 Observation Cooldown

When a wait state is active, CoreLoop skips full observation and instead checks only whether the wait should continue. This saves LLM tokens and prevents StallDetector from accumulating "no change" snapshots.

During cooldown, CoreLoop can still perform lightweight checks (e.g., polling adapter status) without triggering a full observation cycle.

### 2.4 Wait Budget

Not all waits are affordable. WaitStrategy consults `TimeHorizonEngine.canAffordWait()` before entering a wait state. If the time budget cannot accommodate the estimated wait, the wait is shortened or skipped entirely.

---

## 3. Type Definitions

### 3.1 WaitState

```typescript
const WaitPhaseEnum = z.enum(["waiting", "observable"]);
type WaitPhase = z.infer<typeof WaitPhaseEnum>;

const WaitStateSchema = z.object({
  goalId: z.string(),
  taskId: z.string(),
  actionType: z.string(),
  adapterType: z.string(),
  phase: WaitPhaseEnum,
  startedAt: z.string(),               // ISO 8601
  estimatedLatencyMs: z.number().min(0),
  maxWaitMs: z.number().min(0),         // hard ceiling (from time budget)
  elapsedMs: z.number().min(0),
  reason: z.string(),                   // human-readable explanation
});
type WaitState = z.infer<typeof WaitStateSchema>;
```

### 3.2 EffectLatencyEstimate

```typescript
const EffectLatencyEstimateSchema = z.object({
  estimatedMs: z.number().min(0),
  confidence: z.number().min(0).max(1),
  method: z.enum(["heuristic", "historical", "llm"]),
  basis: z.string(),                    // explanation of how estimate was derived
});
type EffectLatencyEstimate = z.infer<typeof EffectLatencyEstimateSchema>;
```

### 3.3 WaitStrategyConfig

```typescript
const WaitStrategyConfigSchema = z.object({
  /** Default latency by action category (ms). */
  default_latencies: z.object({
    code_change: z.number().default(5_000),
    test_execution: z.number().default(30_000),
    deployment: z.number().default(120_000),
    api_call: z.number().default(10_000),
    human_action: z.number().default(300_000),
    unknown: z.number().default(30_000),
  }).default({}),

  /** Multiplier applied to historical average to get estimate. Default: 1.5 */
  historical_buffer_multiplier: z.number().default(1.5),

  /** Minimum observations before using historical estimate. Default: 3 */
  min_history_for_estimate: z.number().default(3),

  /** Maximum wait regardless of estimate (ms). Default: 600_000 (10 min) */
  absolute_max_wait_ms: z.number().default(600_000),

  /** EMA alpha for latency history tracking. Default: 0.3 */
  latency_ema_alpha: z.number().default(0.3),

  /** Whether to use LLM for latency estimation when heuristic confidence is low. Default: false */
  enable_llm_estimation: z.boolean().default(false),
});
type WaitStrategyConfig = z.infer<typeof WaitStrategyConfigSchema>;
```

### 3.4 WaitDecision

```typescript
const WaitDecisionSchema = z.object({
  shouldWait: z.boolean(),
  waitMs: z.number().min(0),
  reason: z.string(),
  suppressStall: z.boolean(),
  estimate: EffectLatencyEstimateSchema,
});
type WaitDecision = z.infer<typeof WaitDecisionSchema>;
```

### 3.5 LatencyRecord (historical tracking)

```typescript
const LatencyRecordSchema = z.object({
  actionType: z.string(),
  adapterType: z.string(),
  actualLatencyMs: z.number().min(0),
  recordedAt: z.string(),
});
type LatencyRecord = z.infer<typeof LatencyRecordSchema>;
```

---

## 4. API

### 4.1 WaitStrategy Class

```typescript
class WaitStrategy {
  constructor(
    config: WaitStrategyConfig,
    timeHorizonEngine: ITimeHorizonEngine,
    llmClient?: ILlmClient,
  );

  /**
   * After an action executes, decide whether to wait before observing.
   * Consults time budget, latency estimate, and stall state.
   */
  decideWait(params: {
    goalId: string;
    taskId: string;
    actionType: string;
    adapterType: string;
    currentGap: number;
    deadline: string | null;
    startTime: string;
    initialGap: number;
    gapHistory: GapObservation[];
  }): Promise<WaitDecision>;

  /**
   * Check whether an active wait should continue or transition to observable.
   * Called each CoreLoop tick during a wait.
   */
  checkWait(waitState: WaitState): WaitCheckResult;

  /**
   * Record actual latency after observation confirms effect materialized.
   * Updates historical EMA for future estimates.
   */
  recordLatency(
    actionType: string,
    adapterType: string,
    actualLatencyMs: number,
  ): void;

  /**
   * Estimate effect latency for an action type.
   * Uses historical data if available, falls back to heuristic, optionally LLM.
   */
  estimateLatency(
    actionType: string,
    adapterType: string,
  ): Promise<EffectLatencyEstimate>;

  /**
   * Get all active wait states (for reporting/UI).
   */
  getActiveWaits(): WaitState[];

  /**
   * Force-expire a wait (e.g., user intervention or deadline pressure).
   */
  expireWait(goalId: string): void;
}
```

### 4.2 WaitCheckResult

```typescript
interface WaitCheckResult {
  phase: "waiting" | "observable";
  remainingMs: number;
  shouldObserve: boolean;
  reason: string;
}
```

---

## 5. Integration Points

### 5.1 CoreLoop

WaitStrategy is called at two points in the loop:

**After execution** (between execute and verify):

```
observe -> gap -> score -> decide -> execute -> [WAIT DECISION] -> verify
```

After a task executes, CoreLoop calls `waitStrategy.decideWait()`. If `shouldWait` is true, the loop records the WaitState and skips to the next iteration without observing.

**Before observation** (loop start):

```
[CHECK WAITS] -> observe (or skip) -> gap -> score -> ...
```

At the top of each iteration, CoreLoop calls `waitStrategy.checkWait()` for any active WaitState. If the wait is still active (`phase === "waiting"`), CoreLoop skips full observation for that goal. If `phase === "observable"`, CoreLoop proceeds with normal observation and clears the wait state.

**CoreLoop changes summary**:

| Current behavior | New behavior |
|-----------------|-------------|
| Always observe every iteration | Check wait state first; skip observation if waiting |
| Always pass gap snapshots to StallDetector | Exclude snapshots taken during wait periods |
| Fixed iteration timing | Next iteration scheduled based on wait expiry |

### 5.2 StallDetector

WaitStrategy does not modify StallDetector internals. Instead, it provides a suppression signal that CoreLoop uses to filter what StallDetector sees.

**Mechanism**: When a wait is active for a goal, CoreLoop does not feed gap snapshots to StallDetector for that goal's dimensions. This prevents the sliding window from filling with "no change" entries during a legitimate wait.

When the wait expires and observation resumes, gap snapshots flow to StallDetector normally. If the post-wait observation still shows no improvement, StallDetector will detect the stall correctly -- the action genuinely failed to produce an effect.

**Interaction with plateau_until**: If both WaitStrategy and `plateau_until` are active for the same goal, both suppression mechanisms apply independently. The wait state expires based on its own timer; `plateau_until` expires based on its timestamp. StallDetector is suppressed as long as either is active.

### 5.3 TimeHorizonEngine

WaitStrategy is a consumer of `TimeHorizonEngine.canAffordWait()`. The flow:

1. WaitStrategy estimates latency: "this action should take ~60 seconds"
2. WaitStrategy asks TimeHorizon: "can this goal afford to wait 60 seconds?"
3. TimeHorizon checks: after subtracting 60s from remaining time, can the required velocity still be met?
4. If yes: wait is approved at full duration
5. If no: wait is shortened to what TimeHorizon reports as `remainingMs`, or denied entirely

This is the connection point described in `time-horizon.md` SS10.

### 5.4 ObservationEngine

ObservationEngine itself does not change. CoreLoop simply does not call `observe()` during active waits. However, WaitStrategy may request lightweight status checks through the adapter (e.g., "is the agent session still running?") that do not constitute full observations.

A future enhancement could add an `ObservationEngine.quickCheck()` method for this purpose, but it is not required for the initial implementation.

### 5.5 ReportingEngine

WaitStrategy exposes `getActiveWaits()` for ReportingEngine to include in status reports. This gives the user visibility into what PulSeed is waiting for and why.

Report fields:
- Goal ID and task ID
- What is being waited on (action type, adapter)
- How long the wait has been active
- Estimated remaining wait time
- Whether the wait is budget-constrained

---

## 6. Effect Latency Estimation

Three estimation methods, used in priority order:

### 6.1 Historical (highest priority)

When at least `min_history_for_estimate` (default 3) latency records exist for the same `(actionType, adapterType)` pair, use the EMA of historical latencies with a buffer:

```
estimate = latency_ema * historical_buffer_multiplier
confidence = min(1.0, record_count / 10)
```

The buffer multiplier (default 1.5) accounts for variance -- waiting too short is worse than waiting too long, since a premature observation wastes tokens and may trigger false stalls.

Historical EMA uses the same alpha as TimeHorizonEngine (default 0.3) for consistency.

### 6.2 Heuristic (fallback)

When insufficient historical data exists, use the `default_latencies` lookup table:

| Action category | Default latency | Rationale |
|----------------|----------------|-----------|
| `code_change` | 5s | Agent writes code, effect visible in files/tests |
| `test_execution` | 30s | Test suite runs, results available |
| `deployment` | 120s | Build + deploy pipeline |
| `api_call` | 10s | External API round-trip |
| `human_action` | 300s | Human reviews/approves something |
| `unknown` | 30s | Conservative default |

Heuristic estimates have `confidence: 0.3` -- they are rough guides.

**Action category mapping**: Task metadata includes an `actionType` string. WaitStrategy maps this to a category using prefix matching:

```
"write_code", "edit_file", "refactor" -> code_change
"run_tests", "execute_test_suite"     -> test_execution
"deploy", "publish", "release"        -> deployment
"call_api", "fetch", "request"        -> api_call
"review", "approve", "human_*"        -> human_action
(everything else)                     -> unknown
```

### 6.3 LLM (optional, lowest priority)

When `enable_llm_estimation` is true and both historical and heuristic confidence are below 0.5, WaitStrategy asks the LLM:

```
Given this action was just executed:
- Action: {actionType}
- Adapter: {adapterType}  
- Goal context: {brief goal description}
- Task: {task description}

How long (in seconds) before the effect of this action would be observable?
Respond with a JSON object: { "estimatedSeconds": number, "reasoning": string }
```

LLM estimates have `confidence: 0.5` and are capped at `absolute_max_wait_ms`. This is a last resort -- most actions should be estimable from history or heuristics.

---

## 7. Observation Frequency Adjustment

WaitStrategy works alongside TimeHorizonEngine's existing `suggestObservationInterval()` (time-horizon.md SS7) to further modulate when CoreLoop observes.

### 7.1 During Wait

While a wait is active, CoreLoop does not observe. Instead, it checks the wait state at each tick. The tick interval can be shorter than the normal observation interval since the check is cheap (no LLM calls).

```
wait_check_interval = min(estimatedLatencyMs / 4, 15_000)
```

This means a 60-second wait is checked every 15 seconds. A 5-second wait is checked every 1.25 seconds.

### 7.2 Post-Wait Observation Burst

Immediately after a wait expires, CoreLoop should observe promptly rather than waiting for the next scheduled interval. This is a one-time "observe now" signal that overrides the normal schedule.

### 7.3 Adaptive Schedule After Observation

After the post-wait observation:
- If the gap improved: the action worked. Record the actual latency. Return to normal observation frequency.
- If the gap did not improve: the action may have failed, or the wait was too short. WaitStrategy does NOT enter a second wait. Instead, it lets StallDetector handle this case normally (the suppression has ended).

This prevents infinite wait loops: each action gets one wait period. If the effect is not observed after the wait, the system treats it as a potential stall.

---

## 8. StallDetector Exemption

### 8.1 Exemption Mechanism

When WaitStrategy has an active wait for a goal:
1. CoreLoop does not call `StallDetector.checkDimensionStall()` for that goal
2. CoreLoop does not feed gap snapshots to StallDetector's sliding window for that goal
3. `StallDetector.checkGlobalStall()` excludes goals with active waits

The exemption is scoped to the specific goal, not global. Other goals without active waits are still monitored normally.

### 8.2 Exemption Boundaries

The exemption is bounded by three limits:

| Limit | Source | Effect |
|-------|--------|--------|
| Estimated latency | WaitStrategy | Primary wait duration |
| Time budget | TimeHorizonEngine.canAffordWait() | Cannot wait longer than the goal can afford |
| Absolute max | WaitStrategyConfig.absolute_max_wait_ms | Hard ceiling regardless of estimates |

The effective wait is `min(estimatedLatency, affordableWait, absoluteMax)`.

### 8.3 Post-Exemption Stall Handling

When a wait expires and observation shows no improvement:
- The exemption ends immediately
- StallDetector receives the new gap snapshot
- If the gap has not improved from the pre-wait value, StallDetector processes it normally
- The escalation count does NOT reset -- the wait exemption does not "forgive" prior stall history

This ensures that waits cannot be used to indefinitely defer stall detection.

---

## 9. Edge Cases

### 9.1 Wait Timeout

If an action's effect never materializes (e.g., an agent session crashes silently), the wait hits `maxWaitMs` and transitions to `observable`. The subsequent observation reports no change, and StallDetector handles it.

**Prevention**: For adapter types that support status polling (e.g., session health checks), WaitStrategy can call a lightweight `adapter.isAlive()` during the wait. If the adapter reports the session is dead, the wait is immediately expired with reason `"adapter_session_terminated"`.

### 9.2 Cascading Waits

A single goal may have multiple tasks executed in sequence. Each gets its own wait period. WaitStrategy does NOT merge or stack waits. If a new action executes while a previous wait is still active:

1. The previous wait is expired (observation for its effect is deemed no longer separable)
2. The new wait begins with its own estimate
3. StallDetector exemption continues uninterrupted

### 9.3 Deadline Pressure

As a deadline approaches, TimeHorizonEngine.canAffordWait() becomes increasingly restrictive. WaitStrategy respects this:

| Pacing status | Wait behavior |
|--------------|--------------|
| `ahead` | Full estimated wait approved |
| `on_track` | Full estimated wait approved |
| `behind` | Wait capped at 50% of estimate |
| `critical` | No wait -- observe immediately |

This is enforced through the `canAffordWait()` check, not hardcoded in WaitStrategy. The pacing status indirectly controls wait approval through the time budget.

### 9.4 Perpetual Goals (No Deadline)

Goals without deadlines have no time budget constraint. `canAffordWait()` returns true for any duration (per time-horizon.md SS3.3). WaitStrategy still applies `absolute_max_wait_ms` as a ceiling.

### 9.5 Multiple Goals

WaitStrategy maintains independent wait states per goal. A wait on Goal A does not affect observation of Goal B. CoreLoop iterates over all goals and checks each one's wait state independently.

### 9.6 User-Initiated Observation

If the user explicitly requests a status check (e.g., via CLI or TUI), WaitStrategy's active wait is overridden. The observation proceeds, and if the gap has changed, the wait is cleared. If not, the wait continues with the remaining duration.

---

## 10. Configuration

All values have sensible defaults. Configuration is per-engine instance.

```typescript
interface WaitStrategyConfig {
  /** Default latency by action category (ms) */
  default_latencies: {
    code_change: number;     // default: 5_000
    test_execution: number;  // default: 30_000
    deployment: number;      // default: 120_000
    api_call: number;        // default: 10_000
    human_action: number;    // default: 300_000
    unknown: number;         // default: 30_000
  };

  /** Multiplier on historical EMA for safety margin. Default: 1.5 */
  historical_buffer_multiplier: number;

  /** Min records before using historical estimate. Default: 3 */
  min_history_for_estimate: number;

  /** Hard ceiling on any wait (ms). Default: 600_000 (10 min) */
  absolute_max_wait_ms: number;

  /** EMA alpha for latency tracking. Default: 0.3 */
  latency_ema_alpha: number;

  /** Use LLM for estimation when heuristic confidence is low. Default: false */
  enable_llm_estimation: boolean;
}
```

---

## 11. Module Location

| Item | Path |
|------|------|
| Source | `src/platform/time/wait-strategy.ts` |
| Types | `src/base/types/wait-strategy.ts` |
| Tests | `src/platform/time/__tests__/wait-strategy.test.ts` |
| Config | Standalone `WaitStrategyConfig`, injected via constructor |

Co-located with TimeHorizonEngine in `src/platform/time/` since the two modules are tightly coupled. Injected into CoreLoop via DI, following the same pattern as StallDetector and TimeHorizonEngine.

---

## 12. Test Strategy

### 12.1 Unit Tests (wait-strategy.test.ts)

**WaitDecision logic**:
- Action with historical data uses historical estimate
- Action without history falls back to heuristic defaults
- LLM estimation triggered only when enabled and confidence is low
- Wait denied when `canAffordWait()` returns false
- Wait capped at `absolute_max_wait_ms`
- Wait shortened when time budget is tight

**WaitState lifecycle**:
- New wait starts in `waiting` phase
- Transitions to `observable` when elapsed >= estimated
- `expireWait()` immediately transitions to `observable`
- Cascading action expires previous wait

**Latency recording**:
- EMA updates correctly with new records
- Historical estimate improves with more data
- Buffer multiplier applied correctly

**Edge cases**:
- Zero-latency estimate (synchronous action) results in `shouldWait: false`
- Negative velocity causes `canAffordWait()` to return false, wait denied
- Perpetual goal (no deadline) approves any wait up to absolute max

### 12.2 Integration Tests

**CoreLoop integration**:
- CoreLoop skips observation when wait is active
- CoreLoop observes immediately when wait expires
- Gap snapshots not fed to StallDetector during wait
- StallDetector resumes normally after wait expires

**StallDetector interaction**:
- No false stall during active wait
- Real stall detected after wait expires with no improvement
- Escalation count preserved across wait periods
- `plateau_until` and WaitStrategy both active: longer window wins

**TimeHorizonEngine interaction**:
- Wait approved when goal is ahead/on_track
- Wait denied when goal is critical
- Wait shortened proportional to budget pressure

### 12.3 Test Doubles

- Mock `ITimeHorizonEngine` with configurable `canAffordWait()` responses
- Mock `ILlmClient` for LLM estimation tests
- In-memory latency history (no file I/O in tests)

---

## 13. Design Decisions

### Why not modify StallDetector directly?

StallDetector's job is detecting lack of progress. Adding "but sometimes lack of progress is OK" to StallDetector would complicate its logic and violate single responsibility. Instead, WaitStrategy controls what StallDetector sees by filtering inputs at the CoreLoop level. StallDetector remains a pure detection module.

### Why EMA for historical latency?

Consistent with TimeHorizonEngine's velocity tracking (time-horizon.md SS2.2). EMA with alpha=0.3 gives ~86% weight to the last 5 observations, adapting to changes in action latency (e.g., a CI pipeline that got faster after optimization) without overreacting to outliers.

### Why not use plateau_until for everything?

`plateau_until` requires the strategy layer (LLM) to predict effect latency at task generation time -- before the action executes. This front-loads a prediction that is better made after execution, when the action type and adapter are known concretely. WaitStrategy makes the decision post-execution with better information.

### Why cap at 10 minutes by default?

PulSeed targets software development workflows where most observable effects (test results, build outputs, deployment status) materialize within minutes. A 10-minute ceiling prevents runaway waits from miscalibrated estimates. For longer-latency domains (marketing, hiring), the user can increase `absolute_max_wait_ms`.

### Why only one wait per action?

Allowing re-waits after a wait expires creates a risk of infinite deferral: "the effect hasn't materialized yet, let's wait more." This is exactly the behavior StallDetector exists to catch. One wait per action is the design boundary. If the effect does not materialize, the system should consider whether the action failed, not whether to wait longer.

---

## Summary of Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Estimation priority | Historical > heuristic > LLM | Historical is most accurate; LLM is expensive and approximate |
| Stall suppression | Filter inputs to StallDetector (not modify it) | Single responsibility; StallDetector stays pure |
| Wait limit | One wait per action, hard max 10 min | Prevents infinite deferral |
| Historical tracking | EMA (alpha=0.3) with 1.5x buffer | Consistent with TimeHorizon, accounts for variance |
| Deadline interaction | Via canAffordWait() | Reuses existing time budget logic, no duplication |
| plateau_until coexistence | Both active independently, longer wins | Backward compatible, no breaking change |
| Post-wait no-improvement | Let StallDetector handle normally | Wait was the one chance; failure is a real signal |
