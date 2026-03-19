# M14.1 Research: 構造化PIVOT/REFINE判断

## 対象ファイルと行数

| ファイル | 現行行数 | 役割 |
|---|---|---|
| `src/drive/stall-detector.ts` | 389行 | Stall検出・分類 |
| `src/strategy/strategy-manager-base.ts` | ~260行以上 | onStallDetected実装 |
| `src/strategy/strategy-manager.ts` | 296行 | Phase2ポートフォリオ操作 |
| `src/loop/core-loop-phases-b.ts` | 393行 | Phase6: detectStallsAndRebalance |
| `src/core-loop.ts` | 453行 | ループ本体（委譲のみ） |
| `src/types/stall.ts` | 25行 | StallReport, StallState |
| `src/types/strategy.ts` | 71行 | Strategy, Portfolio |
| `src/types/core.ts` | ~180行 | StallCauseEnum, StallTypeEnum |

---

## 現状のStallハンドリング（core-loop-phases-b.ts Phase6）

`detectStallsAndRebalance()` の流れ:
1. per-dimension stall → `checkDimensionStall()` → stall検出時 `strategyManager.onStallDetected(goalId, escalationLevel+1)`
2. global stall → `checkGlobalStall()` → stall検出時 `strategyManager.onStallDetected(goalId, 2)`
3. portfolio rebalance → `portfolioManager.shouldRebalance()` → `strategyManager.onStallDetected(goalId, 3)`
4. 戻り値が non-null → `result.pivotOccurred = true`

**onStallDetected()の現実装**（strategy-manager-base.ts L199）:
- stallCount < 2: null返却（通知のみ）
- stallCount >= 2: 現行戦略をterminateして新候補を生成・activateする
- **原因分析なし** — oscillating/flat/divergingの区別がない

---

## 現行型定義

**StallReport**（types/stall.ts）:
```
stall_type: "dimension_stall"|"time_exceeded"|"consecutive_failure"|"global_stall"
goal_id, dimension_name, task_id, detected_at
escalation_level: 0–3
suggested_cause: StallCauseEnum
decay_factor: 0–1
```

**StallCause**（types/core.ts L161）:
```
"information_deficit" | "approach_failure" | "capability_limit" | "external_dependency" | "goal_infeasible"
```
→ M14.1のStallCause (`parameter_issue`/`strategy_wrong`/`goal_unreachable`) は**既存enumに存在しない**。

**Strategy**（types/strategy.ts）:
```
id, goal_id, target_dimensions, primary_dimension, hypothesis, expected_effect,
resource_estimate, state, allocation, created_at, started_at, completed_at,
gap_snapshot_at_start, tasks_generated, effectiveness_score, consecutive_stall_count,
source_template_id, cross_goal_context
```
→ `rollbackTarget`, `maxPivotCount` は**未定義**（M14.1で追加必要）。

---

## 既存のPIVOT/REFINEコード・スタブ

- **なし**。設計doc（hypothesis-verification.md）に仕様はあるが、コードスタブはゼロ。
- `result.pivotOccurred`フラグは存在するが、REFINE/ESCALATE区別なし（pivot=戦略切替の意味のみ）。
- CoreLoopのfinalStatusは `"stalled"` のみ（ESCALATE→ゴール再交渉の分岐なし）。

---

## 各ファイルへの変更内容

### `src/types/stall.ts` / `src/types/core.ts`
- `StallCauseEnum`に `"parameter_issue"`, `"strategy_wrong"`, `"goal_unreachable"` を追加
- 新型 `StallAnalysis` を追加: `{ cause, confidence: number, evidence: string }`
- `StallAnalysisSchema` を `types/stall.ts` に追加

### `src/types/strategy.ts`
- `StrategySchema`に追加: `rollback_target_id: z.string().nullable().default(null)`, `max_pivot_count: z.number().default(2)`

### `src/drive/stall-detector.ts`
- **新メソッド `analyzeStallCause(gapHistory: Array<{normalized_gap: number}>): StallAnalysis`** を追加
  - oscillating判定: variance高 + mean変化小 → `parameter_issue`
  - flat判定: 変化量≈0 → `strategy_wrong`
  - diverging判定: 単調増加 → `goal_unreachable`
- `StallAnalysis`型は `types/stall.ts` からimport

### `src/strategy/strategy-manager-base.ts`
- `onStallDetected()` のシグネチャ変更: `StallAnalysis` を受け取るよう拡張
  - `cause=parameter_issue` → REFINEアクション（戦略はterminateせず、パラメータ調整タスクを生成）
  - `cause=strategy_wrong` → PIVOT（現行実装に近い、ただしrollback_targetを参照）
  - `cause=goal_unreachable` → ESCALATE（null返却 + フラグ）
  - pivot回数カウント（`consecutive_stall_count`流用またはpivot専用カウンタ）
  - maxPivotCount超過 → 強制ESCALATE

### `src/loop/core-loop-phases-b.ts`
- `detectStallsAndRebalance()` を拡張:
  - stall検出後 `stallDetector.analyzeStallCause(gapHistory)` を呼ぶ
  - `cause` に応じて3分岐: REFINE（戦略維持）/ PIVOT（戦略切替）/ ESCALATE（ゴール再交渉）
  - ESCALATE時: `result.stallReport.suggested_cause = "goal_unreachable"` + CoreLoopのescalationカウンタへ通知
  - `result.pivotOccurred` の意味を維持（PIVOTのみtrue）

### `src/core-loop.ts`
- `run()`のループ制御: ESCALATE分岐を追加
  - `finalStatus = "escalate_needed"` （新値）を追加（または既存 `"stalled"` を流用）
  - pivot回数 `maxPivotCount` を超えたESCALATEでループ終了

---

## 依存・注意点

- `StallCauseEnum`変更は**Zodスキーマ**なので既存の `StallReport` のparse/serializeに影響 → 既存テストのfixture確認必須
- `StrategySchema`変更は後方互換OK（`.default(null)` / `.default(2)` で既存JSONを破壊しない）
- `onStallDetected()`シグネチャ変更は **task-lifecycle.ts** が直接呼ばないが、`core-loop-phases-b.ts` が呼ぶ → phases-b側の変更で吸収可能
- `LoopResult.finalStatus`型変更は `core-loop-types.ts` にあるため、そこも変更対象
- テストファイル: `tests/stall-detector.test.ts`, `tests/strategy-manager.test.ts`, `tests/core-loop.test.ts`, `tests/core-loop-integration.test.ts`

---

## 設計docとの差異・Gap

- 設計doc: `StallCause = 'parameter_issue' | 'strategy_wrong' | 'goal_unreachable'`（新enum）
  → 既存`StallCause`（approach_failure等）との共存方法を決める必要あり（別型 or 既存enumに追加）
- 設計doc: `StallAnalysis`は独立型。`StallReport.suggested_cause`とは別。推奨: 別型として追加
- maxPivotCount=2: Strategyスキーマに追加するか、characterConfigに持つか未決（設計docはStrategyDefinition）
