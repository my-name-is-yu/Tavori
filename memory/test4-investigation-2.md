# Test 4 Investigation 2: Approval Loop (Post-Fix Analysis)

## Question 1: Why does every reversible task still require approval?

### Root Cause — Confirmed

`requiresApproval()` in `src/trust-manager.ts` lines 163–169:

```
if (reversibility === "irreversible" || reversibility === "unknown") → return true  // line 163
if (category && hasPermanentGate(...)) → return true                                // line 166
return getActionQuadrant(...) !== "autonomous"                                       // line 169
```

The third check (`!== "autonomous"`) fires for **all reversible tasks** unless trust >= 20 AND confidence >= 0.50 (`src/trust-manager.ts` lines 137–146). At trust=0 (initial), quadrant is `"execute_with_confirm"` or `"observe_and_propose"` — never `"autonomous"`.

The previous fix (changing default reversibility from `"unknown"` to `"reversible"` in `LLMGeneratedTaskSchema`, `src/task-lifecycle.ts` line 64) correctly bypasses the first check, but the third check still gates every task until trust >= 20.

### Recommended Fix — Option (a)

Change `requiresApproval()` to require approval only in the `"observe_and_propose"` quadrant (i.e., low trust AND low confidence), not for `"execute_with_confirm"` (which is the normal initial state with reasonable confidence).

Specific change in `src/trust-manager.ts` line 169:
```ts
// BEFORE
return this.getActionQuadrant(domain, confidence) !== "autonomous";

// AFTER
const quadrant = this.getActionQuadrant(domain, confidence);
return quadrant === "observe_and_propose";
```

This means:
- `observe_and_propose` (trust < 20 AND confidence < 0.50): requires approval
- `execute_with_confirm` (trust < 20 but confidence >= 0.50, or trust >= 20 but confidence < 0.50): no approval needed for reversible tasks
- `autonomous` (trust >= 20 AND confidence >= 0.50): no approval needed

Safety for irreversible/unknown is preserved via the first check (line 163). This is a safer MVP default than option (b), which skips approval entirely for reversible tasks, and more usable than option (c) (which only lowers the threshold).

Default confidence passed in `checkIrreversibleApproval` is 0.5 (`src/task-lifecycle.ts` line 199), which just meets `HIGH_CONFIDENCE_THRESHOLD` (0.50). So at trust=0, quadrant = `"execute_with_confirm"` → no approval required with this fix.

---

## Question 2: Why is the same task regenerated every iteration?

### Root Cause A: No state update after task execution — Confirmed

After `executeTask()`, only the **task file** is updated (status: running → completed/error). The **goal dimensions** (`current_value`, `confidence`, `last_updated`) are never updated by TaskLifecycle. `verifyTask()` returns a `VerificationResult` with `dimension_updates: []` (hardcoded empty, line 413 in `task-lifecycle.ts`).

Next iteration: ObservationEngine's `observe()` hook in `core-loop.ts` (line 357–367) only fires if `engine.observe` exists — it uses `"manual"` type methods with no real data source. In practice, dimension progress does not change.

Result: same gap vector → same top dimension → same task description generated → same approval prompt.

### Root Cause B: Adapter execution succeeds or fails silently — Confirmed

`buildDeps()` in `src/cli-runner.ts` line 90–94 registers both `ClaudeCodeCLIAdapter` and `ClaudeAPIAdapter`. Default `adapterType` is `"claude_api"` (`core-loop.ts` line 72). If `ANTHROPIC_API_KEY` is set, `ClaudeAPIAdapter` executes successfully and calls the LLM to "complete" the task. But the output is never parsed back to update goal dimension state.

`ClaudeAPIAdapter` always returns `success: true` (on API success), so `handleVerdict` records `action: "completed"` and increments trust by +3. But trust rising by 3 per iteration still does not update goal dimensions, so the loop continues generating new tasks for the same dimension.

### Recommended Fix

The core missing link is that `handleVerdict` (action: "completed") must update goal dimension progress. Add a dimension state update step in `runTaskCycle` after verdict:

Location: `src/task-lifecycle.ts` — after `handleVerdict()` call (line 587), if `verdictResult.action === "completed"`, reload the goal and bump `last_updated` on the target dimension. The `current_value` update itself requires a real observation or self-report from the agent output — for MVP, a simple `last_updated = now` prevents the `timeSinceLastAttempt` from staying at 168h, which will reduce the drive score for that dimension on the next iteration, allowing other dimensions to surface.

A more complete fix would parse the executor output and let the LLM set a new `current_value` for the dimension — but that requires a `dimension_updates` population in `verifyTask()`, which is currently hardcoded to `[]`.

**Minimum viable fix for MVP:**
In `handleVerdict` (pass case, `src/task-lifecycle.ts` ~line 436), after recording success, reload the goal and set `last_updated = now` on `task.primary_dimension`. This alone breaks the "same dimension every iteration" cycle.
