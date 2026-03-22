# マルチエージェント委譲設計

> Issue #33。Conatusが単一のタスクを複数エージェントに役割分担して委譲する仕組みを定義する。
> 基本方針: **適切なロールを定義し、適切なケイパビリティに委譲する。ロールはドメイン非依存で拡張可能。**

---

## 1. コアコンセプト: TaskRole（タスクロール）

**「適切なエージェントを選ぶのではなく、適切な役割を与え、適切なケイパビリティに委譲する。」**

ロールとは「プロンプトコンテキスト + 実行設定」の組み合わせだ。同じアダプタ（例: `claude_code_cli`）でも、与えるロールによって振る舞いが変わる。新しいアダプタ型は不要——ロールはアダプタと直交する概念だ。

```typescript
type TaskRole = "implementor" | "reviewer" | "verifier" | "researcher";
```

| ロール | 責務 | コンテキスト共有 |
|--------|------|----------------|
| `implementor` | タスクを実行する（コード変更・API呼び出し・アクション） | タスク定義 + スコープ境界 + 事前観測コンテキスト |
| `verifier` | 機械的検証を実行する（テスト・lint・API応答確認） | タスク定義 + 成果物アクセス手段 |
| `reviewer` | 成果物を独立評価する（品質・意味的整合性） | 成功基準 + 成果物のみ（実行コンテキスト**なし**） |
| `researcher` | 事前コンテキスト収集と知識獲得 | タスク定義 + ドメイン知識 + 既存観測結果 |

`reviewer` が実行コンテキストを受け取らないのは、既存設計書（`task-lifecycle.md` §5 Layer 2）の意図通りだ。バイアスのない評価を保証する。`researcher` は `implementor` に先立ち、必要な知識・コンテキストを収集してパイプラインの `shared_context` に注入する。

ロールは拡張可能だ。将来の候補として `deployer`（デプロイ委譲）、`monitor`（継続監視）、`notifier`（通知送信）がある。拡張手順は§9を参照。

---

## 2. スキーマ定義

### TaskDomain（`src/types/pipeline.ts`）

タスクの対象ドメインを表す。`observeForTask()` の収集戦略とパイプラインのケイパビリティマッチングに使用する。

```typescript
import { z } from "zod";

export const TaskDomainSchema = z.enum([
  "code", "data", "api_action", "research", "communication", "monitoring"
]);
export type TaskDomain = z.infer<typeof TaskDomainSchema>;
```

### TaskPipeline（`src/types/pipeline.ts`）

```typescript
export const TaskRoleSchema = z.enum(["implementor", "reviewer", "verifier", "researcher"]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const PipelineStageSchema = z.object({
  role: TaskRoleSchema,
  capability_requirement: z.object({
    domain: TaskDomainSchema,
    preferred_adapter: z.string().optional(), // 強い選好があれば指定
  }).optional(),
  prompt_override: z.string().optional(),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const TaskPipelineSchema = z.object({
  stages: z.array(PipelineStageSchema).min(1),
  fail_fast: z.boolean().default(true),
  shared_context: z.string().optional(),
  strategy_id: z.string().optional(), // このパイプラインが属する戦略ID
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

### TaskGroup（`src/types/task-group.ts`）

複雑なタスクをサブタスク群に分解する。LLMが単一タスク vs TaskGroup を判断する。

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

## 3. ObservationEngine: ドメイン別タスクスコープ観測

### `observeForTask(task, domain)` — 事前コンテキスト収集

`TaskDomain` に応じて収集戦略を切り替える。

```typescript
async observeForTask(task: AgentTask, domain: TaskDomain): Promise<TaskObservationContext>
```

| ドメイン | 収集内容 |
|----------|----------|
| `code` | 対象ファイル・関連テスト・依存モジュール（importグラフ1段） |
| `data` | データソース・スキーマ・前回観測値 |
| `api_action` | エンドポイント仕様・レート制限・認証状態 |
| `research` | 既知の知識（KnowledgeManager）・未解決の問いリスト |
| `monitoring` | 現在のメトリクス値・アラート閾値・直近の変化傾向 |
| `communication` | 受信者コンテキスト・メッセージ履歴 |

コンテキスト共有ルール:
- `implementor` と `researcher` が観測コンテキストを受け取る
- `verifier` / `reviewer` には渡さない（バイアス防止）

---

## 4. PipelineExecutor: 動的オーケストレーションルール

### タスクサイズ別パイプライン構成

| タスクサイズ | パイプライン | 説明 |
|------------|------------|------|
| Small（1ファイル、軽微変更） | `implementor` のみ | 既存 `runTaskCycle()` と同等 |
| Medium（1ファイル、6行以上） | `implementor → verifier` | 機械的検証を追加 |
| Large（複数ファイル or TaskGroup） | `researcher → implementor(並列) → verifier → reviewer` | researcher が事前コンテキスト収集; ファイル所有権 + shared_context |

LLM がタスク生成時にサイズを判断し、適切なパイプラインを付与する。

### Plan Approval Gate（Large タスク向け）

Large タスクの `implementor` ステージは2サブフェーズに分かれる:

1. **plan** — implementor が実行計画を生成（読み取りのみ、変更なし）
2. Conatus が計画を戦略仮説と照合し、承認/却下を判断
3. **execute** — 承認された計画を implementor が実行

自動承認条件: アダプタの `trust_score >= 20`（高信頼境界）の場合、計画承認を自動化できる。それ以外は `EthicsGate` 経由で人間承認を要求する。

### 3段階エスカレーション

```
Strike 1 → プロンプト調整して同ステージをリトライ（同アダプタ）
Strike 2 → CapabilityRegistry から代替アダプタで再試行（利用可能な場合のみ）
Strike 3 → EthicsGate の approval フロー経由で人間にエスカレーション
```

ステージ種別に応じた分岐:
- `verifier` 連続失敗 → 環境問題と分類し、環境確認タスクを先に生成する
- `reviewer` 失敗 → `task-lifecycle.md` §5 の L1/L2 矛盾解消ルールに従う

### 不可逆操作ゲート

タスクに `irreversible: true` フラグが立っている場合、実行前に必ず承認を取る（既存 `EthicsGate` と統合）。マルチエージェントパイプラインでも例外なし。

### パイプライン永続化

`PipelineExecutor` は各ステージ完了後に `PipelineState` を `StateManager` 経由でディスクに書き込む。再起動時に `CoreLoop` が `status: "interrupted"` のパイプラインを検出し、`current_stage_index` から再開する。

冪等性保証: ステージ実行前に `idempotency_key`（`${task_id}:${stage_index}:${attempt}`）が `completed_stages` に存在するかチェックし、存在すればスキップする。

### 戦略フィードバック

パイプライン完了時に `strategy_id` が設定されている場合、`PortfolioManager.recordTaskResult()` を呼び出してパイプラインの verdict と各ステージ結果を渡す。これにより「仮説 → 実行 → 計測 → リバランス」のサイクルが閉じる。

### `TaskVerifier`: サイドエフェクト探索と確信度ラベル

`verifier` ステージ後に `ImpactAnalysis` を生成し、意図しない副作用を検出する。

```
verdict: "pass" / "partial" / "fail"
side_effects: ["テストY が破壊された", "型定義Zが変わった"]
confidence: "confirmed" | "likely" | "uncertain"
```

`confidence` ラベルは観測エンジンと同じ基準（`>=0.50` で verified、`<0.50` で self-reported）を使う。

---

## 5. 実装フェーズ

### Phase 1（MVP）: 逐次パイプライン + ドメイン別観測 + 永続化 + 冪等性

**新規ファイル:**
- `src/types/pipeline.ts` — TaskDomain, TaskRole, PipelineStage, TaskPipeline, StageResult, PipelineState, ImpactAnalysis（~100行）
- `src/execution/pipeline-executor.ts` — 逐次ステージ実行 + エラーエスカレーション + 永続化 + 冪等性チェック（~200行）

**変更ファイル:**
- `src/observation/observation-engine.ts` — `observeForTask()` に `domain: TaskDomain` パラメータ追加、ドメイン別収集戦略
- `src/execution/task-lifecycle.ts` — `runPipelineTaskCycle()` を `runTaskCycle()` の隣に追加。既存 `runTaskCycle()` は変更しない

**テスト:** `tests/execution/pipeline-executor.test.ts`

`runPipelineTaskCycle()` の流れ:

```
1. selectTargetDimension()     <- 既存ロジック（変更なし）
2. generateTask()              <- pipeline フィールド付きで生成
3. observeForTask(task, domain) <- ドメイン別事前コンテキスト収集
4. runPreExecutionChecks()     <- 既存ロジック（変更なし、不可逆ゲート含む）
5. PipelineExecutor.run()      <- ステージを逐次実行 + 永続化 + 冪等性
6. handleVerdict()             <- 既存ロジック（変更なし）
```

**後方互換性**: パイプラインはオプトイン。`pipeline` フィールドなしのタスクは既存 `runTaskCycle()` を使い続ける。

### Phase 2: タスク分解 + 並列実行 + Plan Gate + 戦略フィードバック

**新規ファイル:**
- `src/types/task-group.ts` — TaskGroup スキーマ（~30行）
- `src/execution/parallel-executor.ts` — `Promise.all` + ファイル所有権チェック（~150行）

**変更ファイル:**
- `src/execution/task-generation.ts` — TaskGroup + plan 生成。LLM がタスク複雑度を評価し、単一タスク vs TaskGroup を決定
- `src/core-loop.ts` — `runOneIteration()` が TaskGroup を検出し `ParallelExecutor` に渡す
- `src/execution/pipeline-executor.ts` — Plan Approval Gate + 3段階エスカレーション + `strategy_id` フィードバック

**テスト:** `tests/execution/parallel-executor.test.ts`

### Phase 3: 自動パイプライン + サイドエフェクト検出 + 矛盾検出 + 耐障害性

**新規ファイル:**
- `src/execution/result-reconciler.ts` — 並列結果の矛盾検出（~120行）

**変更ファイル:**
- `src/execution/task-verifier.ts` — `ImpactAnalysis` 生成 + 忖度防止（別モデルインスタンス使用）
- `src/execution/task-generation.ts` — タスクサイズ評価でパイプラインを自動構成
- `src/execution/adapter-layer.ts` — ケイパビリティマッチング + サーキットブレーカー
- `src/execution/parallel-executor.ts` — 同時実行セマフォ

**テスト:** `tests/execution/result-reconciler.test.ts`

---

## 6. ファイル構成

```
src/types/
  pipeline.ts                    <- 新規 (~100行)
  task-group.ts                  <- 新規 (~30行)

src/execution/
  pipeline-executor.ts           <- 新規 (~200行)
  parallel-executor.ts           <- 新規 (~150行)
  result-reconciler.ts           <- 新規 (~120行)
  task-lifecycle.ts              <- 変更 (runPipelineTaskCycle 追加)
  task-generation.ts             <- 変更 (pipeline生成 + TaskGroup分解)
  task-verifier.ts               <- 変更 (ImpactAnalysis + 忖度防止, Phase 3)
  adapter-layer.ts               <- 変更 (capability matching + circuit breaker, Phase 3)

src/observation/
  observation-engine.ts          <- 変更 (ドメイン別 observeForTask)

tests/execution/
  pipeline-executor.test.ts      <- 新規
  parallel-executor.test.ts      <- 新規
  result-reconciler.test.ts      <- 新規
```

全ファイルが500行制限内に収まる設計。

---

## 7. 主要設計判断

| 判断 | 理由 | ビジョン根拠 |
|------|------|-------------|
| パイプラインはオプトイン | 既存の `runTaskCycle()` を壊さない | — |
| 新アダプタ型不要 | ロールはプロンプトの差異。`IAdapter` インタフェースを変更しない | — |
| `reviewer` へ実行コンテキストを渡さない | バイアスのない評価を保証（task-lifecycle.md §5 L2） | — |
| `observeForTask` を `implementor` と `researcher` のみに渡す | `verifier`/`reviewer` に事前コンテキストを渡すとバイアスが生じる | — |
| `file_ownership` でファイル競合防止 | 並列 implementor が同じファイルを編集すると結果が不定になる | — |
| 矛盾検出はLLM | 意味的矛盾はルールベースで判断できない | — |
| TaskGroup はLLMが判断 | タスク複雑度の評価はLLMに委ねる | — |
| PipelineState 永続化 | 再起動・クラッシュをまたぐパイプライン継続 | vision §3「年単位で動き続ける」 |
| TaskDomain 導入 | コード以外のドメイン（データ・API・監視等）に汎用化 | vision §5.7「外部世界の観測」 |
| `capability_requirement` | 静的アダプタ指定でなく動的ケイパビリティマッチング | vision §5.3「Capability Registry」 |
| `strategy_id` フィードバック | パイプライン結果を戦略効果計測に接続 | vision §5.4「Strategy Engine」 |
| Plan Approval Gate | Large タスクの実行前に計画を検証し無駄な実行を防ぐ | vision §5.8「委譲レイヤー」品質制御 |
| 3段階エスカレーション | 2-strike では長期稼働で通知疲れが発生する | vision §3「長期稼働での通知疲れ防止」 |

---

## 8. 既存設計との接続

本設計は `task-lifecycle.md` §5（3層検証）を完全に踏まえた拡張だ。

- `verifier` ロール → Layer 1（機械的検証）に対応
- `reviewer` ロール → Layer 2（タスクレビュアー）に対応
- 既存の Layer 1/2 の矛盾解消ルール（§5 の表）は `result-reconciler.ts` で実装

パイプラインが成熟した後、Phase 3 で既存 `task-verifier.ts` の L2 を `reviewer` ロール経由に統合する経路を残す。

**戦略統合**: `strategy_id` フィードバックにより、`portfolio-management.md` の `Strategy` エンティティが持つ `hypothesis` → `effectiveness_score` のサイクルがパイプライン実行結果で閉じる。`PortfolioManager.recordTaskResult()` を介して自動的にリバランスがトリガーされる。

---

## 9. ロール拡張ガイド

新しいロールを追加する手順:

1. **`TaskRoleSchema` に追加** — `src/types/pipeline.ts` の enum に新ロール文字列を追加
2. **コンテキスト共有ルールを定義** — 新ロールが受け取る情報と受け取らない情報を§1のテーブルに追記
3. **ドメイン別観測を追加** — `observeForTask()` で新ロールに必要な収集内容を定義（必要に応じて）
4. **PipelineExecutor のステージディスパッチを更新** — 新ロールのステージ実行ロジックを追加
5. **テストを追加** — `pipeline-executor.test.ts` に新ロールのユニットテスト

将来のロール候補:

| ロール | 責務 | 想定フェーズ |
|--------|------|-------------|
| `deployer` | 適切なシステムへのデプロイ委譲 | M14+ |
| `monitor` | ウェアラブル・DB・API等の継続監視 | M14+ |
| `notifier` | メッセージングシステムへの通知送信 | M14+ |

---

## 10. 耐障害性パターン（Phase 3）

### サーキットブレーカー

`AdapterLayer` にアダプタごとの連続失敗カウントを追加する。

```
closed → 5回連続失敗 → open → cooldown経過 → half_open → 成功 → closed
                                             → 失敗 → open
```

`PipelineExecutor` はアダプタ選択時に `open` 状態のアダプタを除外する。`capability_requirement` に `preferred_adapter` が指定されていても、そのアダプタが `open` なら代替を選択する。

### バックプレッシャー

`parallel-executor.ts` にセマフォを組み込む。デフォルト `concurrency_limit = 3`。`CrossGoalPortfolio` の `allocation` 比率をウェイトとして使い、優先度の高いゴールから先にスロットを確保する。

### 忖度防止（Sycophancy Mitigation）

L2 `reviewer` は `implementor` と異なるモデルインスタンス/プロバイダを使用する。同一モデルが自分の出力を評価すると、確証バイアスにより品質が低下するリスクがある（CONSENSAGENT, ACL 2025）。

### イベントソース拡張（将来パス）

`PipelineState` のスナップショット永続化は、将来的に完全な不変イベントログへ拡張できる。各ステージの開始・完了・失敗をイベントとして記録し、任意の時点からのリプレイを可能にする。Phase 3 の範囲では `PipelineState` スナップショットで十分だが、拡張パスを閉じない設計にする。
