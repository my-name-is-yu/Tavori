# LLM Fault Tolerance Design

---

## 1. Overview

PulSeed relies on LLMs across three critical paths: observation, verification, and task generation. While LLMs are often accurate, they can probabilistically hallucinate or misjudge. The purpose of this design is to limit how far a single bad output can propagate through the system.

Two mechanisms are addressed:

- **A. Blast Radius Bound** — caps the impact of any single LLM error
- **B. Invariant Guard** — mechanically detects contradictions without using an LLM, blocking bad outputs before they take effect

**Out of scope**: multi-model voting/consensus (too costly), retry strategies (already implemented), general schema validation (handled elsewhere).

---

## 2. Risk Inventory

High-priority risks identified in the implementation audit (`memory/archive/llm-fault-tolerance-research.md`):

| # | File / Location | Risk | Severity |
|---|----------------|------|----------|
| 1 | `task-verifier.ts` L281/381 | L2 verdict triggers immediate trust update without secondary confirmation | High |
| 2 | `task-verifier.ts` L316/348 | `dimension.current_value` is directly overwritten from LLM output with no range check | High |
| 3 | `observation-llm.ts` L97–107 | Score > 0.0 possible even when no evidence (no contextProvider + no git diff) | Medium |
| 4 | `gap-calculator.ts` | Bad observation score causes false satisficing (goal incorrectly marked complete) | High |
| 5 | `task-verifier.ts` L641 | `completion_judger` result has no Zod validation (only `JSON.parse`) | Medium |

---

## 3. A. Blast Radius Bound

### 3.1 Trust Change Rate Limiting

**Purpose**: Prevent trust from spiking rapidly if the LLM repeatedly returns incorrect `pass` verdicts in a short window.

**Current state**: The `TRUST_SUCCESS_DELTA = +3` cap exists, but there is no time-windowed rate limit. If the LLM misjudges 10 times in one minute, trust can rise by `+30`.

**Definition**:

```
Max trust increase rate: +9 / 1 hour (= 3 consecutive successes)
  → If recordSuccess() is called more than 3 times within 1 hour,
    the 4th call onward is skipped and a WARN log is emitted.

Trust decrease rate limit: none (failures apply immediately — fast penalty application is the safe side)
```

**Implementation location**: Inside `recordSuccess()` in `src/traits/trust-manager.ts`

**Behavior when guard fires**:
- Addition is skipped (current trust value unchanged)
- Log: `WARN: trust rate limit triggered (domain: ${domain}, window: 1h, count: ${count})`

**Priority**: P1

---

### 3.2 `dimension_updates` Change Magnitude Limit

**Purpose**: Prevent LLM verification results (`dimension_updates`) from making large rewrites to `dimension.current_value`.

**Current state**: `task-verifier.ts` L316/L348 performs `dimension.current_value = update.new_value` directly with no range check.

**Definition**:

```
Allowed change magnitude: max(±0.3 absolute, ±30% of current value)
  Example: current_value = 0.2
    → Allowed range: [0.0, 0.5] (±0.3 absolute is larger)
  Example: current_value = 0.8
    → Allowed range: [0.56, 1.0] (±0.24 vs ±30% = ±0.24 — equivalent; capped to [0,1])

If the proposed change exceeds the range: clamp to the limit and emit a warning log
```

**Implementation location**: Add a `clampDimensionUpdate()` helper function inside the `dimension_updates` application loop near L316 in `src/execution/task-verifier.ts`

```typescript
function clampDimensionUpdate(current: number, proposed: number): number {
  const absLimit = 0.3;
  const relLimit = current * 0.3;
  const maxDelta = Math.max(absLimit, relLimit);
  const clamped = Math.max(current - maxDelta, Math.min(current + maxDelta, proposed));
  if (clamped !== proposed) {
    logger.warn(`dimension_update clamped: proposed=${proposed}, applied=${clamped}, current=${current}`);
  }
  return clamped;
}
```

**Behavior when guard fires**:
- Writes the clamped value (does not reject outright)
- Emits a WARN log

**Priority**: P0

---

### 3.3 Observation Score Change Magnitude Limit

**Purpose**: If the LLM shifts the observation score dramatically in a single cycle (e.g., 0.1 → 0.9), do not apply that change to goal state without confirmation.

**Current state**: `observation-llm.ts` returns a score, and `observation-engine.ts` applies it as-is. There is no check on the delta from the previous score.

**Definition**:

```
Max score change per cycle: ±0.4

Rules:
  - |new_score - prev_score| <= 0.4 → apply normally
  - |new_score - prev_score| > 0.4 → hold with a "needs confirmation" flag
    → If a mechanical source (DataSource) is available: prefer the mechanical value (reuse existing cross-validation logic)
    → If no mechanical source: retain prev_score, lower confidence to 0.3, and emit WARN log
```

**Implementation location**: In `src/observation/observation-engine.ts`, in the LLM observation application path (before calling `applyObservation()`)

**Behavior when guard fires**:
- If mechanical source is available, use it (same decision as existing cross-validation)
- If no mechanical source, retain previous score (do not change the score)
- WARN log: `WARN: observation score jump suppressed: prev=${prev}, proposed=${new}, delta=${delta}`

**Priority**: P1

---

## 4. B. Invariant Guard

### 4.1 Progress-Verdict Consistency Check

**Purpose**: Detect the contradiction where the gap has grown (worsened) yet the LLM returns `pass`.

**Definition**:

```
Check conditions:
  prev_gap = normalized gap value from the previous cycle
  curr_gap = normalized gap value for the current cycle (recalculated after task execution)
  verdict  = judgment from completion_judger

Contradiction condition: curr_gap > prev_gap + 0.05 AND verdict == "pass"
  → Force-override verdict to "partial"
  → WARN log: `WARN: progress-verdict contradiction: gap increased (${prev_gap}→${curr_gap}) but verdict was pass. Overriding to partial.`
```

**Implementation location**: Inside `handleVerdict()` in `src/execution/task-verifier.ts`, before the trust update

**Behavior when guard fires**:
- Rewrites `verdict` to `partial` (prevents `recordSuccess` from being triggered by a `pass`)
- Emits WARN log

**Priority**: P0

---

### 4.2 Duplicate Task Guard

**Purpose**: Prevent infinite loops caused by regenerating tasks that are semantically identical to recently completed or failed ones.

**Definition**:

```
Against the N most recent tasks (N=10):
  Duplicate check: string similarity between task.description and recent_task.description
    → Simple implementation: trigram match rate >= 0.7 AND status is "completed" or "failed"
    → If flagged as duplicate: reject task generation and emit WARN log

Future: replace with semantic embedding similarity (once VectorIndex is available)
```

**Implementation location**: In `src/execution/task-generation.ts`, after task generation and before returning to `TaskLifecycle`

**Behavior when guard fires**:
- Returns `null` instead of a task (treated as generation failure)
- WARN log: `WARN: duplicate task rejected: similar to recently ${status} task "${recent_task.id}"`

**Priority**: P1

---

### 4.3 Score-Evidence Consistency Check

**Purpose**: Handle cases where the LLM returns a score > 0.0 despite there being no evidence.

**Current state**: The prompt in `observation-llm.ts` contains a `"Score MUST be 0.0"` instruction, but the LLM can ignore it (Risk #3).

**Definition**:

```
No-evidence conditions:
  - contextProvider result is empty (zero entries or empty string)
  - git diff is empty (no changes)
  → If the LLM returns score > 0.0 under these conditions:
    → Force-override score to 0.0
    → Set confidence = 0.1
    → WARN log: `WARN: score overridden to 0.0 (no evidence available, LLM returned ${score})`
```

**Implementation location**: In `src/observation/observation-llm.ts`, after processing the LLM response (around L157–164)

**Behavior when guard fires**:
- Force-sets score to 0.0
- Sets confidence to 0.1
- Emits WARN log

**Priority**: P0

---

### 4.4 Satisficing Double-Check Guard

**Purpose**: Prevent transient LLM over-estimation from causing a false "goal achieved" detection.

**Current state**: `SatisficingJudge` can declare a goal complete as soon as the gap falls below the threshold. A single cycle of observation is enough to trigger this.

**Definition**:

```
Conditions for declaring goal "satisfied":
  Confirm gap <= threshold across 2 consecutive observation cycles
  → Cycle 1: transition to "satisficing_candidate" state (do not complete the goal)
  → Cycle 2: if gap <= threshold is confirmed again, transition to "satisfied"
  → Cycle 2: if gap > threshold, reset "satisficing_candidate"

The counter is stored as `satisficing_streak` in goal state (`goal.json`)
```

**Implementation location**: Inside the satisficing judgment logic in `src/judgment/satisficing-judge.ts`

**Behavior when guard fires**:
- Does not declare completion on cycle 1 (proceeds to next cycle)
- No WARN log needed (this is normal behavior)
- Completion is declared only after two consecutive passing cycles

**Priority**: P0

---

### 4.5 `dimension_updates` Direction Check

**Purpose**: Detect contradictions where a task intended to raise a score, but the LLM's `dimension_updates` proposes a value that lowers it.

**Definition**:

```
Check conditions:
  If task.intended_direction is defined ("increase" or "decrease")
  AND dimension_updates[dim].new_value is in the opposite direction:
    → Log as contradiction with WARN
    → Ignore dimension_updates (do not change current_value)

task.intended_direction is assigned by task-generation.ts (not yet implemented → add when implementing this guard)
```

**Current limitation**: The `task.intended_direction` field does not exist in the current task schema. Enabling this guard requires a schema addition.

**Implementation locations**:
- Add `intended_direction?: "increase" | "decrease" | "neutral"` to `src/types/tasks.ts`
- Add assignment instructions to the prompt in `src/execution/task-generation.ts`
- Add the check inside the application loop near L316 in `src/execution/task-verifier.ts`

**Behavior when guard fires**:
- Ignores `dimension_updates` (does not change any values)
- WARN log: `WARN: dimension_update direction mismatch: task intended ${intended}, but update suggests ${direction} for dim ${dim}`

**Priority**: P2 (deferred due to schema changes required)

---

### 4.6 `completion_judger` Zod Validation (Addendum)

**Purpose**: Address Risk #5. The `completion_judger` currently uses only `JSON.parse` with manual field access — there is no Zod schema.

**Definition**:

```typescript
const CompletionJudgerResponseSchema = z.object({
  verdict: z.enum(["pass", "partial", "fail"]).default("fail"),
  reasoning: z.string(),
  criteria_met: z.number().int().min(0).optional(),
  criteria_total: z.number().int().min(0).optional(),
});
```

**Implementation location**: Inside the `completion_judger` function at L613–653 in `src/execution/task-verifier.ts`, switching to `llmClient.parseJSON()`

**Behavior when guard fires**:
- On parse failure, retain the existing `{passed: false, confidence: 0.3}` fallback

**Priority**: P1

---

### 4.7 Verification Failure Injection into Next Cycle (LangGraph-inspired)

**Purpose**: When task verification fails, explicitly inject the failure reason into the next task generation prompt to prevent repeating the same mistake.

**Current state**: Task fails → stall-detector catches it → new task is generated. But the details of why it failed (verification result `reasoning`, `criteria_met`/`criteria_total`) are not passed to the task generation prompt.

**Definition**:

```
On task verification failure (verdict = "fail" or "partial"):
  → Save from verification_result:
    - reasoning (failure reason)
    - criteria_met / criteria_total
    - verdict
  → On the next generateTask() call, append to the prompt:
    "The previous task '${prev_task.description}' was judged ${verdict} for the following reason:
     ${reasoning}
     Criteria met: ${criteria_met}/${criteria_total}
     Taking this failure into account, generate a task using a different approach."
```

**Implementation locations**:
- Save failure reason: write `last_failure_context` to `StateManager` inside `handleVerdict()` in `src/execution/task-verifier.ts`
- Prompt injection: read `last_failure_context` and inject it during prompt construction in `src/execution/task-generation.ts`

**Behavior when guard fires**: Normal operation (this is information injection, not a guard). Skipped if no failure context exists.

**Priority**: P1

---

### 4.8 CoreLoop Checkpoint (AutoGen-inspired)

**Purpose**: Allow recovery to the last known-good state after a crash or interruption during CoreLoop execution.

**Current state**: If CoreLoop crashes mid-loop, intermediate state is lost. An auto-archive mechanism exists (moves goal state to `~/.pulseed/archive/<goalId>/` on completion), but there are no mid-loop checkpoints.

**Definition**:

```
Checkpoint save timing: after each successful verify (at the end of each cycle)
Save location: ~/.pulseed/goals/<goalId>/checkpoint.json
Contents:
  - cycle_number: current cycle number
  - last_verified_task_id: ID of the last successfully verified task
  - dimension_snapshot: snapshot of all dimension.current_values
  - trust_snapshot: current trust value
  - timestamp: ISO format

Recovery behavior:
  - On CoreLoop startup, check for the existence of checkpoint.json
  - If found, restore state from dimension_snapshot and trust_snapshot
  - Treat tasks after last_verified_task_id as pending re-execution
  - WARN log: "Resuming from checkpoint (cycle ${cycle_number}, task ${last_verified_task_id})"
```

**Implementation locations**:
- Checkpoint write: after successful verify in `src/core/core-loop.ts`
- Checkpoint read: at loop startup in `src/core/core-loop.ts`

**Behavior when guard fires**: Normal operation (this is a recovery mechanism, not a guard). If no checkpoint exists, performs a normal cold start.

**Priority**: P1

---

## 5. Implementation Priority Summary

| Priority | Guard | File |
|----------|-------|------|
| P0 | 3.2 `dimension_updates` change magnitude limit | `task-verifier.ts` |
| P0 | 4.1 Progress-verdict consistency check | `task-verifier.ts` |
| P0 | 4.3 Score-evidence consistency check | `observation-llm.ts` |
| P0 | 4.4 Satisficing double-check guard | `satisficing-judge.ts` |
| P1 | 3.1 Trust change rate limiting | `trust-manager.ts` |
| P1 | 3.3 Observation score change magnitude limit | `observation-engine.ts` |
| P1 | 4.2 Duplicate task guard | `task-generation.ts` |
| P1 | 4.6 `completion_judger` Zod validation | `task-verifier.ts` |
| P1 | 4.7 Verification failure injection into next cycle | `task-verifier.ts`, `task-generation.ts` |
| P1 | 4.8 CoreLoop checkpoint | `core-loop.ts` |
| P2 | 4.5 `dimension_updates` direction check | `task-verifier.ts` + schema change |

---

## 6. Design Decisions and Boundaries

**"Clamp and apply" vs "reject outright"**: The change magnitude limits (§3.2, §3.3) clamp values and write them. A full rejection would leave observation data stale, preventing the system from tracking the current state. Clamping is more conservative and avoids errors in the opposite direction.

**Favor the conservative side on verdict contradictions**: The progress-verdict contradiction (§4.1) downgrades `pass` to `partial`. Preferring false negatives over false positives (missed completions over incorrect completions) is consistent with PulSeed's safety design principle.

**Why 2 cycles for satisficing double-check**: Set to 2. One cycle is insufficient (LLM can temporarily over-estimate), and 3 or more slows convergence. For goals with high observation cost, the cycle count may be made configurable in the future.

**Rate limit granularity**: The trust rate limit uses a fixed 1-hour window. This may be too short in production, but is kept conservative for MVP. The window size may be made configurable in the future.
