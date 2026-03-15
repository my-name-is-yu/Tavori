# Motiva Dogfooding Plan

Motivaを使ってMotiva自身を改善する — セルフドッグフーディング計画。

## コンセプト

Motivaにゴールを設定し、Motivaが自分のリポジトリを分析してGitHub Issueを起票する。
人間 + Claude Code がissueを解決し、Motivaが次のループで進捗を観測する。

```
Motiva (ゴール設定)
  │
  ├── 観測: リポジトリ状態を読む（docs, tests, code quality）
  ├── ギャップ検出: 不足・改善点を発見
  ├── タスク生成: GitHub Issue として起票（--label motiva）
  │
  └── 人間 + Claude Code が issue を解決
        └── Motivaが次ループで closed/open を観測 → 進捗更新
```

## 安全設計

- Motivaは直接コードを触らない — 出力はGitHub Issueのみ
- issueにはすべて `motiva` ラベルを付与（トラッキング用）
- 人間がissueをレビューしてから着手（不適切なissueはcloseで却下）

## 実装フェーズ

### Phase A: GitHub Issue アダプタ実装

**目的**: Motivaのタスク実行出力をGitHub Issueに変換するアダプタ

実装内容:
1. `src/adapters/github-issue.ts` — IAdapter実装
   - execute: `gh issue create --title "..." --body "..." --label motiva`
   - AgentTask.promptからタイトル・本文・ラベルを抽出
   - AgentResultにissue URLを返す
2. `src/provider-factory.ts` — `github_issue` アダプタ登録
3. 観測: `gh issue list --label motiva --json number,title,state` で状態取得
   - 既存 DataSourceAdapter (http_api) または gh CLI 経由
4. テスト: `tests/github-issue-adapter.test.ts`

### Phase B: 小さいゴールでdogfood開始

**最初のゴール**: "MotivaのREADMEとGetting Startedガイドを整備する"

次元例:
- `readme_completeness`: 0→1 (README.mdの存在と品質)
- `getting_started_exists`: 0→1 (Getting Startedガイドの有無)
- `api_doc_coverage`: 0→1 (主要APIのドキュメント率)

観測方法:
- ファイル存在チェック（mechanical）
- LLMによる品質レビュー（independent_review）
- issue open/closed 比率（mechanical）

### Phase C: ゴール拡大

段階的にスコープを広げる:

1. "全E2Eテストを通過させる" (テスト4の承認ループ修正)
2. "npm publish可能な状態にする" (パッケージ品質)
3. "Motivaのコード品質を改善する" (リファクタリング提案)
4. "Motivaを完成させる" (最終目標)

各段階で学んだことをMotiva自身の学習パイプラインに蓄積。

## 成功基準

Phase Aの成功:
- [ ] `motiva run --adapter github_issue` でissueが作成される
- [ ] 作成されたissueが具体的で実行可能
- [ ] 次のループでissue状態を観測できる

Phase Bの成功:
- [ ] Motivaが3つ以上の有用なissueを自動起票
- [ ] issueを解決したらMotivaが進捗を正しく認識
- [ ] ループが自然に収束（ゴール達成 or satisficing判定）

## 技術メモ

- `gh` CLI を使用（GitHub API直接呼び出しより簡単、認証も`gh auth`で管理済み）
- issue本文にMotiva metadata（goal_id, task_id, dimension）を埋め込む（観測時の紐付け用）
- ラベル `motiva` でフィルタリング、追加ラベルで分類（`docs`, `test`, `bug`等）
