# M15 Phase 2 実装調査

> 調査日: 2026-03-19
> 対象: マルチエージェント委譲 Phase 2 (タスク分解 + 並列実行 + Plan Gate + 戦略フィードバック)
> 前回調査: `memory/research-m15-phase1.md`
> 設計ドキュメント: `docs/design/multi-agent-delegation.md` §5 Phase 2

---

## Phase 1 実装状況（確認済み）

Phase 1 は完全実装済み。以下のファイルが存在する:

| ファイル | 行数 | 状態 |
|---------|-----|------|
| `src/types/pipeline.ts` | 83行 | **完了** |
| `src/execution/pipeline-executor.ts` | 246行 | **完了** |
| `src/execution/task-pipeline-cycle.ts` | 167行 | **完了 (新規)** |
| `src/types/index.ts` | 29行 | `pipeline.ts` 含む **完了** |

`task-pipeline-cycle.ts` は Phase 1 で新規作成された — `runPipelineTaskCycle()` がここに独立した関数として実装されており、`task-lifecycle.ts` 内にもメソッドとして重複実装されている（後述）。

---

## 1. src/execution/task-generation.ts — 129行

### 主要エクスポート

```typescript
export interface TaskGenerationDeps { stateManager, llmClient, strategyManager, logger? }
export const LLMGeneratedTaskSchema   // Zodスキーマ（LLM応答検証用）
export async function generateTask(deps, goalId, targetDimension, strategyId?, knowledgeContext?, adapterType?, existingTasks?, workspaceContext?): Promise<Task>
```

### 現状の挙動

- LLM を呼び出し、単一の `Task` を生成する
- 複雑度評価なし。LLM が「単一タスク vs TaskGroup を判断する」ロジックは未実装
- `LLMGeneratedTaskSchema` は `work_description, rationale, approach, success_criteria, scope_boundary, constraints, reversibility, estimated_duration` のみ（`pipeline` フィールドなし）

### Phase 2 変更点

**変更箇所**: `generateTask()` 関数の拡張 OR 新関数 `generateTaskOrGroup()` の追加

1. **LLM プロンプト拡張** (`task-prompt-builder.ts` の `buildTaskGenerationPrompt()` も変更必要):
   - タスク複雑度評価を促す指示を追加
   - LLM が `{ type: "task", task: {...} }` または `{ type: "task_group", subtasks: [...], dependencies: [...] }` を返す2モード出力形式に変更

2. **`generateTaskOrGroup()` 新関数** (推奨):
   - `generateTask()` は後方互換のため変更しない
   - 新しい `generateTaskOrGroup()` を追加し、戻り値を `Task | TaskGroup` にする
   - `task-pipeline-cycle.ts` から呼ぶ

3. **`LLMGeneratedTaskGroupSchema`** の新規追加が必要:
   ```typescript
   export const LLMGeneratedTaskGroupSchema = z.object({
     subtasks: z.array(LLMGeneratedTaskSchema).min(2),
     dependencies: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
     file_ownership: z.record(z.string(), z.array(z.string())).default({}),
     shared_context: z.string().optional(),
   });
   ```

**注意点**:
- `task-prompt-builder.ts` にも変更が必要（スコープ確認要）
- `generateTask()` は `task-lifecycle.ts#TaskLifecycle.generateTask()` からも呼ばれる — 既存シグネチャ変更NG
- 500行制限: 現在 129行。TaskGroup 生成追加で ~60行増で OK

---

## 2. src/execution/pipeline-executor.ts — 246行

### 現状の実装（Phase 1 MVP）

```typescript
export class PipelineExecutor {
  async run(taskId, task, pipeline, observationContext?): Promise<PipelineRunResult>
}
```

**Phase 1 実装済み機能**:
- 逐次ステージ実行（for ループ）
- PipelineState 永続化 (`pipelines/<taskId>.json`)
- 冪等性チェック (`idempotency_key = ${taskId}:${i}:0`)
- `fail_fast` サポート
- アダプタ選択 (`preferred_adapter` → fallback to first)
- ロール別プロンプト組み立て (`implementor/researcher` vs `verifier` vs `reviewer`)

**Phase 1 で未実装の機能** (Phase 2 対象):
1. Plan Approval Gate — `implementor` ステージの plan/execute 2サブフェーズなし
2. 3段階エスカレーション — 失敗時は `fail_fast` で即終了するだけ
3. `strategy_id` フィードバック — `PortfolioManager.recordTaskCompletion()` 呼び出しなし
4. `strike_count` トラッキング — なし

### Phase 2 変更点

**変更箇所**: `PipelineExecutor.run()` のステージループ内

#### 2-1. Plan Approval Gate

`implementor` ステージで plan/execute の2フェーズ実行:

```
// run() 内の for ループ内、stage.role === "implementor" の場合
if (stage.role === "implementor" && isPlanApprovalEnabled) {
  // Phase A: plan のみ生成（reading-only プロンプト）
  const planTask = buildPlanOnlyPrompt(stage, task);
  const planResult = await adapter.execute(planTask);
  // approval 判断: trust_score >= 20 → auto-approve; else → approvalFn
  const approved = await this.evaluatePlan(planResult, deps.trustScore, deps.approvalFn);
  if (!approved) { /* abort + stageResult: fail */ break; }
  // Phase B: 承認済み計画を元に execute
}
```

**依存追加**: `PipelineExecutorDeps` に `approvalFn?: (plan: string) => Promise<boolean>` と `trustScore?: number` を追加

#### 2-2. 3段階エスカレーション

現在の `fail_fast` break を 3段エスカレーションに置き換え:

```
strike 1: プロンプト調整リトライ（同アダプタ）
strike 2: 代替アダプタでリトライ（CapabilityRegistry から探索）
strike 3: approvalFn 経由で人間エスカレーション
```

実装方針:
- `strikeCount: Map<number, number>` をステージ別に管理 (stageIndex → strikes)
- `idempotency_key` を `${taskId}:${stageIndex}:${attempt}` で attempt をインクリメント
- Phase 2 では attempt は `0, 1, 2` の最大3回

**依存追加**: `PipelineExecutorDeps` に `adapterRegistry` 既存あり（代替アダプタ選択で使用可能）

#### 2-3. strategy_id フィードバック

`run()` 完了後に `PortfolioManager.recordTaskCompletion()` を呼ぶ:

```typescript
// run() の末尾
if (pipeline.strategy_id && this.portfolioManager) {
  this.portfolioManager.recordTaskCompletion(pipeline.strategy_id);
}
```

**依存追加**: `PipelineExecutorDeps` に `portfolioManager?: PortfolioManager` を追加

**注意点**:
- 500行制限: 現在 246行。3段エスカレーション追加で ~80行増 → 326行。OK
- `PipelineRunResult` に `escalated: boolean` フィールド追加が必要かも（呼び出し元が判定できるように）

---

## 3. src/core-loop.ts — 453行

### 現状の runOneIteration() フロー

`core-loop.ts` は薄いオーケストレーター。実際のフロー処理は以下のファイルに分割済み:
- `src/loop/core-loop-phases.ts` — Phase 1-4（load, observe, gap, score）
- `src/loop/core-loop-phases-b.ts` — Phase 5-7（completion, stall, task cycle）

`runOneIteration()` のステップ 7 (task cycle) は `runTaskCycleWithContext()` (`core-loop-phases-b.ts` L402) に委譲される。

### `runTaskCycleWithContext()` の現状 (core-loop-phases-b.ts L402~)

```typescript
// L479: 現在は常に runTaskCycle() を呼ぶ
const taskResult = await ctx.deps.taskLifecycle.runTaskCycle(
  goalId, gapVector, driveContext, adapter, knowledgeContext, existingTasks, workspaceContext
);
```

### Phase 2 変更点（TaskGroup 検出）

**変更箇所**: `src/loop/core-loop-phases-b.ts` の `runTaskCycleWithContext()` 内

設計書の「`core-loop.ts` — `runOneIteration()` が TaskGroup を検出し `ParallelExecutor` に渡す」は実際には `core-loop-phases-b.ts` の `runTaskCycleWithContext()` への変更となる。

変更パターン:
```typescript
// L479 付近を置き換え
const generationResult = await ctx.deps.taskLifecycle.generateTaskOrGroup(
  goalId, targetDimension, strategyId, knowledgeContext, adapter.adapterType, existingTasks, workspaceContext
);

let taskResult: TaskCycleResult;
if (isTaskGroup(generationResult)) {
  // ParallelExecutor に委譲
  taskResult = await ctx.deps.parallelExecutor.run(
    goalId, generationResult, gapVector, driveContext, adapter, { knowledgeContext, workspaceContext }
  );
} else {
  // 従来通り runTaskCycle()
  taskResult = await ctx.deps.taskLifecycle.runTaskCycle(
    goalId, gapVector, driveContext, adapter, knowledgeContext, existingTasks, workspaceContext
  );
}
```

**依存追加**: `CoreLoopDeps` (`core-loop-types.ts`) に `parallelExecutor?: ParallelExecutor` を追加

**注意点**:
- `core-loop.ts` 自体は変更不要（`runOneIteration()` は `runTaskCycleWithContext()` に委譲するだけ）
- 実際の変更先は `src/loop/core-loop-phases-b.ts`
- `TaskLifecycle` に `generateTaskOrGroup()` メソッドを追加するか、`generateTask()` の戻り値を変えるかの設計判断が必要
- `CoreLoopDeps` 型は `core-loop-types.ts` にある（要確認）

---

## 4. src/types/pipeline.ts — 83行（変更なし）

### 現状の主要エクスポート

```typescript
TaskDomainSchema / TaskDomain         // "code"|"data"|"api_action"|"research"|"communication"|"monitoring"
TaskRoleSchema / TaskRole             // "implementor"|"reviewer"|"verifier"|"researcher"
PipelineStageSchema / PipelineStage   // { role, capability_requirement?, prompt_override? }
TaskPipelineSchema / TaskPipeline     // { stages, fail_fast, shared_context?, strategy_id? }
StageResultSchema / StageResult       // { stage_index, role, verdict, output, confidence, idempotency_key }
PipelineStateSchema / PipelineState   // { pipeline_id, task_id, current_stage_index, completed_stages, status, started_at, updated_at }
ImpactAnalysisSchema / ImpactAnalysis // { verdict, side_effects, confidence }
```

**Phase 2 での変更**: Phase 2 では `pipeline.ts` 自体への変更は不要。
- `ImpactAnalysis` は Phase 3 で使用する（Phase 2 ではまだ未使用だが定義済み）

---

## 5. src/types/index.ts — 29行

### 現状

`pipeline.ts` は既に行 28 でエクスポート済み (`export * from "./pipeline.js";`)

**Phase 2 での変更**:
- `task-group.ts` を新規作成後、行 29 付近に `export * from "./task-group.js";` を追加
- それ以外の変更なし

---

## 6. src/portfolio-manager.ts — 552行

### recordTaskCompletion() API

```typescript
/**
 * Record a task completion timestamp for a strategy.
 * Called externally when a task finishes execution.
 */
recordTaskCompletion(strategyId: string): void {
  this.lastTaskCompletionByStrategy.set(strategyId, Date.now());
}
```

**重要事項**: `recordTaskCompletion()` は `strategyId: string` のみを受け取る。verdict や stage_results は受け取らない。
設計書 §4「戦略フィードバック」の「パイプラインの verdict と各ステージ結果を渡す」は現在の API と不一致 — 実際には `recordTaskCompletion(strategyId)` を呼ぶだけでよい（`calculateEffectiveness()` がギャップ差分を自動計算するため）。

**既存の `recordTaskCompletion()` 呼び出し箇所** (`core-loop-phases-b.ts` L506):
```typescript
if (ctx.deps.portfolioManager && taskResult.action === "completed" && taskResult.task.strategy_id) {
  ctx.deps.portfolioManager.recordTaskCompletion(taskResult.task.strategy_id);
}
```

`PipelineExecutor` からも同様に呼べばよい。`pipeline.strategy_id` が設定されていれば `portfolioManager.recordTaskCompletion(pipeline.strategy_id)` を呼ぶ。

**gotcha**: `PortfolioManager` は `src/portfolio-manager.ts`（`src/strategy/` ではない）にある。

---

## 7. src/execution/task-approval.ts — 207行

### 主要エクスポート

```typescript
export interface PreExecutionCheckDeps { ethicsGate?, capabilityDetector?, approvalFn, checkIrreversibleApproval }
export async function runEthicsCheck(ethicsGate, approvalFn, task): Promise<TaskCycleResult | null>
export async function runCapabilityCheck(capabilityDetector, task): Promise<TaskCycleResult | null>
export async function runIrreversibleApprovalCheck(checkIrreversibleApproval, task): Promise<TaskCycleResult | null>
export async function runPreExecutionChecks(deps, task): Promise<TaskCycleResult | null>
```

### Plan Approval Gate との関係

`task-approval.ts` の `runEthicsCheck()` は `flag` verdict の場合 `approvalFn(task)` を呼ぶ。Plan Approval Gate の「EthicsGate 経由で人間承認」は同じ `approvalFn` パターンを再利用できる。

**Phase 2 での変更**: `task-approval.ts` 自体への変更は不要。
- Plan Approval Gate は `pipeline-executor.ts` に直接実装（plan テキストを `approvalFn` に渡す形）
- ただし、現在の `approvalFn` のシグネチャが `(task: Task) => Promise<boolean>` なので、plan テキスト用に別コールバック `planApprovalFn?: (plan: string) => Promise<boolean>` が必要

---

## 8. src/execution/task-lifecycle.ts — 597行

### Phase 1 で追加された runPipelineTaskCycle()

`task-lifecycle.ts` (L402-519) に `runPipelineTaskCycle()` が実装済み。
ただし `src/execution/task-pipeline-cycle.ts` (167行) にも同一ロジックの関数 `runPipelineTaskCycle()` が独立実装されている。

**重複の状況**:
- `task-lifecycle.ts#TaskLifecycle.runPipelineTaskCycle()` (メソッド、L402)
- `task-pipeline-cycle.ts#runPipelineTaskCycle()` (スタンドアロン関数)

どちらが正典かは Phase 2 実装前に統一する必要あり（設計書では `task-lifecycle.ts` に追加する方針だったが、Phase 3 分割設計として `task-pipeline-cycle.ts` が作られた可能性）。

### Phase 2 での generateTaskOrGroup() 追加案

`TaskLifecycle` に以下を追加:
```typescript
async generateTaskOrGroup(
  goalId, targetDimension, strategyId?, knowledgeContext?, adapterType?, existingTasks?, workspaceContext?
): Promise<Task | TaskGroup>
```

内部で `task-generation.ts#generateTaskOrGroup()` に委譲。既存 `generateTask()` は変更しない。

**500行注意**: `task-lifecycle.ts` は現在 597行。既に500行超過している。Phase 2 では `generateTaskOrGroup()` の実装は `task-generation.ts` に置き、`task-lifecycle.ts` はラッパーのみにすること。

---

## 9. src/execution/adapter-layer.ts — 102行

### IAdapter インタフェース（再確認）

```typescript
export interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  listExistingTasks?(): Promise<string[]>;
  checkDuplicate?(task: AgentTask): Promise<boolean>;
}
```

### Phase 2 でのエスカレーション用途

3段階エスカレーション Strike 2（代替アダプタ選択）では `AdapterRegistry.listAdapters()` + `getAdapter()` を使う。`capabilities` はオプショナルで現状動的マッチングなし。

**Phase 2 での変更**: 不要。
- `AdapterRegistry.listAdapters()` で全アダプタを取得し、`preferred_adapter` 以外を選ぶだけ
- 動的ケイパビリティマッチングは Phase 3 で追加

---

## Phase 2 実装サマリー

### 新規作成ファイル

| ファイル | 行数目安 | 内容 |
|---------|---------|------|
| `src/types/task-group.ts` | ~40行 | TaskGroup, TaskGroupSchema |
| `src/execution/parallel-executor.ts` | ~150行 | Promise.all + ファイル所有権チェック + TaskCycleResult 合成 |
| `tests/execution/parallel-executor.test.ts` | — | ParallelExecutor ユニットテスト |

### 変更ファイル

| ファイル | 変更内容 | 変更規模 |
|---------|---------|---------|
| `src/types/index.ts` | `task-group.ts` エクスポート追加 | 1行 |
| `src/execution/task-generation.ts` | `generateTaskOrGroup()` + `LLMGeneratedTaskGroupSchema` 追加 | ~60行追加 |
| `src/execution/pipeline-executor.ts` | Plan Gate + 3段エスカレーション + strategy_id フィードバック | ~80行追加 |
| `src/loop/core-loop-phases-b.ts` | `runTaskCycleWithContext()` に TaskGroup 分岐追加 | ~30行追加 |
| `src/loop/core-loop-types.ts` | `CoreLoopDeps` に `parallelExecutor?` 追加 | ~3行追加 |

### 注意事項・Gotcha

1. **`task-lifecycle.ts` + `task-pipeline-cycle.ts` 重複問題**: Phase 1 で `runPipelineTaskCycle()` が2箇所に実装されている。Phase 2 実装前に統一方針を決めること。

2. **設計書の「`core-loop.ts`」は実際には `core-loop-phases-b.ts`**: TaskGroup 検出ロジックの変更先は `src/loop/core-loop-phases-b.ts` の `runTaskCycleWithContext()` 内。

3. **`PortfolioManager` の場所**: `src/strategy/portfolio-manager.ts` ではなく `src/portfolio-manager.ts` にある。

4. **`recordTaskCompletion()` シグネチャ**: 設計書の「verdict と各ステージ結果を渡す」記述は実際のAPIと一致しない。`recordTaskCompletion(strategyId: string)` のみで十分（ギャップ計測は `calculateEffectiveness()` が行う）。

5. **`task-lifecycle.ts` 500行超過**: 既に597行。Phase 2 で追加するロジックは `task-generation.ts` に置き、`task-lifecycle.ts` はラッパーのみにする。

6. **Plan Approval Gate の `approvalFn` シグネチャ不一致**: 既存 `approvalFn: (task: Task) => Promise<boolean>` はタスク承認用。プラン承認には別コールバック `planApprovalFn?: (plan: string) => Promise<boolean>` を `PipelineExecutorDeps` に追加する。

7. **`core-loop-types.ts` に `CoreLoopDeps` がある**: `core-loop.ts` ではなく `src/loop/core-loop-types.ts` を変更すること。

8. **ParallelExecutor のファイル所有権チェック**: `TaskGroup.file_ownership` を使ってサブタスク間のファイル競合を検出する。重複ファイルがある場合、並列実行をシリアルにフォールバックする方針が安全。

### 依存関係グラフ（Phase 2 実装順）

```
1. src/types/task-group.ts          (新規、依存なし)
2. src/types/index.ts               (task-group.ts エクスポート追加)
3. src/execution/task-generation.ts (task-group.ts に依存)
4. src/execution/parallel-executor.ts (task-group.ts, task-lifecycle.ts, pipeline-executor.ts に依存)
5. src/execution/pipeline-executor.ts (portfolio-manager.ts 追加依存)
6. src/loop/core-loop-types.ts      (parallel-executor.ts 追加依存)
7. src/loop/core-loop-phases-b.ts   (core-loop-types.ts に依存)
```

ステップ 1-3 は並列実装可能。4-5 は 1-3 完了後に並列可能。6-7 は 4 完了後。
