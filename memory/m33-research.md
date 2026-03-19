# Issue #33: マルチエージェント委譲 — 調査レポート

> 調査日: 2026-03-19

---

## 1. 現状の TaskLifecycle — シングルエージェント・シーケンシャル

**Confirmed**: 現在は完全に「1タスク = 1アダプタ = 1エージェント = シーケンシャル」である。

### runTaskCycle() の現フロー (`src/execution/task-lifecycle.ts`)

```
1. selectTargetDimension()  ← ドライブスコアで次元を選択（コード、決定論的）
2. generateTask()            ← LLMでタスクを生成（what to do）
3. runPreExecutionChecks()   ← ethics, capability, approval
4. executeTask(task, adapter) ← 単一アダプタで実行
5. verifyTask()              ← 3層検証（別LLM呼び出しだが同一プロセス内）
6. handleVerdict()           ← verdict処理
```

`executeTask()` には **1つの `adapter: IAdapter`** しか渡されない。並列実行・パイプライン・ロール分担の概念は存在しない。

---

## 2. 検証層に「マルチエージェント」の萌芽がある

**Confirmed**: 設計書には「実行セッションとは別のエージェントセッション」という概念が明記されている。

### `docs/design/task-lifecycle.md` §5 の定義

| 層 | 担当 | 現実装との差 |
|----|------|------------|
| L1: 機械的検証 | 別プロセス（検証専用セッション） | **部分実装**: アダプタ経由のシェルコマンド実行あり、だがエージェントセッション起動ではない |
| L2: タスクレビュアー | 独立したLLM、実行コンテキストを渡さない | **実装済み**: `runLLMReview()` が同一LLMClientで別プロンプトとして実行 |
| L3: 実行者の自己申告 | 参考情報のみ | **実装済み** |

設計書の意図: "実行セッションとは完全に別のセッション" を検証に使うこと。現実装のL2は同一プロセス内の別LLM呼び出しで、設計の精神は守られているが、**別エージェントプロセスの起動**ではない。

### 現 `runLLMReview()` の実装 (`src/execution/task-verifier.ts`)
- L2は `llmClient.chat()` で独立した会話コンテキストを使用
- executor の出力（実行コンテキスト）を渡さない設計（設計書通り）
- 同じ `ILLMClient` インスタンスを使用 — 別モデルや別プロバイダは不可

---

## 3. AdapterLayer — マルチアダプタは未サポート

**Confirmed**: `AdapterRegistry` は登録・取得のみ。タスク単位で**1つのアダプタ**しか使わない。

### `src/execution/adapter-layer.ts`
```typescript
interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
}
```
- パイプライン・チェーン・並列実行の仕組みなし
- `capabilities` フィールドはあるが、マルチエージェントルーティングに使われていない

---

## 4. 現存アダプタとその能力

| アダプタ | adapterType | capabilities |
|---------|-------------|-------------|
| ClaudeCodeCLIAdapter | `claude_code_cli` | execute_code, read_files, write_files, run_commands |
| OpenAICodexCLIAdapter | `openai_codex_cli` | execute_code, read_files, write_files, run_commands |
| ClaudeAPIAdapter | `claude_api` | (adapter-layer.test.ts経由のみ) |
| GitHubIssueAdapter | `github_issue` | (issue管理特化) |

全アダプタが同一インタフェース `IAdapter` を実装。能力的には互いに代替可能だが、**ロールの概念がない**（実装者 vs レビュアーの区別なし）。

---

## 5. Task スキーマ — チェーン・依存・並列の概念なし

**Confirmed**: `src/types/task.ts` の `TaskSchema` に以下は存在しない:

- `depends_on: string[]` （タスク間依存）
- `parallel_with: string[]` （並列実行）
- `pipeline_role: "implementor" | "reviewer"` （ロール）
- `parent_task_id` （タスクチェーン）

現在のタスクはフラット、ステートレス、独立型。

---

## 6. CoreLoop — イテレーション単位での実行、並列化なし

**Confirmed**: `src/core-loop.ts` の `runOneIteration()` は1タスクを順次実行する。

```
for loopIndex in 0..maxIterations:
  observe → gap → drive → task → report (sequential)
```

**multiGoalMode** (`runMultiGoalIteration`) は複数ゴールを**交互に**切り替えるだけで、同時並列実行ではない。

---

## 7. PortfolioManager — 戦略選択であり、エージェント委譲ではない

**Confirmed**: `src/portfolio-manager.ts` は戦略の割り当て（allocation）と選択を行うが、エージェント間の委譲パイプラインではない。

- `selectNextStrategyForTask()`: どの**戦略**が次にタスクを生成するかを選ぶ
- 複数エージェントの協調実行ではない

---

## 8. 設計書に「マルチエージェント委譲」の設計なし

**Confirmed**: `docs/design/` の27ファイルに、Boss/worker/reviewerパターンや「実装エージェント + レビューエージェントのパイプライン」を定義した設計書は存在しない。

`docs/design/task-lifecycle.md` §5 の「別セッション検証」が最も近い概念だが、それは検証の独立性の話であり、エージェントロールの話ではない。

---

## 9. ロードマップ上の位置づけ

`docs/roadmap-m8-beyond.md` に M33 や「マルチエージェント委譲」の言及なし。M15以降の「将来」欄にも記載なし。**これは新機能提案**として扱うべき。

---

## 10. 実装上の拡張ポイント（現状から何を変えれば実現できるか）

### Option A: タスク内パイプライン（最小変更）
`runTaskCycle()` を拡張し、単一タスクを複数フェーズで実行:
1. アダプタAで実装フェーズ実行
2. アダプタB（または同アダプタ別ロール）でレビューフェーズ実行
3. 結果を統合してverifyTask()へ

**変更ファイル**: `src/execution/task-lifecycle.ts`, `src/execution/task-executor.ts`

### Option B: PipelineTask スキーマ（中規模）
`Task` スキーマに `pipeline_stages: PipelineStage[]` を追加し、タスクをマルチフェーズに:
```typescript
interface PipelineStage {
  role: "implementor" | "reviewer" | "verifier";
  adapter_type: string;
  prompt_template?: string;
  depends_on_stage?: number;
}
```
**変更ファイル**: `src/types/task.ts`, `src/execution/task-lifecycle.ts`, `src/execution/task-executor.ts`, `src/execution/task-generation.ts`

### Option C: L2検証を別アダプタエージェントで実行（設計書の完全実装）
`runLLMReview()` を `IAdapter.execute()` 経由に変更:
- 実装者と異なるアダプタ（Claude Code vs Codex、または同種の別インスタンス）でレビューを実行
- ロールをアダプタレベルで分離

**変更ファイル**: `src/execution/task-verifier.ts`, `src/execution/adapter-layer.ts`

---

## ギャップ（不明点）

1. **issue #33 の具体的な要件**: GitHubのissue本文を確認していない（WebFetch不可）
2. **どのロールパターンを採用するか**: Boss/worker/reviewer の「クロード流」をそのまま使うのか、Motiva固有の概念に翻訳するのか
3. **コンテキスト共有のルール**: 実装エージェントの出力をレビューエージェントに渡すか（設計書はL2へのコンテキスト非共有を意図している）
4. **並列実行か逐次パイプラインか**: 実装→レビューは逐次が自然だが、複数実装者の並列実行は要件に含まれるか

---

## 要約（ひと言）

現在のMotivaは「1タスク = 1エージェント = 1アダプタ」のシングルエージェントモデル。設計書（task-lifecycle.md §5）には「実行セッションとは別セッションでの検証」が定義済みで、これがマルチエージェント委譲の最も自然な拡張ポイント。最小変更はL2検証を別アダプタエージェントで実行すること（Option C）で、これは既存設計書の意図と完全に一致する。
