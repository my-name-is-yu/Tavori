# Goal Refinement Pipeline

> Related: `goal-tree.md`, `gap-calculation.md`, `satisficing.md`

---

## 1. Problem

PulSeed has two separate paths for making goals concrete. `negotiate()` in GoalNegotiator runs a 6-step flow: LLM dimension decomposition, baseline estimation, feasibility evaluation (qualitative or quantitative), capability check, and response generation. It produces a single goal with validated, feasibility-checked dimensions. `decomposeGoal()` in GoalTreeManager runs a different flow: LLM specificity scoring, recursive sub-goal generation, coverage validation, and cycle detection. It produces a tree of goals, each with dimensions assigned by the decomposition LLM.

These are the same operation — "turn something ambiguous into something measurable" — split across two code paths with no shared stopping criterion. The key gap: `decomposeGoal()` marks leaf nodes with whatever dimensions the LLM produced during decomposition (`buildGoalFromSubgoalSpec` sets `observation_method.type = "manual"`, `confidence = 0.5`, no feasibility check). These leaves enter the core loop with untested dimensions — no validation that the observation method works, no feasibility assessment, no counter-proposal for unrealistic targets.

This causes real failures: a leaf goal gets dimensions like `{name: "api_response_time", threshold_type: "max", threshold_value: 100}` with no observation command, observation fails, the loop stalls, and stall detection triggers renegotiation — which is the feasibility check that should have happened at refinement time. Unifying the paths eliminates this class of bugs and reduces wasted loop iterations.

---

## 2. Prior Art

- **ADaPT** (arXiv:2311.05772) — decompose only when execution fails, not eagerly. Relevant: our runtime fallback (§3.1 step 5) adopts this for re-refinement.
- **OKR-Agent** (ICLR 2024) — Objective → Key Result hierarchy; stop decomposing when KRs are numeric and measurable. Depth limit of 3 levels. Our leaf test is analogous to their "is this KR numeric?" check.
- **GQM** (Basili/Caldiera/Rombach) — Goal → Question → Metric; stop when every question has a data source. Our leaf test asks exactly this: can you specify a data source and threshold?
- **Voyager** (arXiv:2305.16291) — verifiability test before task proposal. Confirms our design: validate measurability before entering the loop.

---

## 3. Design

### 3.1 `refine(goal, config): Promise<RefineResult>`

Unified entry point. Recursive. Composes GoalNegotiator (feasibility) and GoalTreeManager (decomposition) without replacing them.

```
refine(goal, config):
  1. Leaf test: LLM prompt → {is_measurable, dimensions?, reason}
     "Can you specify (data_source, command, threshold_type, target) for each aspect of this goal?"

  2. If measurable (is_measurable = true):
     a. Validate dimensions via feasibility check (reuse negotiate step 4)
     b. Attach validated dimensions to goal, mark node_type = "leaf"
     c. Return RefineResult with leaf = true

  3. If not measurable:
     a. Decompose into sub-goals (reuse GoalTreeManager decomposition logic)
     b. For each sub-goal: refine(sub-goal, config) recursively
     c. Return RefineResult with children

  4. Stopping conditions (checked before step 1):
     a. depth >= config.maxDepth → force leaf, use best-effort dimensions
     b. config.tokenBudget exhausted → force leaf
     c. Already has validated dimensions (manual or prior negotiate) → skip

  5. Runtime fallback (called from CoreLoop, not during initial refine):
     Observation failure on a leaf → re-refine that leaf with updated context
```

### 3.2 TypeScript Interfaces

```typescript
interface RefineConfig {
  maxDepth: number;           // default: 3
  tokenBudget: number;        // max tokens across all LLM calls in this refine tree
  feasibilityCheck: boolean;  // default: true; skip for dry-run / preview
  minSpecificity: number;     // default: 0.7 (from GoalDecompositionConfig)
  maxChildrenPerNode: number; // default: 5
}

interface LeafTestResult {
  is_measurable: boolean;
  dimensions: LeafDimension[] | null;  // non-null when is_measurable = true
  reason: string;
}

interface LeafDimension {
  name: string;
  label: string;
  threshold_type: "min" | "max" | "range" | "present" | "match";
  threshold_value: number | string | boolean | null;
  data_source: string;           // e.g. "shell", "file_existence", "github_issue"
  observation_command: string;    // e.g. "npm test -- --coverage"
}

interface RefineResult {
  goal: Goal;                           // updated goal with dimensions or children
  leaf: boolean;                        // true = terminal node with validated dimensions
  children: RefineResult[] | null;      // non-null when leaf = false
  feasibility: FeasibilityResult[] | null; // non-null for leaves when feasibilityCheck = true
  tokensUsed: number;
  reason: string;                       // why this node stopped (measurable / depth limit / budget)
}
```

### 3.3 Leaf Test Prompt

Single LLM call. Structured JSON output.

```
You are evaluating whether a goal is directly measurable.

Goal: "${goal.description}"
Constraints: ${goal.constraints}
Available data sources: ${dataSources}   // from ObservationEngine registry
Depth: ${goal.decomposition_depth}

A goal is measurable when you can specify ALL of these for EACH aspect:
1. data_source — where to observe (shell command, file check, API, etc.)
2. observation_command — exact command or check to run
3. threshold_type — min/max/range/present/match
4. threshold_value — concrete target value

Return JSON:
{
  "is_measurable": true/false,
  "dimensions": [                    // only when is_measurable = true
    {
      "name": "snake_case_name",
      "label": "Human Label",
      "threshold_type": "min",
      "threshold_value": 80,
      "data_source": "shell",
      "observation_command": "npm test -- --coverage | grep Statements"
    }
  ],
  "reason": "Brief explanation"
}
```

The prompt includes available data sources from ObservationEngine so the LLM can match dimensions to real observation methods, not hallucinated ones.

### 3.4 Where It Lives

```
src/goal/goal-refiner.ts          # NEW — GoalRefiner class
src/goal/refiner-prompts.ts       # NEW — leaf test prompt builder
src/types/goal-refiner.ts         # NEW — RefineConfig, LeafTestResult, RefineResult schemas
```

**GoalRefiner** composes:
- `GoalNegotiator` — reuses `evaluateQualitatively()` and `runCapabilityCheckStep()` for feasibility validation on leaf dimensions
- `GoalTreeManager` — reuses `_decomposeGoalInternal()` logic for sub-goal generation when the leaf test fails
- `ObservationEngine` — queries available data sources for the leaf test prompt

GoalNegotiator and GoalTreeManager remain independently callable. GoalRefiner is the recommended entry point for new code.

```typescript
class GoalRefiner {
  constructor(
    private readonly stateManager: StateManager,
    private readonly llmClient: ILLMClient,
    private readonly observationEngine: ObservationEngine,
    private readonly negotiator: GoalNegotiator,
    private readonly treeManager: GoalTreeManager,
    private readonly ethicsGate: EthicsGate,
  ) {}

  async refine(goalId: string, config?: Partial<RefineConfig>): Promise<RefineResult>;

  // Runtime re-refinement (called when observation fails on a leaf)
  async reRefineLeaf(goalId: string, failureContext: string): Promise<RefineResult>;
}
```

### 3.5 Integration Points

| Caller | Current | After |
|--------|---------|-------|
| `goal add "desc"` CLI | `--negotiate` flag → `negotiate()`, `--tree` flag → `decomposeGoal()` | Single `refine()` call. `--no-refine` to skip. |
| `run --tree` (CoreLoop) | Auto-calls `decomposeGoal()` if no children | Calls `refine()` if goal has no validated leaves |
| `renegotiate()` | Standalone 6-step flow | Unchanged (renegotiation is for existing goals with prior observations) |
| Stall detection | Triggers `renegotiate()` | Triggers `reRefineLeaf()` for observation-failure stalls, `renegotiate()` for progress stalls |

---

## 4. Migration Plan

Each step is independently testable and deployable. No breaking changes until step 4.

1. **Add types** — `src/types/goal-refiner.ts` with `RefineConfig`, `LeafTestResult`, `RefineResult` Zod schemas. No behavior change.

2. **Add leaf test** — `src/goal/refiner-prompts.ts` with `buildLeafTestPrompt()`. Unit-testable with mock LLM. No integration yet.

3. **Add GoalRefiner** — `src/goal/goal-refiner.ts` implementing `refine()`. Calls GoalNegotiator and GoalTreeManager internally. Integration tests against mock LLM. Old paths still work.

4. **Wire CLI** — `goal add` calls `refine()` by default. `--negotiate` and `--tree` flags become aliases / deprecated. `--no-refine` skips refinement entirely.

5. **Wire CoreLoop** — `tree-loop-runner` calls `refine()` instead of raw `decomposeGoal()`. Add `reRefineLeaf()` path to stall handler.

6. **Deprecation** — Mark standalone `negotiate()` for new goals and standalone `decomposeGoal()` as internal. Keep them callable for backward compat and renegotiation.

---

## 5. Constraints

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Default max depth | 3 | OKR-Agent finding: 3 levels sufficient for most objectives |
| Token budget | 50,000 per refine tree | ~10 LLM calls at 5k tokens each; prevents runaway decomposition |
| Leaf test cost | 1 LLM call, ~1,000 tokens | Must be cheap — called at every node |
| Feasibility check | 1 call per dimension | Reuses existing qualitative evaluation |
| Backward compat | Goals with existing dimensions skip refinement | `user_override = true` or `origin = "manual"` bypasses |
| Existing negotiate/decompose | Remain callable standalone | GoalRefiner wraps them; no removal |
