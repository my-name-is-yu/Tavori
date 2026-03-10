# Motiva 使い方ガイド

## Motivaとは

Motivaはゴール駆動のAIエージェント・オーケストレーターです。`claude --print` をサブプロセスとして繰り返し呼び出し、ゴールの完了を自律的に判定するループを実行します。Motivaはエージェントを呼ぶ側（オーケストレーター）であり、エージェント内部には干渉しません。

## インストール

```bash
git clone https://github.com/yourname/motiva.git
cd motiva
npm install
npm run build
npm link
```

前提: Node.js 18+、`claude` CLI がインストール済みでパスが通っていること。

## クイックスタート

任意のプロジェクトディレクトリで以下を実行します。

```bash
# 1. 初期化（.motiva/ ディレクトリを作成）
motiva init

# 2. ゴールを追加（完了条件をthresholdsで指定）
motiva add-goal "READMEを作成する" --thresholds '{"files_exist":["README.md"]}'

# 3. 自律ループを開始
motiva run
```

`motiva run` を実行すると確認プロンプトが表示されます。`y` を入力するとループが開始されます。

## CLIコマンド一覧

| コマンド | 説明 |
|---|---|
| `motiva init` | カレントディレクトリに `.motiva/` を初期化する |
| `motiva add-goal <description>` | ゴールを追加する（`--thresholds <json>` オプションあり） |
| `motiva goals` | 全ゴールの一覧を表示する |
| `motiva status` | 現在の状態（セッション数・ゴール件数）を表示する |
| `motiva run` | 自律メインループを開始する |

### `motiva add-goal` のオプション

```
--thresholds <json>   完了判定条件をJSONで指定（デフォルト: '{}'）
```

## thresholds の設定

`--thresholds` には以下のキーを組み合わせて指定します。

```jsonc
{
  "files_exist": ["path/to/file.ts", "another/file.md"],  // ファイルが存在かつ非空であること
  "tests_pass": true,    // npm test が exit 0 で完了すること
  "build_pass": true     // npm run build が exit 0 で完了すること
}
```

指定例:

```bash
# ファイル存在チェックのみ
motiva add-goal "設定ファイルを作成" --thresholds '{"files_exist":["config.yaml"]}'

# テストとビルドの両方
motiva add-goal "実装を完成させる" --thresholds '{"tests_pass":true,"build_pass":true}'

# 複数条件の組み合わせ
motiva add-goal "機能Xを実装" --thresholds '{"files_exist":["src/x.ts"],"tests_pass":true}'
```

**thresholds未設定の場合**: `checkCompletion` が常に `false` を返すため、ゴールは完了判定されません。停滞検知（3セッション連続失敗または成功）でのみ終了します。

## 動作の仕組み

```
motiva run
  └─ アクティブゴールを取得（先頭1件）
      └─ タスクプロンプトを生成
          └─ claude --print --dangerously-skip-permissions <prompt> を実行（タイムアウト: 5分）
              └─ 完了判定（checkCompletion）
                  ├─ 合格 → status: completed → 次のゴールへ
                  └─ 不合格 → 停滞判定（detectStall: 直近3セッション全失敗 or 全成功）
                      ├─ 停滞 → status: stalled → 次のゴールへ
                      └─ 継続 → 同ゴールで次セッションへ
```

状態は `.motiva/state.json` および `.motiva/goals.json` にファイルとして永続化されます。

## 制約・注意事項

**`--dangerously-skip-permissions` について**
`motiva run` は内部で `claude --dangerously-skip-permissions` を使用します。Claude Codeの確認プロンプトをすべてスキップするため、ゴール設計には注意が必要です。

**不可逆アクション検出**
Claudeの出力に以下のパターンが含まれる場合、警告ログを出力します（実行は止まりません）。
- `git push`
- `rm -rf`
- `DROP TABLE`
- `npm publish`
- `docker push`

タスクプロンプトにはこれらを実行しないよう指示が含まれますが、保証ではありません。

**停滞検知の条件**
直近3セッションが「すべて失敗」または「すべて成功（ただしgoal未完了）」の場合、ゴールを `stalled` 状態にして手動対応を求めます。

**MVPの制限**
- ゴール分解（サブゴール）は未実装
- アダプターは Claude Code（`claude` CLI）のみ対応
- 複数アクティブゴールがある場合、常に先頭のゴールから処理する
- ゴールの優先度設定は未実装
