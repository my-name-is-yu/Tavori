# Motiva Post-MVP ロードマップ

作成日: 2026-03-12
前提: Stage 1-6 (MVP) 完了、TUI Phase 1-2 実装済み、983テスト通過

---

## 全体サマリー

| Stage | 目的 | ファイル数 | 概算行数 | 前提 |
|-------|------|-----------|---------|------|
| **7** | 基盤安定化・ドッグフーディング準備 | 10-13 | +1000-1500 | MVP |
| **8** | 知識獲得・能力検知 | 7-9 | +1500-2000 | 7 |
| **9** | ポートフォリオ並列・満足化強化 | 8-10 | +2000-2500 | 8 |
| **10** | デーモン・イベントシステム | 7-9 | +1500-2000 | 7-9 |
| **11** | 好奇心・キャラクターカスタマイズ | 7-9 | +1500-2000 | 8, 9 |
| **12** | 知識共有・ベクトル検索 | 7-11 | +1500-2500 | 8, 11 |
| **13** | マルチエージェント協調 | TBD | TBD | 9, 12 |

### 優先度の判断根拠

1. **Stage 7が絶対最優先**: コアループが正しく回らない状態では何も検証できない。ドッグフーディングの開始条件
2. **Stage 8が次点**: ドッグフーディングで即座にぶつかる「知らない・できない」の壁を解決
3. **Stage 9-10は並行検討可能**: ポートフォリオ=賢さ、デーモン=自律性。ドッグフーディング結果で順序調整
4. **Stage 11-12は「Motivaらしさ」の完成**: 好奇心がアイデンティティだが基盤安定が先
5. **Stage 13は将来構想**: 設計のみ存在すれば十分

---

## Stage 7 — 基盤安定化とドッグフーディング準備

**目的**: コアループが現実のタスクで正しく動作する状態にする。

### 7.1 E2Eテスト4のバグ修正（4件）

| # | 修正内容 | ファイル |
|---|---------|---------|
| 1 | `requiresApproval()` を `observe_and_propose` 象限のみ承認要求に変更 | `src/trust-manager.ts` |
| 2 | CoreLoopで `approval_denied` を検知してループ停止 | `src/core-loop.ts` |
| 3 | CoreLoopで `escalate` アクションを検知してループ停止 | `src/core-loop.ts` |
| 4 | CLIRunnerのreadlineシングルトン化 | `src/cli-runner.ts` |

### 7.2 タスク完了後のゴール次元更新

- `handleVerdict` 完了時に `last_updated` を更新（`src/task-lifecycle.ts`）
- `verifyTask()` の `dimension_updates: []` を実装し、エージェント出力から次元進捗を反映

### 7.3 TUI承認UI（Gap 10）

- `ApprovalPrompt` コンポーネント新規作成
- App状態にapproval Promiseの解決パターンを追加
- `entry.ts` の `approvalFn = async () => true` を実装に差し替え

### 7.4 TUI残りのUX改善

- Gap 5: サイドバーレイアウト（Dashboard左/Chat右）
- Gap 9: ReportViewコンポーネント
- Arch A: LoopController hook化
- Arch D: メッセージリスト200件キャップ

### 7.5 npm publish準備

- README.md, LICENSE
- `.npmignore` / `files` フィールド整備
- `package.json` の `engines`, `keywords`, `repository` 整備

### 規模感
- 変更ファイル: 8-10、新規ファイル: 2-3
- 概算: +800-1200行、修正200-300行

---

## Stage 8 — 知識獲得と実行境界の拡張

**目的**: Motivaが「知らないことを調べ、できないことを検知して報告する」能力を獲得。

### 8.1 知識獲得システム（MVP）

設計: `docs/design/knowledge-acquisition.md`

- 知識不足検知（シグナル: 解釈困難、戦略行き詰まり）
- 調査タスク生成（`task_category: "knowledge_acquisition"`）
- ドメイン知識ファイル保存（`~/.motiva/goals/<id>/domain_knowledge.json`）
- タグベース完全一致検索
- コンテキスト選択への知識エントリ注入

### 8.2 能力不足検知（MVP）

設計: `docs/design/execution-boundary.md` §5.1-5.5

- タスク生成時のCapability Registry参照
- 連続失敗からの能力不足確定
- ユーザーエスカレーションによる能力提供フロー
- Capability Registryの永続化

### 8.3 倫理ゲート: タスクレベル手段チェック

設計: `docs/design/goal-ethics.md` Phase 2の一部

- `TaskLifecycle.generateTask()` 後の `EthicsGate.checkMeans()` 実装
- 既存FIXMEコメント（`src/task-lifecycle.ts:197`）の解消

### 規模感
- 新規ファイル: 3-4、変更ファイル: 4-5
- 概算: +1500-2000行

---

## Stage 9 — ポートフォリオ管理と満足化の強化

**目的**: 複数戦略の並列実行と自動リバランスにより「賢いリソース配分」を実現。

### 9.1 ポートフォリオ管理 Phase 2

設計: `docs/design/portfolio-management.md`

- 同時active戦略数: 2-4
- 自動リバランス（定期+イベント駆動）
- 効果計測: 時系列相関 + 次元ターゲット一致
- 打ち切り条件の自動判断
- WaitStrategy型の形式化

### 9.2 満足化 Phase 2

設計: `docs/design/satisficing.md`

- 集約マッピング全種対応（min/avg/max/all_required）
- 意味的類似度による自動マッピング提案
- サブゴール→上位ゴールの次元伝播

### 9.3 倫理ゲート Layer 1

設計: `docs/design/goal-ethics.md` Phase 2

- カテゴリベースブロックリスト（意図レベル分類、LLM不要）
- 2層構造の完成（Layer 1 → Layer 2）
- ユーザーカスタマイズ可能な追加制約

### 規模感
- 新規ファイル: 3-4、変更ファイル: 5-6
- 概算: +2000-2500行

---

## Stage 10 — ランタイム進化（デーモン+イベントシステム）

**目的**: 「呼ばれたら動く」から「自律的に動き続ける」へ。

### 10.1 デーモンモード（Phase 2a）

設計: `docs/runtime.md`

- `motiva start` / `motiva stop` サブコマンド
- PIDファイル管理、ログローテーション
- ゴール別の駆動間隔設定
- グレースフルシャットダウン

### 10.2 cronエントリー生成（Phase 2b）

- `motiva cron` サブコマンド
- crontabエントリーの自動生成・出力

### 10.3 駆動システム Phase 2

設計: `docs/design/drive-system.md`

- インメモリイベントキュー
- ファイルウォッチャー（`~/.motiva/events/` リアルタイム監視）
- ローカルHTTPエンドポイント（webhook受信）

### 10.4 CI/CD

- GitHub Actions（テスト、ビルド、npm publish）
- バージョニング戦略

### 規模感
- 新規ファイル: 4-5、変更ファイル: 3-4
- 概算: +1500-2000行

---

## Stage 11 — 好奇心とキャラクターカスタマイズ

**目的**: 「言われたことをやる」から「やるべきことを自ら見つける」へ。Motivaのアイデンティティの完成。

### 11.1 好奇心メカニズム

設計: `docs/design/curiosity.md`

- 5つの発動条件（タスクキュー空、予測外観測、繰り返し失敗、未定義問題、定期探索）
- 好奇心ゴール生成・承認フロー
- 学習フィードバック: 高インパクトドメイン優先、失敗パターン再構成、盲点検出
- クロスゴール転移（MVP: dimension_name完全一致）
- リソース予算制約（ユーザーゴール優先、最大20%）
- 自動失効（12時間）、同時提案数上限（3）

### 11.2 キャラクターカスタマイズ

設計: `docs/design/character.md` Phase 2

- 4軸パラメータの調整機能
- 構造的制約との分離保証テスト
- `motiva config character` サブコマンド

### 規模感
- 新規ファイル: 3-4、変更ファイル: 4-5
- 概算: +1500-2000行

---

## Stage 12 — 知識共有と高度な検索

**目的**: ゴール間の暗黙的な知識共有、意味的検索。「経験から学ぶ」レベルの引き上げ。

### 12.1 知識獲得 Phase 2

- ゴール横断ナレッジベース
- 意味的埋め込みによるベクトル検索
- 矛盾検知の高度化（埋め込み類似度）
- 知識の陳腐化対処（ドメイン安定性に基づく自動再検証）

### 12.2 能力の自律調達 Phase 2

- エージェントへのツール/コード作成委譲
- 外部サービス連携の自動ガイド生成
- 新能力の検証・自動登録

### 12.3 好奇心 Phase 2

- 意味的埋め込みによるファジー類似度（クロスゴール転移）
- 埋め込みベースの盲点検出

### 規模感
- 新規ファイル: 3-5、変更ファイル: 4-6
- 概算: +1500-2500行
- 外部依存: 埋め込みモデル（Anthropic/OpenAI）

---

## Stage 13（将来構想）— マルチエージェント協調

設計: `docs/design/portfolio-management.md` Phase 3

- 戦略間の依存関係モデリング
- ゴール横断の戦略ポートフォリオ（複数ゴール間のリソース配分最適化）
- 過去のゴール・ドメインからの戦略テンプレート推薦

---

## リスクフラグ

| リスク | 該当Stage | 対応 |
|--------|----------|------|
| ベクトル検索の技術選定 | 12 | Stage 11完了時に技術調査 |
| Node.jsデーモン化のプロセス管理 | 10 | pm2等の外部ツール依存の可能性、設計再評価が必要 |
| ドッグフーディング開始時期 | 7 | Stage 7完了直後から開始、以降の優先順位をフィードバックで調整 |

---

## 設計ドキュメントとの対応

| 設計ドキュメント | 対応Stage |
|----------------|----------|
| `knowledge-acquisition.md` | 8 (MVP), 12 (Phase 2) |
| `execution-boundary.md` | 8 (MVP), 12 (Phase 2) |
| `goal-ethics.md` | 8 (手段チェック), 9 (Layer 1) |
| `portfolio-management.md` | 9 (Phase 2), 13 (Phase 3) |
| `satisficing.md` | 9 (Phase 2) |
| `runtime.md` | 10 (Phase 2a/2b) |
| `drive-system.md` | 10 (Phase 2) |
| `curiosity.md` | 11 (MVP), 12 (Phase 2) |
| `character.md` | 11 (Phase 2) |
