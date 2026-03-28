# Dogfooding R5 実行結果

実行日: 2026-03-16
コミットベース: 6310a85
テスト数: 2920テスト、73ファイル

---

## R5-1: CONTRIBUTING.md 作成ゴール

### 設定

| 項目 | 値 |
|------|-----|
| ゴール | "Create a CONTRIBUTING.md for this project" |
| アダプタ | openai_codex_cli (OpenAI Codex CLI) |
| LLM | gpt-4o-mini |

### 実行結果

2イテレーションで完了。

**イテレーション 1**
- Codex CLI が CONTRIBUTING.md を新規作成（95行）
- 観測フェーズで各品質次元を評価

**イテレーション 2**
- gap = 0.00 を確認
- 全次元が閾値を満たしたと判定 → 完了

### 確認事項

- Codex CLI アダプタ経由でファイルが実際に生成されたことを確認
- コアループが2イテレーション以内に収束することを確認
- LLM 観測が生成ファイルの内容を評価し gap を正しく更新したことを確認

---

## R5-2: npm publish 準備確認ゴール

### 設定

| 項目 | 値 |
|------|-----|
| ゴール | "Make this npm package publish-ready: ensure package.json has proper description, keywords, license, and author fields; README has installation and API usage examples; TypeScript type definitions are exported correctly" |
| アダプタ | openai_codex_cli |
| LLM | gpt-4o-mini |

### 実行結果

1イテレーションで完了（開始時点で gap = 0.00）。

M3 dogfooding での改善が維持されており、全9次元が初回観測時点で閾値を満たしていた。

### 観測次元と評価値

| 次元 | スコア | 判定 |
|------|--------|------|
| package_json_description_quality | 1.0 | 閾値クリア |
| package_json_keywords_quality | 0.9 | 閾値クリア |
| package_json_license_quality | 1.0 | 閾値クリア |
| package_json_author_quality | 1.0 | 閾値クリア |
| readme_installation_quality | 0.9 | 閾値クリア |
| readme_api_usage_quality | 0.8 | 閾値クリア |
| dist_index_js_exists | present | 閾値クリア |
| dist_index_dts_exists | present | 閾値クリア |
| package_json_exports_valid | 1.0 | 閾値クリア |

### 確認事項

- LLM 観測が品質次元を正しく評価できることを確認
- FileExistence データソースが dist ファイルに対して自動登録されることを確認
- 既に満たされたゴールが1イテレーションで冪等に完了することを確認（再実行安全性）

---

## R5 総括

### 検証された特性

**コアループの E2E 動作**
R5-1・R5-2 を通じて、PulSeed のコアループ（observe → gap → score → task → execute → verify）が実 LLM・実アダプタ環境で正常に動作することを確認した。

**実ファイル生成（R5-1）**
Codex CLI アダプタが実際にファイルを作成し、その結果を LLM 観測が評価してループを収束させることを実証した。

**冪等完了（R5-2）**
既に満たされたゴールを与えた場合、1イテレーションで正しく完了と判定される。不要なタスク実行を行わない冪等性を確認した。

---

## 既知の問題と今後の課題

### 次元キー命名の問題（`_2` サフィックス）

**概要**: 一部の次元キーに `_2` サフィックスが自動付与されるケースが確認された。

**影響**: 意図した次元名と実際に記録されるキーが一致しない場合があり、閾値評価や観測履歴の追跡に影響する可能性がある。

**暫定対応**: なし（現状は観測スコアの計算には影響しないが、デバッグ時に混乱を招く）。

**今後**: キー正規化ロジックを ObservationEngine に追加し、重複キーの生成を防ぐ。

### LLM 観測の精度（ハルシネーション）

**概要**: LLM による観測スコアが実態を完全には反映しないケースが確認された。特に定性評価（ドキュメント品質など）でスコアが過大または過小評価される傾向がある。

**影響**: gap 計算の精度に影響し、本来不要なイテレーションが発生する、または早期完了してしまう可能性がある。

**暫定対応**: 3段フォールバック（DataSource → LLM → self_report）により機械的検証を優先。

**今後**: プロンプトエンジニアリングの改善、Few-shot 例の追加、LLM 観測結果の信頼度スコアと実測値との乖離モニタリング機能の追加を検討する。

### ステータス表示の改善

**概要**: CLI のステータス表示において、現在のイテレーション数・観測次元・gap 値がリアルタイムで確認しにくい。

**今後**: TUI ダッシュボード（Layer 7）との統合により、実行状況のリアルタイム可視化を強化する。
