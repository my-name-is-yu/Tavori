# Web UI 設計

> Milestone 18。TUIを補完するWeb UIを定義する。マルチユーザー対応は将来課題。
> 設計思想: **"Calm Control Room"** — 密度が高いが整理された、管制室のような落ち着いたUI。
> 関連: `plugin-architecture.md`, `multi-agent-delegation.md`, `reporting.md`, `knowledge-transfer.md`

---

## 1. 概要

- TUI（`src/tui/`）は単一ターミナル向け。Web UIはブラウザアクセス、複数画面表示を可能にする
- TUIは維持。Web UIはTUIと同じデータ層（StateManager, CoreLoop等）を共有し並行動作する

**スコープ**: Web UI 4画面、REST API層、SSEリアルタイム更新
**スコープ外**: マルチユーザー対応（プロジェクトが広まった段階で検討）、モバイル対応、外部OAuth、Web UIからのゴール作成/編集

---

## 2. 設計思想: "Calm Control Room"

Conatusは「エージェントの管制室」だ。コックピットのように多くの情報が整理された位置に配置され、異常時だけ注意を引く。

| 回避すべきパターン | 対策 |
|------------------|------|
| テンプレート感のあるカードUI | カード不使用。セクション区切りは1px borderか余白のみ |
| 全要素が同じ視覚ウェイト | タイポグラフィで3段ヒエラルキー。数値は大きく、ラベルは小さく |
| 過剰な装飾・グラデーション | 装飾ゼロ。アクセントカラーは状態表示のみ |
| 均一なグリッド | メイン70% + サイドパネル30%の非対称レイアウト |
| SaaSブルー + ライトグレー | ダーク基調 + アンバーアクセント（暖色で「動機」を表現） |

**参考UI**: Linear（情報密度、キーボード操作）、Vercel Dashboard（リアルタイム監視）、Grafana（データヘビーなモニタリング）、Railway（ミニマル開発者ダッシュボード）

---

## 3. 技術スタック

| カテゴリ | 選定 | 理由 |
|---------|------|------|
| Framework | Next.js 15 (App Router) | SSR初期表示 + Client側リアルタイム。React 18は既に依存に含む |
| Styling | Tailwind CSS v4 + CSS custom properties | テーマ切替・カスタム性 |
| Components | shadcn/ui（コピー方式） | ソース所有でカスタマイズ自在 |
| Real-time | SSE（既存EventServer拡張） | WebSocketへのアップグレードパスを確保 |
| State | Zustand | React外でも使える軽量ストア |
| Charts | Recharts | Gap/Trust時系列表示 |
| Font | Geist Sans + Geist Mono | Icons: Lucide |

---

## 4. アーキテクチャ

### ディレクトリ構造

```
web/
├── app/                    # Next.js App Router
│   ├── layout.tsx / page.tsx (Dashboard)
│   ├── goals/[id]/page.tsx, sessions/page.tsx
│   ├── knowledge/page.tsx, settings/page.tsx
│   └── api/                # Route Handlers
│       ├── goals/, sessions/, strategies/, knowledge/, reports/
│       └── events/route.ts  # SSE proxy
├── components/  (ui/, dashboard/, goal/, session/, knowledge/, layout/)
├── lib/  (conatus-client.ts, store.ts, sse.ts)
├── styles/tokens.css
└── package.json, next.config.ts, tailwind.config.ts
```

### データ層とAPI

Route HandlersはNode.jsプロセス内で直接conatus-coreモジュールをimportする（同一プロセス、RPC不要）。

| Endpoint | Method | 対応モジュール |
|----------|--------|---------------|
| `/api/goals` | GET | StateManager.listGoals() |
| `/api/goals/:id` | GET | StateManager.getGoalState() |
| `/api/goals/:id/gap-history` | GET | StateManager（gap履歴） |
| `/api/sessions` | GET | SessionManager.listSessions() |
| `/api/sessions/:id/output` | GET (SSE) | EventServer（ストリーミング） |
| `/api/strategies/:goalId` | GET | StrategyManager.getActiveStrategy() |
| `/api/knowledge/search` | POST | KnowledgeManager.search() |
| `/api/knowledge/transfers` | GET | KnowledgeTransfer.listTransfers() |
| `/api/reports/:goalId` | GET | ReportingEngine.generateReport() |
| `/api/events` | GET (SSE) | EventServer（リアルタイム） |

### SSE統合

`Browser → /api/events → EventServer.subscribe() → SSE stream`
クライアント側はZustandストアがSSEを購読し、UIコンポーネントはストアをsubscribeする。

---

## 5. 画面設計

レイアウト共通: 左サイドバー（ナビ、120px固定） + メイン領域

### 5.1 Dashboard

**上部 — ゴール一覧テーブル**: ゴール名（リンク）、Gap %（プログレスバー、背景`#1a1a1a`）、Trustスコア（数値+色: 赤<0, グレー0-20, 緑>20）、戦略状態バッジ、最終更新

**中部 — アクティブセッション**: アダプタ名+ロール+ステージ（observe→gap→score→task→execute→verify）、経過時間

**下部 — 判断タイムライン（直近10件）**: タイムスタンプ+ゴール名+判断種別（PIVOT/REFINE/ESCALATE）+1行サマリ

### 5.2 Goal Detail (`/goals/:id`)

**ヘッダー**: ゴール名+閾値タイプ+現在のGap %（48px Geist Mono）

**左60%**: Gap履歴チャート（AreaChart, 30日）、Trust推移（LineChart）、タスク一覧（outcome: success/partial/failアイコン）

**右40%**: 戦略履歴（PIVOT/REFINE）、知識転移レコード（effectiveness_score付き）、制約条件

### 5.3 Agent Sessions

**フィルタバー**: ステータス、アダプタ、ロール

**テーブル**: セッションID、ゴール、アダプタ、ロール、ステータス、時刻

**詳細パネル**: パイプラインステージ進捗インジケータ、リアルタイム出力（SSE、`Geist Mono`、背景`#0a0a0a`）

### 5.4 Knowledge & Learning

3セクション構成:
1. **メタパターン一覧** — LearningPipeline出力、ドメインタグ、適用回数、平均effectiveness
2. **判断記録** — PIVOT/REFINE一覧、what_worked/what_failed/suggested_next
3. **転移候補** — ソース→ターゲットゴール、transfer_score、適用結果

### 5.5 Settings & Users

プロバイダー設定（`~/.conatus/provider.json`）、プラグイン管理（有効/無効）、システムヘルス（CoreLoop状態、EventServer接続数）

---

## 6. マルチユーザー対応

**将来課題** — プロジェクトが広まった段階で設計・実装する。MVP時点ではシングルユーザー（認証なし、localhost前提）。

---

## 7. 実装サブステージ

| Sub | テーマ | 規模 | 影響 |
|-----|--------|------|------|
| 18.1 | プロジェクト構造+API層 — Next.js 15, Tailwind v4, shadcn/ui, デザイントークン, Route Handlers | Medium (2-3日) | `web/` 新規 |
| 18.2 | Dashboard画面 — ナビ, ゴール一覧, セッションリスト, タイムライン | Medium (2-3日) | `web/app/page.tsx`, `web/components/dashboard/` |
| 18.3 | Goal Detail+Sessions — チャート(Recharts), タスク一覧, セッション詳細 | Medium (3-4日) | `web/app/goals/`, `web/app/sessions/` |
| 18.4 | リアルタイム更新 — SSEクライアント, Zustand統合, 出力ストリーミング | Medium (2-3日) | `web/lib/sse.ts`, `web/lib/store.ts` |
| 18.5 | Knowledge+Settings画面 | Medium (2-3日) | `web/app/knowledge/`, `web/app/settings/` |
| 18.6 | 統合テスト+Dogfooding — APIテスト, 実ゴール監視, パフォーマンス確認 | Medium (2-3日) | `web/__tests__/` |

---

## 8. 成功基準

- [ ] DashboardでGap %, Trust, 戦略状態がリアルタイム表示される
- [ ] Goal DetailでGap/Trust推移チャートが30日分表示される
- [ ] Agent Sessionsでセッション出力がSSE経由でストリーミングされる
- [ ] localhostアクセスで認証なしに全機能利用できる
- [ ] TUIとWeb UIが同一Conatusプロセスに対して並行動作できる
- [ ] 初期ロード < 1.5秒（SSR）、SSEイベント反映 < 500ms
- [ ] Dogfoodingで2時間以上Web UI監視が異常なく動作する

---

## 9. UIデザイン詳細

### カラーパレット

```css
:root {
  --bg-primary: #0a0a0a;  --bg-secondary: #141414;  --bg-tertiary: #1a1a1a;  --bg-hover: #1f1f1f;
  --border-primary: #262626;  --border-secondary: #333333;
  --text-primary: #fafafa;  --text-secondary: #a3a3a3;  --text-tertiary: #737373;
  /* Accent: Amber (motivation = warmth) */
  --accent-primary: #f59e0b;  --accent-secondary: #d97706;  --accent-muted: #78350f;
  /* Semantic */
  --status-success: #22c55e;  --status-warning: #f59e0b;  --status-error: #ef4444;
  --status-info: #6366f1;  --status-stalled: #f97316;
  /* Trust */
  --trust-negative: #ef4444;  --trust-neutral: #737373;  --trust-positive: #22c55e;
}
```

### タイポグラフィ

| 用途 | Font | Size | Weight |
|------|------|------|--------|
| 画面タイトル | Geist Sans | 20px | 600 |
| セクション見出し | Geist Sans | 14px | 500 |
| 本文・テーブル | Geist Sans | 13px | 400 |
| 強調数値（Gap%, Trust） | Geist Mono | 32-48px | 700 |
| コード・出力 | Geist Mono | 12px | 400 |
| ラベル | Geist Sans | 11px | 400 |

### スペーシング・コンポーネント

4pxベースグリッド: 4, 8, 12, 16, 24, 32, 48, 64。内部8-16px、セクション間24-32px。

**shadcn/uiカスタマイズ**: `border-radius: 4px`（シャープ）、`box-shadow: none`、Button=ghost/outline中心+filledはaccentのみ、Table=1px border行区切り+ヘッダー`--bg-secondary`、Badge=丸み少・padding `2px 8px`・11px

**モーション**: マイクロ150ms `ease-out`、レイアウト300ms `ease-in-out`、データ更新即時、ローディングはpulse skeleton（`--bg-tertiary`→`--bg-hover`）
