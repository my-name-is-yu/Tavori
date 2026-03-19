# M16 実装計画: 長期記憶・知識共有の高度化

## 概要

ゴール横断の知識転移を実用レベルに引き上げ、判断の質を継続的に向上させる。KnowledgeTransfer Phase 2（自動適用）、転移信頼スコア学習、コンテキスト選択の動的バジェット化、セッションまたぎのチェックポイント型ハンドオフの4テーマを段階的に実装する。

## 前提

### 既存実装の状態

- **KnowledgeTransfer** (`src/knowledge/knowledge-transfer.ts`, 654行): Phase 1 実装済み。転移候補検出(`detectCandidates`)、LLMコンテキスト適応(`applyTransfer`)、効果評価(`evaluateTransferEffect`)、CrossGoalKnowledgeBase構築(`buildCrossGoalKnowledgeBase`)が動作する。自動適用は未実装（Phase 1 は全てユーザー提案）
- **TransferCandidate** (`src/types/cross-portfolio.ts`): `candidate_id`, `source_goal_id`, `target_goal_id`, `type`, `source_item_id`, `similarity_score`, `estimated_benefit` の7フィールド。設計書の `state`, `effectiveness_score`, `adapted_content`, `domain_tag_match` 等は未実装
- **TransferEffectivenessRecord** (`src/types/cross-portfolio.ts`): `transfer_id`, `effectiveness`, `delta`, `evaluated_at` の4フィールド。effectiveness は positive/negative/neutral の3値
- **DecisionRecord** (`src/types/knowledge.ts`): M14で実装済み。`goal_type`, `stall_count`, `gap_value`, `strategy_type`, `decision`, `context`, `outcome`, `timestamp` の8フィールド。設計書の `what_worked`, `what_failed`, `suggested_next` は未実装
- **SessionManager** (`src/execution/session-manager.ts`, 584行): `DEFAULT_CONTEXT_BUDGET = 50_000` トークン。`buildContextForType()` で固定的にコンテキストアイテムを構築。セマンティック検索は `searchRelevantKnowledge()` メソッド内で VectorIndex を使用（topK=3 固定）
- **VectorIndex** (`src/knowledge/vector-index.ts`, 152行): cosine similarity ベースの近傍検索。`search(query, topK, threshold)` と `searchByVector(vector, topK, threshold)` を提供
- **EmbeddingClient** (`src/knowledge/embedding-client.ts`, 166行): `IEmbeddingClient` インタフェース + OpenAI/Ollama/Mock 実装
- **LearningPipeline** (`src/knowledge/learning-pipeline.ts`, 692行): クロスゴールパターン抽出・共有を実装済み。`learning-cross-goal.ts` に委譲
- **PipelineExecutor** (`src/execution/pipeline-executor.ts`): M15で実装済み。PipelineState永続化、中断・再開をサポート

### 依存する完了済み機能

- M13: セマンティック知識共有（KnowledgeManager Phase 2、VectorIndex、EmbeddingClient）
- M14: 仮説検証メカニズム（DecisionRecord、PIVOT/REFINE/ESCALATE）
- M15: マルチエージェント委譲（PipelineExecutor、PipelineState永続化）

---

## サブステージ

### M16.1: TransferCandidate スキーマ拡張 + DecisionRecord 構造化

- **目的**: 転移候補と判断記録のデータモデルを Phase 2 仕様に拡張し、後続サブステージの基盤を整える
- **変更ファイル**:
  - `src/types/cross-portfolio.ts` — TransferCandidateSchema 拡張
  - `src/types/knowledge.ts` — DecisionRecordSchema 拡張
- **新規ファイル**: なし
- **主要変更**:
  - TransferCandidateSchema に `state` (pending/proposed/applied/rejected/invalidated)、`domain_tag_match` (boolean)、`adapted_content` (string | null)、`effectiveness_score` (number | null)、`proposed_at`、`applied_at`、`invalidated_at` フィールドを追加（既存フィールドとの後方互換のため `.default()` を使用）
  - DecisionRecordSchema に `what_worked` (string[])、`what_failed` (string[])、`suggested_next` (string[]) フィールドを追加（`.default([])` で後方互換）
  - TransferCandidateSchema に `discovery_tokens` (number, optional) を追加（バジェット配分の根拠用）
- **テスト**:
  - 既存テストが後方互換で通ること（デフォルト値によるパース成功）を確認
  - 新フィールド付きオブジェクトのパース・バリデーションテスト
  - `tests/knowledge-transfer-detect.test.ts` の既存テストがパスすること
- **依存**: なし
- **規模**: Small（型定義のみ、2ファイル）

---

### M16.2: 転移信頼スコア学習（ドメイン類似度 x 過去転移成功率）

- **目的**: 転移候補のスコアリングに過去の転移成功率フィードバックを組み込み、効果のない転移を自動的に抑制する
- **変更ファイル**:
  - `src/knowledge/knowledge-transfer.ts` — `detectCandidates()` のスコアリングロジック改修、転移信頼スコア計算、自動無効化ロジック追加
  - `src/types/cross-portfolio.ts` — TransferTrustScore 型追加（ドメインペア別の成功率記録）
- **新規ファイル**:
  - `src/knowledge/transfer-trust.ts` — 転移信頼スコアの計算・永続化・更新ロジック（knowledge-transfer.ts が 654行あるため分離）
  - `tests/transfer-trust.test.ts` — 転移信頼スコアのユニットテスト
- **主要変更**:
  - `TransferTrustScoreSchema`: `{ domain_pair: string, success_count: number, failure_count: number, neutral_count: number, trust_score: number, last_updated: string }` を定義
  - `transfer_score = similarity_score * original_confidence * trust_score` のスコアリング式を実装（設計書 §4.2）
  - `domain_tags` のマッチングで +0.1 ボーナス（設計書 §4.2）
  - 効果評価後の信頼度更新: positive → +0.1、neutral → 変化なし、negative → -0.15（設計書 §6.2）
  - 3回連続 neutral/negative で自動無効化（設計書 §6.3）、TransferCandidate.state を "invalidated" に更新
  - `evaluateTransferEffect()` の結果を `transfer-trust.ts` にフィードバック
- **テスト**:
  - スコアリング式の計算結果が設計書通りであること
  - ドメインタグマッチ時の +0.1 ボーナス
  - 3回連続失敗で自動無効化されること
  - 信頼度の更新（positive/negative/neutral）が正しいこと
  - 永続化・読み込みの往復テスト
- **依存**: M16.1（拡張された TransferCandidate スキーマ）
- **規模**: Medium（新規ファイル1 + 既存ファイル改修2）

---

### M16.3: KnowledgeTransfer Phase 2 — 自動適用 + リアルタイム検出

- **目的**: 高信頼度パターンの自動適用と、タスク生成直前の動的転移候補スキャンを実装する
- **変更ファイル**:
  - `src/knowledge/knowledge-transfer.ts` — `applyTransfer()` の自動適用パス追加、`detectCandidatesRealtime()` 追加
  - `src/execution/task-lifecycle.ts` — タスク生成前に転移候補をリアルタイムスキャン呼び出し
  - `src/knowledge/knowledge-manager.ts` — DecisionRecord の `what_worked`/`what_failed`/`suggested_next` を recordDecision 時に構造化保存
- **新規ファイル**:
  - `tests/knowledge-transfer-auto-apply.test.ts` — 自動適用のユニットテスト
- **主要変更**:
  - **自動適用条件**: confidence >= 0.85 かつ transfer_trust_score >= 0.7 のパターンはユーザー承認をスキップして自動適用（設計書 Phase 2）
  - **リアルタイム検出**: `detectCandidatesRealtime(goalId)` — タスク生成直前に呼ばれ、アクティブゴールに対する転移候補を動的スキャン。5イテレーション周期の検出に加え、タスク直前検出を追加
  - **TaskLifecycle 統合**: `generateTask()` 内で `detectCandidatesRealtime()` を呼び、候補があれば SessionManager のコンテキストに転移知識を注入
  - **DecisionRecord 構造化**: `recordDecision()` で LLM を呼び、タスク結果から `what_worked`/`what_failed`/`suggested_next` を自動抽出
  - **倫理ゲート通過**: 自動適用でも `EthicsGate.checkGoal()` は必須（設計書 §5.2）
- **テスト**:
  - confidence >= 0.85 で自動適用されること
  - confidence < 0.85 では従来通りユーザー提案になること
  - リアルタイム検出がタスク生成前に動作すること
  - 倫理ゲートで拒否された場合に rejected になること
  - DecisionRecord に what_worked/what_failed/suggested_next が記録されること
- **依存**: M16.2（転移信頼スコア）
- **規模**: Medium-Large（3ファイル改修 + 1テスト新規）

---

### M16.4: コンテキスト選択の動的バジェット化

- **目的**: 固定 topK 取得を Progressive Disclosure 型の動的バジェット選択に変え、コンテキストウィンドウの効率を最大化する
- **変更ファイル**:
  - `src/execution/session-manager.ts` — `buildContextForType()` をバジェットベースに改修、Progressive Disclosure 3段階取得
  - `src/knowledge/knowledge-search.ts` — `searchKnowledge()` / `searchAcrossGoals()` にインデックスのみ返すモード追加
  - `src/knowledge/vector-index.ts` — `searchMetadata()` メソッド追加（ID + スコアのみ返す軽量検索）
- **新規ファイル**:
  - `src/execution/context-budget.ts` — バジェット計算・配分ロジック（session-manager.ts が 584行あるため分離）
  - `tests/context-budget.test.ts` — バジェット計算のユニットテスト
- **主要変更**:
  - **Progressive Disclosure 実装**:
    - Step 1: `searchMetadata()` で全候補の ID + スコアを低コスト取得
    - Step 2: バジェット制約内で上位 N 件を選択（各アイテムの推定トークン数でバジェット消費を計算）
    - Step 3: 選択された候補のみ全文取得
  - **バジェット配分**: コンテキストバジェット(DEFAULT_CONTEXT_BUDGET)を以下に配分:
    - ゴール定義・制約: 20%
    - 直近の観測・ギャップ: 30%
    - 知識・レッスン（セマンティック検索）: 30%
    - 転移知識（M16.3）: 15%
    - メタ情報（戦略・信頼スコア等）: 5%
  - **VectorIndex.searchMetadata()**: ベクトル検索のスコアとIDのみ返す（全文取得しない）
  - **SessionManager のバジェット超過時**: 優先度が低いカテゴリから削減（Progressive Disclosure のおかげで全候補は考慮済み）
- **テスト**:
  - バジェット配分が正しいこと（各カテゴリの割合）
  - Progressive Disclosure で全文取得がバジェット内の候補のみに制限されること
  - バジェット超過時に優先度の低いカテゴリから削減されること
  - searchMetadata() が ID + スコアのみ返すこと
  - 既存の session-manager テストが壊れないこと
- **依存**: M16.3（転移知識のコンテキスト注入）
- **規模**: Medium-Large（3ファイル改修 + 2ファイル新規）

---

### M16.5: セッションまたぎのチェックポイント型ハンドオフ

- **目的**: エージェント A が書き込んだ中間成果をエージェント B が読み込んで続行できるチェックポイント機構を実装する
- **変更ファイル**:
  - `src/execution/session-manager.ts` — `saveCheckpoint()` / `loadCheckpoint()` メソッド追加
  - `src/execution/task-lifecycle.ts` — タスク完了・中断時にチェックポイント自動保存
  - `src/state-manager.ts` — チェックポイントファイルの永続化パス管理（`~/.motiva/checkpoints/<goalId>/`）
- **新規ファイル**:
  - `src/types/checkpoint.ts` — CheckpointSchema 定義
  - `src/execution/checkpoint-manager.ts` — チェックポイントの作成・読み込み・マージ・GCロジック
  - `tests/checkpoint-manager.test.ts` — チェックポイントのユニットテスト
- **主要変更**:
  - **CheckpointSchema**: `{ checkpoint_id, goal_id, task_id, agent_id, session_context_snapshot, intermediate_results, created_at, metadata }` — エージェントが書き出した中間成果物・コンテキストのスナップショット
  - **saveCheckpoint()**: タスク完了/中断時に現在のセッションコンテキスト + 中間結果をチェックポイントとして保存
  - **loadCheckpoint()**: 後続タスク開始時にチェックポイントからコンテキストを復元。セッションコンテキストにマージ
  - **PipelineExecutor 統合**: M15 の PipelineState と連携。パイプラインのステージ間でチェックポイントを自動的に引き継ぎ
  - **GC**: 完了済みゴールのチェックポイントは 7 日後に自動削除
  - **エージェント A → B ハンドオフ**: チェックポイントに `agent_id` を記録し、異なるエージェントが読み込んだ場合にコンテキスト適応（LLM でサマリ変換）
- **テスト**:
  - チェックポイントの保存・読み込みの往復テスト
  - セッションコンテキストへのマージが正しいこと
  - 異なるエージェント間のハンドオフでコンテキスト適応が動作すること
  - GC が 7 日超のチェックポイントを削除すること
  - PipelineExecutor のステージ間でチェックポイントが引き継がれること
- **依存**: M16.4（動的バジェットとの統合 — チェックポイント復元時のバジェット計算）
- **規模**: Large（3ファイル改修 + 3ファイル新規）

---

### M16.6: メタパターン抽出の継続的更新 + 転移効果の可視化

- **目的**: メタパターン抽出をバッチから継続的更新に移行し、転移の効果をレポートに可視化する
- **変更ファイル**:
  - `src/knowledge/knowledge-transfer.ts` — `buildCrossGoalKnowledgeBase()` を増分更新対応に改修
  - `src/knowledge/learning-pipeline.ts` — 学習トリガー時にメタパターンの増分更新を呼び出し
  - `src/reporting-engine.ts` — 転移効果レポートセクション追加（「転移で短縮できた推定時間」等）
- **新規ファイル**:
  - `tests/knowledge-transfer-incremental.test.ts` — 増分更新のテスト
- **主要変更**:
  - **増分メタパターン更新**: `buildCrossGoalKnowledgeBase()` が差分のみ処理（前回集約以降の新規 LearnedPattern のみ対象）。`last_aggregated_at` タイムスタンプで管理
  - **学習トリガー連動**: `LearningPipeline.learn()` 完了時に `KnowledgeTransfer.updateMetaPatternsIncremental()` を呼び出し
  - **転移効果レポート**: ReportingEngine に `transferEffectSummary` セクション追加:
    - 適用された転移の件数と成功率
    - ドメインペア別の転移信頼スコア
    - 推定時間短縮量（gap_reduction_rate の差分から算出）
  - **ナレッジベースの VectorIndex 登録**: 増分更新時に新規メタパターンの埋め込みを VectorIndex に追加
- **テスト**:
  - 増分更新が差分のみ処理すること（全件再処理しないこと）
  - 学習トリガーで自動的にメタパターンが更新されること
  - レポートに転移効果が含まれること
  - 既存の reporting-engine テストが壊れないこと
- **依存**: M16.2（転移信頼スコア）、M16.3（自動適用の結果データ）
- **規模**: Medium（3ファイル改修 + 1テスト新規）

---

### M16.7: 統合テスト + Dogfooding 検証

- **目的**: M16 全体の結合動作を検証し、実ゴールでの知識転移・チェックポイントハンドオフを確認する
- **変更ファイル**:
  - `docs/roadmap.md` — M16 完了ステータス更新
  - `docs/status.md` — M16 完了記録
  - `docs/module-map.md` — 新規モジュール追記
- **新規ファイル**:
  - `tests/m16-integration.test.ts` — M16 統合テスト
- **主要変更**:
  - **統合テスト**: ゴール A で学んだパターンがゴール B の戦略選択に反映される End-to-End フロー
  - **Dogfooding シナリオ**:
    1. 類似ドメインの 2 ゴールを作成
    2. ゴール A を数イテレーション実行（パターン蓄積）
    3. ゴール B 開始時に転移候補が検出・適用されることを確認
    4. チェックポイント保存→別エージェントでの復元を確認
  - **ドキュメント更新**: ロードマップ・ステータス・モジュールマップに M16 完了を反映
- **テスト**:
  - 統合テスト: 転移候補検出 → スコアリング → 自動適用 → 効果評価 → 信頼スコア更新の一連フロー
  - チェックポイント: 保存 → 別セッションでの復元 → コンテキスト復元の一連フロー
  - Progressive Disclosure: インデックス取得 → バジェット内選択 → 全文取得の3段階
- **依存**: M16.1〜M16.6 全て
- **規模**: Medium（ドキュメント3ファイル + テスト1ファイル）

---

## 成功基準

- [ ] ゴール A の成功パターン（confidence >= 0.85）がゴール B のタスク生成時に自動適用される
- [ ] 転移信頼スコアが過去の成功/失敗に基づいて学習され、3回連続失敗で自動無効化される
- [ ] コンテキスト選択が固定 topK ではなくバジェットベースで動的に決定される
- [ ] エージェント A のセッション成果がチェックポイント経由でエージェント B に引き継がれる
- [ ] 転移効果がレポートに可視化される
- [ ] 全既存テスト（3734+）がパスし続ける（後方互換）
- [ ] Dogfooding: 類似ドメイン 2 ゴールで転移が発動し、2 番目のゴールの収束が加速すること

## 注意点

- **knowledge-transfer.ts が既に 654 行**: 新機能追加で 500 行超過確実。M16.2 で `transfer-trust.ts` に分離し、M16 完了時に必要なら追加分割を検討
- **session-manager.ts が既に 584 行**: M16.4 で `context-budget.ts` に分離して 500 行以下を維持
- **後方互換**: TransferCandidateSchema と DecisionRecordSchema の拡張は全て `.default()` / `.optional()` で行い、既存の永続化データが壊れないようにする
- **LLM コスト**: リアルタイム検出（M16.3）とコンテキスト適応（M16.5）は LLM 呼び出しを伴う。不要な呼び出しを避けるため、similarity_score >= 0.7 のフィルタを先に適用する
- **知識転移の信頼度割引**: 転移時は confidence * 0.7 でスタート（learning-pipeline.md §6.2 の既存ルール）
- **設計書との差分**: TransferCandidate の `state` フィールドは設計書にあるが現在の型にない。M16.1 で追加
- **Dogfooding モデル**: gpt-5.3-codex を使用（CLAUDE.md 推奨）
