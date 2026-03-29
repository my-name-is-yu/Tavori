# Multi-Agent Delegation Design

> Issue #33. Defines how PulSeed delegates a single task across multiple agents with divided responsibilities.
> Core principle: **Define appropriate roles and delegate to appropriate capabilities. Roles are domain-agnostic and extensible.**

---

## 1. Core Concept: TaskRole

**"Rather than selecting the right agent, assign the right role and delegate to the right capability."**

A role is a combination of "prompt context + execution configuration." The same adapter (e.g., `claude_code_cli`) behaves differently depending on the role assigned to it. No new adapter types are required — roles are orthogonal to adapters.

```typescript
type TaskRole = "implementor" | "reviewer" | "verifier" | "researcher";
```

| Role | Responsibility | Context sharing |
|------|---------------|----------------|
| `implementor` | Execute the task (code changes, API calls, actions) | Task definition + scope boundaries + pre-execution observation context |
| `verifier` | Run mechanical verification (tests, lint, API response checks) | Task definition + access to artifacts |
| `reviewer` | Independently evaluate artifacts (quality, semantic consistency) | Success criteria + artifacts only (**no** execution context) |
| `researcher` | Gather pre-execution context and acquire knowledge | Task definition + domain knowledge + existing observation results |

The `reviewer` receives no execution context — this is intentional as per the existing design (`task-lifecycle.md` §5 Layer 2), ensuring unbiased evaluation. The `researcher` runs before the `implementor`, collecting the knowledge and context it needs and injecting it into the pipeline's `shared_context`.

Roles are extensible. Future candidates include `deployer` (deploy delegation), `monitor` (continuous monitoring), and `notifier` (sending notifications). See §9 for the extension procedure.

---

## 2. Schema Definitions

### TaskDomain (`src/types/pipeline.ts`)

Represents the target domain of a task. Used by `observeForTask()` to determine collection strategy and by pipeline capability matching.

```typescript
import { z } from "zod";

export const TaskDomainSchema = z.enum([
  "code", "data", "api_action", "research", "communication", "monitoring"
]);
export type TaskDomain = z.infer<typeof TaskDomainSchema>;
```

### TaskPipeline (`src/types/pipeline.ts`)

```typescript
export const TaskRoleSchema = z.enum(["implementor", "reviewer", "verifier", "researcher"]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const PipelineStageSchema = z.object({
  role: TaskRoleSchema,
  capability_requirement: z.object({
    domain: TaskDomainSchema,
    preferred_adapter: z.string().optional(), // specify if there is a strong preference
  }).optional(),
  prompt_override: z.string().optional(),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const TaskPipelineSchema = z.object({
  stages: z.array(PipelineStageSchema).min(1),
  fail_fast: z.boolean().default(true),
  shared_context: z.string().optional(),
  strategy_id: z.string().optional(), // strategy this pipeline belongs to
});
export type TaskPipeline = z.infer<typeof TaskPipelineSchema>;

export const VerdictSchema = z.enum(["pass", "partial", "fail"]);

export const StageResultSchema = z.object({
  stage_index: z.number(),
  role: TaskRoleSchema,
  verdict: VerdictSchema,
  output: z.string(),
  confidence: z.number().min(0).max(1),
  idempotency_key: z.string(), // `${task_id}:${stage_index}:${attempt}`
});
export type StageResult = z.infer<typeof StageResultSchema>;

export const PipelineStateSchema = z.object({
  pipeline_id: z.string(),
  task_id: z.string(),
  current_stage_index: z.number(),
  completed_stages: z.array(StageResultSchema),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  started_at: z.string(),
  updated_at: z.string(),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const ImpactAnalysisSchema = z.object({
  verdict: VerdictSchema,
  side_effects: z.array(z.string()).default([]),
  confidence: z.enum(["confirmed", "likely", "uncertain"]),
});
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;
```

### TaskGroup (`src/types/task-group.ts`)

Breaks a complex task down into a set of subtasks. The LLM decides whether to use a single task or a TaskGroup.

```typescript
import { z } from "zod";
import { TaskSchema } from "./task.js";

export const TaskGroupSchema = z.object({
  subtasks: z.array(TaskSchema).min(2),
  dependencies: z.array(z.object({
    from: z.string(),
    to: z.string(),
  })).default([]),
  file_ownership: z.record(z.string(), z.array(z.string())).default({}),
  shared_context: z.string().optional(),
});
export type TaskGroup = z.infer<typeof TaskGroupSchema>;
```

---

## 3. ObservationEngine: Domain-Specific Task Scope Observation

### `observeForTask(task, domain)` — Pre-execution context collection

Switches collection strategy based on `TaskDomain`.

```typescript
async observeForTask(task: AgentTask, domain: TaskDomain): Promise<TaskObservationContext>
```

| Domain | What is collected |
|--------|------------------|
| `code` | Target files, related tests, dependency modules (1-hop import graph) |
| `data` | Data sources, schemas, previous observation values |
| `api_action` | Endpoint specs, rate limits, authentication status |
| `research` | Known knowledge (KnowledgeManager), list of unresolved questions |
| `monitoring` | Current metric values, alert thresholds, recent trend |
| `communication` | Recipient context, message history |

Context sharing rules:
- `implementor` and `researcher` receive the observation context
- `verifier` / `reviewer` do not (to prevent bias)

---

## 4. PipelineExecutor: Dynamic Orchestration Rules

### Pipeline configuration by task size

| Task size | Pipeline | Description |
|-----------|----------|-------------|
| Small (1 file, minor changes) | `implementor` only | Equivalent to the existing `runTaskCycle()` |
| Medium (1 file, 6+ lines) | `implementor → verifier` | Adds mechanical verification |
| Large (multiple files or TaskGroup) | `researcher → implementor(parallel) → verifier → reviewer` | researcher gathers pre-execution context; file ownership + shared_context |

The LLM assesses size at task generation time and assigns the appropriate pipeline.

### Plan Approval Gate (for Large tasks)

The `implementor` stage of a Large task is split into two sub-phases:

1. **plan** — the implementor generates an execution plan (read-only, no changes)
2. PulSeed compares the plan against the strategy hypothesis and decides to approve or reject
3. **execute** — the approved plan is executed by the implementor

Auto-approval condition: if the adapter's `trust_score >= 20` (high-trust boundary), plan approval can be automated. Otherwise, human approval is requested via `EthicsGate`.

### Three-strike escalation

```
Strike 1 → retry the same stage with adjusted prompt (same adapter)
Strike 2 → retry with an alternative adapter from CapabilityRegistry (if available)
Strike 3 → escalate to human via EthicsGate approval flow
```

Branch by stage type:
- Consecutive `verifier` failures → classified as an environment issue; generate an environment-check task first
- `reviewer` failure → follow the L1/L2 contradiction resolution rules from `task-lifecycle.md` §5

### Irreversible action gate

If a task has the `irreversible: true` flag, approval must be obtained before execution (integrated with the existing `EthicsGate`). No exceptions even in multi-agent pipelines.

### Pipeline persistence

`PipelineExecutor` writes `PipelineState` to disk via `StateManager` after each stage completes. On restart, `CoreLoop` detects pipelines with `status: "interrupted"` and resumes from `current_stage_index`.

Idempotency guarantee: before executing a stage, check whether the `idempotency_key` (`${task_id}:${stage_index}:${attempt}`) already exists in `completed_stages`; if so, skip.

### Strategy feedback

When a pipeline completes and `strategy_id` is set, call `PortfolioManager.recordTaskResult()` and pass the pipeline's verdict and per-stage results. This closes the "hypothesis → execute → measure → rebalance" cycle.

### `TaskVerifier`: Side-effect detection and confidence labeling

After the `verifier` stage, generate an `ImpactAnalysis` to detect unintended side effects.

```
verdict: "pass" / "partial" / "fail"
side_effects: ["test Y was broken", "type definition Z changed"]
confidence: "confirmed" | "likely" | "uncertain"
```

The `confidence` label uses the same criteria as the observation engine (`>=0.50` = verified, `<0.50` = self-reported).

---

## 5. Implementation Phases

### Phase 1 (MVP): Sequential pipeline + domain-specific observation + persistence + idempotency

**New files:**
- `src/types/pipeline.ts` — TaskDomain, TaskRole, PipelineStage, TaskPipeline, StageResult, PipelineState, ImpactAnalysis (~100 lines)
- `src/execution/pipeline-executor.ts` — sequential stage execution + error escalation + persistence + idempotency check (~200 lines)

**Modified files:**
- `src/observation/observation-engine.ts` — add `domain: TaskDomain` parameter to `observeForTask()`, domain-specific collection strategies
- `src/execution/task-lifecycle.ts` — add `runPipelineTaskCycle()` alongside `runTaskCycle()`. Existing `runTaskCycle()` is unchanged.

**Tests:** `tests/execution/pipeline-executor.test.ts`

Flow of `runPipelineTaskCycle()`:

```
1. selectTargetDimension()     <- existing logic (unchanged)
2. generateTask()              <- generated with a pipeline field
3. observeForTask(task, domain) <- domain-specific pre-execution context collection
4. runPreExecutionChecks()     <- existing logic (unchanged, includes irreversible gate)
5. PipelineExecutor.run()      <- sequential stage execution + persistence + idempotency
6. handleVerdict()             <- existing logic (unchanged)
```

**Backward compatibility**: Pipelines are opt-in. Tasks without a `pipeline` field continue to use the existing `runTaskCycle()`.

### Phase 2: Task decomposition + parallel execution + Plan Gate + strategy feedback

**New files:**
- `src/types/task-group.ts` — TaskGroup schema (~30 lines)
- `src/execution/parallel-executor.ts` — `Promise.all` + file ownership check (~150 lines)

**Modified files:**
- `src/execution/task-generation.ts` — TaskGroup + plan generation. LLM evaluates task complexity and decides between single task vs TaskGroup.
- `src/core-loop.ts` — `runOneIteration()` detects TaskGroup and hands it to `ParallelExecutor`
- `src/execution/pipeline-executor.ts` — Plan Approval Gate + three-strike escalation + `strategy_id` feedback

**Tests:** `tests/execution/parallel-executor.test.ts`

### Phase 3: Auto pipeline + side-effect detection + contradiction detection + fault tolerance

**New files:**
- `src/execution/result-reconciler.ts` — contradiction detection in parallel results (~120 lines)

**Modified files:**
- `src/execution/task-verifier.ts` — `ImpactAnalysis` generation + sycophancy mitigation (uses a different model instance)
- `src/execution/task-generation.ts` — auto-configure pipeline based on task size evaluation
- `src/execution/adapter-layer.ts` — capability matching + circuit breaker
- `src/execution/parallel-executor.ts` — concurrency semaphore

**Tests:** `tests/execution/result-reconciler.test.ts`

---

## 6. File Structure

```
src/types/
  pipeline.ts                    <- new (~100 lines)
  task-group.ts                  <- new (~30 lines)

src/execution/
  pipeline-executor.ts           <- new (~200 lines)
  parallel-executor.ts           <- new (~150 lines)
  result-reconciler.ts           <- new (~120 lines)
  task-lifecycle.ts              <- modified (add runPipelineTaskCycle)
  task-generation.ts             <- modified (pipeline generation + TaskGroup decomposition)
  task-verifier.ts               <- modified (ImpactAnalysis + sycophancy mitigation, Phase 3)
  adapter-layer.ts               <- modified (capability matching + circuit breaker, Phase 3)

src/observation/
  observation-engine.ts          <- modified (domain-specific observeForTask)

tests/execution/
  pipeline-executor.test.ts      <- new
  parallel-executor.test.ts      <- new
  result-reconciler.test.ts      <- new
```

All files are designed to stay within the 500-line limit.

---

## 7. Key Design Decisions

| Decision | Rationale | Vision basis |
|----------|-----------|-------------|
| Pipelines are opt-in | Does not break the existing `runTaskCycle()` | — |
| No new adapter types | Roles are prompt differences. `IAdapter` interface is not changed | — |
| Do not pass execution context to `reviewer` | Ensures unbiased evaluation (task-lifecycle.md §5 L2) | — |
| Pass `observeForTask` only to `implementor` and `researcher` | Passing pre-execution context to `verifier`/`reviewer` introduces bias | — |
| `file_ownership` prevents file conflicts | Parallel implementors editing the same file produces indeterminate results | — |
| Contradiction detection uses LLM | Semantic contradictions cannot be judged by rule-based logic | — |
| LLM decides TaskGroup | Task complexity evaluation is delegated to the LLM | — |
| `PipelineState` persistence | Pipeline continuity across restarts and crashes | vision §3 "running for years" |
| `TaskDomain` introduced | Generalize beyond code to other domains (data, API, monitoring, etc.) | vision §5.7 "observing the external world" |
| `capability_requirement` | Dynamic capability matching rather than static adapter assignment | vision §5.3 "Capability Registry" |
| `strategy_id` feedback | Connect pipeline results to strategy effectiveness measurement | vision §5.4 "Strategy Engine" |
| Plan Approval Gate | Validate the plan before executing Large tasks to prevent wasted execution | vision §5.8 "delegation layer" quality control |
| Three-strike escalation | Two strikes causes notification fatigue in long-running operation | vision §3 "preventing notification fatigue in long-running operation" |

---

## 8. Connection to Existing Design

This design is a fully considered extension of `task-lifecycle.md` §5 (3-layer verification).

- `verifier` role → corresponds to Layer 1 (mechanical verification)
- `reviewer` role → corresponds to Layer 2 (task reviewer)
- The existing L1/L2 contradiction resolution rules (table in §5) are implemented in `result-reconciler.ts`

After the pipeline matures, a path is left open in Phase 3 to integrate the existing `task-verifier.ts` L2 through the `reviewer` role.

**Strategy integration**: The `strategy_id` feedback closes the `hypothesis` → `effectiveness_score` cycle of the `Strategy` entity in `portfolio-management.md` using pipeline execution results. Rebalancing is automatically triggered via `PortfolioManager.recordTaskResult()`.

---

## 9. Role Extension Guide

Steps to add a new role:

1. **Add to `TaskRoleSchema`** — add the new role string to the enum in `src/types/pipeline.ts`
2. **Define context sharing rules** — add to the §1 table which information the new role receives and which it does not
3. **Add domain-specific observation** — define what the new role needs collected in `observeForTask()` (if applicable)
4. **Update PipelineExecutor stage dispatch** — add stage execution logic for the new role
5. **Add tests** — add unit tests for the new role in `pipeline-executor.test.ts`

Future role candidates:

| Role | Responsibility | Expected phase |
|------|---------------|----------------|
| `deployer` | Delegate deployment to the appropriate system | M14+ |
| `monitor` | Continuous monitoring of wearables, DB, APIs, etc. | M14+ |
| `notifier` | Send notifications to messaging systems | M14+ |

---

## 10. Fault Tolerance Patterns (Phase 3)

### Circuit Breaker

Add a per-adapter consecutive failure count to `AdapterLayer`.

```
closed → 5 consecutive failures → open → cooldown elapsed → half_open → success → closed
                                                           → failure → open
```

`PipelineExecutor` excludes adapters in `open` state when selecting an adapter. Even if a `preferred_adapter` is specified in `capability_requirement`, if that adapter is `open`, an alternative is selected.

### Backpressure

Embed a semaphore in `parallel-executor.ts`. Default `concurrency_limit = 3`. Use `CrossGoalPortfolio`'s `allocation` ratio as weights to reserve slots for higher-priority goals first.

### Sycophancy Mitigation

The L2 `reviewer` uses a different model instance/provider than the `implementor`. When the same model evaluates its own output, confirmation bias degrades quality (CONSENSAGENT, ACL 2025).

### Event Source Extension (Future Path)

The `PipelineState` snapshot persistence can be extended in the future into a full immutable event log. Each stage's start, completion, and failure would be recorded as events, enabling replay from any point in time. For Phase 3, `PipelineState` snapshots are sufficient, but the design leaves this extension path open.
