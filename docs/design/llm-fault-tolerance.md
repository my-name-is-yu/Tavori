# LLMフォールト・トレランス設計

---

## 1. 概要

ConatusはLLMを観測・検証・タスク生成の3つの重要経路に使っている。LLMは正確な答えを返すことが多いが、確率的にハルシネーションや誤判定を起こす。1回の誤出力がシステム全体にどこまで影響するかを制限するのがこの設計の目的だ。

対象とする2つのメカニズム:

- **A. 影響範囲制限（Blast Radius Bound）** — LLMの1回の誤出力が与える影響量を上限で抑える
- **B. 不変条件ガード（Invariant Guard）** — LLMを使わず機械的に矛盾を検出し、誤出力をブロックする

**スコープ外**: マルチモデル投票・コンセンサス（コスト過多）、リトライ戦略（既実装）、スキーマバリデーション一般（別件）

---

## 2. 現状のリスク整理

実装調査（`memory/archive/llm-fault-tolerance-research.md`）で特定した高優先度のリスク:

| # | ファイル・箇所 | リスク | 深刻度 |
|---|--------------|--------|--------|
| 1 | `task-verifier.ts` L281/381 | L2判定が即トラスト更新（二次確認なし） | 高 |
| 2 | `task-verifier.ts` L316/348 | `dimension.current_value`をLLM出力から直接上書き（範囲チェックなし） | 高 |
| 3 | `observation-llm.ts` L97–107 | 証拠なし（contextProvider未提供+gitdiff不在）でスコア > 0.0 の可能性 | 中 |
| 4 | `gap-calculator.ts` | 誤観測スコアが偽サティスファイシング（ゴール完了誤検知）を引き起こす | 高 |
| 5 | `task-verifier.ts` L641 | `completion_judger`結果がZodバリデーションなし（`JSON.parse`のみ） | 中 |

---

## 3. A. 影響範囲制限（Blast Radius Bound）

### 3.1 トラスト変化レート制限

**目的**: LLMが短時間に連続して誤った`pass`判定を返しても、トラストが急上昇しないようにする。

**現状**: `TRUST_SUCCESS_DELTA = +3` のキャップはあるが、時間窓のレート制限はない。LLMが1分間に10回誤判定した場合、`+30`まで上昇できる。

**定義**:

```
トラスト上昇レート上限: +9 / 1時間（= 連続3回成功分）
  → 1時間に4回以上の`recordSuccess`呼び出しがあった場合、4回目以降は加算をスキップしてWARNログを出力

トラスト下降レート制限: なし（失敗は即座に反映する。ペナルティの迅速適用は安全側）
```

**実装箇所**: `src/traits/trust-manager.ts` の `recordSuccess()` 内

**ガード発動時の挙動**:
- 加算はスキップ（現在のトラスト値は変えない）
- `WARN: trust rate limit triggered (domain: ${domain}, window: 1h, count: ${count})` をログ出力

**優先度**: P1

---

### 3.2 `dimension_updates` 変化幅制限

**目的**: LLMの検証結果（`dimension_updates`）が `dimension.current_value` を大幅に書き換えることを防ぐ。

**現状**: `task-verifier.ts` L316/L348で `dimension.current_value = update.new_value` を直接代入している。範囲チェックなし。

**定義**:

```
許容変化幅: max(±0.3絶対値, 現在値の±30%)
  例: current_value = 0.2 の場合
    → 許容範囲: [0.0, 0.5]（±0.3絶対値が大きい）
  例: current_value = 0.8 の場合
    → 許容範囲: [0.56, 1.0]（±0.24絶対値 vs ±30% = ±0.24 ← 同等; キャップ[0,1]適用）

範囲外の変化を提案した場合: 上限/下限にキャップして警告ログを出力
```

**実装箇所**: `src/execution/task-verifier.ts` L316前後の `dimension_updates` 適用ループ内に `clampDimensionUpdate()` ヘルパー関数を追加

```typescript
function clampDimensionUpdate(current: number, proposed: number): number {
  const absLimit = 0.3;
  const relLimit = current * 0.3;
  const maxDelta = Math.max(absLimit, relLimit);
  const clamped = Math.max(current - maxDelta, Math.min(current + maxDelta, proposed));
  if (clamped !== proposed) {
    logger.warn(`dimension_update clamped: proposed=${proposed}, applied=${clamped}, current=${current}`);
  }
  return clamped;
}
```

**ガード発動時の挙動**:
- キャップされた値を書き込む（完全拒否はしない）
- WARNログを出力

**優先度**: P0

---

### 3.3 観測スコア変化幅制限

**目的**: LLMが1サイクルで観測スコアを大幅に変化させた場合（例: 0.1 → 0.9）、それを無確認でゴール状態に反映しない。

**現状**: `observation-llm.ts` はスコアを返し、`observation-engine.ts` がそのまま適用する。前回スコアとの差に対するチェックなし。

**定義**:

```
1サイクルあたりの最大スコア変化幅: ±0.4

ルール:
  - |new_score - prev_score| <= 0.4 → 通常通り適用
  - |new_score - prev_score| > 0.4 → 「要確認フラグ」付きで適用保留
    → 機械的ソース（DataSource）が利用可能な場合: 機械的値を優先（既存の cross-validation ロジックを流用）
    → 機械的ソースが利用不可の場合: prev_score を維持し、confidence = 0.3 に下げてWARNログを出力
```

**実装箇所**: `src/observation/observation-engine.ts` のLLM観測適用パス（`applyObservation()` 呼び出し前）

**ガード発動時の挙動**:
- 機械的ソースがあればそちらを採用（現状の cross-validation と同じ判断）
- 機械的ソースがなければ前回値を維持（スコアを変えない）
- WARNログ: `WARN: observation score jump suppressed: prev=${prev}, proposed=${new}, delta=${delta}`

**優先度**: P1

---

## 4. B. 不変条件ガード（Invariant Guard）

### 4.1 進捗-判定整合性チェック

**目的**: ギャップが増大（悪化）したのにLLMが`pass`を返すという矛盾を検出する。

**定義**:

```
チェック条件:
  prev_gap = 前サイクルのギャップ正規化値
  curr_gap = 今サイクルのギャップ正規化値（タスク実行後に再計算）
  verdict  = completion_judger の判定

矛盾条件: curr_gap > prev_gap + 0.05 AND verdict == "pass"
  → verdictを "partial" に強制上書き
  → WARNログ: `WARN: progress-verdict contradiction: gap increased (${prev_gap}→${curr_gap}) but verdict was pass. Overriding to partial.`
```

**実装箇所**: `src/execution/task-verifier.ts` の `handleVerdict()` 内、トラスト更新の前

**ガード発動時の挙動**:
- `verdict` を `partial` に書き換え（`pass`による`recordSuccess`を防ぐ）
- WARNログを出力

**優先度**: P0

---

### 4.2 重複タスクガード

**目的**: 最近完了・失敗したタスクと意味的に同一のタスクを再生成して無限ループに陥るのを防ぐ。

**定義**:

```
直近N件のタスク履歴（N=10）に対して:
  重複判定: task.description と recent_task.description の文字列類似度チェック
    → 簡易実装: タスク名のtrigram一致率 >= 0.7、かつステータスが "completed" or "failed"
    → 重複と判定した場合: タスク生成を拒否してWARNログ

将来: セマンティック埋め込みを使った類似度計算（VectorIndex利用可能になったら置き換え）
```

**実装箇所**: `src/execution/task-generation.ts` のタスク生成後、`TaskLifecycle` への返却前

**ガード発動時の挙動**:
- タスクを返さず `null` を返却（生成失敗扱い）
- WARNログ: `WARN: duplicate task rejected: similar to recently ${status} task "${recent_task.id}"`

**優先度**: P1

---

### 4.3 スコア-証拠整合性チェック

**目的**: 証拠なしで LLM が 0.0 以上のスコアを返すことへの対応。

**現状**: `observation-llm.ts` のプロンプトに `"Score MUST be 0.0"` という指示があるが、LLMが無視することがある（リスク#3）。

**定義**:

```
証拠なし判定条件:
  - contextProvider の結果が空（0件または空文字列）
  - git diff が空（変更なし）
  → この状態で LLM が score > 0.0 を返した場合:
    → score = 0.0 に強制上書き
    → confidence = 0.1 に設定
    → WARNログ: `WARN: score overridden to 0.0 (no evidence available, LLM returned ${score})`
```

**実装箇所**: `src/observation/observation-llm.ts` のLLMレスポンス処理後（L157–164の範囲）

**ガード発動時の挙動**:
- スコアを 0.0 に強制上書き
- confidence を 0.1 に設定
- WARNログを出力

**優先度**: P0

---

### 4.4 サティスファイシング二重確認ガード

**目的**: LLMの一時的な過大評価で「ゴール達成」が誤検知されることを防ぐ。

**現状**: `SatisficingJudge` はギャップが閾値以下になった時点でゴール完了と判定できる。1サイクルの観測で判定が可能。

**定義**:

```
ゴール「満足済み」宣言の条件:
  連続2サイクルの観測で gap <= threshold を確認
  → 1サイクル目: "satisficing_candidate" 状態に遷移（ゴール完了はしない）
  → 2サイクル目: gap <= threshold が再確認されれば "satisfied" に遷移
  → 2サイクル目: gap > threshold になれば "satisficing_candidate" をリセット

カウンターはゴール状態（`goal.json`）に `satisficing_streak` として保存する
```

**実装箇所**: `src/judgment/satisficing-judge.ts` の満足判定ロジック内

**ガード発動時の挙動**:
- 1サイクル目は完了宣言しない（次サイクルへ進む）
- WARNログ不要（通常の動作）
- 2サイクル連続でクリアしたときのみ完了

**優先度**: P0

---

### 4.5 `dimension_updates` 方向チェック

**目的**: タスクが「スコアを上げる」意図だったのに、LLMの`dimension_updates`が「下げる」値を返す矛盾を検出する。

**定義**:

```
チェック条件:
  task.intended_direction が定義されている場合（"increase" or "decrease"）
  かつ dimension_updates[dim].new_value が意図と逆方向の場合:
    → 矛盾としてWARNログ
    → dimension_updates を無視（current_value を変更しない）

task.intended_direction は task-generation.ts が付与する（現状未実装 → 本実装時に追加）
```

**現状の課題**: `task.intended_direction` フィールドが現在のタスクスキーマに存在しない。このガードを有効にするにはスキーマ追加が必要。

**実装箇所**:
- `src/types/tasks.ts` に `intended_direction?: "increase" | "decrease" | "neutral"` を追加
- `src/execution/task-generation.ts` のプロンプトに付与指示を追加
- `src/execution/task-verifier.ts` L316前後の適用ループ内でチェック

**ガード発動時の挙動**:
- `dimension_updates` を無視（値を変えない）
- WARNログ: `WARN: dimension_update direction mismatch: task intended ${intended}, but update suggests ${direction} for dim ${dim}`

**優先度**: P2（スキーマ変更が必要なため後回し）

---

### 4.6 `completion_judger` Zodバリデーション追加（補足）

**目的**: リスク#5の対処。`completion_judger` は現在 `JSON.parse` + 手動フィールドアクセスのみで、Zodスキーマがない。

**定義**:

```typescript
const CompletionJudgerResponseSchema = z.object({
  verdict: z.enum(["pass", "partial", "fail"]).default("fail"),
  reasoning: z.string(),
  criteria_met: z.number().int().min(0).optional(),
  criteria_total: z.number().int().min(0).optional(),
});
```

**実装箇所**: `src/execution/task-verifier.ts` L613–653の `completion_judger` 関数内、`llmClient.parseJSON()` に切り替え

**ガード発動時の挙動**:
- パース失敗時は既存の `{passed: false, confidence: 0.3}` フォールバックを維持

**優先度**: P1

---

### 4.7 検証失敗理由の次サイクル注入（LangGraph由来）

**目的**: タスク検証が失敗した際、その失敗理由を次のタスク生成プロンプトに明示的に注入し、同じミスの繰り返しを防ぐ。

**現状**: タスク失敗 → stall-detector が検知 → 新タスク生成。だが「なぜ失敗したか」の詳細（verification result の reasoning、criteria_met/criteria_total）がタスク生成プロンプトに渡っていない。

**定義**:

```
タスク検証失敗時（verdict = "fail" or "partial"）:
  → verification_result の以下を保存:
    - reasoning（失敗理由）
    - criteria_met / criteria_total
    - verdict
  → 次の generateTask() 呼び出し時に、プロンプトに以下を追加:
    "前回のタスク「${prev_task.description}」は以下の理由で${verdict}と判定された:
     ${reasoning}
     達成基準: ${criteria_met}/${criteria_total}
     この失敗を踏まえて、異なるアプローチのタスクを生成すること。"
```

**実装箇所**:
- 失敗理由の保存: `src/execution/task-verifier.ts` の `handleVerdict()` 内で `StateManager` に `last_failure_context` として書き込み
- プロンプト注入: `src/execution/task-generation.ts` のプロンプト構築部分で `last_failure_context` を読み込んで注入

**ガード発動時の挙動**: 通常動作（ガードではなく情報注入）。失敗理由がない場合はスキップ。

**優先度**: P1

---

### 4.8 CoreLoopチェックポイント（AutoGen由来）

**目的**: CoreLoop実行中のクラッシュや中断から、最後の正常状態に復帰できるようにする。

**現状**: CoreLoopはループ中にクラッシュすると途中の状態が失われる。自動アーカイブ機能（ゴール完了時に `~/.conatus/archive/<goalId>/` に移動）は存在するが、ループ途中のチェックポイントはない。

**定義**:

```
チェックポイント保存タイミング: 各verify成功後（1サイクル完了時点）
保存先: ~/.conatus/goals/<goalId>/checkpoint.json
内容:
  - cycle_number: 現在のサイクル番号
  - last_verified_task_id: 最後に検証成功したタスクID
  - dimension_snapshot: 全dimension.current_valueのスナップショット
  - trust_snapshot: 現在のtrust値
  - timestamp: ISO形式

復帰時の動作:
  - CoreLoop起動時に checkpoint.json の存在を確認
  - 存在すれば dimension_snapshot と trust_snapshot から状態を復元
  - last_verified_task_id 以降のタスクを再実行対象とする
  - WARNログ: "Resuming from checkpoint (cycle ${cycle_number}, task ${last_verified_task_id})"
```

**実装箇所**:
- チェックポイント書き込み: `src/core/core-loop.ts` のverify成功後
- チェックポイント読み込み: `src/core/core-loop.ts` のループ開始時

**ガード発動時の挙動**: 通常動作（ガードではなくリカバリ機構）。チェックポイントがない場合は通常のゼロスタート。

**優先度**: P1

---

## 5. 実装優先度まとめ

| 優先度 | ガード | ファイル |
|--------|--------|----------|
| P0 | 3.2 `dimension_updates` 変化幅制限 | `task-verifier.ts` |
| P0 | 4.1 進捗-判定整合性チェック | `task-verifier.ts` |
| P0 | 4.3 スコア-証拠整合性チェック | `observation-llm.ts` |
| P0 | 4.4 サティスファイシング二重確認ガード | `satisficing-judge.ts` |
| P1 | 3.1 トラスト変化レート制限 | `trust-manager.ts` |
| P1 | 3.3 観測スコア変化幅制限 | `observation-engine.ts` |
| P1 | 4.2 重複タスクガード | `task-generation.ts` |
| P1 | 4.6 `completion_judger` Zodバリデーション | `task-verifier.ts` |
| P1 | 4.7 検証失敗理由の次サイクル注入 | `task-verifier.ts`, `task-generation.ts` |
| P1 | 4.8 CoreLoopチェックポイント | `core-loop.ts` |
| P2 | 4.5 `dimension_updates` 方向チェック | `task-verifier.ts` + スキーマ変更 |

---

## 6. 設計上の判断と境界

**「キャップして通す」vs「完全拒否」**: 変化幅制限（§3.2, §3.3）はキャップして値を書き込む。完全拒否すると観測データが更新されず、システムが現状把握できなくなるリスクがある。キャップはより保守的な動作であり、逆方向の誤りを避けられる。

**判定矛盾の場合は保守的側に倒す**: 進捗-判定矛盾（§4.1）は`pass`→`partial`に格下げする。見落としより誤検知（false positive）を優先するのはConatusの安全設計の原則と一致する。

**サティスファイシング二重確認のサイクル数**: 2回に設定した。1回は不十分（LLMが一時的に過大評価）、3回以上は収束が遅くなる。観測コストが高いゴールでは設定可能なパラメータとして外出しすることを将来検討する。

**レート制限の粒度**: トラストのレート制限は1時間窓（固定）。実運用では短すぎることがあるが、MVPでは保守的に設定する。窓サイズは将来設定可能にする。
