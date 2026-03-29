# Token Optimization Design

> Token cost is the primary barrier to PulSeed adoption. A single loop iteration makes 3-7 LLM calls, meaning a goal with 3 dimensions and 10 iterations costs 50-70 API calls before any real work is done. This document defines three independent optimization pillars that together reduce LLM token consumption by an estimated 60-80% without degrading observation quality or loop correctness.

---

## 1. Current State: Where Tokens Go

### LLM calls per loop iteration

| Phase | Module | LLM Calls | Input Tokens (est.) |
|-------|--------|-----------|-------------------|
| Observation (per dimension) | ObservationEngine | N | N x ~800 |
| Task generation | task-generation.ts | 1 | ~2000+ |
| L2 verification | task-verifier.ts | 1 | ~1000-3000 |
| L2 re-review (conditional) | task-verifier.ts | 0-1 | ~1000-3000 |
| Reflection (conditional) | reflection-generator.ts | 0-1 | ~500 |
| **Total (N=3 dimensions)** | | **5-7** | **~7000-12000** |

### Cost profile

For a typical 3-dimension goal running 20 iterations:
- Observation: 60 LLM calls (3 dims x 20 loops) -- **largest consumer**
- Task generation: 20 calls
- Verification: 20-40 calls
- **Total: ~100-120 LLM calls per goal**

The observation phase dominates because it scales linearly with dimension count AND loop count. Task generation and verification are constant per iteration. This means observation is the highest-leverage optimization target.

### What is already cheap

DriveScorer and SatisficingJudge are fully deterministic (zero LLM calls). Gap calculation is deterministic. These require no optimization.

---

## 2. Pillar 1: Staged Observation

### Problem

Every loop iteration calls `ObservationEngine.observe()`, which invokes LLM observation for each dimension that lacks a DataSource. Even when nothing has changed since the last observation, the LLM is called again with the same context, producing the same score. This is pure waste.

### Design

Insert a **deterministic pre-check stage** before the existing 3-layer observation fallback. The new observation pipeline becomes:

```
Stage 0 (NEW): Deterministic pre-check
  → Run cheap checks (DataSource, file stat, git diff --stat)
  → Compare result against last observation's extracted_value
  → If unchanged → SKIP LLM call, reuse previous observation
  ↓ (only if changed or no previous observation)
Stage 1: Mechanical observation (existing DataSource)
  ↓
Stage 2: LLM observation (existing)
  ↓
Stage 3: Self-report (existing)
```

### Interface

```typescript
// New type: pre-check result
interface PreCheckResult {
  changed: boolean;
  hint?: string;        // optional context for LLM if changed (e.g., "3 new files added")
  raw_value?: unknown;  // the deterministic value, if available
}

// New interface for lightweight pre-checks
interface IDimensionPreChecker {
  check(
    dimension: Dimension,
    lastObservation: ObservationLogEntry | null,
    goalContext: { workspace_path?: string }
  ): Promise<PreCheckResult>;
}
```

### Pre-check strategies

| Strategy | Applicable when | How it works |
|----------|----------------|-------------|
| DataSource delta | Dimension has a configured DataSource | Run DataSource.observe(), compare value to last observation. If identical, skip LLM |
| File stat check | Workspace path is known | Run `stat` on key files. If mtime unchanged since last observation, skip LLM |
| Git diff check | Workspace is a git repo | Run `git diff --stat` since last observation timestamp. If empty, skip LLM |
| Observation age | Always | If last observation is younger than `min_observation_interval` (configurable, default 60s), skip |

Multiple strategies can be combined. If ANY strategy reports `changed: true`, proceed to LLM observation. If ALL report `changed: false`, skip.

### Configuration

Add to goal definition (optional, with sensible defaults):

```typescript
interface ObservationOptimization {
  min_observation_interval_sec: number;  // default: 60
  skip_on_no_change: boolean;            // default: true
  pre_check_strategies: Array<'datasource_delta' | 'file_stat' | 'git_diff' | 'age'>;
    // default: ['datasource_delta', 'git_diff', 'age']
}
```

### Implementation

**Files to change:**
- `src/observation/observation-engine.ts` -- add pre-check stage before existing fallback chain
- `src/observation/dimension-pre-checker.ts` -- NEW file, implements `IDimensionPreChecker`
- `src/types/goal.ts` -- add optional `observation_optimization` field to goal schema

**Algorithm in ObservationEngine.observe():**

```
for each dimension:
  lastObs = getLastObservation(dimension)
  preCheck = preChecker.check(dimension, lastObs, context)

  if !preCheck.changed AND lastObs exists:
    // Reuse previous observation with slightly reduced confidence
    record observation with:
      value = lastObs.extracted_value
      confidence = lastObs.confidence * 0.95  // slight decay
      layer = "cached"
      notes = "skipped: no change detected by pre-check"
    continue to next dimension

  // Existing fallback chain (stages 1-3)
  ...
```

The confidence decay (0.95x per skip) ensures that after ~20 consecutive skips, confidence drops enough to force a fresh LLM observation. This prevents indefinite caching.

### Expected savings

- For dimensions with DataSources: nearly 100% of LLM observation calls eliminated (DataSource already handles it; this just makes the skip explicit)
- For dimensions without DataSources but with file/git-based workspaces: 40-70% of LLM calls skipped (when nothing changed between iterations)
- For rapidly changing environments: minimal savings (pre-checks correctly detect change, LLM runs as before)

**Estimate: 40-60% reduction in observation LLM calls.**

---

## 3. Pillar 2: State Diff + Loop Skip

### Problem

Even after observation completes, the remaining loop phases (gap calculation, drive scoring, task generation, execution, verification) run unconditionally. When the goal state has not meaningfully changed, these phases produce identical outputs and waste both LLM tokens (task generation, verification) and wall-clock time.

### Design

After observation completes, compute a **state diff** against the previous iteration. If no meaningful change is detected across ALL dimensions, skip the remaining loop phases entirely.

```
Loop iteration N:
  1. Observe all dimensions         (always runs)
  2. Compute state diff             (NEW)
  3. If no meaningful change:
       log "iteration skipped: no state change"
       update iteration counter
       SKIP phases 3-9
       continue to next iteration
  4-9. Gap → Score → Task → Execute → Verify → Report  (existing)
```

### "Meaningful change" definition

A dimension has meaningfully changed when ANY of the following is true:

```typescript
interface StateDiffThresholds {
  value_delta: number;       // default: 0.05 (absolute change in normalized value)
  confidence_delta: number;  // default: 0.10 (absolute change in confidence)
  layer_change: boolean;     // observation layer changed (e.g., self_report → mechanical)
}

function hasMeaningfulChange(
  prev: DimensionState,
  curr: DimensionState,
  thresholds: StateDiffThresholds
): boolean {
  return (
    Math.abs(curr.current_value - prev.current_value) >= thresholds.value_delta ||
    Math.abs(curr.confidence - prev.confidence) >= thresholds.confidence_delta ||
    curr.observation_layer !== prev.observation_layer
  );
}
```

The loop is skipped ONLY when ALL dimensions report no meaningful change. If even one dimension changes, the full loop runs.

### State snapshot storage

```typescript
interface IterationSnapshot {
  iteration: number;
  timestamp: string;
  dimensions: Record<string, {
    current_value: number;
    confidence: number;
    observation_layer: string;
  }>;
}
```

Stored in memory (not persisted to disk). Only the previous iteration's snapshot is needed. On process restart, the first iteration always runs in full.

### Consecutive skip limit

To prevent pathological cases where the loop skips forever (e.g., a stalled goal where nothing changes but intervention is needed), enforce a maximum consecutive skip count:

```
max_consecutive_skips: 5  (default, configurable per goal)
```

After 5 consecutive skips, the full loop runs regardless of state diff. This interacts with stall detection: if the full loop confirms no progress, stall detection triggers normally.

### Implementation

**Files to change:**
- `src/loop/state-diff.ts` -- NEW file, implements `StateDiffCalculator`
- `src/core-loop.ts` -- add diff check after observation phase, before gap calculation
- `src/types/loop.ts` -- add `IterationSnapshot` and `StateDiffThresholds` schemas

**Integration point in `runOneIteration`:**

```
// After step 2 (observeAndReload)
const snapshot = buildSnapshot(goal);
const diff = stateDiff.compare(previousSnapshot, snapshot);
if (!diff.hasChange && consecutiveSkips < maxConsecutiveSkips) {
  consecutiveSkips++;
  previousSnapshot = snapshot;
  return { skipped: true, reason: 'no_state_change' };
}
consecutiveSkips = 0;
previousSnapshot = snapshot;
// Continue to step 3 (calculateGapOrComplete)
```

### Expected savings

When the loop skips, the following LLM calls are avoided per iteration:
- Task generation: 1 call (~2000 tokens)
- Verification: 1-2 calls (~2000-6000 tokens)
- Total per skipped iteration: 1-3 LLM calls

For a stable goal (e.g., monitoring/maintenance), most iterations may be skippable:
- 20 iterations, 60% skipped = 12 skipped iterations = 12-36 LLM calls saved

**Estimate: 20-40% reduction in total LLM calls** (depends heavily on goal stability).

---

## 4. Pillar 3: 2-Model Routing

### Problem

All LLM calls currently use the same model (configured in `provider.json`). However, not all calls require the same reasoning capability. Routine observations (scoring a file existence check as 0.0 or 1.0) are simple classification tasks. Task generation for a novel stuck dimension requires complex reasoning. Using the same expensive model for both wastes cost.

### Design

Allow users to configure two models: a **main model** for complex reasoning and a **light model** for routine tasks. Each LLM call site declares its complexity, and the LLM client routes to the appropriate model.

### Provider config extension

```json
{
  "provider": "openai",
  "model": "gpt-5.3-codex",
  "light_model": "gpt-4o-mini",
  "adapter": "openai_codex_cli",
  "api_key": "..."
}
```

New field: `light_model`. Optional. When not set, all calls use `model` (no behavior change). This ensures backward compatibility.

For Anthropic users:
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "light_model": "claude-haiku-4-6"
}
```

For Ollama users:
```json
{
  "provider": "ollama",
  "model": "llama-3.3-70b",
  "light_model": "llama-3.3-8b"
}
```

### Routing rules

Routing is **rule-based** (no LLM call to decide routing). Each call site is statically classified:

| Call site | Default tier | Rationale |
|-----------|-------------|-----------|
| Observation (structured score) | light | Scoring 0.0-1.0 on a defined scale is classification |
| Task generation (first attempt) | main | Requires understanding goal context, strategy, past failures |
| Task generation (retry/similar) | light | Incremental variation of a known task pattern |
| L2 verification | light | Binary pass/fail judgment on concrete criteria |
| L2 re-review | main | Disagreement between L1 and L2 requires deeper reasoning |
| Strategy selection | main | Complex tradeoff analysis |
| Goal negotiation | main | Nuanced understanding of user intent |
| Reflection generation | light | Structured summary of execution results |
| Curiosity proposals | light | Creative but low-stakes generation |

### Interface

```typescript
type ModelTier = 'main' | 'light';

interface LLMRequestOptions {
  // ... existing fields ...
  model_tier?: ModelTier;  // NEW: defaults to 'main' for backward compat
}
```

The routing happens inside `BaseLLMClient`:

```typescript
// In BaseLLMClient.sendMessage()
const effectiveModel = (options?.model_tier === 'light' && this.config.light_model)
  ? this.config.light_model
  : this.config.model;
```

This is a 3-line change in the base client. Each call site then opts in by passing `model_tier: 'light'` in its options.

### Tier override config

Advanced users may want to override the default tier for specific call sites:

```json
{
  "model_routing": {
    "observation": "main",
    "task_generation": "light",
    "verification": "main"
  }
}
```

This is optional (phase 2). The default static classification is sufficient for launch.

### Implementation

**Files to change:**
- `src/llm/provider-config.ts` -- add `light_model` field to provider config schema
- `src/llm/base-llm-client.ts` -- add model selection logic based on `model_tier`
- `src/types/llm.ts` -- add `ModelTier` type and `model_tier` to `LLMRequestOptions`
- `src/observation/observation-llm.ts` -- pass `model_tier: 'light'`
- `src/execution/task-generation.ts` -- pass `model_tier: 'main'` (default, explicit)
- `src/execution/task-verifier.ts` -- pass `model_tier: 'light'` for L2, `model_tier: 'main'` for re-review

### Expected savings

Cost savings depend on the price ratio between main and light models. Typical ratios:

| Provider | Main model | Light model | Price ratio (input) |
|----------|-----------|-------------|-------------------|
| OpenAI | gpt-5.3-codex | gpt-4o-mini | ~10-20x cheaper |
| Anthropic | claude-sonnet-4 | claude-haiku-4 | ~10x cheaper |
| Ollama | 70B | 8B | Free (but latency differs) |

With ~60% of calls routed to the light model and a 10x price ratio:
- 60% of calls at 1/10 cost = 6% of original cost for those calls
- 40% of calls at full cost = 40% of original cost
- **Total: ~46% of original cost = 54% cost reduction**

**Estimate: 50-70% cost reduction** (without reducing call count).

---

## 5. Combined Savings Estimate

The three pillars compound multiplicatively because they target different aspects:

| Pillar | What it reduces | Estimated reduction |
|--------|----------------|-------------------|
| Pillar 1: Staged Observation | Number of observation LLM calls | 40-60% fewer observation calls |
| Pillar 2: Loop Skip | Number of task/verify LLM calls | 20-40% fewer task+verify calls |
| Pillar 3: 2-Model Routing | Cost per LLM call | 50-70% lower cost per call |

### Worked example

Baseline: 3-dimension goal, 20 iterations, all using gpt-5.3-codex.

| Phase | Baseline calls | After Pillar 1 | After Pillar 2 | Calls remaining |
|-------|---------------|----------------|----------------|-----------------|
| Observation | 60 | 30 (-50%) | 30 (no effect) | 30 |
| Task generation | 20 | 20 | 12 (-40%) | 12 |
| Verification | 30 | 30 | 18 (-40%) | 18 |
| **Total calls** | **110** | **80** | | **60** |

After Pillar 3 (2-model routing on the 60 remaining calls):
- 36 calls routed to light model (observation + verification)
- 24 calls use main model (task gen + re-reviews)
- At 10x price ratio: effective cost = 24 + 3.6 = **27.6 call-equivalents**

**Combined: ~75% cost reduction** (from 110 full-price calls to ~28 call-equivalents).

---

## 6. Implementation Phases

Each pillar is independently deployable. They do not depend on each other.

### Phase A: 2-Model Routing (Pillar 3)

**Why first:** Smallest code change (5-6 files, mostly adding `model_tier` parameter), largest immediate cost impact, zero risk to loop correctness.

Scope:
1. Add `light_model` to provider config schema
2. Add `ModelTier` type and routing logic to `BaseLLMClient`
3. Annotate existing call sites with appropriate tiers
4. Update provider config documentation

Estimated effort: 1-2 days. No new tests beyond unit tests for routing logic.

### Phase B: Staged Observation (Pillar 1)

**Why second:** Moderate code change (new file + observation engine modification), high savings, but requires careful confidence-decay tuning.

Scope:
1. Implement `DimensionPreChecker` with file-stat and git-diff strategies
2. Integrate into `ObservationEngine.observe()` before existing fallback
3. Add `observation_optimization` config to goal schema
4. Add tests for pre-check logic and confidence decay

Estimated effort: 2-3 days. Requires integration tests with real file-system changes.

### Phase C: State Diff + Loop Skip (Pillar 2)

**Why last:** Requires the most careful testing (loop behavior changes are high-risk). Pillar 1 and 3 should be stable before adding loop-level skipping.

Scope:
1. Implement `StateDiffCalculator`
2. Integrate into `core-loop.ts` after observation phase
3. Add consecutive skip limit and interaction with stall detection
4. Add integration tests for skip behavior

Estimated effort: 2-3 days. Requires end-to-end testing to verify stall detection still works.

### Phase D (optional): Tier Override Config

Add `model_routing` config field for per-call-site tier overrides. Only if user feedback requests it.

---

## 7. Risks and Mitigations

### Risk: Stale observations from caching (Pillar 1)

If the pre-check incorrectly reports "no change" when the environment has changed (e.g., a file was modified by an external process between `stat` checks), the observation will be stale.

**Mitigation:** Confidence decay (0.95x per skip) ensures forced refresh. The `min_observation_interval` default of 60s limits the staleness window. Users can disable `skip_on_no_change` per goal.

### Risk: Loop skip masks stalls (Pillar 2)

If the loop keeps skipping, stall detection (which runs in phase 6) never executes.

**Mitigation:** `max_consecutive_skips` (default 5) forces a full loop run periodically. After 5 skips, stall detection runs and can trigger its graduated response.

### Risk: Light model produces lower quality (Pillar 3)

The light model may produce worse observations or verification judgments than the main model.

**Mitigation:** Observation scores are already validated by score-jump suppression (delta > 0.4 from previous is rejected). Verification has L1 mechanical checks as a safety net. The tier assignment is conservative -- only well-defined classification tasks use the light model. Users can override tiers via config.

### Risk: Provider compatibility

Not all providers support multiple models with the same API key/endpoint.

**Mitigation:** When `light_model` is not configured, all calls use `model` (zero behavior change). The feature is opt-in. For Ollama, both models are local. For cloud providers, both models typically share the same API key.

---

## 8. Not Included / Future Work

The following are explicitly out of scope for this design:

- **Prompt caching** (Anthropic `cache_control`, OpenAI prompt prefix caching): Valuable but provider-specific. Would require changes to the LLM client abstraction. Consider as a separate optimization.

- **Context condensation / trajectory compression**: PulSeed's LLM calls are stateless single-turn (no conversation history). Context condensation is unnecessary because there is no trajectory to compress.

- **Task/plan caching**: Caching successful task templates for reuse. Related to the knowledge transfer system (`knowledge-transfer.md`), not token optimization. Consider integrating with StrategyTemplateRegistry.

- **Dynamic tier routing via LLM**: Using an LLM to decide which model to use. This adds cost and latency. Rule-based routing is simpler and sufficient.

- **Embedding-based observation deduplication**: Using vector similarity to detect redundant observations. Overengineered for the problem size. Simple value comparison suffices.

- **Token-level compression (TokenOps)**: Compiler-style token optimization. High implementation complexity for moderate gains. Not justified given the simpler pillar-based approach.
