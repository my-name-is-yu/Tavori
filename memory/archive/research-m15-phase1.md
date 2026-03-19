# M15 Phase 1 実装調査

> 調査日: 2026-03-19
> 対象: マルチエージェント委譲 Phase 1 (逐次パイプライン + ドメイン別観測 + 永続化 + 冪等性)
> 設計ドキュメント: `docs/design/multi-agent-delegation.md`

---

## 1. src/types/ — 既存型ファイル一覧 + 新規ファイル確認

31ファイル存在。`pipeline.ts` と `task-group.ts` は**存在しない**（Phase 1 で新規作成が必要）。

確認済みファイル群（module-map.md §src/types/ 参照）:
core, goal, goal-tree, gap, drive, task, strategy, state, session, trust, satisficing, stall, ethics, knowledge, memory-lifecycle, learning, cross-portfolio, capability, data-source, dependency, embedding, character, curiosity, notification, daemon, report, portfolio, negotiation, suggest, plugin, index

**Confirmed**: `pipeline.ts` 未存在、`task-group.ts` 未存在。

---

## 2. src/execution/task-lifecycle.ts — 464行

### runTaskCycle() シグネチャ

```typescript
async runTaskCycle(
  goalId: string,
  gapVector: GapVector,
  driveContext: DriveContext,
  adapter: IAdapter,
  knowledgeContext?: string,
  existingTasks?: string[],
  workspaceContext?: string
): Promise<TaskCycleResult>
```

### アダプタ呼び出し

`executeTask(task, adapter, workspaceContext)` → `task-executor.ts#executeTask` に委譲。シグネチャ:
```typescript
async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult>
```
内部では `_executeTask({ stateManager, sessionManager, logger, execFileSyncFn }, task, adapter, workspaceContext)` を呼ぶ。

### 検証 (task-verifier) 統合

```typescript
async verifyTask(task: Task, executionResult: AgentResult): Promise<VerificationResult>
```
→ `task-verifier.ts#verifyTask(this.verifierDeps(), task, executionResult)` に委譲。

`verifierDeps()` が返すオブジェクト: `{ stateManager, llmClient, sessionManager, trustManager, stallDetector, adapterRegistry, logger, onTaskComplete, durationToMs, completionJudgerConfig }`

### インポート

主要: `state-manager`, `llm-client`, `session-manager`, `trust-manager`, `strategy-manager`, `stall-detector`, `drive-scorer`, `ethics-gate`, `capability-detector`, `task-verifier`, `task-generation`, `task-executor`, `task-approval`, `adapter-layer`

### TaskCycleResult 型

```typescript
export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied" | "capability_acquiring";
  acquisition_task?: CapabilityAcquisitionTask;
}
```

### runTaskCycle() の内部フロー

1. `selectTargetDimension()` — loadGoal でdimensionを取得
2. `generateTask()` — pipeline フィールド付きで生成（adapterType渡す）
3. `runPreExecutionChecks()` — EthicsGate + CapabilityDetector + 不可逆承認
4. `executeTask()` — アダプタ実行
5. `reloadTaskFromDisk()` — ディスクから最新タスク状態取得
6. `verifyTask()` — 3層検証
7. `handleVerdict()` — pass/partial/fail 処理

**Phase 1 統合ポイント**: `runTaskCycle()` の隣に `runPipelineTaskCycle()` を追加する。既存の `runTaskCycle()` は**変更しない**。

---

## 3. src/observation/observation-engine.ts — 483行

### observe() シグネチャ

```typescript
async observe(goalId: string, methods: ObservationMethod[]): Promise<void>
```

- `methods` が空配列 → 全次元を観測
- DataSource → LLM → self_report の優先順で観測
- workspace context は `contextProvider` コールバック経由（DI注入、コンストラクタ引数）

### observeWithLLM() シグネチャ

```typescript
async observeWithLLM(
  goalId: string,
  dimensionName: string,
  goalDescription: string,
  dimensionLabel: string,
  thresholdDescription: string,
  workspaceContext?: string,
  previousScore?: number | null,
  dryRun?: boolean
): Promise<ObservationLogEntry>
```

### observeFromDataSource() シグネチャ

```typescript
async observeFromDataSource(
  goalId: string,
  dimensionName: string,
  sourceId: string
): Promise<ObservationLogEntry>
```

### Phase 1 追加: observeForTask()

設計書 §3 の仕様:
```typescript
async observeForTask(task: AgentTask, domain: TaskDomain): Promise<TaskObservationContext>
```
ドメイン別収集戦略 (code/data/api_action/research/monitoring/communication)。
`implementor` と `researcher` のみ受け取り、`verifier`/`reviewer` には渡さない。

---

## 4. src/execution/adapter-layer.ts — 102行

### IAdapter インタフェース

```typescript
export interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  listExistingTasks?(): Promise<string[]>;
  checkDuplicate?(task: AgentTask): Promise<boolean>;
}
```

### AdapterRegistry

- `register(adapter: IAdapter): void`
- `getAdapter(type: string): IAdapter` — 未登録で throw
- `listAdapters(): string[]`
- `getAdapterCapabilities(): Array<{ adapterType: string; capabilities: string[] }>` — 未定義なら `["general_purpose"]` を返す

### 現在のケイパビリティ検出

`capabilities?: readonly string[]` フィールドが `IAdapter` に存在するが、**任意 (optional)**。動的マッチングは現状未実装（Phase 3 で `capability_requirement` によるマッチング追加予定）。

Phase 1 では変更不要（設計書 §5 Phase 1 には adapter-layer.ts が含まれない）。

---

## 5. src/state-manager.ts — 618行

### 任意 JSON 永続化 API（PipelineState 保存用）

```typescript
async readRaw(relativePath: string): Promise<unknown | null>
async writeRaw(relativePath: string, data: unknown): Promise<void>
```

`writeRaw` は atomic write（.tmp → rename）。`relativePath` は `baseDir` 相対。

PipelineState の保存パスとして `pipelines/<task_id>.json` などが使える。

### その他の既存永続化メソッド

- `saveGoal / loadGoal` — `goals/<id>/goal.json`
- `saveObservationLog / loadObservationLog` — `goals/<id>/observations.json`
- `saveGapHistory / loadGapHistory` — `goals/<id>/gap-history.json`
- `saveGoalTree / loadGoalTree` — `goal-trees/<rootId>.json`
- `atomicWrite / atomicRead` — private、`readRaw/writeRaw` 経由で利用

**Confirmed**: `readRaw` + `writeRaw` でスキーマフリーな PipelineState 永続化が可能。

---

## 6. pipeline/PipelineExecutor/TaskRole/TaskDomain — 既存コード調査

**Confirmed**: 以下はいずれも存在しない（新規実装が必要）:
- `pipeline` in grep results → `learning-pipeline.ts` 関連のみ（マルチエージェント関係なし）
- `PipelineExecutor` — 存在しない
- `TaskRole` — 存在しない
- `TaskDomain` — 存在しない
- `task-group.ts` — 存在しない

M15 Phase 1 の実装は完全なグリーンフィールド。

---

## Phase 1 実装サマリー

### 新規作成ファイル

| ファイル | 行数目安 | 内容 |
|---------|---------|------|
| `src/types/pipeline.ts` | ~100行 | TaskDomain, TaskRole, PipelineStage, TaskPipeline, StageResult, PipelineState, ImpactAnalysis (Zodスキーマ) |
| `src/execution/pipeline-executor.ts` | ~200行 | 逐次ステージ実行 + PipelineState永続化 + 冪等性チェック + エスカレーション |
| `tests/execution/pipeline-executor.test.ts` | — | PipelineExecutor ユニットテスト |

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/observation/observation-engine.ts` (483行) | `observeForTask(task, domain)` 追加 |
| `src/execution/task-lifecycle.ts` (464行) | `runPipelineTaskCycle()` 追加（`runTaskCycle()` 変更なし） |

### 統合ポイント

- **PipelineState 永続化**: `stateManager.writeRaw("pipelines/<task_id>.json", state)` / `readRaw` で読み込み
- **冪等性**: `completed_stages` の `idempotency_key` (`${task_id}:${stage_index}:${attempt}`) でスキップ判定
- **アダプタ選択**: Phase 1 は `pipeline.stages[n].capability_requirement?.preferred_adapter` → `adapterRegistry.getAdapter()` のシンプルルックアップ（動的マッチングは Phase 3）
- **後方互換性**: `pipeline` フィールド未設定のタスクは既存 `runTaskCycle()` を使い続ける

### 注意事項

- `task-lifecycle.ts` は `task-executor.ts`, `task-generation.ts`, `task-approval.ts`, `task-verifier.ts` に分割済み — Phase 3 で設計書に示す分割パターンが既に適用されている
- `StateManager.writeRaw/readRaw` は型検証なし — `pipeline-executor.ts` 側で `PipelineStateSchema.parse()` を必ず適用する
- `adapter-layer.ts` の `capabilities` は現状 optional — Phase 1 では `preferred_adapter` 文字列直接指定で十分
