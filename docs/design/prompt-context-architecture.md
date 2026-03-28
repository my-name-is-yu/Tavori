# Prompt Context Architecture — LLM Prompt Utilization Design for Hierarchical Memory

Created: 2026-03-21
Status: Design proposal (not yet implemented)

---

## 1. Executive Summary

PulSeed already has a rich memory infrastructure — four-tier hierarchical memory (hot/warm/cold/archival), context budget management, semantic search, reflection notes, and lesson distillation. However, there is a "last mile" gap between this infrastructure and LLM prompts. This design introduces a new component called **PromptGateway** and defines a pipeline that systematically injects purpose-optimized context into each LLM call. This improves task generation accuracy, prevents repeated failure patterns, and stabilizes observations.

---

## 2. Current Problems

Analysis of internal LLM calls (31 total) has identified the following disconnected points.

### 2.1 Critical Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| Long-term memory lessons not injected into task generation | `LessonEntry` distilled by `MemoryLifecycleManager` is retained in long-term memory, but there is no path to pass it to `generateTask()` | Task generation LLM creates new tasks without knowledge of past failure and success patterns |
| Observation prompts lack dimension history | `observeWithLLM()` uses only `previousScore` (a single scalar value). Time-series data from `dim.history` is unused | Cannot convey trends (rising/falling/flat), reducing detection accuracy for abnormal score jumps |

### 2.2 Important Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| `context-budget.ts` not connected to LLM calls | `allocateBudget()` etc. are implemented, but actual prompts use a fixed value of `MAX_CONTEXT_CHARS=4000` | Token overflows and shortfalls cannot be controlled |
| `ReflectionNote` not used in task generation | `formatReflectionsForPrompt()` is implemented but not connected to `buildTaskGenerationPrompt()` | "What not to do" information is never used |
| `StrategyTemplateRegistry` not connected to strategy generation | Semantic search and adaptation of successful strategy templates are implemented but not passed to `buildGenerationPrompt()` | Successful strategies from other Goals are never applied to new Goals |

### 2.3 Minor Gaps

- `generateTaskGroup()` does not receive `knowledgeContext` / `workspaceContext`
- `CapabilityDetector` results are not reflected in task generation
- `llmClassifyTier()` is inconsistent with the `ILLMClient` interface

---

## 3. Lessons from Prior Art

A survey of 10 agent frameworks identified 5 applicable patterns for PulSeed.

### 3.1 Four-Layer Prompt Structure (Common across all frameworks)

Nearly all frameworks adopt the following hierarchy:

```
[System/Instruction]  -- Static or slowly changing (agent definition)
[Memory/Context]      -- Dynamically selected and updated (memory, knowledge)
[History/State]       -- Subject to management and compression
[Current Input/Task]  -- Immediate input
```

Current state of PulSeed: Most LLM calls use user-only messages with no system prompt, and the Memory/Context layer injection is insufficient.

**Adoption plan**: Unify all LLM calls into the 4-layer structure. Since PulSeed is not a chat-type agent, the History layer is replaced with "dimension observation history" and "recent task results."

### 3.2 Composite Scoring (Generative Agents / CrewAI)

Rather than simple semantic search, retrieve using a 3-factor composite score:

```
score = w_r * recency_decay + w_i * importance + w_s * semantic_similarity
```

- **Recency**: Exponential decay from last access time
- **Importance**: Entry importance score (0–1)
- **Relevance**: Cosine similarity between query and memory

**Adoption plan**: PulSeed's `memory-selection.ts` already has `computeRelevanceScore()`. This will be extended to add weighting for `recency` and `importance`. The scoring logic in the existing `selectForWorkingMemory()` will be improved.

### 3.3 MemGPT's Page-In/Page-Out

The core of MemGPT is the clear separation between "core memory (always in context)" and "external memory (paged in via search)":

- **Core Memory**: Fixed blocks always included in the prompt (persona, user information)
- **Recall Storage**: Full conversation history (paged in via text search)
- **Archival Storage**: Unlimited-capacity knowledge (paged in via embedding search)

**Adoption plan**: Map PulSeed's 4-tier memory as follows:

| MemGPT | PulSeed | Prompt Injection Method |
|--------|---------|-------------------------|
| Core Memory | hot tier (Goal definition, current state, active strategy) | Always injected (mandatory slot) |
| Recall Storage | warm tier (recent observations, task results, reflections) | Selectively injected by purpose |
| Archival Storage | cold/archival tier (lessons, knowledge, templates) | Paged in via semantic search |

### 3.4 Reflexion-style Introspection Injection

The core of Reflexion: generate linguistic reflection after failure, and inject it into the context for the next attempt.

```
Failure → Generate reflection ("what went wrong / what to try next")
        → Store in warm tier (importance=0.9)
        → Include in prompt at next task generation
```

**Adoption plan**: PulSeed's `reflection-generator.ts` and `formatReflectionsForPrompt()` are already implemented. Simply connecting them realizes the Reflexion pattern.

### 3.5 DSPy's Programmatic Optimization (Future Vision)

DSPy's approach treats "prompts as variable parameters to be auto-optimized." Applicable to PulSeed after sufficient goal execution data has been accumulated:

- Define goal achievement rate as the metric
- Define each LLM call as a Signature
- Optimizer automatically improves prompts

**Adoption plan**: Not adopted at this stage. However, the ContextAssembler design will be kept Signature-compatible to facilitate future adoption.

---

## 4. Design Principles

1. **Leverage existing infrastructure**: Do not build a new memory system. Connect `context-provider.ts`, `memory-tier.ts`, `memory-lifecycle.ts`, and `context-budget.ts`
2. **Purpose-optimized injection**: Do not inject the same context into all LLM calls. Observation, task generation, and verification each require different information
3. **Budget control**: Assign token budgets to each slot; when exceeded, reduce from lowest-priority slots first
4. **XML tag structuring**: Structure prompts with XML tags to improve LLM reference accuracy (no model-specific format switching needed)
5. **Incremental rollout**: Do not break existing behavior. Each LLM call can be migrated individually
6. **Context Rot prevention**: Inject information with confidence scores; exclude noise via cosine similarity thresholds

---

## 5. Architecture Design

### 5.1 PromptGateway (New Component)

Implemented as a `src/prompt/` folder with the following structure:

```
src/prompt/
├── gateway.ts              # PromptGateway body (thin orchestrator)
├── context-assembler.ts    # Context assembly (memory → XML blocks)
├── slot-definitions.ts     # Purpose-specific slot definitions (what information goes where)
├── formatters.ts           # XML tag formatters, token truncation
├── purposes/               # Purpose-specific templates + schemas
│   ├── observation.ts      # system prompt + response schema
│   ├── task-generation.ts  # same
│   ├── verification.ts
│   ├── strategy.ts
│   └── goal-decomposition.ts
└── index.ts                # re-export
```

**PromptGateway responsibilities** (full lifecycle):
1. **Context assembly** — Purpose-specific slot selection, retrieval from hierarchical memory, budget control (`context-assembler.ts`)
2. **Prompt construction** — Generation of system prompt + XML-tagged user message (retrieved from `purposes/`)
3. **LLM call** — Executed via `ILLMClient`, with logging and token tracking
4. **Response parsing** — Parsing and validation using Zod schemas

**All LLM callers use only this interface**:

```typescript
interface PromptGatewayInput<T> {
  purpose: ContextPurpose;
  goalId: string;
  dimensionName?: string;
  additionalContext?: Record<string, string>;
  responseSchema: z.ZodSchema<T>;
}

interface PromptGateway {
  execute<T>(input: PromptGatewayInput<T>): Promise<T>;
}
```

Usage example:

```typescript
const result = await promptGateway.execute({
  purpose: "task_generation",
  goalId,
  dimensionName,
  additionalContext: { existingTasks, failureContext },
  responseSchema: TaskSchema,
});
```

**ContextAssembler** (`src/prompt/context-assembler.ts`):

Not exposed to direct callers. Used internally by PromptGateway only.

```typescript
type ContextPurpose =
  | "observation"
  | "task_generation"
  | "verification"
  | "strategy_generation"
  | "goal_decomposition";

interface AssembledContext {
  systemPrompt: string;
  contextBlock: string; // XML-tagged and structured
  totalTokensUsed: number;
}
```

**gateway.ts (thin orchestrator)**:

`gateway.ts` only does the following — all logic is delegated to internal components:
1. Assemble context via `context-assembler.ts::build()`
2. Retrieve prompt template from `purposes/{purpose}.ts`
3. Call the LLM
4. Parse the response

**Absorbing workspace-context.ts**:
The existing `createWorkspaceContextProvider()` is absorbed as an internal implementation of `context-assembler.ts`. Only the single interface `PromptGateway.execute()` is exposed externally. It will not remain as a parallel system.

### 5.2 Purpose-Specific Context Slots

For each purpose, define which slots to use and which memory tier to retrieve from.

| Slot | Observation | Task Gen | Verification | Strategy | Goal Decomp |
|------|-------------|----------|--------------|----------|-------------|
| Goal definition (hot) | o | o | o | o | o |
| Current state (hot) | o | o | o | o | - |
| Dimension history (warm) | o | - | - | - | - |
| Recent task results (warm) | - | o | o | - | - |
| Reflection notes (warm) | - | o | - | - | - |
| Lessons (cold) | - | o | - | o | - |
| Knowledge (archival) | - | o | o | o | o |
| Strategy templates (archival) | - | - | - | o | - |
| Workspace state (warm) | o | o | - | - | - |
| Failure context (warm) | - | o | - | - | - |

`o` = inject, `-` = do not inject

### 5.3 Hierarchical Memory → Prompt Injection Pipeline

```
[LLM caller]
  │
  ├── purpose + goalId + responseSchema + additionalContext
  │
  ▼
[PromptGateway]
  │
  ├── [ContextAssembler]
  │     ├── 1. Budget calculation (context-budget.ts: allocateBudget)
  │     ├── 2. hot tier: always retrieved (Goal definition, current state)
  │     ├── 3. warm tier: selectively retrieved by purpose (observation history, reflections, workspace)
  │     ├── 4. cold tier: lessons and patterns retrieval
  │     ├── 5. archival tier: page in via semantic search
  │     ├── 6. Budget adjustment (on overflow: archival → cold → warm)
  │     └── 7. Structured with XML tags → AssembledContext
  │
  ├── System prompt + user message construction
  ├── ILLMClient.call() execution (logging, token tracking)
  └── Response parsed with Zod schema → T
```

### 5.4 Role of Each Memory Tier

| Tier | PulSeed Equivalent | Prompt Injection Method | Retrieval Cost |
|------|--------------------|------------------------|----------------|
| **hot** | Goal definition, current state, active strategy | Always injected (required for all purposes) | O(1) file read |
| **warm** | Last 5 observation history entries, recent task results, reflection notes, workspace state | Selectively injected by purpose | O(1) in-memory or file |
| **cold** | Distilled lessons (LessonEntry), learned patterns | Semantic search or tag search | O(n) search |
| **archival** | Knowledge entries, strategy templates, DecisionRecords | Semantic search (VectorIndex) | O(log n) embedding search |

### 5.5 Token Budget Management

The budget is configurable via `llm.contextBudgetTokens` in `~/.pulseed/config.json`. When not set, the default is 4000. For model context window information, refer to `provider-config.ts`.

```
totalBudget (default: 4000 tokens, configurable in config.json)
  ├── goalDefinition:    20% (800 tokens)  -- hot tier
  ├── observations:      30% (1200 tokens) -- warm tier
  ├── knowledge:         30% (1200 tokens) -- cold/archival tier
  ├── transferKnowledge: 15% (600 tokens)  -- archival tier
  └── meta:               5% (200 tokens)  -- system prompt etc.
```

Adjusted by purpose:
- **Observation**: observations 40%, knowledge 15% (emphasizes workspace state)
- **Task generation**: knowledge 35%, observations 25% (emphasizes lessons and reflections)
- **Verification**: observations 35%, knowledge 25% (emphasizes task results)

Reduction order on overflow: `archival → cold → warm → hot` (hot is never reduced)

### 5.6 XML Tag-Based Prompt Structuring

XML tags are adopted (no model-specific format switching — XML is valid across all supported models):

```xml
<goal_context>
  Goal: {goal.title}
  Active Strategy: {strategy.hypothesis}
</goal_context>

<current_state>
  {dimension}: {currentValue} (target: {threshold}, gap: {gap})
</current_state>

<recent_observations>
  {formatted_recent_observations_with_timestamps}
</recent_observations>

<lessons_learned>
  {formatted_lessons_from_cold_memory}
</lessons_learned>

<relevant_knowledge>
  {formatted_knowledge_entries_from_archival}
</relevant_knowledge>

<workspace_state>
  {workspace_context_items}
</workspace_state>

<past_reflections>
  {formatted_reflection_notes}
</past_reflections>
```

Each tag's content is included selectively based on purpose (following the slot table in §5.2).

---

## 6. Purpose-Specific Prompt Design (Before/After)

### 6.1 Observation (observeWithLLM)

**Before**:
```
You are an objective evaluator of software project progress.
Goal: {goalDescription}
Context (max 4000 chars): {workspaceContext}
```

**After**:
```
You are an objective evaluator of software project progress.

<goal_context>
  Goal: {goal.description}
  Threshold: {thresholdDescription}
</goal_context>

<observation_history>
  Trend (last 5): 2026-03-18: 0.3, 2026-03-19: 0.4, 2026-03-20: 0.45, ...
  Direction: improving
  Previous score: {previousScore}
</observation_history>

<workspace_state>
  {workspaceContext -- via ContextAssembler, budget-controlled}
</workspace_state>
```

**Changes**: Injection of dimension history (warm tier), XML tag structuring, budget control

### 6.2 Task Generation (generateTask)

**Before**:
```
System: You are a task generation assistant. ...
Goal: {title} - {description}
Workspace: {workspaceContext}
```

**After**:
```
System: You are a task generation assistant. Given a goal, gap analysis,
and past experience, generate the most effective next task.

<goal_context>
  Goal: {title} - {description}
  Current: {current}, Target: {threshold}, Gap: {gap}
  Active Strategy: {strategy.hypothesis}
</goal_context>

<past_reflections>
  What failed: Direct file modification without running tests
  Suggestion: Always include test execution in task scope
</past_reflections>

<lessons_learned>
  - [HIGH] When gap > 0.5, break into sub-tasks of gap <= 0.2 each
</lessons_learned>

<relevant_knowledge>
  Q: What testing framework does this project use?
  A: Vitest (confidence: 0.95)
</relevant_knowledge>

<constraints>
  Existing tasks (avoid duplication): {existingTasks}
  Last failure context: {failureContext}
</constraints>
```

**Changes**: Injection of reflection notes (warm tier), lessons (cold tier), knowledge (archival tier)

### 6.3 Task Verification (runLLMReview)

**Before**:
```
System: Review task results objectively against criteria.
Task: {work_description}
Executor output: {output}
```

**After**:
```
System: Review task results objectively. Ignore executor self-assessment.

<task_definition>
  Task: {work_description}, Success criteria: {criteria}
</task_definition>

<execution_result>
  Output (truncated): {output}
  Stop reason: {stopReason}
</execution_result>

<current_state>
  Dimension: {dimension} was {beforeValue}, expected >= {threshold}
</current_state>

<relevant_knowledge>
  {knowledgeEntries -- definition of correct state}
</relevant_knowledge>
```

**Changes**: Injection of dimension value changes (hot tier), knowledge (archival tier)

### 6.4 Strategy Generation (generateCandidates)

**Before**:
```
Goal: {goalId}, Current gap: {gapScore}
Past strategies: {pastStrategies}
```

**After**:
```
<goal_context>
  Goal: {goalId}, Current gap: {gapScore}
</goal_context>

<strategy_templates>
  Successful patterns from other goals:
  - Template: "{hypothesis_pattern}" (success rate: 0.8)
</strategy_templates>

<lessons_learned>
  {lessons -- patterns from LearningPipeline}
</lessons_learned>
```

**Changes**: Injection of strategy templates (archival tier), lessons (cold tier)

### 6.5 Goal Decomposition (buildDecompositionPrompt)

**Before**:
```
Goal: {description}
Workspace context: {workspaceContext}
```

**After**:
```
<goal_context>
  Goal: {description}, Constraints: {constraints}
</goal_context>

<relevant_knowledge>
  {domainKnowledge}
</relevant_knowledge>

<workspace_state>
  {workspaceContext}
</workspace_state>
```

**Changes**: Injection of knowledge (archival tier), XML tag structuring

---

## 7. Implementation Roadmap

### Phase A: Foundation (PromptGateway + ContextAssembler Implementation)

**Goal**: Implement components and write unit tests

| Task | File | Dependencies |
|------|------|--------------|
| A-1: ContextAssembler body | `src/prompt/context-assembler.ts` | context-budget.ts |
| A-2: Purpose-specific slot definitions | `src/prompt/slot-definitions.ts` | - |
| A-3: XML tag formatters | `src/prompt/formatters.ts` | - |
| A-4: PromptGateway body | `src/prompt/gateway.ts` | A-1, ILLMClient |
| A-5: Purpose-specific template group | `src/prompt/purposes/*.ts` (5 files) | A-2 |
| A-6: Unit tests | `tests/prompt/context-assembler.test.ts`, `tests/prompt/gateway.test.ts` | A-1 through A-4 |
| A-7: Integration tests (pipeline validation) | `tests/prompt/gateway-integration.test.ts` | A-4 |

A-7 validates that context flows from ContextAssembler → prompt construction → mock LLM → arrives in the prompt.

**Estimated size**: 8 files + 3 test files, each under 200–300 lines

### Phase B: Connection (Integration with Existing LLM Calls)

**Goal**: Connect PromptGateway (`src/prompt/gateway.ts`) to 5 major LLM call sites

| Task | Caller File | Dependencies | Priority |
|------|-------------|--------------|----------|
| B-1: Inject lessons + reflections into task generation | `task-lifecycle.ts` | `src/prompt/purposes/task-generation.ts` | P1 |
| B-2: Inject dimension history into observation | `observation-engine.ts` | `src/prompt/purposes/observation.ts` | P1 |
| B-3: Inject knowledge + state into verification | `task-lifecycle.ts` | `src/prompt/purposes/verification.ts` | P2 |
| B-4: Inject templates + lessons into strategy generation | `strategy-manager.ts` | `src/prompt/purposes/strategy.ts` | P2 |
| B-5: Live connection of context-budget.ts | `src/prompt/context-assembler.ts` | Phase A-4 | P2 |

**Estimated size**: Modifications to 5–6 files, 20–50 lines of changes per file

### Phase C: Optimization

**Goal**: Improve accuracy and efficiency

| Task | File | Priority |
|------|------|----------|
| C-1: Composite scoring (recency + importance + relevance) | `memory-selection.ts` | P2 |
| C-2: Purpose-specific budget allocation tuning | `src/prompt/context-assembler.ts` | P3 |
| C-3: Context Rot prevention (confidence threshold, cosine similarity threshold) | `src/prompt/context-assembler.ts` | P3 |
| C-4: Add context to generateTaskGroup | `task-generation.ts` | P3 |

**Estimated size**: Modifications to 3–4 files

### Phase D: Migration of Remaining Call Sites (Low Priority)

**Goal**: Migrate the remaining ~26 call sites (out of 31 total) not covered in Phases A–C to the `src/prompt/gateway.ts` pattern

| Task | Target | Priority |
|------|--------|----------|
| D-1: Migrate goal-negotiator LLM calls | `goal-negotiator.ts` and others | P3 |
| D-2: Migrate knowledge-manager LLM calls | `knowledge-manager.ts` and others | P3 |
| D-3: Migrate remaining LLM calls | Remaining sites | P4 |

Phase D is a mechanical migration of functionally working code and should begin after Phases A–C are complete. The migration unifies logging, token tracking, and structuring across all LLM calls. Each caller simply imports the appropriate `purposes/*.ts` module from `src/prompt/` to complete the migration.

---

## 8. Tradeoffs and Decisions

### Decisions Made

| Decision | Rationale | Tradeoff |
|----------|-----------|----------|
| Adopt XML tag structuring (no model-specific switching) | Uniformly effective across all supported models. Avoids complexity of switching logic | - |
| PromptGateway manages the full lifecycle | Single control point for logging, token tracking, and A/B testing | Purpose-specific templates are separated into dedicated files to prevent the component from becoming a God Object |
| Absorb workspace-context.ts into ContextAssembler | Unify the external interface. Eliminate parallel systems | Existing direct call sites require modification |
| Budget configurable via config.json | Optimal values vary by user environment and model | Default of 4000 is sufficient in most cases |
| Reuse existing allocateBudget ratios | Minimizes implementation cost | Purpose-specific optimal ratios may differ (to be tuned in Phase C) |
| Set archival tier cosine similarity threshold at 0.6 | Balance between noise elimination and relevant information retrieval | If threshold is too high, useful information may be missed |

### Decisions Deferred

| Deferred Item | Reason |
|---------------|--------|
| DSPy-style automatic prompt optimization | Ineffective until sufficient execution data is accumulated. To be reconsidered in Phase C and beyond |
| YAML externalization of prompt templates | Code-internal templates are sufficient at this stage |
| LLM-autonomous memory management (MemGPT-style) | PulSeed is an orchestrator; having the system control memory management is more predictable |
| Model-specific prompt format switching (XML/Markdown) | Unnecessary. XML works across all supported models |

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Increased token cost from context injection | Budget control sets an upper limit. Configurable via config.json |
| Outdated lessons causing misleading context (Context Rot) | Composite score of importance + recency eliminates old, low-importance entries |
| PromptGateway with too many dependencies (God Object) | Purpose-specific templates and schemas are separated into dedicated files. All ContextAssembler dependencies are optional |
| Impact on existing tests | In Phase B, existing prompt construction functions are extended (not replaced). Existing tests will not break |
