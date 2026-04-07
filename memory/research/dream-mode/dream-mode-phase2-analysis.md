# Dream Mode Phase 2: Dream Analysis Pipeline
> Phase 2 is PulSeed's offline LLM-powered dream analysis pass. It processes accumulated logs to discover patterns, extract lessons, and suggest schedules.

---
## 1. Overview
Phase 2 is the core analysis stage of Dream Mode.
It runs offline during dream mode, not during the live loop. Its job is to convert accumulated runtime traces into reusable knowledge:
- discover recurring patterns
- synthesize lessons and heuristics
- identify schedules or triggers worth formalizing
Primary outputs:
- `LearnedPattern[]` persisted through `LearningPipeline`
- `schedule-suggestions.json`
- analysis metrics included in `DreamReport`

---
## 2. `DreamEngine.run()` Orchestration
Proposed entry points:
```ts
type DreamRunOptions = {
  goalIds?: string[];
  phases?: Array<"A" | "B" | "C">;
  tier?: "light" | "deep";
  dryRun?: boolean;
  tokenBudget?: number;
  recentIterationWindow?: number;
};

class DreamEngine {
  run(options?: DreamRunOptions) {}
  runLight(options?: DreamRunOptions) {}
  runDeep(options?: DreamRunOptions) {}
}
```
Execution rules:
1. Resolve eligible goals.
2. Prioritize goals with the most unprocessed logs first.
3. `run()` dispatches to `runLight()` or `runDeep()` based on `options.tier`, defaulting to deep for `pulseed dream`.
4. Light Dream executes partial Phase A plus a quick version of Phase B over only the most recent `N` iterations.
5. Deep Dream executes full phases in fixed order: `A -> B -> C`.
6. Stop when requested phases are complete or budget is exhausted.
7. Persist outputs unless `dryRun` is `true`.
Budget allocation:
- Light Dream: target about `10k-20k`, default `15k`, with most budget reserved for importance-first quick analysis
- Deep Dream: target about `200k`
- Deep Dream budget allocation: 40% to Phase B pattern mining, 10% to Phase C schedule discovery, remaining 50% reserved for retries, importance mini-reflections, and slack
Budget enforcement:
```ts
if (remainingBudget <= 0) {
  stopFurtherPhaseExecution();
  markDreamRunPartial();
}
```
Rules:
- estimate token cost before each LLM call
- skip calls that exceed phase or total budget
- early-exit on exhaustion instead of failing the run
- Light Dream does not run Phase C schedule discovery

---
## 3. Phase A: Log Ingestion
Phase A is deterministic and makes no LLM calls.
Responsibilities:
- read JSONL from watermark to EOF
- parse each line
- skip malformed lines and log a warning
- group records into configurable batches
- process the importance buffer before bulk logs
- correlate importance-tagged items with surrounding iteration context
- in Light Dream, restrict ingestion to high-signal importance items plus recent iterations only
Default batching:
- `100` iterations per batch
Watermark semantics:
- read from last successful dream watermark
- only newly unprocessed logs are eligible
- advance watermark only after successful persistence of downstream outputs
Malformed-line handling:
```ts
try {
  parseJsonlLine(line);
} catch (error) {
  logger.warn("Dream ingestion skipped malformed line", { source, offset, error });
}
```
Importance-first flow:
1. Drain the importance buffer.
2. Enrich each high-importance item with nearby iteration context.
3. Queue those windows ahead of regular batches.
4. In Light Dream, skip older regular batches outside the recent iteration window.
Token cost:
- zero
Output shape:
```ts
type IngestionOutput = {
  prioritizedBatches: IterationWindow[];
  regularBatches: IterationWindow[];
  importanceEntries: ImportanceEntry[];
  sessionLogs: SessionLog[];
  stats: { linesRead: number; malformedLines: number; batchesBuilt: number };
};
```

---
## 4. Phase B: Pattern Mining
Phase B is the main LLM analysis layer.
Input:
- batched `IterationLog[]`
- `ImportanceEntry[]`
- context windows from Phase A
Processing rules:
- send iteration windows, not individual log items
- importance-first windows get deeper analysis
- prefer fewer richer synthesis calls over many shallow calls
- Light Dream runs only a quick scan on the most recent `N` iterations, default `50`, to surface immediate insights
- Deep Dream runs the full pattern-mining pass across the eligible corpus
Output:
- `LearnedPattern[]` with `embedding_id`, persisted through `LearningPipeline`
```ts
type LearnedPattern = {
  pattern_type: string;
  goal_id?: string;
  confidence: number;
  summary: string;
  evidence_refs: string[];
  embedding_id: string;
  metadata: Record<string, unknown>;
};
```
### 4.1 Sub-Analyses
#### a. Recurring Task Patterns
Group by `taskAction` and analyze:
- frequency
- average gap reduction
- success rate
- repeatability
#### b. Strategy Effectiveness
Analyze per `strategyId`:
- convergence speed
- success rate
- token efficiency
- common failure modes
#### c. Failure Patterns
Cluster stalls and failures by:
- severity
- preceding task
- gap state
- observation confidence
#### d. Temporal Patterns
Analyze:
- hour/day bucketing
- spacing between runs
- periodicity
#### e. Decision Trend Mining
Analyze decision history to:
- cluster pivot causes
- cluster escalation causes
- compute per-strategy win rates
Output pattern type:
- `decision_trend`
#### f. Stall Pattern Mining
Analyze `StallDetected` events from the Phase 1 event stream to:
- detect same-stall cross-session loops
- find recurring precursors
- correlate stall type with strategy and trust state
Output pattern type:
- `stall_precursor`
#### g. Observation Reliability
Analyze observation logs to:
- compute per-method and per-dimension confidence distributions
- detect drift
- detect disagreement with later evidence
Output pattern type:
- `observation_reliability`
#### h. Verification Pattern Mining
Analyze verification artifacts to:
- find recurring criterion failures
- compute verdict distributions
- identify verification bottlenecks
Output pattern type:
- `verification_pattern`
### 4.2 Prompt Templates
Prompt templates live in `src/prompt/purposes/dream.ts`.
Each template should include:
- analysis goal
- input schema reminder
- output schema reminder
- confidence rubric
- example output
Example prompt skeleton:
```ts
const recurringTaskPatternPrompt = `
Analyze PulSeed dream-mode iteration windows.
Find recurring task patterns correlated with gap reduction.
Return JSON:
{
  "patterns": [
    {
      "pattern_type": "recurring_task",
      "summary": "string",
      "confidence": 0.0,
      "metadata": {
        "taskAction": "string",
        "frequency": 0,
        "success_rate": 0.0,
        "avg_gap_reduction": 0.0
      },
      "evidence_refs": ["logRef"]
    }
  ]
}
`;
```
Expected output example:
```json
{
  "patterns": [
    {
      "pattern_type": "recurring_task",
      "summary": "Retrying lightweight verification after observation drift often restores progress.",
      "confidence": 0.82,
      "metadata": {
        "taskAction": "rerun_verification",
        "frequency": 6,
        "success_rate": 0.67,
        "avg_gap_reduction": 0.11
      },
      "evidence_refs": ["iter:goal-1:143", "iter:goal-1:144"]
    }
  ]
}
```
### 4.3 Validation and Persistence
Pipeline:
1. Parse model output.
2. Validate JSON schema.
3. Drop patterns below `patternConfidenceThreshold`.
4. Persist accepted patterns through `LearningPipeline`.
5. Store returned `embedding_id`.

---
## 5. Phase C: Schedule Discovery
Phase C turns temporal patterns into schedule suggestions.
Input:
- temporal patterns from Phase B
- session logs and dream run history
Output:
- `schedule-suggestions.json`
Rules:
- suggestions are surfaced in report and CLI
- suggestions are not auto-applied
- token budget target is about 10%
Discovery rules:
### a. Manual-to-Cron
Detect regular manual goal execution and suggest a `cron` entry.
### b. Probe-to-Trigger
Correlate probe changes with later goal runs and suggest a `goal_trigger`.
### c. Dream Self-Scheduling
If dream has not run in more than 7 days, suggest a weekly dream cron.
### d. Consolidation Schedule
If logs, reports, sessions, or archives show unbounded growth, suggest cleanup or compaction schedules.
Suggested artifact:
```json
{
  "generated_at": "2026-04-07T00:00:00.000Z",
  "suggestions": [
    {
      "type": "cron",
      "goalId": "goal-123",
      "confidence": 0.79,
      "reason": "Manual execution appears every weekday around 09:00.",
      "proposal": "0 9 * * 1-5"
    }
  ]
}
```

---
## 6. Importance-Driven Prioritization
Importance changes both ordering and depth.
Rules:
- process importance buffer before bulk logs
- high-importance items receive more tokens per item
- threshold crossing triggers an immediate mini-reflection
- accumulated importance since last dream run is shown in `pulseed dream status`
Mini-reflection trigger:
```ts
if (importanceSinceLastReflection >= threshold) {
  scheduleMiniReflection();
}
```
This is smaller than the full Phase B pass and exists to avoid losing fresh high-salience lessons inside a backlog.

---
## 7. Industry-Inspired Techniques
Phase 2 explicitly borrows these techniques:
- Pre-compaction flush (OpenClaw): extract latent facts before pruning or summarization
- Importance-triggered reflection (Generative Agents): synthesize when salience accumulates past a threshold
- Procedural consolidation (Voyager): convert repeated successful workflows into reusable plans or checklists
- Policy-changing consolidation (SOAR / ACT-R): emit rules and heuristics, not just summaries

---
## 8. New Files
Phase 2 introduces:
- `src/platform/dream/dream-analyzer.ts` for `DreamAnalyzer` orchestration, target under 500 lines
- `src/prompt/purposes/dream.ts` for prompt templates

---
## 9. Configuration
Phase 2 uses the `analysis` section of `dream-config.json`.
```json
{
  "analysis": {
    "batchSize": 100,
    "minIterationsForAnalysis": 20,
    "maxGoalsPerRun": 25,
    "patternConfidenceThreshold": 0.7
  }
}
```
Parameters:
- `batchSize`: iterations per analysis batch
- `minIterationsForAnalysis`: minimum volume before LLM analysis is allowed
- `maxGoalsPerRun`: hard cap per dream session
- `patternConfidenceThreshold`: minimum confidence for persistence
