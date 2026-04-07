# Dream Mode Phase 3: Consolidation
> Phase 3 is PulSeed's batch consolidation pass over the runtime data categories that accumulate faster than the online loop can clean up or synthesize.

---
## 1. Overview
Phase 3 is where Dream Mode acts on the Dream targets plus the existing memory systems that already support retention and transfer.
It wraps existing APIs where possible, adds new cross-cutting consolidation where needed, and turns long-running data sprawl into durable knowledge, archives, and cleanup actions.
Primary goals:
- reduce storage sprawl
- preserve important facts before pruning
- promote repeated lessons into reusable knowledge
- keep archives and reports searchable
- record per-category outcomes in `DreamReport`

---
## 2. `DreamConsolidator.run()` Orchestration
Proposed flow:
1. Load `dream-config.json`.
2. Build the ordered list of enabled categories.
3. Run each category independently.
4. Catch and record category-local failures.
5. Aggregate per-category metrics into `DreamReport`.
6. Persist artifacts and summary output.
Rules:
- categories execute in fixed order
- each category can be enabled or disabled independently
- errors in one category do not block others
- every category reports status and metrics
Suggested result shape:
```ts
type ConsolidationCategoryResult = {
  category: string;
  status: "completed" | "skipped" | "failed";
  metrics: Record<string, number>;
  warnings: string[];
  errors: string[];
};
```

### 2.1 Tier Scope

Phase 3 runs different consolidation scope depending on dream tier.

Light Dream runs only:

- Memory for active goals only
- Agent memory lint with quick auto-fix for high-confidence findings
- Stale knowledge check in flag-only mode

Deep Dream runs the full consolidation set:

- all eleven Dream target categories
- cross-goal knowledge transfer
- archive postmortems and reusable template extraction
- full knowledge optimization and report generation

---
## 3. Category: Memory (Existing, Enhanced)
Actions:
- call `MemoryLifecycleManager.applyRetentionPolicy()` for all goals in Deep Dream, and for active goals only in Light Dream
- run garbage collection on archival tier
- call `extractPatterns()` for goals with enough data
- call `distillLessons()` for goals with enough data
- before pruning, perform a pre-compaction flush to extract latent important facts
The pre-compaction flush is OpenClaw-inspired: compression should happen only after fact extraction.
Metrics:
- memories pruned
- archival items collected
- latent facts extracted
- lessons distilled

---
## 4. Category: Agent Memory (Existing, Enhanced)
Actions:
- call `KnowledgeManager.lintAgentMemory()` for all goals in Deep Dream, with a quick pass in Light Dream
- auto-consolidate high-confidence lint findings
- deduplicate cross-goal agent memory via embedding similarity
Metrics:
- lint findings
- auto-applied consolidations
- duplicates merged

---
## 5. Category: Cross-Goal Knowledge Transfer (Existing)
Actions:
- call `KnowledgeTransfer.detectTransferOpportunities()` across goal pairs
- evaluate candidate transfers
- apply transfers above threshold
Scale control:
- limit evaluation to top-k most active goals to contain `O(n^2)` growth
Metrics:
- goal pairs scanned
- candidates found
- transfers applied
- transfers rejected

---
## 6. Category: Decision History (New)
Actions:
- scan decision records within the retention window
- cluster by `goal_type + strategy_id`
- compute win/loss rates
- detect repeated pivot causes and promote them to lessons
- detect stale `suggested_next` values that never improve outcomes
Output:
- `LearnedPattern` with `pattern_type: "decision_trend"`
Metrics:
- decision records scanned
- clusters built
- pivot causes promoted
- stale suggestions flagged

---
## 7. Category: Stall History (New)
Actions:
- read `StallDetected` events from the Phase 1 event stream
- correlate stall types with strategies, adapters, and trust state
- detect same-stall cross-session loops
- learn stall precursors from escalation trajectories
Output:
- `LearnedPattern` with `pattern_type: "stall_precursor"`
Metrics:
- stall events scanned
- recurring loops detected
- precursors extracted

---
## 8. Category: Session Data (New)
Actions:
- scan both `sessions/*.json` and `~/.pulseed/dream/session-logs.jsonl`
- build outcome distributions by `session_type` and `goal_type`
- identify oversized context slots correlated with bad results
- archive cold completed sessions older than 30 days into compressed bundles
- maintain a searchable session index
Metrics:
- sessions scanned
- cold sessions archived
- bundles created
- index entries updated

---
## 8.1 Category: Iteration Logs (New)
Actions:
- scan per-goal `iteration-logs.jsonl` files from Phase 1
- rotate old logs according to retention policy
- archive completed-goal iteration logs into colder storage
- maintain a searchable index so Phase 2 and later consolidation passes can locate historical slices efficiently
Metrics:
- iteration logs scanned
- rotated log segments
- archived completed-goal logs
- index entries updated

---
## 9. Category: Gap History (New)
Actions:
- read `gap-history.json` per goal
- fit convergence curves per dimension using an exponential decay model
- detect false progress where aggregate improves but primary dimensions stagnate
- compare convergence against strategy switches
Output:
- convergence archetypes as `LearnedPattern`
Metrics:
- goals analyzed
- dimensions modeled
- false-progress cases detected
- archetypes emitted

---
## 10. Category: Observation Logs (New)
Actions:
- read `observations.json` per goal
- compute per-method and per-dimension confidence statistics
- detect observation drift
- detect flaky methods
- rank observation methods by reliability
Output:
- method reliability scores
- recommendations for observation changes
Metrics:
- observations scanned
- flaky methods detected
- drift alerts produced

---
## 11. Category: Reports (New)
Actions:
- scan `reports/<goalId>/*.json`
- extract cross-report sequences such as stall -> pivot -> success
- compress old reports into weekly or monthly summaries
- clean up unread low-signal reports
Metrics:
- reports scanned
- sequences extracted
- summary reports created
- low-signal reports cleaned up

---
## 12. Category: Trust Scores (New)
Actions:
- read `trust-store.json` and `override_log`
- reconstruct trust trajectories from override events
- detect oscillating domains
- recommend trust delta recalibration
Output:
- trust health report
Metrics:
- trust domains analyzed
- override events replayed
- oscillations detected
- recalibration recommendations emitted

---
## 13. Category: Strategy History (New)
Actions:
- read `strategy-history.json` per goal
- reconstruct strategy timelines
- learn pivot ladders that succeed after failure
- identify strategy families that burn cycles without moving the gap
- compare with archived goal strategies
Output:
- `LearnedPattern` with `pattern_type: "strategy_sequence"`
Metrics:
- timelines reconstructed
- successful pivot ladders found
- wasteful strategy families flagged

---
## 14. Category: Verification Artifacts (New)
Actions:
- read `verification/<taskId>/` and `task-history.json`
- aggregate verdict distributions per strategy, adapter, and dimension
- detect recurring criterion failures
- correlate verdicts with trust and stall transitions
Output:
- verification reliability insights
Metrics:
- artifacts scanned
- criterion failure patterns detected
- verdict distributions computed

---
## 15. Category: Archive (New)
Actions:
- scan `archive/<goalId>/` bundles
- treat each as a complete case study
- derive postmortem lessons on what worked, failed, and pivoted
- build a "solved before" index from archived goal and strategy pairs
- compress raw archives into searchable summaries plus colder storage
- extract successful strategy sequences as reusable templates
This is Voyager-inspired: successful explored behavior should become reusable procedures.
Metrics:
- archives scanned
- postmortem lessons extracted
- solved-before entries added
- reusable templates emitted

---
## 16. Knowledge Optimization (Cross-Cutting)
Cross-category actions:
- stale knowledge revalidation through `generateRevalidationTasks` in Deep Dream; Light Dream only flags stale knowledge for later revalidation
- contradiction detection across goals
- `KnowledgeGraph` edge inference from co-occurrence in logs
- redundancy pruning where cosine similarity is greater than `0.95` and tags match
Suggested merge rule:
```ts
if (cosineSimilarity > 0.95 && sameTags) {
  mergeKnowledgeEntries();
}
```
Metrics:
- revalidation tasks generated
- contradictions found
- graph edges inferred
- redundant entries merged

---
## 17. `DreamReport` Schema
Requirements:
- define a full Zod schema
- include per-category metrics
- persist to `~/.pulseed/dream/reports/<timestamp>.json`
- generate a human-readable summary from the same report object
Suggested top-level shape:
```ts
const DreamReportSchema = z.object({
  timestamp: z.string(),
  status: z.enum(["completed", "partial", "failed"]),
  categories: z.array(
    z.object({
      category: z.string(),
      status: z.enum(["completed", "skipped", "failed"]),
      metrics: z.record(z.number()),
      warnings: z.array(z.string()),
      errors: z.array(z.string())
    })
  ),
  summary: z.string()
});
```
The JSON file is the source of truth. The readable summary is a derived view.

---
## 18. New Files
Phase 3 introduces:
- `src/platform/dream/dream-consolidator.ts` for orchestration, target under 500 lines
- `src/platform/dream/dream-consolidator-categories.ts` if category handlers would push the class over 500 lines

---
## 19. Configuration
Phase 3 uses the `consolidation` section of `dream-config.json` with per-category enable/disable flags.
```json
{
  "consolidation": {
    "memory": { "enabled": true },
    "agentMemory": { "enabled": true },
    "crossGoalTransfer": { "enabled": true, "topKActiveGoals": 20 },
    "decisionHistory": { "enabled": true, "retentionDays": 30 },
    "stallHistory": { "enabled": true },
    "sessionData": { "enabled": true, "archiveAfterDays": 30 },
    "iterationLogs": { "enabled": true, "archiveAfterDays": 30 },
    "gapHistory": { "enabled": true },
    "observationLogs": { "enabled": true },
    "reports": { "enabled": true },
    "trustScores": { "enabled": true },
    "strategyHistory": { "enabled": true },
    "verificationArtifacts": { "enabled": true },
    "archive": { "enabled": true },
    "knowledgeOptimization": { "enabled": true, "redundancySimilarityThreshold": 0.95 }
  }
}
```
The config should allow expensive categories to be disabled independently without changing the report schema.
