# Test 4 Investigation: Repeated Approval Prompt / Escalate Loop

## Root Cause: TrustManager approval logic (Area 3)

At fresh start, trust score = 0. `requiresApproval()` in `trust-manager.ts` line 163-169:

```
if (reversibility === "irreversible" || reversibility === "unknown") → return true
if quadrant !== "autonomous" → return true
```

- `autonomous` requires trust >= 20 AND confidence >= 0.50 (line 137)
- LLM-generated tasks default `reversibility` to `"unknown"` (task-lifecycle.ts line 64)
- **Every single task triggers approval regardless of trust level** because reversibility defaults to "unknown"

Even if the user approves and the task succeeds (+3 trust), trust reaches 3 — still below 20.
Even if reversibility were "reversible", trust would need 7 consecutive successes before reaching autonomous.

**In practice: every task in every loop iteration shows the approval prompt.**

## Secondary Cause 1: CoreLoop does not short-circuit on "approval_denied" (Area 2)

`runTaskCycle` in `task-lifecycle.ts` line 558-578 returns `action: "approval_denied"` when denied.
`CoreLoop.runOneIteration` at line 491-509 receives `TaskCycleResult` but never checks `action === "approval_denied"`.

The loop continues to the next iteration, generates a new task, asks for approval again. This repeats up to `maxIterations` (default 100).

## Secondary Cause 2: Escalate does not break the CoreLoop (Area 2)

When approval is denied, `checkIrreversibleApproval` returns `false`. The code skips to return `approval_denied`.
But if the task *runs* and fails, `handleFailure` in task-lifecycle.ts line 497-504 escalates after 3 consecutive failures.

The CoreLoop only breaks on `stallReport.escalation_level >= 3` (line 244-251 core-loop.ts), NOT on task `action === "escalate"`. So escalate signals from `TaskCycleResult` are silently ignored by CoreLoop — the loop keeps running and generating new tasks.

## Secondary Cause 3: readline instance per approval call (Area 4)

`buildApprovalFn()` in cli-runner.ts line 64-83 creates a **new `readline.createInterface()`** on every invocation. Because the CoreLoop loops 100 times and each iteration triggers approval, 100 readline instances compete for stdin simultaneously. This can cause input to be consumed by the wrong instance or cause garbled/missed responses.

## Area 1: Adapter execution (no primary bug)

`ClaudeCodeCLIAdapter` requires `claude` CLI binary on PATH. If not installed, `child.on("error")` fires immediately (`ENOENT`), returning `success: false`. This causes the task to be marked as `error`, which after 3 consecutive errors breaks the loop with `finalStatus: "error"` — not the looping behavior observed.

`ClaudeAPIAdapter` would succeed if `ANTHROPIC_API_KEY` is set, so this is not the adapter issue.

## Root Cause Summary

| # | Issue | Location | Severity |
|---|-------|----------|----------|
| 1 | Tasks default to `reversibility: "unknown"` — approval always required | `task-lifecycle.ts:64` | **PRIMARY** |
| 2 | CoreLoop does not stop/skip on `approval_denied` result | `core-loop.ts:491-509` | High |
| 3 | CoreLoop does not stop on task `action === "escalate"` from TaskCycleResult | `core-loop.ts:491-509` | High |
| 4 | New readline instance per approval call — stdin conflicts | `cli-runner.ts:67` | Medium |

## Recommended Fixes

### Fix 1 (PRIMARY): Default reversibility to "reversible" in LLM prompt or post-parse
In `task-lifecycle.ts` change the Zod default for `reversibility` from `"unknown"` to `"reversible"`, OR change `requiresApproval()` to not gate on `unknown` unless explicitly set by the LLM with reasoning. This alone eliminates the per-iteration approval loop for most tasks.

### Fix 2: Handle `approval_denied` in CoreLoop
After `runTaskCycle`, check `taskResult.action === "approval_denied"` and either:
- Increment a consecutive-denied counter and stop after threshold, or
- Stop the loop immediately (user rejected, no point continuing)

### Fix 3: Handle escalate from TaskCycleResult in CoreLoop
If `taskResult.action === "escalate"`, increment the escalation counter or stop the loop.

### Fix 4: Singleton readline in CLIRunner
Create one readline interface in `buildApprovalFn()` and reuse it across calls, closing only on loop completion. This prevents stdin contention.
