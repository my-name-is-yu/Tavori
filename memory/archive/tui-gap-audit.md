# TUI Gap Audit — 2026-03-12

## Gap Status

| # | Gap | Status | Evidence |
|---|-----|--------|----------|
| 1 | Markdownレンダリング | ✅ | `markdown-renderer.ts` 独自実装（`marked-terminal` 不使用、理由はInkのANSI競合）。`renderMarkdownLines()` がヘッダー/リスト/コードブロック/水平線をパース。`chat.tsx:11` でimport、`:134` で全Motivaメッセージに適用 |
| 2 | ロール表示 | ✅ | `chat.tsx:118-130`: userメッセージは `color="cyan" bold "› "` プレフィックス。`chat.tsx:139`: Motivaメッセージは `color="magenta" bold "Motiva"` ラベル。明確に区別済み |
| 3 | アニメーションスピナー | ✅ | `package.json`: `ink-spinner: ^5.0.0` インストール済み。`chat.tsx:158-165`: `<Spinner type="dots" />` + `" Thinking..."` を yellow でアニメーション表示 |
| 4 | 入力プロンプトプレフィックス `›` | ✅ | `chat.tsx:177-179`: `<Text color="green" bold>{"› "}</Text>` をTextInputの前に配置。上下に適応幅のボーダーラインも追加 |
| 5 | ダッシュボードレイアウト（サイドバー） | ❌ | `app.tsx:126`: 依然として `flexDirection="column"` 縦積み。Dashboardと Chatは上下に積まれたまま。サイドバー分割は未実装 |
| 5b | 下部ステータスバー | ✅ | `app.tsx:22-40`: `StatusBar` コンポーネント実装済み。goal数/trust/status/iteration を表示。`app.tsx:140-145` で使用 |
| 6 | セパレータ幅の適応 | ✅ | `dashboard.tsx:107`: `"─".repeat(Math.min(process.stdout.columns \|\| 60, 60) - 4)` で適応的幅（最大60列クランプ）。`chat.tsx:171`: 入力エリアも `"─".repeat(termCols)` で完全適応 |
| 7 | タイムスタンプ表示 | ✅ | `chat.tsx:43-48`: `formatTime()` 実装済み（HH:MM 24時間形式）。user(`chat.tsx:126`)・Motiva(`chat.tsx:142`)両方で `dimColor` 表示 |
| 8 | ヘルプオーバーレイのカラー化 | ✅ | `help-overlay.tsx:42-86`: コマンドが `color="green" bold`、ショートカットが `color="cyan" bold`。COMMANDS / KEYBOARD SHORTCUTSの2セクション構造。スクロールナビゲーションは未実装（元要件の範囲外） |
| 9 | レポート単一メッセージ問題 | 🔶 | `actions.ts:151`: `messages.push(report.content)` は単一文字列のまま。ただし Gap 1 の解決で `renderMarkdownLines()` が行分割して表示するため視覚的影響は軽減済み。専用 `ReportView` コンポーネントは未実装 |
| 10 | 承認UI（不可逆タスク） | ❌ | `entry.ts:57`: `const approvalFn = async () => true` のまま。`entry.ts:133` に `console.warn` 警告追加のみ。TODO(Phase 2)コメント残存 |

## Architecture Status

| # | Issue | Status | Evidence |
|---|-------|--------|----------|
| A | LoopController hook化 | ❌ | `use-loop.ts`: `export class LoopController` のままクラス実装。コールバックパターン(`setOnUpdate`)を使用。React hook への変換なし |
| B | ターミナルリサイズ対応 | 🔶 | `app.tsx:126`: `height={process.stdout.rows \|\| 24}` は依然静的読み取り。`chat.tsx:101,171` で個別に `process.stdout.rows/columns` を再読み込み。明示的なリサイズイベントリスナーなし。Ink 5.x 内部の自動再レンダリングに依存 |
| C | 承認バイパス | ❌ | Gap 10 と同じ。`entry.ts:57` の `approvalFn = async () => true` はハードコード |
| D | メッセージリスト無制限蓄積 | 🔶 | `chat.tsx:101-104`: 表示を `Math.max(termRows - 12, 8)` 件に制限し、スクロールインジケーター実装済み(`chat.tsx:109-111`)。`app.tsx:44` の `messages` state 自体の上限（200件キャップ等）は未設定 |
| E | 単一列レイアウト | ❌ | Gap 5 と同じ。`app.tsx` root は `flexDirection="column"` のまま |

## Summary

- 解決済み: 8件（Gap 1, 2, 3, 4, 5b, 6, 7, 8）
- 部分的: 3件（Gap 9, Arch B, Arch D）
- 未解決: 4件（Gap 5/Arch E, Gap 10/Arch C, Arch A）

## 新規発見（研究後に実装済みの追加機能）

1. **ink バージョンアップ** — `ink: ^5.2.1`、`ink-text-input: ^6.0.0`（研究時は v4.4.1 / v5.0.1 を記録）
2. **marked/marked-terminal はインストール済みだが未使用** — `markdown-renderer.ts` が独自実装で代替。`src/tui/types/marked-terminal.d.ts` の型定義も残存。整理対象
3. **コマンド補完機能** — `chat.tsx:72-89`: `/` 入力時に最大6件のコマンド候補表示。研究時点では未存在
4. **F1キーによるヘルプトグル** — `app.tsx:64-72`: F1 キー (`\u001bOP` など) でヘルプ切り替え実装済み
5. **messageType 色分け** — `chat.tsx:26-41`: `getMessageTypeColor()` が error/warning/success/info を色別表示
