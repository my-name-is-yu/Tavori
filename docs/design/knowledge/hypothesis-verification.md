# Hypothesis Verification Mechanism Design

> Three design improvements inspired by AutoResearchClaw's PIVOT/REFINE decision loop, self-learning, and convergence detection.
> These make PulSeed's orchestration loop more autonomous and adaptive.

---

## Background

### What is AutoResearchClaw?

[AutoResearchClaw](https://github.com/aiming-lab/AutoResearchClaw) is an autonomous research pipeline with a 23-stage, 8-phase structure. Its key characteristics are:

- A repeating loop of: hypothesis generation → experiment design → execution → evaluation
- **PIVOT/REFINE decision loop**: automatically decides whether to "tune parameters (REFINE)" or "change direction (PIVOT)" when an experiment fails
- **Self-learning**: accumulates past decision outcomes as meta-knowledge and uses them in future decisions
- **Convergence detection**: distinguishes convergence from stagnation based on transition patterns rather than simple threshold checks

### PulSeedtion for Applying This to PulSeed

PulSeed's core loop (observe → gap → score → task → execute → verify) is structurally sound, but has the following issues:

1. **No defined action after stall detection** — Even when StallDetector determines "it has stalled," CoreLoop has only limited branching
2. **Zero meta-knowledge for strategy decisions** — There is no record of which strategies were effective for similar goals in the past, and no way to look that up
3. **Cannot distinguish convergence from stagnation** — An absolute threshold check on `gap < threshold` alone cannot handle the case where progress is "close but not quite there"

AutoResearchClaw's approach directly addresses these three issues. However, PulSeed is fundamentally loop-based and should not adopt domain-specific logic such as paper generation.

---

## Improvement 1: Structured PIVOT/REFINE Decision

**Affected modules**: `stall-detector.ts`, `strategy-manager.ts`, `core-loop.ts`, `types/`
**Effort**: Medium (2–3 days)

### Current Problem

```
observe → gap → stall? → YES → switch_strategy (rationale unclear)
                       → NO  → continue
```

StallDetector returns "stall detected," but there is no root cause analysis of **why** it stalled. StrategyManager has strategy-switching logic, but the criteria for deciding when and how to switch are vague.

### Proposed Design

```
observe → gap → stall?
  ├─ NO  → continue
  └─ YES → analyze_cause()          ← NEW
       ├─ parameter_issue → REFINE  (adjust parameters and retry)
       ├─ strategy_wrong  → PIVOT   (switch strategy, keep goal)
       └─ goal_unreachable → ESCALATE (re-negotiate goal)
```

### Addition to StallDetector: `analyzeStallCause()`

Infers the cause from the recent Gap transition pattern.

| Pattern | Judgment | Definition |
|---------|----------|------------|
| oscillating | `parameter_issue` | Gap repeatedly goes up and down (high variance, mean unchanged) |
| flat | `strategy_wrong` | Gap change is nearly zero |
| diverging | `goal_unreachable` | Gap monotonically increases (worsening) |

```typescript
type StallCause = 'parameter_issue' | 'strategy_wrong' | 'goal_unreachable';

interface StallAnalysis {
  cause: StallCause;
  confidence: number;   // 0.0–1.0
  evidence: string;     // Human-readable explanation
}
```

### Addition to StrategyManager: Rollback Target

Define a "fallback destination when this strategy fails" for each strategy.

```typescript
interface StrategyDefinition {
  id: string;
  rollbackTarget?: string;   // Target strategy id on PIVOT
  maxPivotCount: number;     // Default 2 (aligned with AutoResearchClaw)
}
```

### CoreLoop Changes

Extend the existing stall branch to three directions:

```typescript
if (stallDetected) {
  const analysis = await stallDetector.analyzeStallCause(gapHistory);
  switch (analysis.cause) {
    case 'parameter_issue': return 'REFINE';    // Adjust parameters and continue
    case 'strategy_wrong':  return 'PIVOT';     // Switch strategy
    case 'goal_unreachable': return 'ESCALATE'; // Proceed to goal re-negotiation
  }
}
```

If the maximum pivot count is exceeded, escalate to ESCALATE.

---

## Improvement 2: Decision History Learning Loop

**Affected modules**: `knowledge-manager.ts`, `strategy-manager.ts`, `types/`
**Effort**: Medium–Large (3–5 days); recommended to implement alongside M13

### Current Problem

KnowledgeManager accumulates knowledge within a goal (execution logs, observation results), but it does not retain **meta-knowledge about strategy decisions** (which type of strategy was effective for which type of goal). This means the same mistakes may be repeated.

### Proposed Design: DecisionRecord Schema

```typescript
interface DecisionRecord {
  goalType: string;       // Type of goal (e.g., "code_quality", "test_coverage")
  strategyId: string;     // Strategy used
  decision: 'proceed' | 'refine' | 'pivot' | 'escalate';
  context: {
    gapValue: number;
    stallCount: number;
    cycleCount: number;
    trustScore: number;
  };
  outcome: 'success' | 'failure';
  timestamp: string;      // ISO 8601
}
```

### New API Added to KnowledgeManager

```typescript
// Record a decision
recordDecision(record: DecisionRecord): Promise<void>;

// Retrieve past decisions for similar goals (with time-decay)
queryDecisions(goalType: string, limit?: number): Promise<DecisionRecord[]>;
```

**Time-decay**: 30 days (same as AutoResearchClaw). Old records are referenced with reduced weight and automatically deleted after a long period.

### Integration into StrategyManager.selectStrategy()

Reference past decision history when selecting a strategy:

1. Exclude strategies that were previously PIVOTed away from on similar goals
2. Prioritize strategies with a high success rate on similar goals
3. Fall back to the existing logic when history is insufficient (fewer than 3 records)

### Integration with M13

This naturally integrates with the cross-goal semantic knowledge sharing planned for M13 (KnowledgeManager Phase 2). Including DecisionRecords as targets for semantic search improves the accuracy of "similar goal" matching.

---

## Improvement 3: Strengthened Convergence Detection

**Affected modules**: `satisficing-judge.ts`, `types/`
**Effort**: Small (half a day to 1 day)

### Current Problem

SatisficingJudge uses only an absolute value check of `gap < threshold`. It cannot distinguish between "close but not yet at the threshold, and improvement has stalled" and "still improving."

```
gap = 0.15, threshold = 0.10
→ Current: Continues indefinitely as unachieved
→ Ideal: Should detect convergence and delegate to StallDetector
```

### Proposed Design: Convergence Detection Logic

Maintain the last N Gap values (default N=5) in a ring buffer, and declare convergence if the variance is small.

| Condition | Judgment | Action |
|-----------|----------|--------|
| `gap < threshold` | satisficed | Complete (existing) |
| `variance < ε AND gap ≤ threshold × 1.5` | converged_satisficed | Complete (NEW) |
| `variance < ε AND gap > threshold × 1.5` | stalled | Delegate to StallDetector (NEW) |
| Otherwise | in_progress | Continue |

Default parameter values:

```typescript
const CONVERGENCE_WINDOW = 5;       // Ring buffer size
const CONVERGENCE_EPSILON = 0.01;   // Variance threshold (requires tuning)
const ACCEPTABLE_RANGE_FACTOR = 1.5; // How many multiples of threshold to accept
```

`converged_satisficed` aligns with the spirit of satisficing (don't chase perfection). If the value is within threshold × 1.5, it is judged as "effectively sufficient."

### Additions to Type Definitions

```typescript
type SatisficingResult =
  | 'satisficed'
  | 'converged_satisficed'   // NEW
  | 'stalled'                // NEW (delegated to StallDetector)
  | 'in_progress';
```

---

## Implementation Order

| Order | Improvement | Rationale |
|-------|-------------|-----------|
| 1 | **Improvement 3** Convergence detection | Highly independent and immediately actionable. Limited impact on existing tests |
| 2 | **Improvement 1** PIVOT/REFINE decision | Greatly increases StallDetector's value. Leverages the `stalled` judgment from Improvement 3 |
| 3 | **Improvement 2** Learning loop | Only meaningful after Decisions from Improvement 1 have accumulated. Efficient to implement alongside M13 |

---

## What Not to Adopt from AutoResearchClaw

| Element | Reason |
|---------|--------|
| 23-stage linear pipeline | PulSeed is fundamentally loop-based. Linear flow is an anti-pattern |
| Domain-specific logic (LaTeX/papers) | PulSeed is a domain-agnostic orchestrator |
| Fixed loop count cap | PulSeed judges via satisficing. A count cap undermines autonomy |
| Automatic experiment design generation | This is the role of TaskLifecycle. No overlap needed |

---

## References

- [AutoResearchClaw](https://github.com/aiming-lab/AutoResearchClaw)
- [docs/module-map.md](../module-map.md) — Related module boundary map
- [docs/design/stall-detector.md](stall-detector.md) — StallDetector design
- [docs/design/satisficing.md](satisficing.md) — SatisficingJudge design
- [docs/design/knowledge-acquisition.md](knowledge-acquisition.md) — KnowledgeManager design
