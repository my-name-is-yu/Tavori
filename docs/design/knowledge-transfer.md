# 知識転移設計

> 関連: `learning-pipeline.md`, `curiosity.md`, `portfolio-management.md`, `goal-tree.md`, `trust-and-safety.md`

---

## 1. 概要

知識転移は**ゴール間の知識・戦略転移システム**だ。あるゴールで学んだパターンや成功戦略を、類似する別のゴールに自動的に適用する。

```
ゴールA（完了・進行中）
  └── LearnedPattern群 / 成功戦略履歴
        │
        ↓ 類似度検索 + LLMによるコンテキスト適応
        │
ゴールB（進行中）
  └── 転移された知識・戦略テンプレート
        │
        └→ タスク発見ループへのフィードバック
```

**転移の目的**: `learning-pipeline.md` が「単一ゴール内の経験学習」であるのに対し、知識転移は「ゴールをまたいだ経験の再利用」だ。同じドメインで複数のゴールを追う場合、最初のゴールの失敗・成功が後続ゴールの効率を大幅に向上させる。

---

## 2. データモデル

### 2.1 転移候補（TransferCandidate）

```
TransferCandidate {
  id: string
  source_goal_id: string          // 転移元ゴール
  target_goal_id: string          // 転移先ゴール
  transfer_type: TransferType     // 転移タイプ（§3）
  source_item_id: string          // 元のパターン/戦略のID

  similarity_score: number        // ゴール間の埋め込み類似度（0.0〜1.0）
  domain_tag_match: boolean       // ドメインタグが一致するか
  adapted_content: string | null  // LLMによるコンテキスト適応後の内容

  state: TransferCandidateState   // pending / proposed / applied / rejected / invalidated
  effectiveness_score: number | null  // 適用後の効果スコア（§5）

  proposed_at: DateTime
  applied_at: DateTime | null
  invalidated_at: DateTime | null
}
```

### 2.2 ゴール横断ナレッジベース（CrossGoalKnowledgeBase）

```
CrossGoalKnowledgeBase {
  meta_patterns: MetaPattern[]    // ドメイン横断メタパターン（§6）
  strategy_templates: StrategyTemplate[]  // 戦略テンプレート（§3.2参照）
  last_aggregated_at: DateTime
}
```

---

## 3. 転移タイプ

| タイプ | 内容 | 転移元 |
|--------|------|--------|
| `knowledge` | ドメイン知識の転移（観測精度・スコープサイジングパターン） | LearnedPattern |
| `strategy` | 成功戦略のテンプレート適用 | Strategy（effectiveness_score >= 0.5 かつ completed） |
| `pattern` | 学習パターンの共有（`learning-pipeline.md` §4と同一タイプ） | LearnedPattern |

---

## 4. 転移候補の検出

### 4.1 検出タイミング

5イテレーションに1回、転移候補の検出サイクルを実行する。

```
検出サイクル
    │
    ↓
アクティブな全ゴールを取得
    │
    ↓
各ゴールペアの転移候補をスコアリング（§4.2）
    │
    ↓
スコア上位の候補を TransferCandidate として保存
```

### 4.2 スコアリング

```
transfer_score =
  similarity_score × original_confidence × effectiveness_score_normalized

similarity_score:
  VectorIndex でゴール埋め込みの cosine similarity を計算

original_confidence:
  転移元 LearnedPattern または戦略の confidence / effectiveness_score

effectiveness_score_normalized:
  転移元で適用済みの場合は実績スコア（0.0〜1.0）
  未適用の場合は 0.5（中立）
```

**検索範囲**:
1. `KnowledgeManager.searchAcrossGoals()` で関連知識を検索
2. `VectorIndex` でゴール定義の埋め込み類似度を計算（similarity_score >= 0.7 のみ対象）
3. `LearnedPattern.domain_tags` のマッチング（タグが1つ以上一致する場合、スコアに +0.1 ボーナス）

---

## 5. 適用プロセス

### 5.1 フロー

```
TransferCandidate（proposed）
    │
    ↓
LLMによるコンテキスト適応
    │ - 転移元の表現を転移先のドメイン・次元に合わせて書き換える
    │ - 転移元の文脈依存部分を抽象化
    ↓
安全チェック（§5.2）
    │
    ├── 不適合 → TransferCandidate を rejected に更新
    │
    └── 適合 → ユーザーへの提案（Phase 1）
                    │
                    ├── 承認 → applied に更新 → SessionManager に注入
                    └── 拒否 → rejected に更新
```

### 5.2 安全チェック

**ドメイン制約の互換性確認**: 転移先ゴールの制約（`constraints`）と転移されたパターン・戦略の前提条件が矛盾しないか確認する。LLMが互換性を評価し、矛盾が検出された場合は rejected にする。

**倫理ゲート**: `ethics-gate.md` の checkGoal() を通過させる。転移適用は新しい行動方針の注入に相当するため、倫理チェックは必須だ。

**自動適用の禁止（Phase 1）**: Phase 1 では転移は常にユーザーへの提案とする。自動適用は行わない。

---

## 6. 効果評価

### 6.1 効果の測定

転移適用後、次の学習トリガー（`learning-pipeline.md` §2）で効果を評価する。

```
effectiveness_delta =
  gap_reduction_rate_after_transfer - gap_reduction_rate_before_transfer

  gap_reduction_rate: 単位時間あたりのギャップ縮小量（normalized）
```

### 6.2 信頼度の更新

```
効果あり（effectiveness_delta > 0.05）   → original_confidence += 0.1
効果なし（-0.05 <= delta <= 0.05）        → 変化なし
悪化（effectiveness_delta < -0.05）       → original_confidence -= 0.15
```

### 6.3 自動無効化

```
3回連続 neutral または negative の評価
    │
    ↓
TransferCandidate を invalidated に更新
転移元パターン/戦略の cross_goal_applicable フラグを false に設定
```

---

## 7. ゴール横断ナレッジベース

### 7.1 メタパターン抽出

全ゴールの LearnedPattern を集約し、LLMでドメイン横断のメタパターンを抽出する。

```
メタパターン抽出
    │ 入力: 全ゴールの LearnedPattern (confidence >= 0.6)
    │
    ↓
LLMによるクラスタリングと抽象化
    │ - 同種のパターンをグループ化
    │ - ゴール固有の部分を除去し汎化
    │
    ↓
MetaPattern として CrossGoalKnowledgeBase に登録
    │
    └→ VectorIndex へ埋め込み生成 + 登録
```

### 7.2 メタパターンの活用

新しいゴールが追加されたとき、CrossGoalKnowledgeBase から類似メタパターンを検索し、セッションコンテキストに注入する。これにより「過去に似たゴールで何が効いたか」を最初から参照できる。

---

## 8. 安全弁のまとめ

| 制約 | 詳細 |
|------|------|
| 類似度閾値 | 0.7 以上のゴールペアのみ転移候補として検出 |
| LLMによる互換性チェック | ドメイン制約の矛盾検出 |
| 倫理ゲート通過必須 | 全転移候補は ethics-gate.md のチェックを通過 |
| ユーザー承認（Phase 1） | 自動適用なし、常に提案→承認フロー |
| 自動無効化 | 3回連続で効果なし/悪化なら自動無効化 |
| 信頼度の割引 | 転移時に confidence × 0.7 でスタート（`learning-pipeline.md` §6.2） |

---

## 9. MVP vs Phase 2

### MVP（Phase 1 / Stage 14F）

| 項目 | MVP仕様 |
|------|---------|
| 検出タイミング | 5イテレーションに1回 |
| 類似度計算 | VectorIndex の cosine similarity |
| 自動適用 | なし（全てユーザー提案） |
| メタパターン抽出 | goal_completed トリガー時のみ |
| ナレッジベース更新 | バッチ（手動トリガー） |

### Phase 2

| 項目 | Phase 2仕様 |
|------|------------|
| 自動適用 | 高信頼度（confidence >= 0.85）パターンは自動適用 |
| リアルタイム検出 | タスク生成直前に動的に転移候補をスキャン |
| ナレッジベース更新 | 継続的（各学習トリガーで増分更新） |
| 転移効果の可視化 | レポートに「転移で時短できた時間」を表示 |

---

## 設計原則のまとめ

| 原則 | 具体的な設計決定 |
|------|----------------|
| 転移は提案、人が決める | Phase 1では自動適用なし。常にユーザーが最終判断 |
| 類似性の根拠を示す | similarity_score と domain_tag_match を可視化する |
| 安全チェックは必須 | 互換性チェック + 倫理ゲートを全転移候補に適用 |
| 効果を追跡して改善 | 転移結果のフィードバックで信頼度を継続的に更新 |
| 失敗した転移は無効化 | 3回連続失敗で自動無効化してノイズを除去 |

---

## 外部参考: claude-mem

> 参照元: [claude-mem](https://github.com/thedotmack/claude-mem) — セッション間記憶注入ライブラリ。以下の知見をConatus M16設計に反映する。

### A. session_summaries の構造化フィールド設計（データ構造パターン）

claude-mem はセッションサマリーを `investigated / learned / completed / next_steps` の構造化フィールドに分離して保存する。非構造化テキストと比べて、フィールド単位の検索・マッチングが可能になり、転移時の精度が大幅に向上する。

**M16への適用**: KnowledgeTransfer Phase 2 の転移元データ（DecisionRecord 等）に以下のフィールドを追加し、転移元データを構造化する。

```
DecisionRecord（拡張案）{
  // 既存フィールド...

  // Phase 2 追加フィールド（claude-mem パターン）
  what_worked: string[]    // 効果があったアプローチ・戦略
  what_failed: string[]    // 失敗したアプローチ・その理由
  suggested_next: string[] // 次のゴールへの示唆・推奨アクション
}
```

構造化によって転移時のマッチングが「全文類似度」から「フィールド単位の比較」に変わり、「失敗パターンの回避」と「成功パターンの再利用」を分離して扱えるようになる。

### B. Progressive Disclosure（3段階取得戦略）

claude-mem は `search → timeline → get_observations` の3段階フェッチで約10倍のトークン削減を実現している。

| フェーズ | 内容 | トークン量 |
|---------|------|-----------|
| search | インデックスのみ返す | ~50〜100 tokens/件 |
| timeline | アンカーID周辺の時系列コンテキスト | 中間 |
| get_observations | IDリストで全文取得 | ~500〜1000 tokens/件 |

**M16への適用**: コンテキスト選択の動的バジェット化（Phase 2）において、現在の固定 top-4 取得を段階的取得に変える。

```
現在（固定top-4）:
  全候補を全文取得 → 上位4件選択

改善案（Progressive Disclosure）:
  Step 1: 全候補のインデックス（ID + タイトル + スコア）を取得      ← 低コスト
  Step 2: スコア上位N件に絞り込み（バジェット制約内）
  Step 3: 絞り込んだ候補のみ全文取得                               ← 必要分のみ
```

この段階的アプローチにより、コンテキストバジェットが厳しい場面でも幅広い候補を考慮した上で最適な知識を選択できる。

### C. 小粒だが参考になる設計パターン

| パターン | claude-mem での実装 | M16への適用可能性 |
|---------|-------------------|----------------|
| `discovery_tokens` フィールド | 知識取得コストを記録 | TransferCandidate にトークンコストを記録し、バジェット配分の根拠にする |
| `concepts` JSON配列 | スキーマ非依存の概念タグ | LearnedPattern の `domain_tags` を拡張し、ゴール横断マッチングの精度向上に活用 |
| `timeline` パターン | アンカーID周辺の時系列取得 | 戦略変更前後に何が起きたか（stall検知 → 戦略切替 → 回復）を効率的に取得 |

### D. claude-mem にない部分（Conatus独自設計が必要な領域）

claude-mem はシングルセッション間の記憶注入に特化しており、以下はConatus独自に設計が必要だ。

| 機能 | 理由 |
|------|------|
| ゴール横断知識転移 | claude-mem は単一セッション間の注入のみ。Conatusは並列・直列に複数ゴールが走る |
| 転移信頼スコア学習 | 転移の効果をフィードバックして信頼度を更新する仕組み（§6.2）はConatus独自 |
| 動的バジェット強制 | claude-mem の TokenCalculator はコスト計算のみでバジェット強制なし。Conatusはバジェット超過時の優先度ベース削減が必要 |
