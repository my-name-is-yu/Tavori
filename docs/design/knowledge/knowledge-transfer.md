# Knowledge Transfer Design

> Related: `learning-pipeline.md`, `curiosity.md`, `portfolio-management.md`, `goal-tree.md`, `trust-and-safety.md`

---

## 1. Overview

Knowledge transfer is a **cross-goal knowledge and strategy transfer system**. It automatically applies patterns and successful strategies learned in one goal to similar goals.

```
Goal A (completed / in progress)
  └── LearnedPattern set / successful strategy history
        │
        ↓ Similarity search + LLM context adaptation
        │
Goal B (in progress)
  └── Transferred knowledge / strategy templates
        │
        └→ Feedback to the task discovery loop
```

**Purpose of transfer**: While `learning-pipeline.md` handles "experiential learning within a single goal," knowledge transfer handles "reuse of experience across goals." When pursuing multiple goals in the same domain, failures and successes from the first goal can substantially improve efficiency on subsequent goals.

---

## 2. Data Model

### 2.1 TransferCandidate

```
TransferCandidate {
  id: string
  source_goal_id: string          // Source goal
  target_goal_id: string          // Target goal
  transfer_type: TransferType     // Transfer type (§3)
  source_item_id: string          // ID of the original pattern/strategy

  similarity_score: number        // Embedding similarity between goals (0.0–1.0)
  domain_tag_match: boolean       // Whether domain tags match
  adapted_content: string | null  // Content after LLM context adaptation

  state: TransferCandidateState   // pending / proposed / applied / rejected / invalidated
  effectiveness_score: number | null  // Effectiveness score after application (§5)

  proposed_at: DateTime
  applied_at: DateTime | null
  invalidated_at: DateTime | null
}
```

### 2.2 CrossGoalKnowledgeBase

```
CrossGoalKnowledgeBase {
  meta_patterns: MetaPattern[]    // Cross-domain meta-patterns (§6)
  strategy_templates: StrategyTemplate[]  // Strategy templates (see §3.2)
  last_aggregated_at: DateTime
}
```

---

## 3. Transfer Types

| Type | Content | Source |
|------|---------|--------|
| `knowledge` | Domain knowledge transfer (observation accuracy, scope-sizing patterns) | LearnedPattern |
| `strategy` | Application of successful strategy templates | Strategy (effectiveness_score >= 0.5 and completed) |
| `pattern` | Sharing of learned patterns (same type as `learning-pipeline.md` §4) | LearnedPattern |

---

## 4. Transfer Candidate Detection

### 4.1 Detection Timing

A transfer candidate detection cycle runs once every 5 iterations.

```
Detection cycle
    │
    ↓
Retrieve all active goals
    │
    ↓
Score transfer candidates for each goal pair (§4.2)
    │
    ↓
Save top-scoring candidates as TransferCandidates
```

### 4.2 Scoring

```
transfer_score =
  similarity_score × original_confidence × effectiveness_score_normalized

similarity_score:
  Calculate cosine similarity of goal embeddings via VectorIndex

original_confidence:
  confidence / effectiveness_score of the source LearnedPattern or strategy

effectiveness_score_normalized:
  If already applied at source: actual effectiveness score (0.0–1.0)
  If not yet applied: 0.5 (neutral)
```

**Search scope**:
1. Search for related knowledge via `KnowledgeManager.searchAcrossGoals()`
2. Calculate embedding similarity of goal definitions via `VectorIndex` (only where similarity_score >= 0.7)
3. Match `LearnedPattern.domain_tags` (if at least one tag matches, add +0.1 bonus to score)

---

## 5. Application Process

### 5.1 Flow

```
TransferCandidate (proposed)
    │
    ↓
LLM context adaptation
    │ - Rewrite the source expression to fit the target domain/dimensions
    │ - Abstract context-dependent parts from the source
    ↓
Safety check (§5.2)
    │
    ├── Incompatible → Update TransferCandidate to rejected
    │
    └── Compatible → Proposal to user (Phase 1)
                    │
                    ├── Approved → Update to applied → Inject into SessionManager
                    └── Rejected → Update to rejected
```

### 5.2 Safety Check

**Domain constraint compatibility check**: Verify that the constraints of the target goal (`constraints`) are not in conflict with the prerequisites of the transferred pattern or strategy. The LLM evaluates compatibility, and any detected conflict results in rejection.

**Ethics gate**: Pass through the `checkGoal()` function in `ethics-gate.md`. Since applying a transfer equates to injecting a new action policy, the ethics check is mandatory.

**No automatic application (Phase 1)**: In Phase 1, all transfers are always presented as proposals to the user. Automatic application is not performed.

---

## 6. Effectiveness Evaluation

### 6.1 Measuring Effectiveness

After a transfer is applied, effectiveness is evaluated at the next learning trigger (`learning-pipeline.md` §2).

```
effectiveness_delta =
  gap_reduction_rate_after_transfer - gap_reduction_rate_before_transfer

  gap_reduction_rate: Amount of Gap reduction per unit time (normalized)
```

### 6.2 Confidence Updates

```
Effective (effectiveness_delta > 0.05)       → original_confidence += 0.1
No effect (-0.05 <= delta <= 0.05)           → no change
Degraded (effectiveness_delta < -0.05)       → original_confidence -= 0.15
```

### 6.3 Automatic Invalidation

```
3 consecutive neutral or negative evaluations
    │
    ↓
Update TransferCandidate to invalidated
Set cross_goal_applicable flag on source pattern/strategy to false
```

---

## 7. Cross-Goal Knowledge Base

### 7.1 Meta-Pattern Extraction

Aggregate all goals' LearnedPatterns and use the LLM to extract cross-domain meta-patterns.

```
Meta-pattern extraction
    │ Input: All goals' LearnedPatterns (confidence >= 0.6)
    │
    ↓
LLM clustering and abstraction
    │ - Group similar patterns together
    │ - Remove goal-specific parts and generalize
    │
    ↓
Register as MetaPattern in CrossGoalKnowledgeBase
    │
    └→ Generate embedding + register in VectorIndex
```

### 7.2 Applying Meta-Patterns

When a new goal is added, search the CrossGoalKnowledgeBase for similar meta-patterns and inject them into the session context. This allows PulSeed to reference "what worked for similar goals in the past" from the very beginning.

---

## 8. Safety Guardrails Summary

| Constraint | Details |
|------------|---------|
| Similarity threshold | Only goal pairs with similarity >= 0.7 are detected as transfer candidates |
| LLM compatibility check | Detects domain constraint conflicts |
| Ethics gate required | All transfer candidates must pass the check in ethics-gate.md |
| User approval (Phase 1) | No automatic application; always follows propose → approve flow |
| Automatic invalidation | Auto-invalidated after 3 consecutive ineffective/degrading results |
| Confidence discount | Transfers start at confidence × 0.7 (`learning-pipeline.md` §6.2) |

---

## 9. MVP vs Phase 2

### MVP (Phase 1 / Stage 14F)

| Item | MVP Specification |
|------|------------------|
| Detection timing | Once every 5 iterations |
| Similarity calculation | Cosine similarity via VectorIndex |
| Automatic application | None (all presented as user proposals) |
| Meta-pattern extraction | Only on goal_completed trigger |
| Knowledge base updates | Batch (manual trigger) |

### Phase 2

| Item | Phase 2 Specification |
|------|----------------------|
| Automatic application | High-confidence (confidence >= 0.85) patterns applied automatically |
| Real-time detection | Transfer candidates scanned dynamically just before task generation |
| Knowledge base updates | Continuous (incremental updates on each learning trigger) |
| Transfer effectiveness visualization | Display "time saved via transfer" in reports |

---

## Summary of Design Principles

| Principle | Specific Design Decision |
|-----------|--------------------------|
| Transfer is proposed; humans decide | No automatic application in Phase 1. The user always makes the final call |
| Show the basis for similarity | Visualize similarity_score and domain_tag_match |
| Safety checks are mandatory | Compatibility check + ethics gate applied to all transfer candidates |
| Track and improve effectiveness | Continuously update confidence based on transfer outcome feedback |
| Invalidate failed transfers | Auto-invalidate after 3 consecutive failures to remove noise |

---

## External Reference: claude-mem

> Source: [claude-mem](https://github.com/thedotmack/claude-mem) — A library for injecting memory across sessions. The following insights are reflected in the PulSeed M16 design.

### A. Structured Field Design for session_summaries (Data Structure Pattern)

claude-mem stores session summaries in structured fields: `investigated / learned / completed / next_steps`. Compared to unstructured text, this enables field-level search and matching, greatly improving transfer accuracy.

**Application to M16**: Add the following fields to transfer source data (e.g., DecisionRecord) in KnowledgeTransfer Phase 2 to structure the transfer source data.

```
DecisionRecord (extended proposal) {
  // Existing fields...

  // Phase 2 additional fields (claude-mem pattern)
  what_worked: string[]    // Approaches/strategies that were effective
  what_failed: string[]    // Approaches that failed and their reasons
  suggested_next: string[] // Suggestions/recommended actions for the next goal
}
```

Structuring the data changes transfer matching from "full-text similarity" to "field-level comparison," enabling separate handling of "avoiding failure patterns" and "reusing success patterns."

### B. Progressive Disclosure (Three-Phase Fetch Strategy)

claude-mem achieves approximately a 10x token reduction with a three-phase fetch: `search → timeline → get_observations`.

| Phase | Content | Token Volume |
|-------|---------|--------------|
| search | Returns index only | ~50–100 tokens/item |
| timeline | Chronological context around an anchor ID | Medium |
| get_observations | Full text retrieval by ID list | ~500–1000 tokens/item |

**Application to M16**: In Phase 2's dynamic context budget approach, change the current fixed top-4 retrieval to progressive retrieval.

```
Current (fixed top-4):
  Fetch all candidates in full → Select top 4

Improved approach (Progressive Disclosure):
  Step 1: Fetch index of all candidates (ID + title + score)    ← Low cost
  Step 2: Narrow to top N candidates (within budget constraints)
  Step 3: Fetch full text only for the narrowed candidates      ← Only what's needed
```

This progressive approach allows PulSeed to consider a wide set of candidates and select the optimal knowledge even when the context budget is tight.

### C. Small but Useful Design Patterns

| Pattern | claude-mem Implementation | Applicability to M16 |
|---------|--------------------------|----------------------|
| `discovery_tokens` field | Records the token cost of knowledge retrieval | Record token costs in TransferCandidate to use as a basis for budget allocation |
| `concepts` JSON array | Schema-independent concept tags | Extend LearnedPattern's `domain_tags` to improve cross-goal matching accuracy |
| `timeline` pattern | Chronological retrieval around an anchor ID | Efficiently retrieve what happened around a strategy change (stall detection → strategy switch → recovery) |

### D. What claude-mem Does Not Cover (Areas Requiring PulSeed-Specific Design)

claude-mem specializes in memory injection between single sessions; the following require original PulSeed design.

| Feature | Reason |
|---------|--------|
| Cross-goal knowledge transfer | claude-mem handles single-session injection only. PulSeed runs multiple goals in parallel and in series |
| Transfer confidence score learning | The mechanism to update confidence by feeding back transfer effectiveness (§6.2) is unique to PulSeed |
| Dynamic budget enforcement | claude-mem's TokenCalculator only calculates costs without enforcing budgets. PulSeed needs priority-based reduction when budget is exceeded |
