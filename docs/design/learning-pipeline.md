# Learning Pipeline Design

> Related: `curiosity.md`, `session-and-context.md`, `stall-detection.md`, `observation.md`, `portfolio-management.md`

---

## 1. Overview

The learning pipeline is a **structured learning system built from experience**. It analyzes experience gathered during goal pursuit (task execution results, Gap changes, strategy effectiveness) and applies it as feedback to the four steps — Observation, Gap, Strategy, and Task.

```
Experience log (task results, Gap changes, strategy effectiveness)
    │
    ↓
Analysis pipeline (LLM batch analysis)
    │ Extract state→action→outcome triplets
    │ Pattern detection, confidence calculation
    ↓
LearnedPattern (registered)
    │
    ├── Observation accuracy patterns → Feedback to ObservationEngine
    ├── Strategy selection patterns   → Feedback to StrategyManager
    ├── Scope-sizing patterns         → Feedback to TaskLifecycle
    └── Task generation patterns      → Feedback to TaskLifecycle
```

**Purpose of learning**: PulSeed may pursue the same goal multiple times. Without learning, it would repeat the same mistakes every time. The learning pipeline is the mechanism to "put accumulated experience to use in the next loop."

---

## 2. Learning Triggers

Learning analysis is triggered by the following four events.

### 2.1 Milestone Reached (milestone_reached)

```
Condition: A specific dimension of the goal has crossed a milestone threshold
Meaning: Record and analyze partial success
```

Record what worked immediately after it takes effect. Over time, the state changes and causal relationships become unclear, so batch analysis right after reaching the milestone is important.

### 2.2 Stall Detected (stall_detected)

```
Condition: First or second detection from stall-detection.md has triggered
Meaning: Record what did not work and extract patterns to avoid repeating the same failure
```

During a stall, analyze "why it did not work." Task-level failure patterns (scope too large, missing prerequisites, etc.) are the primary extraction targets.

### 2.3 Periodic Review (periodic_review)

```
Condition: A defined interval has elapsed since the last learning analysis
```

| Goal Type | Default Interval |
|-----------|-----------------|
| Short-term (within 1 month) | 72 hours (3 days) |
| Medium-term (1–6 months) | 1 week |
| Long-term (6+ months) | 2 weeks |

Even for in-progress goals, periodically analyze the accumulated logs and update patterns.

### 2.4 Goal Completed (goal_completed)

```
Condition: The goal has passed the completion judgment in satisficing.md
Meaning: A full retrospective of the entire goal. The most comprehensive analysis.
```

Completion analysis is the most important. It summarizes the experience across the entire goal and becomes the source data for cross-goal sharing (§6).

---

## 3. Analysis Pipeline

### 3.1 Input Data

```
Analysis batch input {
  goal_id: string
  analysis_window: { start: DateTime, end: DateTime }
  task_results: TaskResult[]       // All task results within the window
  gap_history: GapSnapshot[]       // Time series of Gap changes
  strategy_history: Strategy[]     // Strategies tried and their effectiveness scores
  observation_accuracy_log: ObservationAccuracyEntry[]  // Observation accuracy records
}
```

### 3.2 Triplet Extraction

The LLM extracts **state→action→outcome triplets** from the input data.

```
Triplet {
  state_context: string     // What state was in place
  action_taken: string      // What action was taken
  outcome: string           // What outcome resulted
  gap_delta: number         // Quantitative Gap change
}
```

### 3.3 Pattern Detection

Aggregate the extracted triplets and detect recurring patterns.

**Confidence calculation**:

```
confidence = occurrence_frequency × result_consistency

occurrence_frequency = tripletsWithSameAction.length / totalTriplets
result_consistency   = consistentOutcomes / tripletsWithSameAction.length
  // consistentOutcomes: number of times the outcome went in the same direction (improvement or degradation)
```

Only patterns at or above the `min_confidence_threshold` (default: 0.6) are registered as LearnedPatterns.

### 3.4 Specificity Check

Before registration, verify the specificity of the pattern. **Vague descriptions are rejected**.

| Description Example | Judgment | Reason |
|---------------------|----------|--------|
| "Make it better" | Rejected | Cannot identify the action |
| "Multiply the estimate by 1.5" | Accepted | A specific action is identifiable |
| "Make the scope smaller" | Rejected | Unclear what or by how much |
| "Split the task into 3 steps or fewer" | Accepted | Action is clear |

---

## 4. Pattern Types

### 4.1 observation_accuracy

```
Target: Observation accuracy of ObservationEngine
Example: "In this goal's domain, LLM estimates average 20% higher than file-based measurements"
Applied to: Confidence correction factor during observation
```

### 4.2 strategy_selection

```
Target: Strategy candidate generation by StrategyManager
Example: "In this domain, content initiatives are only effective when initial gap > 0.5"
Applied to: Adding constraints to strategy generation prompts
```

### 4.3 scope_sizing

```
Target: Task scope decisions in TaskLifecycle
Example: "In this goal, the failure rate doubles when a single task's scope exceeds 3 steps"
Applied to: Scope instructions in task generation prompts
```

### 4.4 task_generation

```
Target: Task content generation in TaskLifecycle
Example: "In this domain, including a prerequisite check step first in the task improves success rate"
Applied to: Format instructions in task generation prompts
```

---

## 5. Applying Feedback

### 5.1 Injection into SessionManager

Registered LearnedPatterns are injected into the SessionManager's context. When each LLM call is made, relevant patterns are passed as context.

```
Session context (additional fields):
  learned_patterns: {
    pattern_type: PatternType
    description: string          // Specific pattern content
    confidence: number
    applicable_condition: string // The conditions under which to apply it
  }[]
```

### 5.2 Tracking Effectiveness After Application

Track outcomes after a pattern is applied and update the pattern's confidence accordingly.

```
After pattern application
    │
    ↓ (at the next analysis trigger)
Effectiveness evaluation
    │
    ├── positive (Gap reduction accelerates)   → confidence += 0.1
    ├── neutral (no change)                    → confidence unchanged
    └── negative (Gap reduction slows)         → confidence -= 0.15
```

If confidence falls below `min_confidence_threshold`, the pattern is invalidated.

### 5.3 Pattern Count Limit

The maximum number of LearnedPatterns per goal is `max_patterns_per_goal` (default: 50).

When the limit is reached, the pattern with the lowest confidence is removed to make room for a new one (LRU-style update).

---

## 6. Cross-Goal Sharing

### 6.1 How Sharing Works

Patterns learned from one goal are shared with similar goals.

```
Sharing flow:
1. On goal_completed trigger, search for sharing candidates
2. Search for similar goals via VectorIndex (similarity >= 0.7)
3. LLM verifies compatibility with the target goal's domain and dimensions
4. Patterns judged compatible are registered in the target goal with injected_from_goal_id
5. Track effectiveness (same as §5.2)
```

### 6.2 Confidence Discount for Shared Patterns

Rather than using the source goal's confidence as-is, an initial discount is applied at the time of sharing.

```
transferred_confidence = original_confidence × 0.7
```

Reason: The domain and context are not completely identical, so the initial confidence is set conservatively. If effectiveness is confirmed, confidence rises following the rules in §5.2.

### 6.3 Control Flag

Controlled by the `cross_goal_sharing_enabled` flag (default: `true`). Users who wish to prohibit knowledge sharing between goals for privacy reasons can set this to `false`.

---

## 7. MVP vs Phase 2

### MVP (Phase 1 / Stage 14E)

| Item | MVP Specification |
|------|------------------|
| Analysis scope | Within the same goal only |
| Cross-goal sharing | Only on goal_completed trigger (with manual confirmation) |
| Feedback application | Injection into SessionManager only |
| Pattern count limit | 50 per goal |
| Periodic review interval | Fixed per goal type (table in §2.3) |

### Phase 2

| Item | Phase 2 Specification |
|------|----------------------|
| Real-time application | Dynamically inject patterns just before task generation |
| Automatic confidence adjustment | Immediate feedback from application results |
| Pattern version management | Maintain history of pattern changes |
| Pattern visualization for users | Include "what was learned" in reports |

---

## Summary of Design Principles

| Principle | Specific Design Decision |
|-----------|--------------------------|
| Do not register vague patterns | Exclude ambiguous descriptions via the specificity check |
| Confidence changes with evidence | Update confidence based on application outcomes |
| Apply a discount to transferred patterns | Patterns shared from other goals start at 0.7× confidence |
| Analysis is event-driven | Learning triggered at appropriate times by 4 triggers |
| Cap the number of patterns | Prevent unlimited accumulation with max_patterns_per_goal |
