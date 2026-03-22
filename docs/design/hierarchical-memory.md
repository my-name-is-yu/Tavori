# 階層型コンテキストメモリ設計

> MemGPT/Lettaが示した階層型メモリモデル（core/recall/archival）をConatus のContextProvider + MemoryLifecycleに適用し、コンテキスト選択の質を向上させる。

> 関連: `memory-lifecycle.md`, `session-and-context.md`, `knowledge-acquisition.md`

---

## 1. 問題定義

現在のContextProviderは固定top-4選択で動いている。記憶エントリに重要度の差がなく、「今このループで絶対必要な情報」と「あれば参考になる情報」が同列に扱われる。その結果:

- アクティブゴールの現在ギャップ・戦略が他の情報に押し出される可能性がある
- 完了済みゴールの知識が常にコンテキストを圧迫する
- コンテキストバジェットの使い方が非効率になる

MemGPT/Lettaのアプローチは「LLMが自律的にコンテキストウィンドウへのページイン/アウトを決定する」3層モデルだ。Conatusのスコープでは、MVPはルールベース分類で実装し、LLM自律判断はPhase 2とする。

---

## 2. 3層メモリモデル

| 層 | 定義 | コンテキスト配分 | 保存場所 |
|----|------|----------------|---------|
| **core** | 常にコンテキスト内。現在のループに必須の情報 | 50% | ShortTermEntry / ContextProvider |
| **recall** | 検索可能な中期記憶。関連性が高ければ引き出す | 35% | ShortTermEntry / MemoryIndexEntry |
| **archival** | 完了ゴールや古い教訓。セマンティック検索で引き出す | 15% | MemoryIndexEntry（archive） |

### 既存3層モデルとの対応

本設計は `memory-lifecycle.md` の3層（Working/Short-term/Long-term）を**置き換えない**。コンテキスト選択の優先度付けを追加するものだ。

| memory-lifecycle.md | 本設計での分類 |
|--------------------|--------------|
| Working Memory | — （コンテキスト組立時の出力そのもの） |
| Short-term Memory | core または recall |
| Long-term Memory | recall または archival |
| Archive | archival |

---

## 3. 分類ルール（MVP: ルールベース）

### core に分類するエントリ

- アクティブゴールの直近5ループ以内の観測・経験ログ
- 現在の戦略エントリ（active strategy）
- 現在のギャップ計算結果

### recall に分類するエントリ

- アクティブゴールの古い観測・タスク結果・知識エントリ（直近5ループより古い）
- 戦略履歴（active でないもの）
- Long-termの教訓でアクティブゴールに関連するもの

### archival に分類するエントリ

- 完了・キャンセル済みゴールのデータ全般
- Long-termのうち古い教訓・統計（直近50ループ以上参照されていないもの）
- superseded マーク済みの知識エントリ

### デフォルト値

既存データに `memory_tier` フィールドがない場合は `"recall"` として扱う（後方互換）。

---

## 4. コンテキストバジェット配分

`session-and-context.md` §4 の優先度1-6ルールの上位レイヤーとして機能する。

```
コンテキストバジェット（モデルウィンドウの50%）
  └─ core 層:     50%  — 必ず含める。eviction 禁止
  └─ recall 層:   35%  — 関連性スコア順に詰める
  └─ archival 層: 15%  — セマンティック検索結果をバジェット残があれば追加（Phase 2）
                         MVP では残バジェットがあれば recall と同列に追加
```

core 層は**絶対に追い出さない**。バジェットが足りない場合は recall / archival を削減する。

---

## 5. 統合ポイント

### 5.1 ShortTermEntry / MemoryIndexEntry（型定義）

`src/types/memory-lifecycle.ts` に `memory_tier` フィールドを追加（default: `"recall"`）。

- `ShortTermEntrySchema`: `memory_tier: MemoryTierSchema.default("recall")`
- `MemoryIndexEntrySchema`: `memory_tier: MemoryTierSchema.default("recall")`

### 5.2 MemorySelectionの変更（Phase 1）

`src/knowledge/memory-selection.ts` の `selectForWorkingMemory()` でエントリを tier 別に分けて選択する。core → recall → archival の順に、各バジェット配分まで埋める。

### 5.3 ContextBudget（Phase 1）

`TierBudget` 型（`{ core, recall, archival }`）を追加し、ContextProvider がバジェット配分を参照できるようにする。

### 5.4 ContextProvider（Phase 1）

収集したワークスペースコンテキストエントリに tier を付与する。

- アクティブゴール次元 + 現在ギャップ → `core`
- 過去観測・戦略履歴 → `recall`
- 完了ゴールの知識 → `archival`

---

## 6. MVP vs Phase 2

| 機能 | MVP (Phase 1) | Phase 2 |
|------|---------------|---------|
| tier 分類 | ルールベース（loop_number, goal status） | LLM自律判断（ページイン/アウト） |
| archival 検索 | recall と同列のバジェット残填め | VectorIndex によるセマンティック検索 |
| tier 間プロモーション | なし | recall→core の自動昇格（類似ゴール検出時） |
| tier 間デモーション | なし | core→recall の自動降格（satisficing 判定時） |
| budget 配分 | 固定比率（50/35/15） | DriveScorer 連携による動的配分 |

---

## 7. ストレージ変更

既存のディレクトリ構造は変更しない。`memory_tier` フィールドはエントリの JSON に追加されるだけだ。

```json
// ShortTermEntry の例（追加フィールドのみ）
{
  "id": "entry_abc",
  "memory_tier": "core",
  ...
}
```

backward compat: `.default("recall")` により既存エントリは `Zod.parse()` で `"recall"` が補完される。

---

## 設計原則のまとめ

| 原則 | 具体的な設計決定 |
|------|----------------|
| core は evict しない | バジェット超過時は recall/archival を削減 |
| 既存設計を壊さない | memory-lifecycle.md の3層は維持し、tier は分類レイヤーとして追加 |
| 後方互換 | `memory_tier` は `default("recall")` で既存データが壊れない |
| MVP ファースト | LLM自律判断はPhase 2。MVPはシンプルなルールベース |
