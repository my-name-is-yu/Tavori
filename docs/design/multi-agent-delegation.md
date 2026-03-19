# マルチエージェント委譲設計

> Issue #33。Motivaが単一のタスクを複数エージェントに役割分担して委譲する仕組みを定義する。
> 基本方針: **新しいロールを追加しない。既存モジュールがオーケストレーション知見を吸収する。**

---

## 1. コアコンセプト: TaskRole（タスクロール）

**「適切なLLMを選ぶのではなく、適切な役割を与える。」**

ロールとは「プロンプトコンテキスト + 実行設定」の組み合わせだ。同じアダプタ（例: `claude_code_cli`）でも、与えるロールによって振る舞いが変わる。新しいアダプタ型は不要——ロールはアダプタと直交する概念だ。

```typescript
type TaskRole = "implementor" | "reviewer" | "verifier";
```

| ロール | 責務 | コンテキスト共有 |
|--------|------|----------------|
| `implementor` | タスクを実行する（コード変更・アクション） | タスク定義 + スコープ境界 + 事前観測コンテキスト |
| `verifier` | 機械的検証を実行する（テスト・lint） | タスク定義 + 成果物アクセス手段 |
| `reviewer` | 成果物を独立評価する（品質・意味的整合性） | 成功基準 + 成果物のみ（実行コンテキスト**なし**） |

`reviewer` が実行コンテキストを受け取らないのは、既存設計書（`task-lifecycle.md` §5 Layer 2）の意図通りだ。バイアスのない評価を保証する。

---

## 2. スキーマ定義

### TaskPipeline（`src/types/pipeline.ts`）

```typescript
import { z } from "zod";

export const TaskRoleSchema = z.enum(["implementor", "reviewer", "verifier"]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const PipelineStageSchema = z.object({
  role: TaskRoleSchema,
  adapter_type: z.string().optional(), // 省略時はデフォルトアダプタを使用
  prompt_override: z.string().optional(),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const TaskPipelineSchema = z.object({
  stages: z.array(PipelineStageSchema).min(1),
  fail_fast: z.boolean().default(true),
  shared_context: z.string().optional(), // 全ステージ共通の背景情報
});
export type TaskPipeline = z.infer<typeof TaskPipelineSchema>;

export const VerdictSchema = z.enum(["pass", "partial", "fail"]);

export const StageResultSchema = z.object({
  stage_index: z.number(),
  role: TaskRoleSchema,
  verdict: VerdictSchema,
  output: z.string(),
  confidence: z.number().min(0).max(1),
});
export type StageResult = z.infer<typeof StageResultSchema>;

export const ImpactAnalysisSchema = z.object({
  verdict: VerdictSchema,
  side_effects: z.array(z.string()).default([]),
  confidence: z.enum(["confirmed", "likely", "uncertain"]),
});
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;
```

### TaskGroup（`src/types/task-group.ts`）

複雑なタスクをサブタスク群に分解する。LLMが単一タスク vs TaskGroup を判断する。

```typescript
import { z } from "zod";
import { TaskSchema } from "./task.js";

export const TaskGroupSchema = z.object({
  subtasks: z.array(TaskSchema).min(2),
  dependencies: z.array(z.object({
    from: z.string(), // subtask_id
    to: z.string(),   // subtask_id（fromの完了後にtoを実行）
  })).default([]),
  file_ownership: z.record(z.string(), z.array(z.string())).default({}), // subtask_id → files（競合防止）
  shared_context: z.string().optional(), // 全サブタスク共通の背景情報
});
export type TaskGroup = z.infer<typeof TaskGroupSchema>;
```

`file_ownership` は並列実行時のファイル競合を防ぐ。1サブタスク最大5ファイル、1サブタスク最大4編集箇所のルールを LLM プロンプトで指示する。

---

## 3. ObservationEngine: タスクスコープ観測

### `observeForTask(task)` — 事前コンテキスト収集

現在の `ObservationEngine` はゴールレベルの観測のみ。タスク実行品質を上げるため、実行**前**にタスクスコープのコンテキストを収集する機能を追加する（"pre-researcher" パターン）。

```typescript
// src/observation-engine.ts に追加
interface TaskObservationContext {
  target_files: Array<{ path: string; last_modified: string }>;
  related_tests: string[];
  dependent_modules: string[];
  summary: string; // LLMが生成する簡潔な要約
}

async observeForTask(task: AgentTask): Promise<TaskObservationContext>
```

収集内容:
- タスクの `target` から対象ファイルと最終更新時刻
- 関連テストファイル（命名規則から推定）
- 依存モジュール（importグラフから1段）

この結果を `implementor` ステージの入力コンテキストに追加する。`verifier` / `reviewer` には渡さない。

---

## 4. PipelineExecutor: 動的オーケストレーションルール

### タスクサイズ別パイプライン構成

| タスクサイズ | パイプライン | 説明 |
|------------|------------|------|
| Small（1ファイル、軽微変更） | `implementor` のみ | 既存 `runTaskCycle()` と同等 |
| Medium（1ファイル、6行以上） | `implementor → verifier` | 機械的検証を追加 |
| Large（複数ファイル or TaskGroup） | `implementor(並列) → verifier → reviewer` | ファイル所有権 + shared_context + エラーエスカレーション |

LLM がタスク生成時にサイズを判断し、適切なパイプラインを付与する。

### エラーエスカレーション

```
1回目の失敗 → プロンプト調整して同ステージをリトライ（1回のみ）
2回目の失敗 → 人間にエスカレーション（EthicsGate の approval フロー経由）
```

### 不可逆操作ゲート

タスクに `irreversible: true` フラグが立っている場合、実行前に必ず承認を取る（既存 `EthicsGate` の approval フローと統合）。マルチエージェントパイプラインでも例外なし。

### `TaskVerifier`: サイドエフェクト探索と確信度ラベル

`verifier` ステージ後に `ImpactAnalysis` を生成し、意図しない副作用を検出する（"post-researcher" パターン）。

```
verdict: "pass" / "partial" / "fail"
side_effects: ["テストY が破壊された", "型定義Zが変わった"]
confidence: "confirmed" | "likely" | "uncertain"
```

`confidence` ラベルは観測エンジンと同じ基準（`>=0.50` で verified、`<0.50` で self-reported）を使う。

---

## 5. 実装フェーズ

### Phase 1（MVP）: 逐次パイプライン + タスクスコープ観測

**新規ファイル:**
- `src/types/pipeline.ts` — TaskRole, PipelineStage, TaskPipeline, StageResult, ImpactAnalysis スキーマ（~70行）
- `src/execution/pipeline-executor.ts` — 逐次ステージ実行 + エラーエスカレーション（~180行）

**変更ファイル:**
- `src/observation-engine.ts` — `observeForTask()` 追加
- `src/execution/task-lifecycle.ts` — `runPipelineTaskCycle()` を `runTaskCycle()` の隣に追加。既存 `runTaskCycle()` は変更しない

**テスト:** `tests/execution/pipeline-executor.test.ts`

`runPipelineTaskCycle()` の流れ:

```
1. selectTargetDimension()     ← 既存ロジック（変更なし）
2. generateTask()              ← pipeline フィールド付きで生成
3. observeForTask()            ← 新規: 事前コンテキスト収集
4. runPreExecutionChecks()     ← 既存ロジック（変更なし、不可逆ゲート含む）
5. PipelineExecutor.run()      ← 新規: ステージを逐次実行 + エラーエスカレーション
6. handleVerdict()             ← 既存ロジック（変更なし）
```

**後方互換性**: パイプラインはオプトイン。`pipeline` フィールドなしのタスクは既存 `runTaskCycle()` を使い続ける。

### Phase 2: タスク分解 + 並列実行

**新規ファイル:**
- `src/types/task-group.ts` — TaskGroup スキーマ（~30行）
- `src/execution/parallel-executor.ts` — `Promise.all` + ファイル所有権チェック（~150行）

**変更ファイル:**
- `src/execution/task-generation.ts` — LLM がタスク複雑度を評価し、単一タスク vs TaskGroup を決定。shared_context を生成
- `src/core-loop.ts` — `runOneIteration()` が TaskGroup を検出し `ParallelExecutor` に渡す

**テスト:** `tests/execution/parallel-executor.test.ts`

### Phase 3: 自動パイプライン + サイドエフェクト検出 + 矛盾検出

**新規ファイル:**
- `src/execution/result-reconciler.ts` — 並列結果の矛盾検出（~120行）

**変更ファイル:**
- `src/execution/task-verifier.ts` — `ImpactAnalysis` 生成ロジック追加（`side_effects` + `confidence` ラベル）
- `src/execution/task-generation.ts` — タスクサイズ評価でパイプラインを自動構成
- `src/execution/adapter-layer.ts` — `capabilities` フィールドを使ってロール→アダプタマッチング

矛盾検出は既存 `ObservationEngine` と同じパターン（LLM呼び出し）で実装する。

---

## 6. ファイル構成

```
src/types/
  pipeline.ts                    ← 新規 (~70行)
  task-group.ts                  ← 新規 (~30行)

src/execution/
  pipeline-executor.ts           ← 新規 (~180行)
  parallel-executor.ts           ← 新規 (~150行)
  result-reconciler.ts           ← 新規 (~120行)
  task-lifecycle.ts              ← 変更 (runPipelineTaskCycle 追加)
  task-generation.ts             ← 変更 (pipeline生成 + TaskGroup分解)
  task-verifier.ts               ← 変更 (ImpactAnalysis追加, Phase 3)
  adapter-layer.ts               ← 変更 (role→adapter マッチング, Phase 3)

src/
  observation-engine.ts          ← 変更 (observeForTask 追加)

tests/execution/
  pipeline-executor.test.ts      ← 新規
  parallel-executor.test.ts      ← 新規
```

全ファイルが500行制限内に収まる設計。

---

## 7. 主要設計判断

| 判断 | 理由 |
|------|------|
| パイプラインはオプトイン | 既存の `runTaskCycle()` を壊さない。シンプルなタスクはシンプルなまま |
| 新アダプタ型不要 | ロールはプロンプトの差異。`IAdapter` インタフェースを変更しない |
| `reviewer` へ実行コンテキストを渡さない | 既存設計書（task-lifecycle.md §5 Layer 2）の意図を完全に踏襲 |
| `observeForTask` を `implementor` のみに渡す | `verifier`/`reviewer` に事前コンテキストを渡すとバイアスが生じる |
| `file_ownership` でファイル競合防止 | 並列 implementor が同じファイルを編集すると結果が不定になる |
| エラーエスカレーションは2回目で人間へ | 自動リトライは1回のみ。無限ループを防ぎ、人間の監視を保証する |
| 矛盾検出はLLM | ObservationEngine と同じパターン。コードで判断できない意味的矛盾に対応するため |
| TaskGroup はLLMが判断 | タスク複雑度の評価はLLMに委ねる。ルールベースでは漏れが生じる |

---

## 8. 既存設計との接続

本設計は `task-lifecycle.md` §5（3層検証）を完全に踏まえた拡張だ。

- `verifier` ロール → Layer 1（機械的検証）に対応
- `reviewer` ロール → Layer 2（タスクレビュアー）に対応
- 既存の Layer 1/2 の矛盾解消ルール（§5 の表）は `result-reconciler.ts` で実装

パイプラインが成熟した後、Phase 3 で既存 `task-verifier.ts` の L2 を `reviewer` ロール経由に統合する経路を残す。
