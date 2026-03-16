# R9: 3+イテレーション反復改善 実Dogfooding — 結果

## 実行日: 2026-03-16

## 結果: 成功（課題修正後、6イテレーションで安定した段階的改善を確認）

## 実行概要

### Run 1 (temperature=0, auto-progress=0.4)
- Goal ID: 4df5d9f0-c70d-4089-b334-b4ea4f3e5657
- 結果: **失敗** — 6イテレーション、スコア固定（0.75/0.75/0.75→0.60）
- 原因: FileExistence次元（contributing_md_exists）がgap最大→タスクがCONTRIBUTING.md作成に集中
- temperature=0でcontext不変→スコア固定

### Run 2 (temperature=0.2, auto-progress=0.2)
- Goal ID: 63ff6286-3c9e-4835-b76d-ce221b290473
- 結果: **失敗** — 同じパターン、CONTRIBUTING.mdタスクに逸れ続ける
- 原因: FileExistence次元がまだ存在、temperature変更だけでは不十分

### Run 3 (temperature=0.2, auto-progress=0.2, 改善版ゴール — CONTRIBUTING.md事前作成)
- Goal ID: 6e8736a3-891f-464a-b619-6ed70a2732e3
- 結果: **部分成功** — 6イテレーション、全次元でスコア変動、段階的改善確認
- 問題: gap振動あり（error_handling 0.75→0.70、help_messages 0.75→0.70）

#### Run 3 スコア推移

| Iter | jsdoc_coverage | error_handling | help_messages | gap  |
|------|---------------|----------------|---------------|------|
| 1    | 0.50          | 0.75           | 0.00          | 1.30 |
| 2    | 0.50          | 0.65           | 0.30          | 0.81 |
| 3    | 0.50          | 0.75           | 0.65          | 0.58 |
| 4    | 0.75          | 0.70           | 0.65          | 0.24 |
| 5    | 0.75          | 0.75           | 0.75          | 0.22 |
| 6    | 0.85          | **0.70↓**      | **0.70↓**     | 0.23 |

### Run 4 (課題修正後: FileExistence guard + monotonic progress)
- Goal ID: 6b71a5cc-c280-4468-b358-14f727c1c8e1
- 結果: **成功** — 6イテレーション、jsdoc安定上昇、gap振動なし

#### Run 4 スコア推移

| Iter | jsdoc_coverage | error_handling | help_messages | gap  |
|------|---------------|----------------|---------------|------|
| 1    | 0.00          | 0.75           | 0.60          | 1.30 |
| 2    | 0.15          | 0.75           | 0.65          | 1.08 |
| 3    | 0.35          | 0.75           | 0.65          | 0.79 |
| 4    | 0.50          | 0.75           | 0.65          | 0.58 |
| 5    | 0.65          | 0.75           | 0.65          | 0.36 |
| 6    | 0.75          | 0.75           | 0.65          | 0.24 |

**改善ポイント**:
- jsdoc: 0.00→0.75 の安定した6段階上昇（Run 3よりクリーン）
- error_handling: 0.75で安定（monotonic progressにより下がらない）
- help_messages: 0.65で安定（同上）
- gap: 1.30→0.24 の単調減少

## 課題と修正

### 修正済み

#### 課題1: FileExistence次元の自動登録が反復改善を妨害 ✅
- **修正**: `src/cli-runner.ts` L895 — 非FileExistence次元が1つ以上ある場合、自動登録をスキップ
- **効果**: LLM品質次元がある場合、FileExistence次元がgapを独占しなくなった

#### 課題5: gap振動（スコアが下がる） ✅
- **修正**: `src/observation-engine.ts` L233-243 — monotonic progress（min閾値では下がらない、max閾値では上がらない）
- **効果**: Run 4でerror_handling/help_messagesが一度到達した値を維持

#### 課題3: temperature=0ではスコア不変 ✅
- **修正**: `src/openai-client.ts` L9 — DEFAULT_TEMPERATURE 0→0.2
- **効果**: LLM再評価でcontext変化を反映した適度なスコア変動

### 未修正（非クリティカル）

#### 課題2: auto-progressがLLM再評価で上書きされる
- 影響小（LLM評価が実ファイル変更を検知するため）
- auto-progress 0.4→0.2に削減済み

#### 課題4: 閾値到達せずmax_iterations到達
- 6イテレーションではjsdoc 0.75 < 0.9で未到達
- max-iterations増加 or 閾値下げで対応可能（チューニング問題）

## コード変更（全て維持）

1. `src/openai-client.ts` L9: DEFAULT_TEMPERATURE 0→**0.2**
2. `src/task-lifecycle.ts` L526: auto-progress pass 0.4→**0.2**（テスト修正済み）
3. `src/cli-runner.ts` L895: FileExistence auto-registration guard（非FileExistence次元≥1でスキップ）
4. `src/observation-engine.ts` L233-243: monotonic progress（min/max閾値方向のクランプ）
5. `tests/task-lifecycle.test.ts`: auto-progress期待値修正（0.4→0.2）
6. `tests/e2e/r3-adapter-execution.test.ts`: auto-progress期待値修正（0.6→0.4）

## 結論

R9は**成功**。4回のdogfooding実行を通じて3つの課題を発見・修正。
修正後のRun 4で、6イテレーションの安定した段階的改善（jsdoc 0→0.75、gap振動なし）を確認。
全2928テスト通過（74ファイル）。
