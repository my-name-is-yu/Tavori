# PromptGateway Phase D Step 2 — Research Findings

_Written: 2026-03-22 by researcher agent_

---

## 1. Existing ContextPurpose Values

Defined in `src/prompt/slot-definitions.ts` (line 9-14):

```
"observation" | "task_generation" | "verification" | "strategy_generation" | "goal_decomposition"
```

PURPOSE_CONFIGS in `src/prompt/purposes/index.ts` matches exactly these 5 values.

---

## 2. Migration Pattern (from Phase D Step 1)

Observed in `src/execution/task-generation.ts` (lines 284-320):

**Pattern A — Optional gateway with direct-LLM fallback:**
```ts
// In deps interface, add optional gateway:
gateway?: IPromptGateway;

// In the call site:
if (deps.gateway) {
  generated = await deps.gateway.execute({
    purpose: "task_generation",        // new ContextPurpose value
    goalId,
    dimensionName: targetDimension,
    additionalContext: { someKey: prompt },
    responseSchema: TheZodSchema,
    maxTokens: 2048,
  });
} else {
  // fallback: original sendMessage() call unchanged
  const response = await deps.llmClient.sendMessage(...)
  generated = deps.llmClient.parseJSON(response.content, TheZodSchema)
}
```

**Pattern B — gateway replaces sendMessage entirely (when deps already have gateway):**
Same shape, no fallback needed when gateway is required.

Key import to add:
```ts
import type { IPromptGateway } from "../prompt/gateway.js";
```

For each new purpose, also need:
1. A new entry in `ContextPurpose` union (`src/prompt/slot-definitions.ts`)
2. A new `PurposeSlotConfig` entry in `PURPOSE_SLOT_CONFIGS`
3. A new purpose module in `src/prompt/purposes/<name>.ts` with system prompt + export
4. Register in `src/prompt/purposes/index.ts` and `PURPOSE_CONFIGS`

---

## 3. All Remaining Call Sites (27 total across 12 files)

### Batch C — Goal Quality (3) + Dependency Graph (1) + Strategy Template Registry (2)

#### `src/goal/goal-tree-quality.ts` — 2 call sites **Confirmed**
- **Line 110**: `scoreConcreteness()` — evaluates goal description concreteness
  - Function args: `(description: string, deps: GoalTreeQualityDeps)`
  - Schema: `ConcretenessLLMResponseSchema` → returns `ConcretenessScore`
  - Proposed purpose: `"goal_quality_concreteness"`
  - Pattern: `deps.llmClient.sendMessage([{role:"user", content: prompt}], { temperature: 0 })`
- **Line 171**: `evaluateDecompositionQuality()` — evaluates parent/subgoal coverage, overlap, actionability
  - Schema: `QualityEvaluationResponseSchema`
  - Proposed purpose: `"goal_quality_decomposition"`
  - Pattern: same

Note: The task description says goal-quality(3) but only 2 call sites exist in `goal-tree-quality.ts`. Check if `src/goal/goal-tree-manager.ts` has quality-related calls (it has 3 `sendMessage` calls at lines 241, 392, 592 — those are in goal-tree-manager, separate from goal-quality). **Gap: need to clarify if "goal-quality(3)" refers to goal-tree-manager or goal-tree-quality.**

#### `src/goal/goal-dependency-graph.ts` — 1 call site **Confirmed**
- **Line 269**: `autoDetectDependencies()` — LLM detects dependency edges between goals
  - Schema: `AutoDetectResponseSchema` (z.array of edge objects)
  - Proposed purpose: `"dependency_detection"`
  - Pattern: `this.llmClient.sendMessage(messages)` (no options object)

#### `src/strategy/strategy-template-registry.ts` — 2 call sites **Confirmed**
- **Line 99**: `registerTemplate()` — generalizes a strategy hypothesis into a reusable pattern
  - Schema: `GeneralizeHypothesisResponseSchema`
  - Proposed purpose: `"strategy_template_generalize"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: generalizePrompt}])`
- **Line 210**: `applyTemplate()` — adapts a template to a new goal context
  - Schema: `AdaptTemplateResponseSchema`
  - Proposed purpose: `"strategy_template_adapt"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: adaptPrompt}])`

---

### Batch D — Knowledge Manager (3) + Knowledge Decisions (1) + Knowledge Revalidation (1) + Memory Distill (2) + Knowledge Transfer (3)

#### `src/knowledge/knowledge-manager.ts` — 3 call sites **Confirmed**
- **Line 178**: `detectKnowledgeGap()` — LLM-based knowledge gap detection (fast-path heuristics first)
  - Schema: `GapDetectionResponseSchema`
  - Proposed purpose: `"knowledge_gap_detection"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: prompt}], { system: "...", max_tokens: 512 })`
- **Line 240**: `generateAcquisitionTask()` — generates research task for a knowledge gap
  - Schema: `AcquisitionTaskFieldsSchema`
  - Proposed purpose: `"knowledge_acquisition_task"`
  - Pattern: same shape, max_tokens: 1024
- **Line 411**: `checkContradiction()` — checks new knowledge entry for contradictions with existing entries
  - Schema: `ContradictionCheckResponseSchema`
  - Proposed purpose: `"knowledge_contradiction_check"`
  - Pattern: same shape, max_tokens: 512

#### `src/knowledge/knowledge-decisions.ts` — 1 call site **Confirmed**
- **Line 66**: `enrichDecisionRecord()` — LLM extracts what_worked/what_failed/suggested_next
  - Schema: `EnrichmentSchema`
  - Proposed purpose: `"decision_enrichment"`
  - Pattern: `deps.llmClient.sendMessage([{role:"user", content: prompt}], { max_tokens: 512 })`

#### `src/knowledge/knowledge-revalidation.ts` — 1 call site **Confirmed**
- **Line 62**: `classifyDomainStability()` — LLM classifies domain as stable/moderate/volatile
  - Schema: `DomainStabilityResponseSchema`
  - Proposed purpose: `"knowledge_domain_stability"`
  - Pattern: `deps.llmClient.sendMessage([{role:"user", content: prompt}], { system: "...", max_tokens: 256 })`

#### `src/knowledge/memory-distill.ts` — 2 call sites **Confirmed**
- **Line 56**: `extractPatterns()` — LLM extracts recurring patterns from short-term entries
  - Schema: `PatternExtractionResponseSchema`
  - Proposed purpose: `"memory_pattern_extraction"`
  - Pattern: `llmClient.sendMessage([{role:"user", content: prompt}], { system: "...", max_tokens: 2048 })`
- **Line 132**: `distillLessons()` — LLM converts patterns into structured LessonEntry objects
  - Schema: `LessonDistillationResponseSchema`
  - Proposed purpose: `"memory_lesson_distillation"`
  - Pattern: same shape, max_tokens: 4096

#### `src/knowledge/knowledge-transfer.ts` — 3 call sites **Confirmed**
- **Line 362**: `applyTransfer()` — LLM adapts a source pattern to a target goal (adaptation)
  - Schema: `AdaptationResponseSchema` (from `knowledge-transfer-prompts.ts`)
  - Proposed purpose: `"knowledge_transfer_adapt"`
  - Pattern: `this.deps.llmClient.sendMessage([{role:"user", content: adaptationPrompt}], { max_tokens: 1024 })`
  - Note: uses `extractJSON()` then `JSON.parse()` + `AdaptationResponseSchema.parse()` (not `parseJSON()`)
- **Line 529**: `updateMetaPatterns()` — LLM extracts cross-domain meta-patterns from high-confidence patterns
  - Schema: `MetaPatternsResponseSchema`
  - Proposed purpose: `"knowledge_meta_patterns"`
  - Pattern: `this.deps.llmClient.sendMessage([{role:"user", content: metaPrompt}], { max_tokens: 2048 })`
  - Note: uses `extractJSON()` pattern
- **Line 598**: `updateMetaPatternsIncremental()` — incremental version, same schema
  - Schema: `MetaPatternsResponseSchema`
  - Proposed purpose: reuse `"knowledge_meta_patterns"` (same purpose, different context)
  - Pattern: `this.deps.llmClient.sendMessage([{role:'user', content: prompt}], { max_tokens: 1024 })`
  - Note: also uses `extractJSON()` pattern

---

### Batch E — Learning Pipeline (2) + Capability Detector (3) + Ethics Gate (2) + Curiosity Proposals (1)

#### `src/knowledge/learning-pipeline.ts` — 2 call sites **Confirmed**
- **Line 182**: `analyzeLogs()` Stage 1 — extracts triplets from experience logs
  - Schema: `TripletsResponseSchema` (from `learning-pipeline-prompts.ts`)
  - Proposed purpose: `"learning_triplet_extraction"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: extractionPrompt}], { max_tokens: 2048 })`
  - Note: uses `extractJSON()` pattern
- **Line 203**: `analyzeLogs()` Stage 2 — patternizes triplets into learned patterns
  - Schema: `PatternsResponseSchema`
  - Proposed purpose: `"learning_pattern_synthesis"`
  - Pattern: same shape, max_tokens: 2048

#### `src/observation/capability-detector.ts` — 3 call sites **Confirmed**
- **Line 142**: `detectDeficiency()` — LLM detects if a task has capability deficiencies
  - Schema: `DeficiencyResponseSchema`
  - Proposed purpose: `"capability_deficiency_detection"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: userMessage}], { system: systemPrompt })`
- **Line 217**: `detectGoalCapabilityGap()` — LLM detects goal-level capability gaps
  - Schema: `GoalCapabilityGapResponseSchema`
  - Proposed purpose: `"capability_goal_gap_detection"`
  - Pattern: same shape
- **Line 443**: `verifyCapabilityAcquisition()` — LLM verifies a newly acquired capability is ready
  - Schema: `VerificationResponseSchema` (defined inline, z.object with verdict/reason)
  - Proposed purpose: `"capability_verification"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: userMessage}], { system: systemPrompt })`

#### `src/traits/ethics-gate.ts` — 2 call sites **Confirmed**
- **Line 578**: `check()` — Layer 2 LLM evaluation of goal/task ethics
  - Schema: parsed by `parseVerdictSafe()` (custom parser, not standard `parseJSON`)
  - Proposed purpose: `"ethics_evaluation"`
  - Pattern: `this.llmClient.sendMessage([{role:"user", content: userMessage}], { system: ETHICS_SYSTEM_PROMPT, temperature: 0 })`
  - **Warning**: ethics-gate uses a custom `parseVerdictSafe()` parser — migration needs care not to break custom parsing logic
- **Line 636**: `checkMeans()` — Layer 2 LLM evaluation of task execution means ethics
  - Schema: same custom parser
  - Proposed purpose: reuse `"ethics_evaluation"` (or `"ethics_means_evaluation"` if different slot config needed)
  - Pattern: same

#### `src/traits/curiosity-proposals.ts` — 1 call site **Confirmed**
- **Line 199**: `generateProposals()` — LLM generates curiosity/exploration proposals per trigger
  - Schema: `LLMProposalsResponseSchema`
  - Proposed purpose: `"curiosity_proposal_generation"`
  - Pattern: `deps.llmClient.sendMessage([{role:"user", content: prompt}], { temperature: 0.3 })`

---

## 4. Call Site Count Summary

| File | Call Sites | Batch |
|------|-----------|-------|
| `src/goal/goal-tree-quality.ts` | 2 | C |
| `src/goal/goal-dependency-graph.ts` | 1 | C |
| `src/strategy/strategy-template-registry.ts` | 2 | C |
| `src/knowledge/knowledge-manager.ts` | 3 | D |
| `src/knowledge/knowledge-decisions.ts` | 1 | D |
| `src/knowledge/knowledge-revalidation.ts` | 1 | D |
| `src/knowledge/memory-distill.ts` | 2 | D |
| `src/knowledge/knowledge-transfer.ts` | 3 | D |
| `src/knowledge/learning-pipeline.ts` | 2 | E |
| `src/observation/capability-detector.ts` | 3 | E |
| `src/traits/ethics-gate.ts` | 2 | E |
| `src/traits/curiosity-proposals.ts` | 1 | E |
| **TOTAL** | **23** | |

**Note:** The in-progress.md claims 27 call sites, but the grep reveals 23 unique unmigrated `sendMessage` calls across these 12 files. The discrepancy of 4 may come from:
- `src/goal/goal-tree-manager.ts` has 3 `sendMessage` calls (lines 241, 392, 592) — not in the C/D/E batch lists but in the unmigrated set
- 1 additional site elsewhere — needs verification

---

## 5. New ContextPurpose Values Needed (17)

| Purpose String | File | Function |
|---------------|------|----------|
| `goal_quality_concreteness` | goal-tree-quality.ts | scoreConcreteness |
| `goal_quality_decomposition` | goal-tree-quality.ts | evaluateDecompositionQuality |
| `dependency_detection` | goal-dependency-graph.ts | autoDetectDependencies |
| `strategy_template_generalize` | strategy-template-registry.ts | registerTemplate |
| `strategy_template_adapt` | strategy-template-registry.ts | applyTemplate |
| `knowledge_gap_detection` | knowledge-manager.ts | detectKnowledgeGap |
| `knowledge_acquisition_task` | knowledge-manager.ts | generateAcquisitionTask |
| `knowledge_contradiction_check` | knowledge-manager.ts | checkContradiction |
| `decision_enrichment` | knowledge-decisions.ts | enrichDecisionRecord |
| `knowledge_domain_stability` | knowledge-revalidation.ts | classifyDomainStability |
| `memory_pattern_extraction` | memory-distill.ts | extractPatterns |
| `memory_lesson_distillation` | memory-distill.ts | distillLessons |
| `knowledge_transfer_adapt` | knowledge-transfer.ts | applyTransfer |
| `knowledge_meta_patterns` | knowledge-transfer.ts | updateMetaPatterns + updateMetaPatternsIncremental |
| `learning_triplet_extraction` | learning-pipeline.ts | analyzeLogs (stage 1) |
| `learning_pattern_synthesis` | learning-pipeline.ts | analyzeLogs (stage 2) |
| `capability_deficiency_detection` | capability-detector.ts | detectDeficiency |
| `capability_goal_gap_detection` | capability-detector.ts | detectGoalCapabilityGap |
| `capability_verification` | capability-detector.ts | verifyCapabilityAcquisition |
| `ethics_evaluation` | ethics-gate.ts | check + checkMeans |
| `curiosity_proposal_generation` | curiosity-proposals.ts | generateProposals |

That is **21 distinct purpose strings** (some files share). The in-progress.md says 17 new ones — likely because some purposes can be shared (e.g., ethics check + checkMeans both use `ethics_evaluation`, meta-patterns lines 529+598 share `knowledge_meta_patterns`).

---

## 6. Suggested Worker Batches (≤5 files each)

### Worker Batch C (4 files)
- `src/goal/goal-tree-quality.ts` — 2 sites
- `src/goal/goal-dependency-graph.ts` — 1 site
- `src/strategy/strategy-template-registry.ts` — 2 sites
- Plus: add 4 new purposes to `src/prompt/slot-definitions.ts` + purposes/
  - `goal_quality_concreteness`, `goal_quality_decomposition`, `dependency_detection`, `strategy_template_generalize`, `strategy_template_adapt`

### Worker Batch D-1 (3 files)
- `src/knowledge/knowledge-manager.ts` — 3 sites
- `src/knowledge/knowledge-decisions.ts` — 1 site
- `src/knowledge/knowledge-revalidation.ts` — 1 site
- Plus: add purposes: `knowledge_gap_detection`, `knowledge_acquisition_task`, `knowledge_contradiction_check`, `decision_enrichment`, `knowledge_domain_stability`

### Worker Batch D-2 (2 files)
- `src/knowledge/memory-distill.ts` — 2 sites
- `src/knowledge/knowledge-transfer.ts` — 3 sites
- Plus: add purposes: `memory_pattern_extraction`, `memory_lesson_distillation`, `knowledge_transfer_adapt`, `knowledge_meta_patterns`
- **Note**: knowledge-transfer uses `extractJSON()` + `JSON.parse()` + `Schema.parse()` pattern instead of `parseJSON()` — migration must adapt

### Worker Batch E (4 files)
- `src/knowledge/learning-pipeline.ts` — 2 sites
- `src/observation/capability-detector.ts` — 3 sites
- `src/traits/ethics-gate.ts` — 2 sites
- `src/traits/curiosity-proposals.ts` — 1 site
- Plus: add purposes: `learning_triplet_extraction`, `learning_pattern_synthesis`, `capability_deficiency_detection`, `capability_goal_gap_detection`, `capability_verification`, `ethics_evaluation`, `curiosity_proposal_generation`
- **Warning**: ethics-gate uses `parseVerdictSafe()` custom parser. Migration must not change the parsing logic — only wrap the `sendMessage` call.

---

## 7. Special Cases / Migration Warnings

1. **`extractJSON()` pattern** (`knowledge-transfer.ts` lines 362, 529; `learning-pipeline.ts` lines 182, 203): These use `extractJSON(response.content)` → `JSON.parse()` → `Schema.parse()` instead of `parseJSON()`. When migrating to gateway, the gateway's `execute()` method handles parsing via `responseSchema`, so the `extractJSON()` intermediate step needs to be removed. The Zod schema must be passed as `responseSchema`.

2. **ethics-gate custom parser** (`ethics-gate.ts` lines 578, 636): Uses `parseVerdictSafe()` which is a custom parser with specific error handling. The gateway uses standard `parseJSON()`. Migrating to gateway means either (a) standardizing the Zod schema for the response, or (b) NOT migrating ethics-gate through gateway (it has unique safety-critical custom parsing). **Recommended: skip ethics-gate or create a dedicated gateway override that preserves `parseVerdictSafe()`.**

3. **Inline schema** (`capability-detector.ts` line 438): `VerificationResponseSchema` is defined inline in the function scope — needs to be hoisted to module scope before migration.

4. **No `goalId` available** in several files (e.g., `knowledge-decisions.ts`, `knowledge-revalidation.ts`, `memory-distill.ts`): These functions operate on data without a goalId. The gateway accepts `goalId?: string` so this is optional — context assembly will still work with `goalId: undefined`.

5. **`strategy-template-registry.ts` no `additionalContext`**: The prompts are fully self-contained strings built by inline builders. Can pass as `additionalContext: { prompt: thePrompt }` if needed, or rely solely on the purpose's system prompt.

---

## 8. Shared Infrastructure Changes

Each batch worker must also update:
- `src/prompt/slot-definitions.ts` — add new purpose strings to `ContextPurpose` union + add `PurposeSlotConfig` entries
- `src/prompt/purposes/index.ts` — add imports, export new purpose modules, add to `PURPOSE_CONFIGS`
- Create new files: `src/prompt/purposes/<name>.ts` for each new purpose group

**Recommended slot configs for new purposes** (most are stateless — no goalId context needed):
- `goal_quality_*`, `dependency_detection`, `strategy_template_*`: `activeSlots: []` (no memory context, prompt is self-contained)
- `knowledge_*`, `decision_*`, `memory_*`: `activeSlots: []` or `["knowledge"]` if relevant
- `learning_*`: `activeSlots: []`
- `capability_*`: `activeSlots: []`
- `ethics_evaluation`: `activeSlots: []`
- `curiosity_proposal_generation`: `activeSlots: ["goal_definition", "lessons"]` (benefits from goal/lesson context)

---

## 9. Files NOT in Scope for This Migration

The following files have `sendMessage` calls but are outside the C/D/E batches:
- `src/goal/goal-tree-manager.ts` (3 calls at lines 241, 392, 592) — may be "goal-quality(3)" target
- `src/goal/negotiator-steps.ts` (4 calls)
- `src/goal/goal-decomposer.ts` (1 call) — already migrated via `goal_decomposition`?
- `src/goal/goal-suggest.ts` (1 call)
- `src/observation/observation-llm.ts` (2 calls) — likely already migrated via `observation`
- `src/strategy/strategy-manager-base.ts` (1 call)
- `src/execution/result-reconciler.ts` (1 call)
- `src/execution/reflection-generator.ts` (1 call)
- `src/execution/impact-analyzer.ts` (1 call)
- `src/execution/checkpoint-manager.ts` (1 call — uses `.chat()` not `.sendMessage()`)
- `src/tui/intent-recognizer.ts` (1 call)

---

## 10. Gaps / Could Not Determine

- **Count discrepancy**: task says 27 call sites, grep finds 23 across C/D/E files. Either goal-tree-manager (3) + 1 other counts toward the 27, or the count includes some files not in the batch lists.
- **`goal-quality(3)` meaning**: The in-progress.md batch C says "goal-quality(3)" but `goal-tree-quality.ts` only has 2 LLM calls. The 3rd may refer to `goal-tree-manager.ts` lines 241/392/592 (decomposition quality calls) — needs clarification from the in-progress.md author.
- **Gateway injection wiring**: Where exactly does each class/function receive `IPromptGateway` — some are class constructors, some are `deps` objects. Each worker must check the wiring point.
- **Test files**: Not checked for expected call site counts — workers should verify test coverage for each migrated function.
