# PulSeed ロードマップ

## 現在地

Stage 1-14 完了。Milestone 1-7 完了（3282テスト、90テストファイル）。Dogfooding Phase A/B 完了。GitHub Issueアダプタ・FileExistenceDataSourceAdapter・能力自律調達フルサイクル・ホットプラグ・Goal Tree Phase 2・横断ポートフォリオ Phase 2・学習パイプライン Phase 2 実装済み。詳細は `docs/status.md` 参照。

---

## ロードマップ概要

PulSeedは**ユニバーサルタスク発見エンジン**だ — コーディングだけでなく、どんなゴールにも適用できる。Dogfoodingはトラックではなく、各マイルストーンの**検証手段**として組み込まれている。

| Milestone | テーマ | 検証方法 |
|-----------|--------|----------|
| **1** | 観測強化（LLM-powered観測） | READMEゴールで2ループ検証 |
| **2** | 中規模Dogfooding（3テーマ） | 実戦での結合バグ検出 |
| **3** | npm publish & パッケージ化 | PulSeedに「publishできる状態にする」ゴールを与える |
| **4** | 永続ランタイム Phase 2（旧 Stage 10 Phase 2） | PulSeedをデーモンとして自律運用 |
| **5** | 意味的埋め込み Phase 2（旧 Stage 12 Phase 2） | 複数ゴール横断のナレッジ検索検証 |
| **6** | 能力自律調達 Phase 2（旧 Stage 13 Phase 2） | PulSeed自身の新能力調達を委譲 |
| **7** | 再帰的Goal Tree & 横断ポートフォリオ Phase 2（旧 Stage 14 Phase 2） | 大規模ゴールの木分解と並列実行 |

---

## Milestone 1: 観測強化（LLM-powered観測）

**テーマ**: `self_report` に依存しない、実質的な観測基盤を作る。現状の `self_report` はエージェントが自己申告した値をそのまま記録するだけで、複雑なゴール（品質改善など）には使えない。

### C-1: LLM-powered observation実装

**実装内容**:
- `ObservationEngine.observe()` にLLM呼び出しを追加
  - DataSourceで値が取れない次元に対してLLM評価を実行
  - ワークスペースのファイル内容をアダプタ経由で取得 → LLMに渡して0-1スコアを返させる
  - 信頼度: `independent_review` tier (0.50–0.84)
- LLM観測プロンプト例:
  ```
  以下のファイル内容を読み、「{次元ラベル}」を0.0〜1.0で評価してください。
  ゴール: {goal.description}
  閾値（目標値）: {threshold}
  ファイル: {content}
  回答: {"score": 0.0〜1.0, "reason": "..."}
  ```
- 既存DataSource（FileExistence等）で取得可能な次元はDataSource優先

**成功基準**:
- [x] `observe()` がLLM観測を実行し `independent_review` 信頼度でスコアを返す
- [x] DataSource未設定の次元でもLLM観測でギャップ計算が進む

### C-2: 観測プロンプト改善

**実装内容**:
- 次元ごとにプロンプトを最適化（ゴールの `description` + 次元の `label` + `threshold` を含める）
- DataSource観測とLLM観測の結果をマージするロジック
  - DataSourceが取得できた場合 → DataSource優先（信頼度: `mechanical`）
  - 取得できない場合 → LLM観測にフォールバック（信頼度: `independent_review`）
- 次元名の不一致検出: DataSourceの次元名とゴール次元名が一致しない場合に警告ログ出力

**成功基準**:
- [x] 次元ごとに適切な信頼度でスコアが返る
- [x] 不一致次元名に対して警告が出る

### C-3: 観測精度テスト

**実装内容**:
- モック環境でLLM観測が正しいスコアを返すか確認するテスト
- `FileExistenceDataSource` + LLM観測の併用テスト
- 観測結果がギャップ計算→タスク生成の正しいインプットになるかE2E確認

**成功基準**:
- [x] LLM観測テストがvitestで通過
- [x] FileExistence + LLM観測の併用でループ1周が完走する

**Milestone 1 Dogfooding検証**: ゴール「PulSeedのREADME品質を改善する」を再実行し、LLM観測が `independent_review` 信頼度で正しくスコアを返すことを2ループで確認する。

---

## Milestone 2: 中規模Dogfooding検証

**Status**: 完了 ✅

**前提**: Milestone 1（LLM-powered観測）の完了。

**テーマ**: 観測基盤が整った状態で、より複雑なゴールを試す。タスク品質・dedup・satisficingの実戦検証。

### D-1: README品質ゴール

- **次元**: `readme_quality`（LLMがREADME.mdを評価）、`installation_guide_present`、`usage_example_present`
- **観測方法**: LLM観測（独立レビュー）
- **検証ポイント**: LLM観測の精度、タスク生成品質
- **成功基準**: [x] 2ループ以内に収束

### D-2: E2Eループテスト自動化ゴール

- **次元**: `e2e_test_file_exists`（FileExistenceDataSource）、`e2e_test_passing`（LLM観測）、`approval_loop_fixed`
- **観測方法**: FileExistenceDataSource + LLM観測の併用
- **検証ポイント**: DataSource + LLM観測の組み合わせ、ループ収束
- **成功基準**: [x] DataSource + LLM観測の併用で1ループ完走

### D-3: npm publish準備ゴール

- **次元**: `package_json_valid`（LLM観測: bin/main/exports設定）、`build_succeeds`（FileExistence: dist/ファイル存在）、`version_set`
- **観測方法**: LLM観測 + FileExistenceDataSource
- **検証ポイント**: 重複タスク防止（dedup）、satisficing判定
- **成功基準**: [x] satisficing判定が正しく動作しループが過剰に続かない

---

## Milestone 3: npm publish & パッケージ化

**テーマ**: PulSeedを外部から使えるnpmパッケージとして整備する。PulSeed自身に「npm publishできる状態にする」ゴールを与え、自分で自分を整備させる。

**実装内容**:
- `package.json` の `bin`/`main`/`exports`/`types` フィールド整備
- `npm run build` → `dist/` 出力の確認、TypeScript宣言ファイル生成
- `README.md` のインストール手順・使用例の充実
- バージョン戦略（semver）の確立
- GitHub Actions: `npm publish` の自動化（タグトリガー）

**Dogfooding検証**: Milestone 2のD-3「npm publish準備ゴール」の完了をそのまま検証とする。PulSeedが自律的に `package.json` 不足を検出し、issueを起票し、解決まで追跡できれば合格。

---

## Milestone 4: 永続ランタイム Phase 2

**ビジョン対応**: 1. Goal-and-forget / 2. 年単位の永続動作 / 3. プッシュ型の自己報告

Stage 10でデーモンモード・イベント駆動・プッシュ報告のMVPは実装済み。Phase 2ではそれらを実用レベルに強化する。

### 4.1 デーモンモード強化

設計: `docs/runtime.md` Phase 2b

- グレースフルシャットダウンとクラッシュリカバリの実装完成
- 状態復元: プロセス再起動後に中断地点から再開
- ログローテーション（サイズ/日付ベース）
- `pulseed cron` コマンドでcrontabエントリーを出力（デーモン不要ユーザー向け）

### 4.2 イベント駆動システム強化

設計: `docs/design/drive-system.md` Phase 2

- ファイルウォッチャー（`~/.pulseed/events/` リアルタイム監視）
- ローカルHTTPエンドポイント（`127.0.0.1:41700`、webhook受信）強化
- 外部イベントからの駆動トリガー（即時評価）

### 4.3 プッシュ報告強化

設計: `docs/design/reporting.md` Phase 2

- Slack Webhook（コンパクト形式）
- メール（SMTP、HTML形式）
- Do Not Disturb機能（時間帯ベースの通知抑制、緊急アラート・承認要求は例外）
- Slackボタンによるインタラクティブ承認応答
- ゴール別レポーティング設定オーバーライド（頻度・詳細度）

### 4.4 記憶ライフサイクル MVP（10.5）

設計: `docs/design/memory-lifecycle.md` Phase 1

- 3層記憶モデル（Working / Short-term / Long-term）基盤実装
- Short-term: 設定可能な保持期間管理（ループ数/時間ベース）
- Short→Long 圧縮: LLMによる要約生成（パターン抽出、教訓の蒸留）
- 要約品質保証: 失敗パターン保持確認、矛盾検知
- ガベージコレクション: サイズ制限（Short-term: ゴールあたり10MB、Long-term: 全体100MB）

**Dogfooding検証**: PulSeedをデーモンとして24時間動かし、プッシュ通知が正しいタイミングで届くこと、ループ再起動後に状態が復元されることを確認する。

---

## Milestone 5: 意味的埋め込み Phase 2

**ビジョン対応**: 5. 自律的知識獲得（高度化）

Stage 12で埋め込み基盤（EmbeddingClient, VectorIndex, KnowledgeGraph, GoalDependencyGraph）は実装済み。Phase 2ではこれらを実用的な機能として活かす。

### 5.1 知識獲得 Phase 2 完成（12.2 残り）

設計: `docs/design/knowledge-acquisition.md` Phase 2

- ゴール横断共有ナレッジベース（ゴール別JSONからの移行）
- 意味的埋め込みによるベクトル検索（異なるゴール間での暗黙的知識共有）
- ドメイン安定性に基づく自動再検証スケジュール

### 5.2 記憶ライフサイクル Phase 2（12.7）

設計: `docs/design/memory-lifecycle.md` Phase 2

- Drive-based Memory Management: DriveScorer連携（不満駆動・締切駆動・機会駆動での圧縮優先度制御）
- 意味的検索によるWorking Memory選択（12.1 埋め込み基盤を使ったタグ完全一致 → 埋め込みベースへの移行）
- Long-term教訓のゴール横断検索

### 5.3 セッション・コンテキスト Phase 2（12.6）

設計: `docs/design/session-and-context.md` Phase 2

- バジェットベースの動的コンテキスト選択（MVPの固定top-4から、トークンバジェットに応じた動的選択へ）
- ゴール依存グラフの活用（resource_conflict時の排他制御）

**Dogfooding検証**: 複数の異なるゴールを同時に与え、一方のゴールで学んだ知識が別ゴールの観測・タスク生成に活用されることを確認する。

---

## Milestone 6: 能力自律調達 Phase 2

**Status**: 完了 ✅

**ビジョン対応**: 6. 現実世界との接続 / 7. 自律的ツール調達

Stage 13でCapabilityDetector拡張・DataSourceAdapterは実装済み。Phase 2ではフルサイクル（能力不足検出→調達→検証→登録）を完成させた。

### 6.1 能力自律調達フルサイクル（M6.1a + M6.1b）

- CoreLoopに `capability_acquiring` ハンドラ追加 — 検出→委譲→検証→登録のフルサイクル
- CLI: `capability list`, `capability remove` サブコマンド追加
- `data_source_setup` タスクタイプ追加（データソース設定委譲用）

### 6.2 Capability Registryの動的管理（M6.2a + M6.2b）

- `DataSourceRegistry.upsert()` 追加 — ObservationEngineへの動的追加/削除
- 能力依存解決: トポロジカルソート + 循環依存検出

**実装結果**: 43テスト追加（3105テスト合計、83テストファイル）。

---

## Milestone 7: 再帰的Goal Tree & 横断ポートフォリオ Phase 2

**Status**: 完了 ✅

**ビジョン対応**: 9. 再帰的Goal Tree + ポートフォリオ

Stage 14でGoalTreeManager・StateAggregator・TreeLoopOrchestrator・CrossGoalPortfolio・LearningPipelineは実装済み。Phase 2では実運用レベルの安定化と高度化を完成させた。

### 7.1 Goal Tree Phase 2

#### 7.1a: Concreteness Scoring & Auto-Stop
- `scoreConcreteness()` — LLMベース4次元評価（具体性スコアリング）
- `decompose()` auto-stop — 具体性閾値到達時に自動停止
- maxDepth強制（デフォルト: 5）
- 21テスト追加（goal-tree-concreteness.test.ts）

#### 7.1b: Quality Metrics & Pruning Stabilization
- `evaluateDecompositionQuality()` — coverage, overlap, actionability, depthEfficiency評価
- `pruneSubgoal()` — 理由トラッキング付き剪定 + `getPruneHistory()`
- `restructure()` — 品質評価付き再構成 + 自動リバート
- 23テスト追加（goal-tree-quality.test.ts）

### 7.2 ゴール横断ポートフォリオ Phase 2

#### 7.2a: Momentum Allocation & Dependency Scheduling
- `calculateMomentum()` — velocity、トレンド検出
- `buildDependencySchedule()` — トポロジカルソート、クリティカルパス
- `allocateResources()` — momentum & dependency_aware戦略
- `rebalanceOnStall()` — スタル検出とリソース再分配
- 17テスト追加（cross-goal-portfolio-phase2.test.ts）

#### 7.2b: Embedding-Based Template Recommendation
- `indexTemplates()` — 全テンプレートをVectorIndexに埋め込み登録
- `recommendByEmbedding()` — 類似度ベース推薦
- `recommendHybrid()` — タグ + 埋め込みスコア統合推薦
- 11テスト追加（strategy-template-embedding.test.ts）

### 7.3 学習パイプライン Phase 2

#### 7.3a: 4-Step Structural Feedback
- `recordStructuralFeedback()` — 全4タイプ対応（observation_accuracy, strategy_selection, scope_sizing, task_generation）
- `aggregateFeedback()` — 平均値・トレンド・最悪領域算出
- `autoTuneParameters()` — フィードバック駆動パラメータ提案
- 16テスト追加（learning-pipeline-phase2.test.ts）

#### 7.3b: Cross-Goal Pattern Sharing
- `extractCrossGoalPatterns()` — 複数ゴールにわたるパターン抽出
- `sharePatternsAcrossGoals()` — パターンを新規ゴールに適用
- `storePattern()` / `retrievePatterns()` — KnowledgeTransferでの永続化
- 13テスト追加（learning-cross-goal.test.ts）

**実装結果**: 163テスト追加（3282テスト合計、90テストファイル）。

**Dogfooding検証** (2026-03-16 完了):
- gpt-5.3-codexで2イテレーション実行
- Goal Tree自動分解成功（親ゴールから子ゴールが正確に生成され、個別実行）
- バグ修正4件: auto-decompose（runTreeIterationで自動呼び出し）、specificity skip（scoreConcreteness部分適用修正）、prompt改善（decompose次元の値明示）、threshold_type sanitize
- 3282テスト全パス確認

---

## Phase E: 大規模ゴール（将来）

Milestone 1-7 の安定化後に着手する探索的テーマ。

- **「PulSeedのコード品質を改善する」** — 全ソースのリファクタリング提案をissue起票、ゴール木として追跡
- **「PulSeedを完成させる」** — ロードマップに沿った残機能実装の自動追跡、学習パイプラインへの蓄積

各段階で学んだことをPulSeed自身のLearningPipelineに蓄積し、次のゴールに知識転移する。

---

## Lessons Learned（Phase A/B Dogfoodingから）

将来のMilestoneで活きる教訓。

1. **DataSource次元名とゴール次元名の不一致がスタックの最大原因**
   - DataSourceが返す次元名（例: `file_exists`）とゴール定義の次元名（例: `readme_completeness`）が一致しないと観測値が使われず、ループが前進しない
   - Milestone 1 C-2で不一致検出の警告ログを追加する

2. **`--yes` フラグがないと承認ループで止まる**
   - インタラクティブな承認プロンプトがある限り、自動実行ができない
   - Dogfoodingでは常に `--yes` を使う。承認が必要な場面では明示的に除外する

3. **ファイルパス設定ミスで観測がずれる → 設定検証の仕組みが必要**
   - Phase Bで `GETTING_STARTED.md` → `docs/getting-started.md` の修正が必要だった
   - DataSource設定時にファイルパスの存在チェックや正規化を行う仕組みを将来整備する

4. **`self_report` 観測は実質何もしない → LLM-powered観測が必須**
   - `self_report` はエージェントが自己申告した値をそのまま記録するだけ
   - 複雑なゴール（品質改善など）ではLLMが独立してワークスペースを評価する必要がある（Milestone 1 C-1）

5. **単純なゴールでも多くのバグが見つかる → Dogfoodingの価値は高い**
   - Phase Bの1ゴールだけで、次元名不一致・ファイルパスミス・`--yes`フラグ不足など複数の問題が露見した
   - 実際のゴールを動かすことでユニットテストでは発見できない結合バグが見つかる

---

## リスクフラグ

| リスク | 該当Milestone | 対応方針 |
|--------|--------------|----------|
| LLM観測の精度とコスト | M1 | 観測1回あたりの推定コストを計測。高コストな次元はキャッシュ優先 |
| DataSource次元名不一致 | M1 | 不一致検出の警告ログ（C-2）が安全弁。将来的に自動マッピング提案 |
| Node.jsデーモン化のプロセス管理 | M4 | pm2等の外部ツール依存を検討。設計フェーズで技術選定 |
| プッシュ通知の信頼性と頻度制御 | M4 | 通知疲れを避ける設計が必要。MVP時はSlack webhookに絞る |
| LLM要約による情報欠落 | M4 | 要約品質の検証が必要。MVPでは比率チェックで代替、Phase 2で完全照合 |
| 埋め込みモデルの技術選定 | M5 | IEmbeddingClient抽象化済み（OpenAI/Ollama/Mock）。選定は実測コストで判断 |
| ベクトル検索のスケーラビリティ | M5 | ローカルファイルベースから開始し、必要に応じて外部DBに移行 |
| 能力自律調達の安全性 | M6 | EthicsGateとの統合を密に。エージェントが作成するツールの検証が不可欠 |
| N層Goal Tree分解の品質 | M7 | 分解の深さ・粒度をLLMに依存する。検証ループと人間レビューの併用 |
| ゴール横断ポートフォリオの複雑性 | M7 | 単一ゴール内の並列化が安定してから着手。段階的なリスク管理 |

---

## 設計ドキュメントとの対応

| 設計ドキュメント | 対応Milestone | フェーズ |
|----------------|--------------|---------|
| `observation.md` | M1 (C-1, C-2) | Phase 2 (LLM観測) |
| `runtime.md` | M4 (4.1) | Phase 2b |
| `drive-system.md` | M4 (4.2) | Phase 2 |
| `reporting.md` | M4 (4.3) | Phase 2 |
| `memory-lifecycle.md` | M4 (4.4 MVP), M5 (5.2 Phase 2) | Phase 1, 2 |
| `knowledge-acquisition.md` | M5 (5.1) | Phase 2 |
| `session-and-context.md` | M5 (5.3) | Phase 2 |
| `execution-boundary.md` | M6 (6.1) | Phase 2 |
| `portfolio-management.md` | M7 (7.2) | Phase 3 |
| `mechanism.md` (学習パイプライン) | M7 (7.3) | Phase 2 |
| `vision.md` (Goal Tree) | M7 (7.1) | -- |
