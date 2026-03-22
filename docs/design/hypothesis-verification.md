# 仮説検証メカニズム設計

> AutoResearchClawのPIVOT/REFINE決定ループ・自己学習・収束検出からインスパイアされた3つの設計改善案。
> Conatusのオーケストレーションループをより自律的・適応的にする。

---

## 背景

### AutoResearchClawとは

[AutoResearchClaw](https://github.com/aiming-lab/AutoResearchClaw) は自律研究パイプラインで、23ステージ・8フェーズの構造を持つ。特徴は以下の通り:

- 仮説生成 → 実験設計 → 実行 → 評価の繰り返しループ
- **PIVOT/REFINE決定ループ**: 実験失敗時に「パラメータ調整(REFINE)」か「方針転換(PIVOT)」かを自動判断
- **自己学習**: 過去の判断結果をメタ知識として蓄積し、次の判断に活用
- **収束検出**: 単純な閾値判定ではなく、推移パターンから収束/停滞を区別

### Motivaへの適用動機

Motivaのコアループ（observe → gap → score → task → execute → verify）は構造としては健全だが、以下の課題がある:

1. **stall検出後のアクションが未定義** — StallDetectorが「止まった」と判断しても、CoreLoopは限定的な分岐しか持たない
2. **戦略判断のメタ知識ゼロ** — 過去に同種のゴールでどの戦略が有効だったか、記録も参照もない
3. **収束と停滞の区別ができない** — gap < thresholdの絶対値判定だけでは「惜しいが届かない」ケースを扱えない

AutoResearchClawのアプローチはこれら3課題に直接対応する。ただしMotiviaはループが本質であり、論文生成などのドメイン固有ロジックは取り込まない。

---

## 改善1: 構造化PIVOT/REFINE判断

**対象モジュール**: `stall-detector.ts`, `strategy-manager.ts`, `core-loop.ts`, `types/`
**工数**: 中（2〜3日）

### 現状の問題

```
observe → gap → stall? → YES → switch_strategy (根拠曖昧)
                       → NO  → continue
```

StallDetectorは「stall detected」を返すが、**なぜ止まったか**の原因分析がない。StrategyManagerは戦略切り替えロジックを持つが、どの状況でどう切り替えるかの判断基準が曖昧。

### 提案設計

```
observe → gap → stall?
  ├─ NO  → continue
  └─ YES → analyze_cause()          ← NEW
       ├─ parameter_issue → REFINE  (パラメータ調整して再実行)
       ├─ strategy_wrong  → PIVOT   (戦略切り替え、ゴール維持)
       └─ goal_unreachable → ESCALATE (ゴール再交渉)
```

### StallDetectorへの追加: `analyzeStallCause()`

直近の gap 推移パターンから原因を推定する。

| パターン | 判定 | 定義 |
|----------|------|------|
| oscillating（振動） | `parameter_issue` | gap が上下を繰り返す（variance 高、mean 変化なし） |
| flat（横ばい） | `strategy_wrong` | gap の変化量がほぼゼロ |
| diverging（悪化） | `goal_unreachable` | gap が単調増加 |

```typescript
type StallCause = 'parameter_issue' | 'strategy_wrong' | 'goal_unreachable';

interface StallAnalysis {
  cause: StallCause;
  confidence: number;   // 0.0–1.0
  evidence: string;     // 人間向け説明
}
```

### StrategyManagerへの追加: rollback target

各戦略に「この戦略が失敗した場合の戻り先」を定義する。

```typescript
interface StrategyDefinition {
  id: string;
  rollbackTarget?: string;   // PIVOT時の遷移先strategy id
  maxPivotCount: number;     // デフォルト 2（AutoResearchClawに合わせる）
}
```

### CoreLoopの変更

既存のstall分岐を3方向に拡張:

```typescript
if (stallDetected) {
  const analysis = await stallDetector.analyzeStallCause(gapHistory);
  switch (analysis.cause) {
    case 'parameter_issue': return 'REFINE';    // パラメータ調整して継続
    case 'strategy_wrong':  return 'PIVOT';     // 戦略切り替え
    case 'goal_unreachable': return 'ESCALATE'; // ゴール再交渉へ
  }
}
```

最大pivot回数を超えた場合はESCALATEに昇格する。

---

## 改善2: 判断履歴の学習ループ

**対象モジュール**: `knowledge-manager.ts`, `strategy-manager.ts`, `types/`
**工数**: 中〜大（3〜5日）、M13と同時実装推奨

### 現状の問題

KnowledgeManagerはゴール内の知識（実行ログ、観測結果）を蓄積するが、**戦略判断のメタ知識**（どの種の戦略がどの種のゴールで有効か）は保持しない。同じ失敗を繰り返す可能性がある。

### 提案設計: DecisionRecord スキーマ

```typescript
interface DecisionRecord {
  goalType: string;       // ゴールの種別（例: "code_quality", "test_coverage"）
  strategyId: string;     // 使用した戦略
  decision: 'proceed' | 'refine' | 'pivot' | 'escalate';
  context: {
    gapValue: number;
    stallCount: number;
    cycleCount: number;
    trustScore: number;
  };
  outcome: 'success' | 'failure';
  timestamp: string;      // ISO 8601
}
```

### KnowledgeManagerへの追加API

```typescript
// 判断を記録
recordDecision(record: DecisionRecord): Promise<void>;

// 類似ゴールでの過去判断を取得（time-decayあり）
queryDecisions(goalType: string, limit?: number): Promise<DecisionRecord[]>;
```

**time-decay**: 30日（AutoResearchClawと同じ）。古い記録は重みを下げて参照し、長期間後に自動削除。

### StrategyManager.selectStrategy()への統合

戦略選択時に過去の判断履歴を参照:

1. 「過去に同種ゴールでPIVOTされた戦略」を候補から除外
2. 「同種ゴールで成功率の高い戦略」を優先
3. 履歴が十分でない場合（＜3件）は従来ロジックにフォールバック

### M13との統合

M13で予定されているゴール横断のセマンティック知識共有（KnowledgeManager Phase 2）と自然に統合できる。DecisionRecordをセマンティック検索の対象に含めることで、「類似ゴール」の判定精度が向上する。

---

## 改善3: 収束判定の強化

**対象モジュール**: `satisficing-judge.ts`, `types/`
**工数**: 小（半日〜1日）

### 現状の問題

SatisficingJudgeは `gap < threshold` の絶対値判定のみ。「惜しいが閾値に届かない、かつ改善も停滞している」状態と「まだ改善中」の状態を区別できない。

```
gap = 0.15, threshold = 0.10
→ 現状: 未達成として継続し続ける
→ 理想: 収束を検出してStallDetectorに委譲すべき
```

### 提案設計: 収束検出ロジック

直近N回（デフォルトN=5）のgap値をリングバッファで保持し、分散が小さければ収束と判定する。

| 条件 | 判定 | アクション |
|------|------|------------|
| `gap < threshold` | satisficed | 完了（既存） |
| `variance < ε AND gap ≤ threshold × 1.5` | converged_satisficed | 完了（NEW） |
| `variance < ε AND gap > threshold × 1.5` | stalled | StallDetectorへ委譲（NEW） |
| それ以外 | in_progress | 継続 |

パラメータのデフォルト値:

```typescript
const CONVERGENCE_WINDOW = 5;       // リングバッファサイズ
const CONVERGENCE_EPSILON = 0.01;   // 分散の閾値（要チューニング）
const ACCEPTABLE_RANGE_FACTOR = 1.5; // threshold の何倍まで許容するか
```

`converged_satisficed` はsatisficingの精神（完璧を追わない）に合致する。threshold × 1.5 の範囲内なら「実質的に十分」と判断する。

### 型定義への追加

```typescript
type SatisficingResult =
  | 'satisficed'
  | 'converged_satisficed'   // NEW
  | 'stalled'                // NEW（StallDetectorへ委譲）
  | 'in_progress';
```

---

## 実装順序

| 順序 | 改善 | 理由 |
|------|------|------|
| 1 | **改善3** 収束判定強化 | 独立性が高く即着手可能。既存テストへの影響が限定的 |
| 2 | **改善1** PIVOT/REFINE判断 | StallDetectorの価値を大幅に向上。改善3の結果（stalled判定）を活用 |
| 3 | **改善2** 学習ループ | 改善1のDecisionが蓄積されてから意味を持つ。M13と同時実装で効率化 |

---

## AutoResearchClawから取り入れないもの

| 要素 | 理由 |
|------|------|
| 23ステージ線形パイプライン | Motivaはループが本質。線形フローはアンチパターン |
| ドメイン固有ロジック（LaTeX/論文） | Motivaはドメイン非依存のオーケストレーター |
| 固定回数ループ上限 | Motivaはsatisficingで判断。回数上限は自律性を損なう |
| 実験設計の自動生成 | TaskLifecycleが担う役割。重複しない |

---

## 参考

- [AutoResearchClaw](https://github.com/aiming-lab/AutoResearchClaw)
- [docs/module-map.md](../module-map.md) — 関連モジュール境界マップ
- [docs/design/stall-detector.md](stall-detector.md) — StallDetector設計
- [docs/design/satisficing.md](satisficing.md) — SatisficingJudge設計
- [docs/design/knowledge-acquisition.md](knowledge-acquisition.md) — KnowledgeManager設計
