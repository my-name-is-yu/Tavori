# In-Progress: Milestone 7（再帰的Goal Tree & 横断ポートフォリオ Phase 2）着手前

## 完了済み

### M6 — 能力自律調達 Phase 2
- 6.1a CoreLoop `capability_acquiring` ハンドラ（委譲→検証→登録フルサイクル、3回失敗でescalate）
- 6.1b CLI `motiva capability list/remove` + `data_source_setup` 型追加
- 6.2a DataSourceRegistry.upsert() + ObservationEngine.addDataSource()/removeDataSource()
- 6.2b CapabilityDetector依存関係解決（トポロジカルソート、循環検出、取得順序決定）
- TSエラー修正2件: buildLLMClient引数、AgentTask型フィールド
- 新規テスト43件追加（3062→3105、83ファイル）

### M5 — 意味的埋め込み Phase 2（commit 2af141e）
- 5.1 知識獲得Phase2: 共有ナレッジベース、ベクトル検索、ドメイン安定性自動再検証
- 5.2 記憶ライフサイクルPhase2: Drive-based Memory Management、意味的WM選択、ゴール横断教訓検索
- 5.3 セッション・コンテキストPhase2: バジェットベース動的コンテキスト選択、依存グラフ排他制御

### M5 Dogfooding（commit ef1bbbb）
- E2Eテスト26件: milestone4-daemon(9), milestone5-semantic(17)
- 実ゴール2件完走: CHANGELOG(1iter), CONTRIBUTING(5iter)

### M5 配線修正（commit b9053bc）
- CLIRunnerにMemoryLifecycleManager配線、GoalDependencyGraph配線

### 過去の完了
- M4 — 永続ランタイム Phase 2（commit 5d1f7f4）

## 現在の状態
- 3105テスト全パス（83ファイル）
- ブランチ: main

## 次のステップ: Milestone 7（再帰的Goal Tree & 横断ポートフォリオ Phase 2）
- 7.1: Goal Tree Phase 2（N層自動分解品質向上、動的追加・剪定）
- 7.2: ゴール横断ポートフォリオ Phase 2（リソース配分最適化、優先度動的調整）
- 7.3: 学習パイプライン Phase 2（構造的フィードバック、クロスゴールパターン共有）
- ロードマップ: `docs/roadmap.md` Milestone 7セクション
