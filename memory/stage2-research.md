# Stage 2 実装リサーチサマリー

作成日: 2026-03-10
対象: Stage 2 — DriveSystem, TrustManager, ObservationEngine, DriveScorer, SatisficingJudge, StallDetector

---

## 1. 実装対象モジュール一覧

### Layer 1 (Stage 2前半)
- `src/drive-system.ts` — DriveSystem (イベントキュー処理、起動チェック、スケジューリング)
- `src/trust-manager.ts` — TrustManager (トラストバランス管理、象限判定)

### Layer 2 (Stage 2後半)
- `src/observation-engine.ts` — ObservationEngine (3層観測、進捗上限、観測ログ)
- `src/drive-scorer.ts` — DriveScorer (3駆動スコア計算、統合)
- `src/satisficing-judge.ts` — SatisficingJudge (完了判断、プログレス上限)
- `src/stall-detector.ts` — StallDetector (停滞検知、分類、decay_factor)

---

## 2. モジュール別設計詳細

### 2.1 DriveSystem (`drive-system.md`)

#### 役割
「今、注意を向けるべきゴールがあるか」を判断する軽量チェック機構。LLM呼び出しなし。

#### 主要機能
1. **4種トリガー管理**:
   - `scheduled`: ゴール種別ごとの定期チェック (health: 30〜60分, business: 数時間〜1日, project: 1日〜1週)
   - `event_driven`: ファイルキュー `~/.motiva/events/` の読み取り・アーカイブ
   - `completion_driven`: タスク完了後の即時再評価
   - `deadline_driven`: 残り時間に応じた段階的頻度強化
     ```
     1ヶ月以上 → ×1.0
     1ヶ月     → ×1.5
     2週間     → ×2.0
     1週間     → ×3.0
     2日       → 毎日
     ```

2. **軽量起動チェックシーケンス** (LLM不要):
   ```
   1. イベントキューに未処理イベントあり？ → Yes → 起動
   2. 期限切れスケジュールあり？ → Yes → 起動
   3. 完了通知受け取り？ → Yes → 起動
   4. 全ゴールが満足/待機状態か？ → Yes → 休眠継続
   5. それ以外 → 起動
   ```

3. **イベント処理 (MVP: ファイルキュー)**:
   - `~/.motiva/events/` のJSONファイルをタイムスタンプ順で処理
   - 処理済みを `~/.motiva/events/archive/` に移動
   - イベントフォーマット: `{ type, source, timestamp (ISO 8601), data }`

4. **マルチゴール優先付き処理**:
   - 複数ゴールが同時起動 → DriveScoreの高い順に処理
   - 並列実行可能なら並列、不可なら直列

5. **トリガー重複処理**: 同ゴールへの複数トリガーは単一評価サイクルに統合

#### 公開インターフェース (推定)
```typescript
class DriveSystem {
  constructor(stateManager: StateManager, baseDir?: string)

  // 起動チェック (LLM不要、軽量)
  shouldActivate(goalId: string): boolean

  // イベントキューの読み取りと処理
  readEventQueue(): MotivaEvent[]
  archiveEvent(eventFileName: string): void

  // スケジュール管理
  isScheduleDue(goalId: string): boolean
  updateSchedule(goalId: string, nextCheckAt: string): void

  // 複数ゴールのソート
  prioritizeGoals(goalIds: string[], scores: Map<string, number>): string[]
}
```

#### 依存型 (既存)
- `MotivaEvent` — `src/types/drive.ts` に定義済み
- `StateManager` — `src/state-manager.ts`

#### 新規型の必要性
- スケジュール状態を保持するための型が必要:
  ```typescript
  // ~/.motiva/schedule/<goal_id>.json に保存
  GoalSchedule {
    goal_id: string
    next_check_at: string  // ISO 8601
    check_interval_hours: number
    last_triggered_at: string | null
    trigger_history: Array<{ trigger_type, timestamp }>
  }
  ```

---

### 2.2 TrustManager (`trust-and-safety.md`)

#### 役割
ドメイン別トラストバランス管理と、trust×confidence による4象限判定。

#### 数値仕様 (固定値)
```
初期値: 0
最小値: -100, 最大値: +100
成功時 Δs: +3
失敗時 Δf: -10
高トラスト境界: >= 20
高確信度境界: >= 0.50
```

これらは `src/types/trust.ts` に定数として既に定義済み:
- `HIGH_TRUST_THRESHOLD = 20`
- `HIGH_CONFIDENCE_THRESHOLD = 0.50`
- `TRUST_SUCCESS_DELTA = 3`
- `TRUST_FAILURE_DELTA = -10`

#### 4象限マトリクス (既存型 `ActionQuadrant` に対応)
```
trust >= 20 AND confidence >= 0.50 → "autonomous"
trust >= 20 AND confidence < 0.50  → "execute_with_confirm"
trust < 20  AND confidence >= 0.50 → "execute_with_confirm"
trust < 20  AND confidence < 0.50  → "observe_and_propose"
```

注: 設計ドキュメントでは象限2と3を区別するが、型は両方を `execute_with_confirm` にまとめている。これは **Confirmed** (trust.ts:22-27)。

#### 不可逆アクション判定
- `reversibility` が `"irreversible"` or `"unknown"` → 常に人間承認必須 (象限マトリクス無効化)
- タスク実行前に評価。discard時も同様。

#### ユーザーオーバーライド
- 永続ゲート: 特定カテゴリに対してスコアに関わらず確認強制
- 信頼付与: trast_balanceをユーザー指定値に設定
- オーバーライドはログに記録 (理由・日時・before/after)

#### 公開インターフェース (推定)
```typescript
class TrustManager {
  constructor(stateManager: StateManager)

  // ドメイン別バランス取得・更新
  getBalance(domain: string): TrustBalance
  recordSuccess(domain: string): TrustBalance
  recordFailure(domain: string): TrustBalance

  // 象限判定
  getActionQuadrant(domain: string, confidence: number): ActionQuadrant

  // 不可逆アクション判定
  requiresApproval(reversibility: Reversibility, domain: string, confidence: number): boolean

  // ユーザーオーバーライド
  setOverride(domain: string, balance: number): void
  addPermanentGate(domain: string, category: string): void

  // 永続化
  loadTrustStore(): TrustStore
  saveTrustStore(store: TrustStore): void
}
```

#### 依存型 (既存)
- `TrustBalance`, `TrustStore`, `ActionQuadrant` — `src/types/trust.ts` に定義済み
- `HIGH_TRUST_THRESHOLD`, `HIGH_CONFIDENCE_THRESHOLD`, `TRUST_SUCCESS_DELTA`, `TRUST_FAILURE_DELTA` — 定数も定義済み
- `ReversibilityEnum` — `src/types/core.ts` に定義済み

#### 新規型の必要性
- ユーザーオーバーライドログ型:
  ```typescript
  TrustOverrideLog {
    timestamp: string
    override_type: "trust_grant" | "permanent_gate"
    domain: string
    target_category?: string
    balance_before?: number
    balance_after?: number
  }
  ```
- `TrustStore` の拡張: `permanent_gates: Record<string, string[]>` フィールド追加検討

#### 永続化パス
`~/.motiva/trust/trust-store.json` (StateManagerのwriteRaw/readRawを使用)

---

### 2.3 ObservationEngine (`observation.md`)

#### 役割
「この次元は今どういう状態か、どの程度信頼できるか」を答える。3層観測アーキテクチャ。

#### 3層アーキテクチャ
| Layer | 信頼度 | 範囲 |
|-------|--------|------|
| mechanical | 0.85〜1.0 | テスト、ファイル存在、API、DB、センサー |
| independent_review | 0.50〜0.84 | 独立LLMセッション (Task/Goal Reviewer) |
| self_report | 0.10〜0.49 | 実行者の自己申告 |

#### 進捗上限ルール (Progress Ceiling)
```
evidence_level == "mechanical"         → progress_ceiling = 1.0
evidence_level == "independent_review" → progress_ceiling = 0.90
evidence_level == "self_report"        → progress_ceiling = 0.70 (デフォルト)

effective_progress = min(calculated_progress, progress_ceiling)
```

**重要**: 進捗上限は状態ベクトルへの記録値を制限するデータ品質ゲート。スコアリング調整ではない。スコアリング調整はGapCalculatorが担当。

#### 証拠ゲートと検証タスク自動生成
```
if effective_progress >= threshold AND confidence < 0.85:
    → 「機械的手段で検証せよ」タスクを自動生成
```

#### 観測ログエントリ構造
既存型 `ObservationLogEntry` (`src/types/state.ts`) が完全に対応:
- `observation_id`, `timestamp`, `trigger`, `goal_id`, `dimension_name`
- `layer`, `method`, `raw_result`, `extracted_value`, `confidence`, `notes`

#### Dimension.history との結合
- 結合キー: `goal_id + dimension_name + timestamp` (タプルで一意)
- `Dimension.history[].source_observation_id` → `ObservationLog[].observation_id`

#### 矛盾解決ルール
```
優先度: mechanical > independent_review > self_report
機械的観測内で矛盾: 悲観的な方(最小値)を採用 + 解消タスク生成
自己申告 vs mechanical: mechanicalを採用
```

#### 公開インターフェース (推定)
```typescript
class ObservationEngine {
  constructor(stateManager: StateManager, adapterConfig?: AdapterConfig)

  // 観測実行 (Layer 1のみ、MVP)
  observe(goalId: string, dimensionName: string, trigger: ObservationTrigger): Promise<ObservationLogEntry>
  observeAllDimensions(goalId: string, trigger: ObservationTrigger): Promise<ObservationLogEntry[]>

  // 進捗上限適用
  applyProgressCeiling(progress: number, confidenceTier: ConfidenceTier): number

  // 証拠ゲート判定
  needsVerificationTask(effectiveProgress: number, confidence: number, threshold: number): boolean

  // 観測結果の状態ベクトルへの反映
  applyObservationToGoal(goalId: string, entry: ObservationLogEntry): void

  // 矛盾検出
  detectContradictions(entries: ObservationLogEntry[]): ContradictionReport[]
}
```

#### 依存型 (既存)
- `ObservationLogEntry`, `ObservationLog` — `src/types/state.ts`
- `ObservationMethod`, `ObservationTrigger`, `ObservationLayer`, `ConfidenceTier` — `src/types/core.ts`
- `Dimension`, `Goal` — `src/types/goal.ts`
- `StateManager` — `src/state-manager.ts`

#### 新規型の必要性
- `ContradictionReport` (矛盾検出結果)
- MVP範囲ではLayer 1 (mechanical) の実際の実行機構は外部アダプターに依存するため、実行インターフェースは抽象化が必要

---

### 2.4 DriveScorer (`drive-scoring.md`)

#### 役割
ギャップベクトルから「どの次元を次に攻めるか」の優先スコアを計算する。純粋関数。

#### 入力前提
- 入力は `normalized_weighted_gap(dim)` — GapCalculatorのパイプライン済み値 ([0,1])
- 単位の違いを吸収済み

#### 3つの駆動スコア計算式

**1. 不満駆動 (Dissatisfaction Drive)**
```
score_dissatisfaction(dim) = normalized_weighted_gap(dim) × decay_factor(t)

decay_factor(t) = decay_floor + (1 - decay_floor) × (1 - exp(-t / recovery_time))
  where:
    t = 最後に試みてからの経過時間 (hours)
    decay_floor = 0.3 (デフォルト)
    recovery_time = 24 (hours, デフォルト)
```

**2. 締切駆動 (Deadline Drive)**
```
score_deadline(dim) = normalized_weighted_gap(dim) × urgency(T)

urgency(T) = exp(urgency_steepness × (1 - T / deadline_horizon))
  where:
    T = 残り時間 (hours)
    deadline_horizon = 168 (hours = 1週間, デフォルト)
    urgency_steepness = 3.0 (デフォルト)

特殊ケース:
  T >= deadline_horizon → urgency = 1.0
  T < 0 (overdue) → score = cap (最大値固定)
  deadline なし → score = 0
```

**3. 機会駆動 (Opportunity Drive)**
```
score_opportunity(dim) = opportunity_value(dim) × freshness_decay(t)

opportunity_value(dim) = downstream_impact(dim) × (1 + external_bonus(dim) + timing_bonus(dim))
  where:
    downstream_impact = dependent_dims / total_dims  [0.0, 1.0]
    external_bonus = 0.0 | 0.25 | 0.5  (イベントキューから)
    timing_bonus = 0.0 | 0.25 | 0.5    (LLM評価)

freshness_decay(t) = exp(-ln(2) × t / half_life)
  where:
    t = 機会検知からの経過時間 (hours)
    half_life = 12 (hours, デフォルト)

opportunity_value の範囲: [0.0, 2.0]
```

#### スコア統合: Max + 締切オーバーライド
```
final_score(dim) = max(score_dissatisfaction, score_deadline, score_opportunity)

ただし:
if urgency(T) >= urgency_override_threshold (デフォルト: 10.0):
    final_score(dim) = score_deadline  // 他の駆動を無視
```

#### DriveConfig (既存型 `DriveConfigSchema` が完全対応)
```typescript
// src/types/drive.ts に定義済み:
DriveConfig {
  decay_floor: 0.3,
  recovery_time_hours: 24,
  deadline_horizon_hours: 168,
  urgency_steepness: 3.0,
  urgency_override_threshold: 10.0,
  half_life_hours: 12,
}
```

#### 期限なしゴールのペース制御
```
min_check_interval: 1h (デフォルト)
max_check_interval: 24h (デフォルト)
max_consecutive_actions: 5 (デフォルト)
cooldown_duration: 6h (デフォルト)
significant_change_threshold: 0.05 (正規化ギャップの5%)
backoff_factor: 1.5

変化あり → interval = min_check_interval
変化なし → interval = min(interval × backoff_factor, max_check_interval)
```

#### 公開インターフェース (推定)
```typescript
class DriveScorer {
  constructor(config?: DriveConfig)

  // 個別駆動スコア (純粋関数)
  scoreDissatisfaction(normalizedWeightedGap: number, timeSinceLastAttemptHours: number): DissatisfactionScore
  scoreDeadline(normalizedWeightedGap: number, timeRemainingHours: number | null): DeadlineScore
  scoreOpportunity(opportunityValue: number, timeSinceDetectedHours: number): OpportunityScore

  // 統合スコア
  combineDriveScores(d: DissatisfactionScore, dl: DeadlineScore, o: OpportunityScore): DriveScore

  // 全次元のスコア計算
  scoreAllDimensions(gapVector: GapVector, context: DriveContext): DriveScore[]

  // ランキング
  rankDimensions(scores: DriveScore[]): DriveScore[]
}

// DriveContext: 各次元に必要なコンテキスト情報
interface DriveContext {
  timeSinceLastAttempt: Map<string, number>  // dimension_name -> hours
  deadlines: Map<string, number | null>       // dimension_name -> time_remaining_hours
  opportunities: Map<string, { value: number; detected_at: string }>
}
```

#### 依存型 (既存)
- `DissatisfactionScore`, `DeadlineScore`, `OpportunityScore`, `DriveScore`, `DriveConfig` — `src/types/drive.ts` に定義済み
- `GapVector`, `WeightedGap` — `src/types/gap.ts`

#### 新規型の必要性
- `DriveContext` インターフェース (上記)
- `PaceConfig` (期限なしゴールのペース制御パラメータ)

---

### 2.5 SatisficingJudge (`satisficing.md`)

#### 役割
「全次元が閾値を超え、かつ十分な証拠があるか」を判定する。完了判断の最終ゲート。

#### 完了判断フロー
```
全次元の current_value >= threshold？
  No → ループ継続
  Yes → 完了候補
         ↓
    各次元の confidence 確認
    全次元で high/medium → 完了
    low の次元あり → 検証タスク生成 → 再判断
```

#### プログレス上限ルール (SatisficingJudge版)
ObservationEngineのものと似ているが、完了判断に特化:
```
confidence high   → ceiling = 1.00
confidence medium → ceiling = 0.85 (観測の0.90と異なる点に注意)
confidence low    → ceiling = 0.60 (観測の0.70と異なる点に注意)

reported_progress = min(actual_evidence_score, ceiling)
```

**注意**: observation.md と satisficing.md で ceiling の値が異なる。
- observation.md §4: `self_report → 0.70`, `independent_review → 0.90`
- satisficing.md §2: `low → 0.60`, `medium → 0.85`
実装では**どちらの数値を使うか方針を統一する必要がある**。設計の優先階層上、observation.md (進捗上限はデータ品質ゲート) が先、satisficing.md は完了判断コンテキストでの適用と解釈するのが自然。

#### 完了宣言の必須チェックリスト
```
□ 全次元の現在値が閾値を超えているか
□ 各次元の観測信頼度が "high" or "medium" か
□ 機械的検証 (Layer 1) 完了
□ 独立レビューセッション (Layer 2) 完了
□ 過去48時間以内の観測に基づいているか
```

#### イテレーション制約
```typescript
iteration_constraints {
  max_dimensions: number          // 1イテレーションで攻める最大次元数 (デフォルト: 2〜3)
  uncertainty_threshold: number   // これ以下の信頼度の次元は観測タスク先行
  divergence_filter: string       // 意味的距離フィルタ
}
```

#### サブゴール完了の伝播 (MVP)
- 名前一致による直接マッピングのみ
- マッピング未定義 → サブゴールの完了ステータス (0 or 1) が上位ゴールの1次元として伝播

#### 閾値調整提案生成条件
```
- 同一次元で3回以上タスク失敗、かつ閾値に近づく気配なし
- 他の次元が全閾値超えなのに一つだけ大幅に低くボトルネック
- 当初想定より大幅に少ないリソースで閾値を超えた
```

#### 公開インターフェース (推定)
```typescript
class SatisficingJudge {
  constructor(stateManager: StateManager)

  // ゴールレベルの完了判断
  isGoalComplete(goal: Goal): CompletionJudgment

  // 個別次元の充足確認
  isDimensionSatisfied(dim: Dimension): DimensionSatisfaction

  // プログレス上限の適用
  applyProgressCeiling(actualProgress: number, confidence: number): number

  // イテレーション次元選択
  selectDimensionsForIteration(
    gapVector: GapVector,
    driveScores: DriveScore[],
    constraints: IterationConstraints
  ): string[]  // 選択された次元名リスト

  // 閾値調整提案の検出
  detectThresholdAdjustmentNeeded(goal: Goal, taskHistory: Task[]): ThresholdAdjustmentProposal[]

  // サブゴール完了の伝播
  propagateSubgoalCompletion(subgoalId: string, parentGoal: Goal): Goal
}

interface CompletionJudgment {
  is_complete: boolean
  blocking_dimensions: string[]  // 未充足の次元
  low_confidence_dimensions: string[]  // 証拠不十分の次元
  needs_verification_task: boolean
}
```

#### 依存型 (既存)
- `Goal`, `Dimension`, `DimensionMapping` — `src/types/goal.ts`
- `GapVector`, `WeightedGap` — `src/types/gap.js`
- `DriveScore` — `src/types/drive.ts`
- `Task` — `src/types/task.ts`

#### 新規型の必要性
- `CompletionJudgment` インターフェース
- `DimensionSatisfaction` インターフェース
- `IterationConstraints` インターフェース
- `ThresholdAdjustmentProposal` インターフェース

---

### 2.6 StallDetector (`stall-detection.md`)

#### 役割
ループが無意味に回り続けていないかを検知するサーキットブレーカー。

#### 4種の停滞タイプ (既存型 `StallTypeEnum` に対応)
```
"dimension_stall"      — 特定次元のギャップが N ループ以上縮まらない
"time_exceeded"        — タスクの見積もり時間の2倍を超過
"consecutive_failure"  — 同種タスクが連続で検証失敗
"global_stall"         — 全次元で N ループ以上改善なし
```

#### 5種の停滞原因 (既存型 `StallCauseEnum` に対応)
```
"information_deficit"   — 観測信頼度が低い次元で停滞
"approach_failure"      — 情報十分だがギャップ縮まらない
"capability_limit"      — ツール/権限/知識の範囲外
"external_dependency"   — Motivaが制御できない外部待ち
"goal_infeasible"       — 複数ピボット後も全体停滞継続
```

#### 検知閾値 (次元種別別 N)
```
即時反映 (テスト結果、API応答) → N = 3
中期反映 (売上、顧客満足度)    → N = 5
長期反映 (組織、市場)          → N = 10
```

#### 時間超過の閾値
```
見積もりあり: 見積もり時間 × 2
見積もりなし (estimated_duration = null):
  コーディング・実装: 2時間
  調査・リサーチ: 4時間
  その他・不明: 3時間
```

#### plateau_until による抑制
```
plateau_until が設定されており AND 現在時刻 < plateau_until
  → §2.1〜§2.4 のすべての停滞検知を抑制
plateau_until 過ぎたら → 通常の検知再開
```

#### 段階的対応
```
第1検知 → 同戦略内で別アプローチ試行
第2検知 → 別戦略にピボット
第3検知 → 人間にエスカレーション
```
段階リセット: 停滞次元で有意な改善時にゼロに戻す

#### DecayFactor フィードバック (DriveScorer連携)
```
停滞検知 → decay_factor = 0.6 を不満駆動スコアに適用
停滞解消後の回復スケジュール:
  解消直後: 0.6 → 0.75
  2ループ後: 0.75 → 0.9
  4ループ後: 0.9 → 1.0 (正常)
```

#### 停滞タイプ → 原因の診断マッピング
```
dimension_stall     → アプローチ失敗, 能力の限界 (可能性高)
time_exceeded       → 外部依存, アプローチ失敗 (可能性高)
consecutive_failure → アプローチ失敗, 能力の限界, ゴール実行不可能 (可能性高)
global_stall        → ゴール実行不可能, 外部依存 (可能性高)
```

#### 公開インターフェース (推定)
```typescript
class StallDetector {
  constructor(stateManager: StateManager)

  // 全タイプの停滞チェック (1回のループで呼ぶ)
  checkStalls(goalId: string): StallReport[]

  // 個別タイプのチェック
  checkDimensionStall(goalId: string, dimensionName: string, history: GapHistoryEntry[]): boolean
  checkTimeExceeded(task: Task): boolean
  checkConsecutiveFailures(goalId: string, taskCategory: string, dimensionName: string): boolean
  checkGlobalStall(goalId: string, history: GapHistoryEntry[]): boolean

  // 原因診断
  classifyStallCause(stall: StallReport, goal: Goal): StallCause

  // decay_factor の計算
  computeDecayFactor(stallCount: number, loopsSinceRecovery: number | null): number

  // plateau_until チェック
  isSupressed(plateauUntil: string | null): boolean

  // 段階的対応レベルの管理
  getEscalationLevel(goalId: string, dimensionName: string): 0 | 1 | 2 | 3
  incrementEscalation(goalId: string, dimensionName: string): void
  resetEscalation(goalId: string, dimensionName: string): void
}

interface StallReport {
  stall_type: StallType
  goal_id: string
  dimension_name?: string
  task_id?: string
  detected_at: string
  escalation_level: number
  suggested_cause: StallCause
  decay_factor: number
}
```

#### 依存型 (既存)
- `StallTypeEnum`, `StallCauseEnum` — `src/types/core.ts`
- `Task` — `src/types/task.ts`: `consecutive_failure_count`, `plateau_until`, `estimated_duration`, `task_category` が利用可能
- `Strategy` — `src/types/strategy.ts`: `consecutive_stall_count` が利用可能
- `GapHistoryEntry` — `src/types/gap.ts`
- `StateManager` — `src/state-manager.ts`

#### 新規型の必要性
- `StallReport` インターフェース
- エスカレーションレベルの永続化: `~/.motiva/stalls/<goal_id>.json`

---

## 3. Stage 1 パターン — 実装慣習

### 3.1 クラス構造パターン (StateManager, GapCalculator から)

**StateManager パターン**:
- `class` + `constructor(dep?: optional)`
- プライベートメソッドに `private readonly` または `private`
- ファイルI/Oは `atomicWrite` (tmp→rename) で安全性を保証
- Zodスキーマで parse & validate (入力も出力も)
- `null` を「存在しない」の標準表現として使用
- エラーは `throw new Error(message)` (カスタムエラークラスなし)

**GapCalculator パターン**:
- 純粋関数群 (`export function`)
- 副作用なし
- 型引数は型エイリアス (インターフェースではなく `z.infer<>`)
- 追加のインターフェースは `export interface` で定義
- ヘルパーは非エクスポート (`function toNumber`, `function isTruthy`)

### 3.2 テストパターン (vitest)

Stage 1のテストから読み取れるパターン:
- `describe` ブロックでメソッドごとにグループ化
- `it()` で個別テストケース
- `expect(...).toBe()`, `expect(...).toEqual()` を使用
- エラーケースは `expect(() => ...).toThrow()`
- 一時ディレクトリは `os.tmpdir()` + `Math.random()` で分離
- テスト後のクリーンアップは `afterEach` / `afterAll`

### 3.3 インポート/エクスポート規約

- ESM (`"type": "module"` in package.json, `Node16` module resolution)
- ローカルインポートは `.js` 拡張子付き: `from "./types/goal.js"`
- 型インポートは `import type { ... }` で分離
- `src/index.ts` から全パブリックAPIを再エクスポート

### 3.4 型定義規約

- すべての型は Zod スキーマ + `z.infer<>` パターン
- スキーマ名: `<TypeName>Schema`
- 型名: `<TypeName>`
- 両方エクスポート
- enum は `z.enum(["a", "b"])` + `const <Name>Enum = z.enum(...)` パターン
- 定数値 (マジックナンバー) は `export const CONSTANT_NAME = value` で分離

---

## 4. 依存関係と実装順序

### 依存グラフ (Stage 2)

```
Layer 1 (依存なし — StateManagerのみに依存):
  DriveSystem    → StateManager
  TrustManager   → StateManager

Layer 2 (Layer 1 + Stage 1 に依存):
  ObservationEngine → StateManager, [DriveSystem (イベントトリガー連携)]
  DriveScorer       → GapCalculator (normalized_weighted_gap を入力), [DriveSystem (機会イベント)]
  SatisficingJudge  → StateManager, GapCalculator, [ObservationEngine (信頼度判定)]
  StallDetector     → StateManager, [DriveScorer (decay_factor フィードバック)]
```

### 推奨実装順序

1. **TrustManager** — 最も独立性が高い。依存は StateManager のみ。型も完全に揃っている。
2. **DriveSystem** — StateManager と MotivaEvent 型のみに依存。スケジュール型の追加が必要。
3. **DriveScorer** — 純粋関数が中心。GapCalculatorの出力を受け取る。DriveConfig型は既存。
4. **ObservationEngine** — StateManager + 観測型に依存。実際の実行は抽象化でMVP可能。
5. **StallDetector** — Task, Strategy, GapHistoryEntry に依存。DriveScorer との連携 (decay_factor) が必要だが、計算自体は独立可能。
6. **SatisficingJudge** — 上記全てを統合する判定ロジック。最後に実装するのが自然。

---

## 5. 新規追加が必要な型

既存型ファイルへの追加または新規ファイルの作成が必要なもの:

### `src/types/drive.ts` への追加
```typescript
// DriveContext: DriveScorer が必要とするコンテキスト
export const DriveContextSchema = z.object({
  time_since_last_attempt: z.record(z.string(), z.number()),  // dim -> hours
  deadlines: z.record(z.string(), z.number().nullable()),      // dim -> time_remaining_hours
  opportunities: z.record(z.string(), z.object({
    value: z.number(),
    detected_at: z.string(),
  })),
})

// PaceConfig: 期限なしゴールのペース制御
export const PaceConfigSchema = z.object({
  min_check_interval_hours: z.number().default(1),
  max_check_interval_hours: z.number().default(24),
  max_consecutive_actions: z.number().default(5),
  cooldown_duration_hours: z.number().default(6),
  significant_change_threshold: z.number().default(0.05),
  backoff_factor: z.number().default(1.5),
})

// GoalSchedule: DriveSystem が管理するスケジュール状態
export const GoalScheduleSchema = z.object({
  goal_id: z.string(),
  next_check_at: z.string(),
  check_interval_hours: z.number(),
  last_triggered_at: z.string().nullable().default(null),
  consecutive_actions: z.number().default(0),
  cooldown_until: z.string().nullable().default(null),
  current_interval_hours: z.number(),
})
```

### `src/types/trust.ts` への追加
```typescript
export const TrustOverrideLogEntrySchema = z.object({
  timestamp: z.string(),
  override_type: z.enum(["trust_grant", "permanent_gate"]),
  domain: z.string(),
  target_category: z.string().nullable().default(null),
  balance_before: z.number().nullable().default(null),
  balance_after: z.number().nullable().default(null),
})

// TrustStore の拡張
// permanent_gates: Record<domain, string[]> フィールドを追加
```

### `src/types/stall.ts` (新規)
```typescript
export const StallReportSchema = z.object({
  stall_type: StallTypeEnum,
  goal_id: z.string(),
  dimension_name: z.string().nullable().default(null),
  task_id: z.string().nullable().default(null),
  detected_at: z.string(),
  escalation_level: z.number().min(0).max(3).default(0),
  suggested_cause: StallCauseEnum,
  decay_factor: z.number().min(0).max(1),
})

export const StallStateSchema = z.object({
  goal_id: z.string(),
  dimension_escalation: z.record(z.string(), z.number()),  // dim -> level
  global_escalation: z.number().default(0),
  decay_factors: z.record(z.string(), z.number()),         // dim -> factor
  recovery_loops: z.record(z.string(), z.number()),        // dim -> loops since recovery
})
```

---

## 6. ギャップと未確定事項

1. **observation.md vs satisficing.md の progress_ceiling 数値の差異**: 観測層 (0.70/0.90) と完了判断層 (0.60/0.85) で数値が異なる。どちらを使うかの判断が必要。推奨: 観測層の0.70/0.90を採用し satisficing.md の値は上書き扱いとする。**Uncertain**

2. **ObservationEngine の実際の実行機構**: MVPでは mechanical 観測 (APIコール、ファイル確認等) の実際の実行はどう行うか。外部アダプターパターンが必要だが、設計書に詳細なし。**Likely**: AdapterLayer (Layer 0) に委譲するが、Stage 2 では stub/mock で実装。

3. **LLM呼び出しインターフェース**: DriveScorer の `timing_bonus` (LLM評価) と ObservationEngine の `llm_review` 層で Anthropic SDK が必要。しかし package.json に `@anthropic-ai/sdk` 依存がない。Stage 2 の実装時に追加が必要かは scope 確認要。**Uncertain**

4. **`src/types/stall.ts` vs `src/types/core.ts` への統合**: `StallReport` と `StallState` を既存の types ファイルに統合するか新規ファイルを作るか。Stage 1 の precedent (11 ファイル) を見ると新規ファイル作成が自然。**Likely**

5. **DriveSystem のスケジュール状態の永続化パス**: `~/.motiva/schedule/<goal_id>.json` を想定しているが、StateManager のレイアウトに未定義。`writeRaw` / `readRaw` を使えば拡張可能。**Confirmed** (StateManagerにreadRaw/writeRaw実装済み)

---

## 7. 型の充足状況サマリー

| 型カテゴリ | 状況 |
|-----------|------|
| DriveSystem 用スケジュール型 | 未定義 → 追加必要 |
| TrustManager 用全型 | **完全定義済み** (TrustBalance, TrustStore, ActionQuadrant, 定数) |
| ObservationEngine 用観測型 | **完全定義済み** (ObservationLogEntry, ObservationLog, ConfidenceTier等) |
| DriveScorer 用スコア型 | **完全定義済み** (DissatisfactionScore, DeadlineScore, OpportunityScore, DriveScore, DriveConfig) |
| DriveScorer 用コンテキスト型 | 未定義 → 追加必要 |
| SatisficingJudge 用判定結果型 | 未定義 → 追加必要 |
| StallDetector 用停滞報告型 | 未定義 → 追加必要 |
| StallDetector の検知種別・原因 | **完全定義済み** (StallTypeEnum, StallCauseEnum) |
