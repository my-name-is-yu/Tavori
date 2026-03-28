# Memory Lifecycle Design

> PulSeed runs for years. Data accumulates without bound, but LLM context windows are finite.
> This document defines how to manage accumulating data hierarchically, and how to surface the right memories at the right time.

> Related: `session-and-context.md`, `knowledge-acquisition.md`, `reporting.md`, `state-vector.md`, `drive-system.md`, `curiosity.md`, `stall-detection.md`

---

## 1. Problem Definition

### What accumulates

Under long-term operation, PulSeed continuously accumulates the following data:

| Data type | Source | Growth rate |
|-----------|--------|------------|
| Experience log | Each step of the core loop (observe→gap→score→task→execute→verify) | 1 entry per loop |
| Observation history | ObservationEngine periodic and event-driven observations | dimensions × observation frequency |
| Knowledge base | Results of KnowledgeManager research tasks | Multiple entries per research task |
| Strategy history | Strategy execution results from StrategyManager/PortfolioManager | 1 entry per strategy change |
| Task history | Past tasks from TaskLifecycle | 1 entry per task |
| Report history | Past reports from ReportingEngine | Daily/weekly + immediate notifications |

Over a year of active operation, thousands to tens of thousands of entries accumulate. Tracking multiple goals simultaneously multiplies that count.

### Why simple LRU is not sufficient

"Delete the oldest first" is the simplest memory management strategy. But for PulSeed, it does not work.

**Reason 1: Old memories can be directly relevant to today's task.** Lessons from a strategy that failed 6 months ago may be needed for today's strategy selection. LRU would have discarded those lessons.

**Reason 2: New memories can be worthless.** During a stable period, daily "no change" observation logs are the latest entries but carry zero information. LRU retains them indefinitely.

**Reason 3: Importance is determined by relevance to the goal, not by data age.** Past data for a dimension with an approaching deadline is more important than the latest data for a dimension that is on track.

### Context window constraint

The context budget defined in `session-and-context.md` §4 (50% of the model's context window) is fixed. No matter how much data accumulates, the amount of information that can be passed to a single session does not change. This means the more data accumulates, the more critical the judgment of "what to select and pass" becomes.

---

## 2. Three-Layer Memory Model

The three memory tiers defined in `session-and-context.md` §8 (working memory, goal state, experience log) are extended and redefined as a three-layer model for managing memory lifecycle.

Correspondence to the existing three tiers:

| session-and-context.md §8 | This design | Notes |
|---|---|---|
| Working Memory | Working Memory | Extended: adds selection logic via DriveScorer integration |
| Goal State | Not managed here | Goal tree, state vector, and other persistent files are outside this design's lifecycle management. They follow the goal lifecycle (create→progress→complete/cancel), governed by the archiving rules in `state-vector.md` |
| Experience Log | Short-term + Long-term | Raw logs retained in Short-term; compressed/summarized patterns moved to Long-term |

```
Working Memory
  │ Capacity: within context budget
  │ Lifetime: 1 session (1 loop)
  │ Contents: only information needed for the current task
  │
  ├── Selection ←── selects relevant data from Short-term Memory
  │
Short-term Memory
  │ Capacity: configurable (default: last 100 loops)
  │ Lifetime: configurable retention period
  │ Contents: raw data retained as-is
  │
  ├── Compression ←── summarizes and migrates data past the retention period
  │
Long-term Memory
  │ Capacity: up to storage limit (with garbage collection)
  │ Lifetime: as long as the PulSeed instance exists
  │ Contents: summaries of patterns, statistics, and lessons. Raw logs discarded
```

### Working Memory

**Definition**: Data injected into the context window of the current session. It is the direct output of the context selection algorithm in `session-and-context.md` §4.

**Capacity**: Context budget (50% of the model's context window).

**Lifecycle**: Assembled at session start, discarded when the session ends. Lifetime is one loop.

**Design decision**: Working Memory is less of a "layer" and more of a "view" — a selection and projection of data from Short-term/Long-term that is relevant to the current task. Designing Working Memory means designing the selection logic (detailed in §5).

### Short-term Memory

**Definition**: A layer that retains recent loop results as uncompressed raw data.

**Retention period**: Configurable. Defaults are as follows:

| Goal type | Default loop retention count | Approximate time |
|-----------|----------------------------|-----------------|
| Health monitoring | 200 loops | ~1 week |
| Business metrics | 100 loops | ~1–3 months |
| Long-term projects | 50 loops | ~3–6 months |

**Rationale for retention**: Raw data is needed for two reasons. (1) Stall detection (`stall-detection.md` §2) requires time-series raw data. (2) Detailed recent context is directly tied to strategy selection accuracy.

### Long-term Memory

**Definition**: A layer that retains old data that has exceeded its retention period, compressed into patterns, statistics, and lessons.

**Summary format**: Varies by data type (detailed in §3). The common principle is "discard raw logs and retain only the insights extracted from them."

**Retention rules**: Entries in Long-term Memory are retained under the following conditions:
- Success patterns: retained indefinitely as lessons
- Failure patterns: retained indefinitely as summaries of "what failed"
- Statistical data: retained as long as the goal exists. Statistics for completed or canceled goals are archived after lesson extraction.

---

## 3. Memory Management by Data Type

### 3.1 Experience Log

Records of the result of each step of the core loop (observe→gap→score→task→execute→verify). The data source for the learning pipeline in `mechanism.md` §4.

| Layer | What is retained | Format |
|-------|----------------|--------|
| Working | Summary of the last 2–3 loops of experience relevant to the current task | Text summary |
| Short-term | Complete experience log entries for the last N loops | Raw JSON |
| Long-term | Extracted lessons ("this approach worked/didn't work in this situation") | Structured lesson entries |

```
// Example Long-term lesson entry
{
  "lesson_id": "lesson_abc123",
  "type": "strategy_outcome",
  "context": "Churn rate exceeded 8%",
  "action": "Onboarding UI improvement",
  "outcome": "No effect after 3 weeks. Churn rate change was only -2%",
  "lesson": "UI improvement alone is insufficient to reduce churn. Combined with improved support is necessary",
  "source_loops": ["loop_042", "loop_043", "loop_044"],
  "extracted_at": "2026-06-15T09:00:00Z",
  "relevance_tags": ["churn", "onboarding", "ui"]
}
```

### 3.2 Observation History

Past observation results produced by ObservationEngine. Corresponds to the `history` field in `state-vector.md` §5.

| Layer | What is retained | Format |
|-------|----------------|--------|
| Working | Last 3 observed values + trend (rising/falling/flat) for the target dimension | Text summary |
| Short-term | Raw observation data for the history depth defined in `state-vector.md` §5 | Raw JSON |
| Long-term | Per-dimension statistical summary (mean, variation range, trend, anomaly frequency) | Statistics JSON |

**Relationship to existing design**: The history retention depth in `state-vector.md` §5 (short-term goals: 10–20 observations, long-term goals: 50–100 observations) corresponds to this design's Short-term Memory. This design defines what happens next — "what to do with observation data that has exceeded its retention period."

### 3.3 Knowledge Base

Domain knowledge managed by KnowledgeManager. Corresponds to `domain_knowledge.json` in `knowledge-acquisition.md` §5.

| Layer | What is retained | Format |
|-------|----------------|--------|
| Working | Domain knowledge entries relevant to the current task (matched by tags) | Text excerpt |
| Short-term | All active knowledge entries | KnowledgeEntry from `knowledge-acquisition.md` §5.2 |
| Long-term | Only high-confidence knowledge retained. Low-confidence and stale knowledge discarded | Compressed KnowledgeEntry |

**Relationship to existing design**: The knowledge staleness handling in `knowledge-acquisition.md` §6.3 and the active forgetting policy in this design (§6) are complementary. Staleness detection triggers re-verification; the forgetting policy determines whether to retain or discard. They do not conflict.

### 3.4 Strategy History

Strategy execution results and evaluations recorded by StrategyManager/PortfolioManager.

| Layer | What is retained | Format |
|-------|----------------|--------|
| Working | Current strategy + result of the last strategy tried | Text summary |
| Short-term | Complete execution records for the last N strategies (start date, end date, effect, pivot reason) | Raw JSON |
| Long-term | Strategy success/failure patterns ("which strategies worked/failed in which situations") | Lesson entries |

Strategy history retains high value even after moving to Long-term. "What worked and what didn't in the past" directly influences future strategy selection.

### 3.5 Task History

Records of past tasks managed by TaskLifecycle.

| Layer | What is retained | Format |
|-------|----------------|--------|
| Working | Current task definition + result of the previous task (for retries) | Task definition JSON |
| Short-term | Complete records for the last N tasks (definition, success criteria, result, duration) | Raw JSON |
| Long-term | Per-task-category statistics (success rate, average duration, failure patterns) | Statistics JSON |

```
// Example Long-term task statistics
{
  "task_category": "knowledge_acquisition",
  "goal_id": "goal_health_01",
  "stats": {
    "total_count": 12,
    "success_rate": 0.83,
    "avg_duration_hours": 2.5,
    "common_failure_reason": "Insufficient source reliability"
  },
  "period": "2026-01 to 2026-06"
}
```

### 3.6 Report History

Past reports generated by ReportingEngine.

| Layer | What is retained | Format |
|-------|----------------|--------|
| Working | Not included (reports are PulSeed→user output, not loop input) | |
| Short-term | Recent daily/weekly reports (following file structure from `reporting.md` §5.1) | Markdown files |
| Long-term | Archive (following the existing design at `reports/archive/` in `reporting.md` §5.1) | Markdown files |

**Relationship to existing design**: Follows the existing design from `reporting.md` §5.1: "archive to `archive/` monthly." The report persistence principle (§10: archive, not delete) is also maintained.

---

## 4. Compression and Summarization Mechanism (Short → Long Migration)

Data in Short-term Memory that has exceeded its retention period is compressed and migrated to Long-term Memory. The migration process consists of two stages.

### 4.1 LLM-based summary generation

Extract reproducible patterns and lessons from the set of raw logs. Memory compression and the learning pipeline (`mechanism.md` §4) are **complementary mechanisms**. The learning pipeline is event-driven (triggered at milestone reached, stall detected, or periodic review) and performs pattern extraction and feedback. Memory compression is time-driven (triggered when retention period expires) and performs data summarization and migration. Both outputs are stored in the same Long-term Memory, but differ in trigger condition and purpose.

```
compress_to_long_term(data_type, entries):
    // Step 1: Extract patterns
    patterns = llm_extract_patterns(entries)

    // Step 2: Distill lessons
    lessons = llm_distill_lessons(patterns)

    // Step 3: Check for missing critical information (described below)
    validated_lessons = validate_completeness(lessons, entries)

    // Step 4: Save to Long-term Memory
    store_long_term(data_type, validated_lessons)

    // Step 5: Delete raw data from Short-term
    purge_short_term(entries)
```

### 4.2 Statistical summary

In parallel with LLM summarization, retain statistics computed in code.

| Statistic type | Calculation method | Use |
|---------------|-------------------|-----|
| Success rate | Successful tasks / total tasks | Strategy effectiveness evaluation |
| Average duration | Arithmetic mean of task durations | Scope sizing improvement |
| Progress rate per dimension | Gap reduction rate during the period | Foundation data for goal review |
| Observation value statistics | Mean, standard deviation, trend | Baseline update for anomaly detection |

Statistics are computed in code without using an LLM. Consistent with the `reporting.md` §7 principle: "numbers always come from code."

### 4.3 Summary quality assurance

There is a risk of losing important information during compression. The following checks prevent this.

**Failure pattern retention check**: Check whether any failure entries in Short-term are not reflected in Long-term lessons. Records of failure are more important than records of success (to avoid repeating the same mistake).

**Contradiction detection**: Check whether new lessons contradict existing Long-term lessons. If so, handle using the same flow as contradiction detection in `knowledge-acquisition.md` §6.2 (adopt the one with higher confidence).

**No complete deletion**: If migration to Long-term fails (LLM call error, etc.), do not delete Short-term data. Extend retention until migration succeeds.

For MVP, instead of full cross-checking, use a ratio check between failure entries and lesson entries (pass if lesson count ≥ failure entry count × 0.5). Full cross-checking is implemented in Phase 2.

---

## 5. Working Memory Selection Logic

Designing Working Memory is fundamentally about deciding what to include in context. Extend the context selection algorithm from `session-and-context.md` §4 to account for memory layers.

### 5.1 Goal and dimension partitioning

Memory data is partitioned by goal and dimension. Working Memory selection pulls preferentially from the partition belonging to the goal and dimension of the current task.

```
select_for_working_memory(current_task):
    goal_id = current_task.goal_id
    dimensions = current_task.target_dimensions

    // Step 1: Data directly related to current goal and dimensions
    primary = query_memory(goal_id, dimensions, layer="short_term")

    // Step 2: Other dimensions of the same goal (may be indirectly related)
    secondary = query_memory(goal_id, all_dimensions, layer="short_term")

    // Step 3: Long-term lessons (cross-goal)
    lessons = query_long_term_lessons(dimensions, current_task.context)

    // Step 4: Assemble in priority order within budget
    return assemble_context(primary, secondary, lessons, budget)
```

The inter-goal context isolation from `session-and-context.md` §7 is maintained. Raw data from goal B is not included in a session for goal A. However, Long-term lessons can be referenced across goals (because lessons are generalized insights, not raw data specific to a goal).

### 5.2 Relevance scoring via DriveScorer integration

In addition to the priority-based inclusion rules in `session-and-context.md` §4 (priorities 1–6), rank memory entries by relevance using DriveScorer (`drive-scoring.md`) scores.

| Score element | Meaning | Effect |
|--------------|---------|--------|
| Dissatisfaction score | Large gap for this dimension | Raises priority of related memories |
| Deadline score | Deadline approaching for this dimension | Raises priority of related memories |
| Opportunity score | An opportunity exists in this situation | Raises priority of past patterns in similar situations |

> **Phase 2**: The following DriveScorer integration is implemented in Phase 2. In MVP, Working Memory is selected using chronological ordering by `last_accessed`.

```
relevance_score(memory_entry, current_context):
    // Base score from tag matching
    tag_match = count_matching_tags(memory_entry.tags, current_context.tags)

    // Weighting from DriveScorer
    drive_weight = get_drive_score(current_context.goal_id, current_context.dimension)

    // Freshness (Short-term data scores higher than Long-term)
    freshness = compute_freshness(memory_entry.timestamp)

    return tag_match * drive_weight * freshness
```

### 5.3 Integration with context budget

Allocate memory data within the context budget (`session-and-context.md` §4 — 50% of the model's context window).

```
Budget allocation guidelines:
  Priorities 1–4 (task definition, state, constraints): 60%  ← existing rule from session-and-context.md
  Priority 5   (previous session result):               15%
  Priority 6   (relevant data from memory layer):       25%  ← extended by this design
```

Within the 25% for priority 6, pack Short-term raw data and Long-term lessons in order of relevance score. Stop when the budget is exhausted.

---

## 6. Active Forgetting Policy

Memory management is not just about "what to remember" — it's also about "what to forget." Active forgetting is implemented as the concrete policy for the Short→Long compression.

### 6.1 Automatic invalidation of contradictory old knowledge

When a new observation result contradicts existing knowledge, automatically invalidate the older knowledge.

```
on_new_observation(observation):
    conflicting = find_conflicting_knowledge(observation)
    for entry in conflicting:
        if observation.confidence > entry.confidence:
            entry.status = "superseded"
            entry.superseded_by = observation.id
            // Do not delete the knowledge entry — invalidate it with a "superseded" mark
```

Uses the same mechanism as contradiction detection in `knowledge-acquisition.md` §6.2. However, in the memory lifecycle context, generating additional investigation tasks to resolve contradictions is omitted — the new observation takes precedence.

### 6.2 Archiving unreferenced information

> **Phase 2**: Reference-frequency-based archiving is implemented in Phase 2. MVP uses retention-period-based archiving only.

Information that has not been selected for Working Memory N consecutive times is removed from the active index and archived.

```
Default N:
  Short-term entries: 20 loops (bring forward Long-term migration if not referenced for 20 loops)
  Long-term lessons: 50 loops (archive if not referenced for 50 loops)
```

Archived lessons are not deleted — they are simply removed from the active index. If circumstances change and relevance returns, they can be rediscovered via semantic search (Phase 2).

### 6.3 Retaining lessons from successful strategies

Successful strategies are retained compressed as lessons in the following format:

```
{
  "type": "success_pattern",
  "context_summary": "What the situation was",
  "strategy": "What was done",
  "outcome": "What result was produced",
  "applicability": "In what situations this can be reused"
}
```

Raw execution logs are discarded, but the lesson itself is retained indefinitely.

### 6.4 Compressing failed attempts

Failed attempts are retained only as "what failed," with execution details discarded.

```
{
  "type": "failure_pattern",
  "context_summary": "What the situation was",
  "strategy": "What was tried",
  "failure_reason": "Why it failed",
  "avoidance_hint": "What to avoid next time in the same situation"
}
```

Records of failure are more important than records of success. Retain failure patterns with higher priority to avoid repeating the same mistakes.

### 6.5 Data from completed or canceled goals

Processing when a goal is completed or canceled:

```
on_goal_close(goal, reason):
    // Step 1: Run the learning pipeline (mechanism.md §4)
    lessons = run_learning_pipeline(goal)

    // Step 2: Save lessons to Long-term Memory
    store_long_term("lessons", lessons)

    // Step 3: Archive Short-term raw data
    archive_short_term(goal.id)

    // Step 4: Archive goal-specific knowledge base
    archive_domain_knowledge(goal.id)
```

**Relationship to existing design**: Follows the existing design from `state-vector.md` §5: "When a sub-goal receives a completion verdict or is canceled, its state vector is archived — not deleted — kept in a state usable for future learning as an experience log." This design defines the concrete implementation of that "archiving."

---

## 7. Drive-based Memory Management

> **Phase 2**: All content in this section is implemented in Phase 2. MVP manages memory using retention periods and size limits only.

PulSeed already has a mechanism for judging "what matters" — DriveScorer (dissatisfaction, deadline, opportunity) and SatisficingJudge (whether something is good enough). Rather than a generic LRU, this existing drive system is applied to memory management.

### 7.1 DriveScorer integration

**Dissatisfaction-driven: Delay compression of memories related to high-dissatisfaction dimensions.**

Dimensions with large gaps are areas PulSeed is actively focused on. Short-term data related to these dimensions is retained beyond its normal retention period without compression.

```
compression_delay(dimension):
    dissatisfaction = get_dissatisfaction_score(dimension)
    if dissatisfaction > 0.7:  // high dissatisfaction
        return retention_period * 2.0  // extend retention period by 2x
    elif dissatisfaction > 0.4:  // medium dissatisfaction
        return retention_period * 1.5
    else:
        return retention_period  // normal
```

### 7.2 Deadline-driven

**Pull memories for dimensions with approaching deadlines into Working Memory preferentially.**

Memories related to dimensions with a high deadline score receive a deadline bonus added to their relevance score (§5.2). This makes it easier for past strategy results and observation patterns for deadline-bound dimensions to enter Working Memory.

```
deadline_bonus(dimension):
    deadline_score = get_deadline_score(dimension)
    return deadline_score * 0.3  // up to 30% bonus added to relevance score
```

### 7.3 Opportunity-driven

**Preferentially surface past patterns related to high-opportunity situations.**

When the opportunity score is high, search Long-term Memory for similar "opportunity" patterns. The lesson "what was done the last time this kind of opportunity arose" helps guide today's decision.

### 7.4 SatisficingJudge integration

**Migrate detailed memories for "satisfied" dimensions to Long-term early.**

When SatisficingJudge (`satisficing.md`) judges "this dimension is sufficient," the Short-term data for that dimension becomes a candidate for early Long-term compression, without waiting for the retention period. There is no value in retaining raw data for dimensions that PulSeed no longer needs to focus on.

```
on_satisficing_judgment(dimension, is_satisfied):
    if is_satisfied:
        // Mark this dimension's Short-term data for early compression
        mark_for_early_compression(dimension)
```

---

## 8. Integration with Existing Design

Clarifying the relationship between this design and existing design documents.

### session-and-context.md

Working Memory = an extension of the context selection algorithm in `session-and-context.md` §4. The existing priority-based inclusion rules (priorities 1–6) are preserved as-is, with memory layers introduced as the source for priority 6 (relevant excerpt from experience log). The existing context isolation principle (§7) is also maintained.

### knowledge-acquisition.md

The knowledge staleness handling in `knowledge-acquisition.md` §6.3 is complementary to the active forgetting policy in this design (§6.1). Staleness detection identifies "knowledge that should be re-verified"; the forgetting policy handles "knowledge that should be invalidated." The `superseded_by` field in knowledge entries (`knowledge-acquisition.md` §5.2) can be used directly to implement forgetting.

### reporting.md

Follows `reports/archive/` from `reporting.md` §5.1 and the report persistence principle (§10: archive, not delete). Report history is integrated into this design's Long-term Memory archive, but the existing directory structure is not changed.

### state-vector.md

Follows `state-vector.md` §5: "State vectors of completed/canceled sub-goals are archived." This design defines the concrete implementation of archiving (lesson extraction → raw data discard). The observation history retention depth (short-term goals: 10–20 observations, long-term goals: 50–100 observations) is used as-is as Short-term Memory configuration values.

### drive-system.md

Follows `drive-system.md` §3 event archiving (moving processed events to `events/archive/`). Event data is outside this design's scope; the existing archiving approach is maintained.

### mechanism.md

Short-term/Long-term Memory functions as the data source for the learning pipeline in `mechanism.md` §4 (experience log → analysis → feedback → improvement). The learning pipeline's input is Short-term raw data; its output is Long-term lesson entries.

### curiosity.md

The learning feedback in `curiosity.md` §4 (direction guided by accumulated experience logs) references Long-term Memory lesson entries. The data source through which the curiosity engine judges "which domains had room for improvement" is structured through the memory layer.

### stall-detection.md

Stall detection in `stall-detection.md` §2 requires raw data from Short-term Memory (especially the time series of observation history). Data for stall-detected dimensions has its compression delayed by Drive-based Memory Management (§7.1).

---

## 9. Storage Design

### 9.1 Directory structure

```
~/.pulseed/
├── memory/
│   ├── short-term/
│   │   ├── goals/
│   │   │   ├── <goal_id>/
│   │   │   │   ├── experience-log.json      # experience log
│   │   │   │   ├── observations.json         # observation history
│   │   │   │   ├── strategies.json           # strategy history
│   │   │   │   └── tasks.json                # task history
│   │   │   └── ...
│   │   └── index.json                        # Short-term index
│   ├── long-term/
│   │   ├── lessons/
│   │   │   ├── by-goal/
│   │   │   │   └── <goal_id>.json            # per-goal lessons
│   │   │   ├── by-dimension/
│   │   │   │   └── <dimension_name>.json     # per-dimension lessons
│   │   │   └── global.json                   # cross-goal lessons
│   │   ├── statistics/
│   │   │   └── <goal_id>.json                # per-goal statistics
│   │   └── index.json                        # Long-term index
│   └── archive/
│       └── <goal_id>/                        # archive for completed/canceled goals
│           ├── lessons.json
│           └── statistics.json
├── goals/                                    # goal state (domain_knowledge.json is a compression target in this design. See §3.3)
│   └── <goal_id>/
│       └── domain_knowledge.json             # knowledge-acquisition.md §5.2
├── events/                                   # existing event queue (unchanged)
├── reports/                                  # existing reports (unchanged)
│   └── archive/
└── ...
```

The existing directory structure (`goals/`, `events/`, `reports/`) is not changed. A new `memory/` directory is created to manage memory layer data.

### 9.2 File format

All JSON. Consistent with `mechanism.md` §5: "transparent, human-readable, and manageable with git."

### 9.3 Index design

Both Short-term and Long-term have index files. The index is metadata to speed up search — not the data itself.

```
// index.json structure
{
  "version": 1,
  "last_updated": "2026-03-12T09:00:00Z",
  "entries": [
    {
      "id": "entry_abc123",
      "goal_id": "goal_health_01",
      "dimensions": ["respiratory_rate", "activity_level"],
      "tags": ["health", "monitoring", "respiratory"],
      "timestamp": "2026-03-10T14:00:00Z",
      "data_file": "goals/goal_health_01/experience-log.json",
      "entry_id": "exp_20260315_042",
      "last_accessed": "2026-03-11T09:00:00Z",
      "access_count": 3
    }
  ]
}
```

Entries are referenced directly by ID, unaffected by changes to file structure.

Index keys:
- `goal_id`: for per-goal search
- `dimensions`: for per-dimension search
- `tags`: for tag-based relevance search
- `timestamp`: for time-series search
- `last_accessed` / `access_count`: for the reference-frequency-based forgetting policy

### 9.4 Size limits and garbage collection

| Layer | Size limit | Garbage collection |
|-------|-----------|-------------------|
| Short-term | 10 MB per goal (default) | Migration to Long-term when retention period expires |
| Long-term | 100 MB total (default) | Archive from lowest-referenced entries |
| Archive | No limit (storage-dependent) | None (retained permanently) |

When the size limit is reached, compression is brought forward even within the retention period. However, if a compression delay is applied by Drive-based Memory Management (§7), that delay is respected (data for high-dissatisfaction dimensions is not compressed solely due to a size limit).

---

## 10. MVP vs Phase 2

| Item | MVP (Phase 1) | Phase 2 |
|------|---------------|---------|
| Memory layers | Basic 3-layer implementation | No change |
| Short→Long compression | Configurable retention period + LLM-based compression | Improved compression quality (recursive refinement of summaries) |
| Working Memory selection | Full tag matching + chronological sort | Semantic search (embedding-based) |
| Forgetting policy | Retention-period-based + contradiction detection | Dynamic adjustment based on reference frequency |
| Drive-based management | Not implemented. Retention period and size limits only | Dynamic compression priority via DriveScorer/SatisficingJudge integration |
| Index | Simple per-goal/per-dimension index | Semantic embedding vector index (requires Stage 12 embedding infrastructure) |
| Statistical summary | Basic statistics (success rate, average duration) | Advanced statistics (trend analysis, anomaly detection patterns) |
| Storage | File-based JSON | No change (same as MVP) |

### What is implemented in MVP

1. Create `~/.pulseed/memory/` directory structure
2. Short-term Memory retention period management (configurable loop count / time-based)
3. Short→Long compression via LLM summary (integrated with learning pipeline in `mechanism.md` §4)
4. Working Memory selection via tag-based relevance search
5. Basic forgetting policy (retention period expiry, invalidation of contradictory knowledge)
6. Lesson extraction and archiving on goal completion/cancellation

### What is implemented in Phase 2

1. Drive-based Memory Management (all features in §7)
2. Working Memory selection via semantic search (requires Stage 12 embedding infrastructure)
3. Dynamic forgetting policy based on reference frequency
4. Cross-goal search of Long-term lessons

---

## Design Principles Summary

| Principle | Concrete design decision |
|-----------|------------------------|
| Manage in 3 layers | Clear separation of Working/Short-term/Long-term. Each layer has a distinct responsibility and lifetime |
| Separate policy from architecture | The 3-layer structure is the framework. Forgetting and selection policies can be changed independently |
| PulSeedtion controls memory | Dynamic compression priority is set by DriveScorer/SatisficingJudge, not generic LRU |
| Prioritize retaining failures | Failure patterns take retention priority over success patterns — to avoid repeating the same mistakes |
| Do not break existing design | Follow existing rules from session-and-context.md, reporting.md, etc., and design as extensions |
| Do not pursue perfection | MVP uses simple retention period + LLM summary. Drive-based management is introduced incrementally in Phase 2 |
