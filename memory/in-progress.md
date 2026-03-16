# In-Progress: R8 — contextProvider統合によるLLM観測精度改善

## 背景
R7完了。テスト4件パス（2924テスト、74ファイル）。commit 385a2fc。
Dogfooding実施: 5イテレーション完走、Codexタスク実行成功。

## R7 Dogfooding結果
- ループ: 5イテレーション完走（max_iterations）
- observe→gap→task→execute→verify: 全サイクル正常動作
- Codex: 毎回タスク実行成功
- 所要時間: 約9分（5iter）

## 発見したバグ（R8で対処すべき）
1. **LLM観測のスコアが変化しない**: contextProviderが未設定のため、LLMがワークスペースのファイル内容を読めず、毎回同じスコア（0.6, 0.6, 0.5）を返す
2. **反復改善が実質機能しない**: Codexがファイルを編集してもLLM観測が変化を検知できない
3. verifyTaskのauto-progress(+0.4)でcurrent_valueは上がるが、次iterのobserveで元に戻る

## R8の方針
- CoreLoop/CLIRunnerにcontextProviderを設定する仕組みを追加
- contextProvider: 対象ファイルの内容を読んでLLMに渡す関数
- `--workspace-dir` CLIオプション or ゴール設定でワークスペースパスを指定
- これにより「Codexが編集 → 次iterでLLMが変更後の内容を評価」のフィードバックループが成立

## 修正済みバグ（R7で発見・修正）
1. MockAdapterのadapterType不一致（openai_codex_cli）
2. verifyTaskのauto-progress(+0.4)未考慮のテスト設計
