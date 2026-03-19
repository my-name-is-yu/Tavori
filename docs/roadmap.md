# ロードマップ

## 現在地

Stage 1-14 + Milestone 1-16 + Phase 3 完了（3741テスト、161テストファイル）。
次: Milestone 17（外部連携プラグイン拡充）。

---

## 次のマイルストーン

### Milestone 14: 仮説検証メカニズム（PIVOT/REFINE + 学習ループ）

**テーマ**: AutoResearchClawの仮説検証パターンをMotivaに導入し、戦略停滞時の自律判断力を強化する。設計: `docs/design/hypothesis-verification.md`

### 14.1: 構造化PIVOT/REFINE判断（StallDetector + StrategyManager統合）
- StallDetectorに `analyzeStallCause()` 追加 — gap推移パターンから原因を推定
  - oscillating（振動）→ REFINE（パラメータ調整して再実行）
  - flat（横ばい）→ PIVOT（戦略変更、ゴールは維持）
  - diverging（悪化）→ ESCALATE（ゴール再交渉）
- StrategyManagerに各戦略のrollback target定義
- CoreLoopのstall分岐を3方向に拡張
- 最大pivot回数: 2
- 影響: stall-detector.ts, strategy-manager.ts, core-loop.ts, types/
- 規模: Medium（2-3日）

### 14.2: 判断履歴の学習ループ（KnowledgeManager拡張）
- DecisionRecordスキーマ — PIVOT/REFINE判断時のコンテキスト（gap値、戦略種別、stall回数、trust）を記録
- KnowledgeManagerにdecision記録・検索API追加
- StrategyManager.selectStrategy()で過去の判断履歴を参照（失敗戦略回避、成功戦略優先）
- 30日time-decay
- M13のセマンティック知識共有と統合
- 影響: knowledge-manager.ts, strategy-manager.ts, types/
- 規模: Medium-Large（3-5日）

**成功基準**:
- [ ] stall検出時にPIVOT/REFINE/ESCALATEが原因に応じて自動選択される
- [x] 過去にPIVOTされた戦略が同種ゴールで自動的に低優先になる
- [ ] dogfooding: 2回以上のstallが発生するゴールで自律回復を確認

**Status**: done (2026-03-19) — 14.1は既存実装確認、14.2はgoalType引数修正+outcome更新実装で有効化

---

## 将来ロードマップ（M17以降）

### Milestone 15: マルチエージェント委譲

**テーマ**: Motiva自身がサブエージェントを並行活用して大規模タスクを分解・委譲・統合する。設計: `docs/design/multi-agent-delegation.md`

- PipelineExecutor実装（implementor → reviewer → verifier の3ステージ）
- PipelineState永続化（再起動をまたぐステージ継続）
- 冪等性キー（task_id + stage_index + attempt）によるステージ重複実行防止
- CapabilityDetectorと連携した動的アダプタ選択（静的 `adapter_type` → `capability_requirement` に移行）
- 前提: M14完了

**Status**: done (2026-03-19)

---

### Milestone 16: 長期記憶・知識共有の高度化

**テーマ**: ゴール横断の知識転移を実用レベルに引き上げ、判断の質を継続的に向上させる

#### 16.1: TransferCandidate スキーマ拡張 + DecisionRecord 構造化
- TransferCandidateSchema に state, domain_tag_match, adapted_content, effectiveness_score 等を追加
- DecisionRecordSchema に what_worked, what_failed, suggested_next を追加
- 規模: Small
- 影響: src/types/cross-portfolio.ts, src/types/knowledge.ts

#### 16.2: 転移信頼スコア学習
- TransferTrustManager: ドメインペア別の成功率記録・学習
- transfer_score = similarity_score × confidence × trust_score
- 3回連続失敗で自動無効化
- 規模: Medium
- 影響: src/knowledge/transfer-trust.ts (新規), src/knowledge/knowledge-transfer.ts

#### 16.3: KnowledgeTransfer Phase 2 — 自動適用 + リアルタイム検出
- confidence >= 0.85 かつ trust_score >= 0.7 で自動適用
- タスク生成直前のリアルタイム転移候補スキャン
- DecisionRecord の what_worked/what_failed 自動抽出
- 規模: Medium-Large
- 影響: src/knowledge/knowledge-transfer.ts, src/execution/task-lifecycle.ts, src/knowledge/knowledge-manager.ts

#### 16.4: コンテキスト選択の動的バジェット化
- Progressive Disclosure 3段階取得（メタデータ→選択→全文）
- バジェット配分: ゴール定義20%, 観測30%, 知識30%, 転移15%, メタ5%
- 規模: Medium-Large
- 影響: src/execution/context-budget.ts (新規), src/execution/session-manager.ts, src/knowledge/vector-index.ts, src/knowledge/knowledge-search.ts

#### 16.5: セッションまたぎのチェックポイント型ハンドオフ
- エージェント A → B のコンテキスト引き継ぎ
- CheckpointManager: 保存・読み込み・LLM適応・GC
- PipelineExecutor 統合
- 規模: Large
- 影響: src/types/checkpoint.ts (新規), src/execution/checkpoint-manager.ts (新規), src/execution/session-manager.ts, src/execution/task-lifecycle.ts, src/state-manager.ts

#### 16.6: メタパターン増分更新 + 転移効果可視化
- buildCrossGoalKnowledgeBase() をバッチから増分更新に移行
- LearningPipeline → KnowledgeTransfer 自動トリガー
- ReportingEngine に転移効果レポートセクション追加
- 規模: Medium
- 影響: src/knowledge/knowledge-transfer.ts, src/knowledge/learning-pipeline.ts, src/reporting-engine.ts

#### 16.7: 統合テスト + ドキュメント更新
- M16 全体の結合動作テスト
- ドキュメント更新

**Status**: done (2026-03-19)

---

### M17: 外部連携プラグイン拡充

**テーマ**: データソース・通知の種類を増やし、DatabaseやAPIをそのまま観測ソースにできる状態にする。

- DatabaseDataSourceAdapter（PostgreSQL / MySQL / SQLite）
- WebSocket / SSEリアルタイムDataSource
- コミュニティプラグイン基盤（npmスコープ: `@motiva-plugins/`、GitHub DataSource、Jira DataSource、PagerDuty Notifier等）
- プラグインバージョン管理 + 互換性チェック
- `motiva plugin list / install / remove` CLIコマンド
- 前提: M12（プラグインアーキテクチャ）完了

### M18: ユーザーインターフェース拡張

**テーマ**: TUIを補完するWeb UIと、チーム利用に向けたマルチユーザー対応。

- Web UI（React、TUIと並行動作可能）
- マルチユーザー対応（ゴール・状態の分離、認証）
- Agent Sessions統合ビュー（複数エージェントの実行状態を一覧表示）
- 前提: M15（マルチエージェント）完了

### 将来検討

- DimensionMapping意味的自動提案（観測次元の名前からZodスキーマを自動生成）
- プラグインマーケットプレイス / レジストリ
- サーキットブレーカー（アダプタ連続失敗時の自動切り離し）
- バックプレッシャー制御（並列エージェント数の上限管理）

---

## 完了済みマイルストーン

| M | テーマ | 完了日 |
|---|--------|--------|
| 1 | LLM-powered観測（3段フォールバック） | 2026-03-15 |
| 2 | 中規模Dogfooding検証（D1-D3） | 2026-03-15 |
| 3 | npm publish品質（contextProvider追加） | 2026-03-15 |
| 8 | 安全性強化 + npm公開（EthicsGate L1） | 2026-03-16 |
| 9 | 観測精度強化（ShellDataSource + クロス検証） | 2026-03-16 |
| 10 | ゴール自動生成（suggestGoals, motiva improve） | 2026-03-16 |
| 11 | 戦略自律選択 + 実行品質（healthCheck, undershoot） | 2026-03-16 |
| 12 | プラグインアーキテクチャ（+115テスト） | 2026-03-17 |
| 13 | プラグイン自律選択 + セマンティック知識共有 | 2026-03-17 |
| 14 | 仮説検証メカニズム（PIVOT/REFINE + 学習ループ） | 2026-03-19 |
| 15 | マルチエージェント委譲 | 2026-03-19 |
| 16 | 長期記憶・知識共有の高度化 | 2026-03-19 |

詳細は `docs/status.md` を参照。

---

## 設計原則

1. **各Milestoneの最後にDogfooding検証を必ず行う** — 実ゴール実行で予期しない結合バグが必ず出る
2. **LLM応答はZodパース前にサニタイズ** — enum外の値が来る前提で設計
3. **catchブロックでエラーを握りつぶさない** — 必ずログ出力
4. **gpt-5.3-codexを推奨モデルとして使う** — 観測精度・収束速度が大幅に優れる
5. **サブステージ単位で一つずつ実装** — 大きなステージは分割する
6. **コアは薄く、拡張はプラグインで** — 特定サービス依存（Slack, メール, GitHub等）はプラグインに分離し、コアの依存を最小に保つ
7. **プラグインの判断基準**: (1) ループに必須 → コア、(2) 依存ゼロ → コア同梱可、(3) 特定サービス依存 → プラグイン
8. **MotivaはプラグインをMasterする** — 能力メタデータとマッチングにより自律的にプラグインを選択・活用する
9. **観測の正確性がすべての基盤** — LLM観測を盲信しない。機械的検証とのクロスチェック必須
10. **自律能力はコア→拡張の順** — 正しく見る（M9）→ 自分で考える（M10）→ 自分で決める（M11）→ 拡張する（M12+）
