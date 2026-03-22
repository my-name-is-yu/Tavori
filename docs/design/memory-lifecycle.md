# 記憶ライフサイクル設計

> Conatusは年単位で動き続ける。データは無限に蓄積するが、LLMのコンテキストウィンドウは有限だ。
> 本ドキュメントは、蓄積されるデータを階層的に管理し、必要な記憶を必要なときに引き出す仕組みを定義する。

> 関連: `session-and-context.md`, `knowledge-acquisition.md`, `reporting.md`, `state-vector.md`, `drive-system.md`, `curiosity.md`, `stall-detection.md`

---

## 1. 問題定義

### 何が蓄積するか

Conatusが長期運用されると、以下のデータが継続的に蓄積される。

| データ種別 | 生成元 | 増加速度 |
|-----------|--------|---------|
| 経験ログ | コアループの各ステップ（observe→gap→score→task→execute→verify） | ループごとに1エントリ |
| 観測履歴 | ObservationEngineの定期・イベント駆動観測 | 次元数 x 観測頻度 |
| 知識ベース | KnowledgeManagerの調査タスク結果 | 調査タスクごとに複数エントリ |
| 戦略履歴 | StrategyManager/PortfolioManagerの戦略実行結果 | 戦略変更ごとに1エントリ |
| タスク履歴 | TaskLifecycleの過去タスク | タスクごとに1エントリ |
| レポート履歴 | ReportingEngineの過去レポート | 日次/週次 + 即時通知 |

1年間のアクティブな運用で、数千から数万のエントリが蓄積される。複数ゴールを同時追跡していれば、その倍数になる。

### なぜ単純なLRUでは不十分か

「古いものから消す」は記憶管理の最も単純な戦略だ。しかしConatus においてはこれが機能しない。

**理由1: 古い記憶が今のタスクに直結することがある。** 6ヶ月前に失敗した戦略の教訓は、今日の戦略選択で必要になる。LRUではこの教訓が消えている。

**理由2: 新しい記憶が無価値なことがある。** 安定期に毎日生成される「変化なし」の観測ログは、最新でも情報量がゼロだ。LRUはこれを保持し続ける。

**理由3: 重要度はデータの年齢ではなく、ゴールとの関連性で決まる。** 締切が迫っている次元の過去データは、順調な次元の最新データより重要だ。

### コンテキストウィンドウの制約

`session-and-context.md` §4 で定義されているコンテキストバジェット（モデルのコンテキストウィンドウの50%）は固定だ。蓄積データが増えても、1回のセッションに渡せる情報量は変わらない。つまり、データが増えるほど「何を選んで渡すか」の判断が重要になる。

---

## 2. 3層記憶モデル

`session-and-context.md` §8 で定義された記憶の3階層（作業記憶・ゴール状態・経験ログ）を拡張し、記憶のライフサイクルを管理する3層モデルとして再定義する。

既存の3階層との対応:

| session-and-context.md §8 | 本設計 | 備考 |
|---|---|---|
| 作業記憶（Working Memory） | Working Memory | 拡張: DriveScorer連携による選択ロジックを追加 |
| ゴール状態（Goal State） | 管理対象外 | ゴールツリー・状態ベクトル等の永続ファイルは本設計のライフサイクル管理の対象外。これらはゴールのライフサイクル（作成→進行→完了/キャンセル）に従い、`state-vector.md` のアーカイブルールに準拠する |
| 経験ログ（Experience Log） | Short-term + Long-term | 生ログをShort-termに保持し、圧縮・要約後のパターンをLong-termに移行 |

```
Working Memory（作業記憶）
  │ 容量: コンテキストバジェット内
  │ 寿命: 1セッション（1ループ）
  │ 内容: 今のタスクに必要な情報のみ
  │
  ├── 選択 ←── Short-term Memory から関連データを選択
  │
Short-term Memory（短期記憶）
  │ 容量: 設定可能（デフォルト: 直近100ループ分）
  │ 寿命: 設定可能な保持期間
  │ 内容: 生データをそのまま保持
  │
  ├── 圧縮 ←── 保持期間を超えたデータを要約して移行
  │
Long-term Memory（長期記憶）
  │ 容量: ストレージ上限まで（ガベージコレクション付き）
  │ 寿命: Conatusインスタンスの存在する限り
  │ 内容: パターン・統計・教訓の要約。生ログは破棄済み
```

### Working Memory

**定義**: 現在のセッションのコンテキストウィンドウに注入されるデータ。`session-and-context.md` §4 のコンテキスト選択アルゴリズムの出力そのものだ。

**容量**: コンテキストバジェット（モデルのコンテキストウィンドウの50%）。

**ライフサイクル**: セッション開始時に組み立てられ、セッション終了とともに消える。1ループの寿命だ。

**設計判断**: Working Memoryは「層」というより「ビュー」に近い。Short-term/Long-termのデータから、今のタスクに関連するものを選択・射影したものだ。Working Memoryの設計 = 選択ロジックの設計（§5で詳述）。

### Short-term Memory

**定義**: 直近のループ結果を圧縮なしの生データとして保持する層。

**保持期間**: 設定可能。デフォルトは以下の通り。

| ゴール種別 | デフォルト保持ループ数 | 時間の目安 |
|-----------|---------------------|-----------|
| ヘルスモニタリング | 200ループ | 約1週間 |
| ビジネス指標 | 100ループ | 約1-3ヶ月 |
| 長期プロジェクト | 50ループ | 約3-6ヶ月 |

**保持の根拠**: 生データが必要な理由は2つある。(1) 停滞検知（`stall-detection.md` §2）が時系列の生データを必要とする。(2) 直近の詳細な経緯は戦略選択の精度に直結する。

### Long-term Memory

**定義**: 保持期間を超えた古いデータを、パターン・統計・教訓に要約して保持する層。

**要約形式**: データ種別ごとに異なる（§3で詳述）。共通するのは「生ログは破棄し、そこから抽出した知見のみを保持する」という原則だ。

**保持ルール**: Long-term Memoryのエントリは以下の条件で保持される。
- 成功パターン: 教訓として無期限に保持
- 失敗パターン: 「何が失敗したか」の要約として無期限に保持
- 統計データ: ゴールが存在する限り保持。完了・キャンセルされたゴールの統計は教訓抽出後にアーカイブ

---

## 3. データ種別ごとの記憶管理

### 3.1 経験ログ

コアループの各ステップ（observe→gap→score→task→execute→verify）の結果を記録したもの。`mechanism.md` §4 の学習パイプラインのデータソースだ。

| 層 | 保持内容 | 形式 |
|----|---------|------|
| Working | 今のタスクに関連する直近2-3ループの経験サマリー | テキスト要約 |
| Short-term | 直近Nループの完全な経験ログエントリ | 生JSON |
| Long-term | パターン抽出済みの教訓（「この状況でこのアプローチが効いた/効かなかった」） | 構造化された教訓エントリ |

```
// Long-term の教訓エントリ例
{
  "lesson_id": "lesson_abc123",
  "type": "strategy_outcome",
  "context": "チャーン率が8%を超えている状態",
  "action": "オンボーディングUI改善",
  "outcome": "3週間で効果なし。チャーン率の変化は-2%にとどまった",
  "lesson": "UI改善単独ではチャーン改善に不十分。サポート体制との併用が必要",
  "source_loops": ["loop_042", "loop_043", "loop_044"],
  "extracted_at": "2026-06-15T09:00:00Z",
  "relevance_tags": ["churn", "onboarding", "ui"]
}
```

### 3.2 観測履歴

ObservationEngineが生成する過去の観測結果。`state-vector.md` §5 の `history` フィールドに対応する。

| 層 | 保持内容 | 形式 |
|----|---------|------|
| Working | 対象次元の直近3観測値 + 傾向（上昇/下降/横ばい） | テキスト要約 |
| Short-term | `state-vector.md` §5 で定義された履歴の深さ分の生観測データ | 生JSON |
| Long-term | 次元別の統計要約（平均値、変動幅、傾向、異常値の発生頻度） | 統計JSON |

**既存設計との関係**: `state-vector.md` §5 の履歴保持（短期ゴール: 10-20観測、長期ゴール: 50-100観測）は、本設計のShort-term Memoryに相当する。本設計はその先の「保持期間を超えた観測データをどうするか」を定義する。

### 3.3 知識ベース

KnowledgeManagerが管理するドメイン知識。`knowledge-acquisition.md` §5 の `domain_knowledge.json` に対応する。

| 層 | 保持内容 | 形式 |
|----|---------|------|
| Working | 今のタスクに関連するドメイン知識エントリ（tags照合） | テキスト抜粋 |
| Short-term | 全アクティブな知識エントリ | `knowledge-acquisition.md` §5.2 のKnowledgeEntry |
| Long-term | 高信頼度の知識のみ保持。低信頼度・陳腐化した知識は破棄 | 圧縮されたKnowledgeEntry |

**既存設計との関係**: `knowledge-acquisition.md` §6.3 の知識の陳腐化対処と本設計の能動的忘却ポリシー（§6）は補完関係にある。陳腐化検知は再検証のトリガーであり、忘却ポリシーは保持/破棄の判断基準だ。矛盾しない。

### 3.4 戦略履歴

StrategyManager/PortfolioManagerが記録する戦略の実行結果と評価。

| 層 | 保持内容 | 形式 |
|----|---------|------|
| Working | 現在の戦略 + 直前に試した戦略の結果 | テキスト要約 |
| Short-term | 直近N戦略の完全な実行記録（開始日、終了日、効果、ピボット理由） | 生JSON |
| Long-term | 戦略の成功/失敗パターン（「どの状況でどの戦略が有効/無効だったか」） | 教訓エントリ |

戦略履歴はLong-termに移行しても価値が高い。「過去に何が効いて何が効かなかったか」は、将来の戦略選択に直接影響する。

### 3.5 タスク履歴

TaskLifecycleが管理する過去タスクの記録。

| 層 | 保持内容 | 形式 |
|----|---------|------|
| Working | 現在のタスク定義 + 直前タスクの結果（リトライの場合） | タスク定義JSON |
| Short-term | 直近Nタスクの完全な記録（定義、成功基準、結果、所要時間） | 生JSON |
| Long-term | タスク種別ごとの統計（成功率、平均所要時間、失敗パターン） | 統計JSON |

```
// Long-term のタスク統計例
{
  "task_category": "knowledge_acquisition",
  "goal_id": "goal_health_01",
  "stats": {
    "total_count": 12,
    "success_rate": 0.83,
    "avg_duration_hours": 2.5,
    "common_failure_reason": "情報源の信頼度不足"
  },
  "period": "2026-01 to 2026-06"
}
```

### 3.6 レポート履歴

ReportingEngineが生成した過去レポート。

| 層 | 保持内容 | 形式 |
|----|---------|------|
| Working | 含めない（レポートはConatus→ユーザーの出力であり、ループの入力ではない） |  |
| Short-term | 直近の日次/週次レポート（`reporting.md` §5.1 のファイル構造に従う） | Markdownファイル |
| Long-term | アーカイブ（`reporting.md` §5.1 の `reports/archive/` に既存設計を踏襲） | Markdownファイル |

**既存設計との関係**: `reporting.md` §5.1 の「アーカイブは月次で `archive/` に移動する」という既存設計をそのまま踏襲する。レポートの永続性の原則（§10: 削除ではなくアーカイブ）も維持する。

---

## 4. 圧縮・要約メカニズム（Short → Long 移行）

Short-term Memoryの保持期間を超えたデータは、Long-term Memoryに圧縮・移行される。移行プロセスは2段階で構成される。

### 4.1 LLMによる要約生成

生ログの集合から、再現性のあるパターンと教訓を抽出する。記憶の圧縮と学習パイプライン（`mechanism.md` §4）は**相補的な仕組み**だ。学習パイプラインはイベント駆動（マイルストーン到達時、停滞検知時、定期レビュー）でトリガーされ、パターンの抽出とフィードバックを行う。記憶の圧縮は時間駆動（保持期間超過時）でトリガーされ、データの要約と移行を行う。両者の出力は同じLong-term Memoryに格納されるが、トリガー条件と目的が異なる。

```
compress_to_long_term(data_type, entries):
    // Step 1: パターン抽出
    patterns = llm_extract_patterns(entries)

    // Step 2: 教訓の蒸留
    lessons = llm_distill_lessons(patterns)

    // Step 3: 重要情報の欠落チェック（後述）
    validated_lessons = validate_completeness(lessons, entries)

    // Step 4: Long-term Memoryに保存
    store_long_term(data_type, validated_lessons)

    // Step 5: Short-term の生データを削除
    purge_short_term(entries)
```

### 4.2 統計的要約

LLM要約と並行して、コードベースで算出する統計情報を保持する。

| 統計種別 | 算出方法 | 用途 |
|---------|---------|------|
| 成功率 | 成功タスク数 / 全タスク数 | 戦略の有効性評価 |
| 平均所要時間 | タスク所要時間の算術平均 | スコープサイジングの改善 |
| 次元別進捗率 | 期間中のギャップ縮小率 | ゴールレビューの基礎データ |
| 観測値の統計 | 平均、標準偏差、トレンド | 異常検知の基準値更新 |

統計はLLMを使わずにコードで計算する。`reporting.md` §7 の「数値は常にコードが出す」原則と一致する。

### 4.3 要約の品質保証

圧縮時に重要情報が欠落するリスクがある。以下のチェックで防ぐ。

**失敗パターンの保持確認**: Short-termに含まれる失敗エントリのうち、Long-termの教訓に反映されていないものがないかをチェックする。失敗の記録は成功の記録より重要だ（同じ失敗を繰り返さないために）。

**矛盾検知**: 新しい教訓が既存のLong-term教訓と矛盾していないかをチェックする。矛盾がある場合、`knowledge-acquisition.md` §6.2 の矛盾検知と同じフローで処理する（信頼度の高い方を採用）。

**完全消去の禁止**: Long-termへの移行に失敗した場合（LLM呼び出しのエラー等）、Short-termのデータは削除しない。移行が成功するまで保持を延長する。

MVPでは完全照合ではなく、失敗エントリ数とLong-termの教訓エントリ数の比率チェック（教訓数 ≥ 失敗エントリ数 × 0.5 なら合格）で代替する。完全照合はPhase 2で実装する。

---

## 5. Working Memoryへの選択ロジック

Working Memoryの設計は「何をコンテキストに含めるか」の判断そのものだ。`session-and-context.md` §4 のコンテキスト選択アルゴリズムを、記憶層を考慮して拡張する。

### 5.1 ゴール・次元別パーティショニング

記憶データはゴールと次元でパーティショニングされる。Working Memoryへの選択は、現在のタスクが属するゴール・次元のパーティションから優先的に引く。

```
select_for_working_memory(current_task):
    goal_id = current_task.goal_id
    dimensions = current_task.target_dimensions

    // Step 1: 現在のゴール・次元に直接関連するデータ
    primary = query_memory(goal_id, dimensions, layer="short_term")

    // Step 2: 同じゴールの他の次元（間接的に関連する可能性）
    secondary = query_memory(goal_id, all_dimensions, layer="short_term")

    // Step 3: Long-termの教訓（ゴール横断）
    lessons = query_long_term_lessons(dimensions, current_task.context)

    // Step 4: バジェット内で優先度順に組み立て
    return assemble_context(primary, secondary, lessons, budget)
```

`session-and-context.md` §7 のゴール間コンテキスト分離は維持する。ゴールAのセッションにゴールBの生データは含めない。ただし、Long-termの教訓はゴールを横断して参照可能だ（教訓はゴール固有の生データではなく、汎化された知見だから）。

### 5.2 DriveScorer連携による関連性スコアリング

`session-and-context.md` §4 の優先度付き包含ルール（優先度1-6）に加えて、記憶エントリの関連性をDriveScorer（`drive-scoring.md`）のスコアでランキングする。

| スコア要素 | 意味 | 効果 |
|-----------|------|------|
| 不満スコア | この次元のギャップが大きい | 関連する記憶の優先度を上げる |
| 締切スコア | この次元に期限が迫っている | 関連する記憶の優先度を上げる |
| 機会スコア | この状況に好機がある | 類似状況の過去パターンの優先度を上げる |

> **Phase 2**: 以下のDriveScorer連携はPhase 2で実装する。MVPでは`last_accessed`の時系列順でWorking Memoryを選択する。

```
relevance_score(memory_entry, current_context):
    // タグベースの基本スコア
    tag_match = count_matching_tags(memory_entry.tags, current_context.tags)

    // DriveScorer からの重み付け
    drive_weight = get_drive_score(current_context.goal_id, current_context.dimension)

    // 鮮度（Short-termのデータはLong-termより高スコア）
    freshness = compute_freshness(memory_entry.timestamp)

    return tag_match * drive_weight * freshness
```

### 5.3 コンテキストバジェットとの統合

`session-and-context.md` §4 のコンテキストバジェット（モデルのコンテキストウィンドウの50%）の中で、記憶データの配分を行う。

```
バジェット配分の目安:
  優先度1-4（タスク定義、状態、制約）: 60%  ← session-and-context.md の既存ルール
  優先度5  （直前セッション結果）:     15%
  優先度6  （記憶層からの関連データ）:  25%  ← 本設計で拡張
```

優先度6の25%の中で、Short-termの生データとLong-termの教訓を関連性スコア順に詰める。バジェットが尽きた時点で停止する。

---

## 6. 能動的忘却ポリシー

記憶管理は「何を覚えるか」だけでなく「何を忘れるか」の設計でもある。能動的忘却はShort→Long圧縮の具体的ポリシーとして実装する。

### 6.1 矛盾する古い知識の自動削除

新しい観測結果が既存の知識と矛盾する場合、古い知識を自動的に無効化する。

```
on_new_observation(observation):
    conflicting = find_conflicting_knowledge(observation)
    for entry in conflicting:
        if observation.confidence > entry.confidence:
            entry.status = "superseded"
            entry.superseded_by = observation.id
            // 知識エントリ自体は削除しない。superseded マークで無効化する
```

`knowledge-acquisition.md` §6.2 の矛盾検知と同じ仕組みを使う。ただし、記憶ライフサイクルの文脈では、矛盾解消のための追加調査タスク生成は省略し、新しい観測を優先する。

### 6.2 参照されない情報のアーカイブ

> **Phase 2**: 参照頻度ベースのアーカイブはPhase 2で実装する。MVPでは保持期間ベースのアーカイブのみ。

N回連続でWorking Memoryに選択されなかった情報は、アクティブなインデックスから外してアーカイブする。

```
デフォルトN:
  Short-term エントリ: 20ループ（参照されないまま20ループ経過したらLong-term移行を前倒し）
  Long-term 教訓: 50ループ（参照されないまま50ループ経過したらアーカイブ）
```

アーカイブされた教訓は削除しない。アクティブインデックスから外すだけだ。状況が変わって関連性が復活した場合、意味的検索（Phase 2）で再発見できる。

### 6.3 成功した戦略の教訓保持

成功した戦略は、以下の形式で教訓として圧縮保持する。

```
{
  "type": "success_pattern",
  "context_summary": "どういう状況だったか",
  "strategy": "何をしたか",
  "outcome": "どういう結果が出たか",
  "applicability": "どういう状況で再利用できるか"
}
```

生の実行ログは破棄するが、教訓自体は無期限に保持する。

### 6.4 失敗した試行の圧縮

失敗した試行は「何が失敗したか」のみを保持し、実行の詳細は破棄する。

```
{
  "type": "failure_pattern",
  "context_summary": "どういう状況だったか",
  "strategy": "何を試したか",
  "failure_reason": "なぜ失敗したか",
  "avoidance_hint": "次回同じ状況で何を避けるべきか"
}
```

失敗の記録は成功の記録より重要だ。同じ失敗を繰り返さないために、失敗パターンの保持を優先する。

### 6.5 完了・キャンセルされたゴールのデータ

ゴールが完了またはキャンセルされた場合の処理。

```
on_goal_close(goal, reason):
    // Step 1: 学習パイプラインを実行（mechanism.md §4）
    lessons = run_learning_pipeline(goal)

    // Step 2: 教訓をLong-term Memoryに保存
    store_long_term("lessons", lessons)

    // Step 3: Short-termの生データをアーカイブ
    archive_short_term(goal.id)

    // Step 4: ゴール固有の知識ベースをアーカイブ
    archive_domain_knowledge(goal.id)
```

**既存設計との関係**: `state-vector.md` §5 の「サブゴールが完了判定を受けた、またはキャンセルされた場合、そのノードの状態ベクトルはアーカイブされる。削除ではなく保持し、経験ログとして将来の学習に使える状態にしておく」という既存設計を踏襲する。本設計はその「アーカイブ」の具体的な実施方法を定義する。

---

## 7. 動機に基づく記憶管理（Drive-based Memory Management）

> **Phase 2**: 本節の内容はすべてPhase 2で実装する。MVPでは保持期間とサイズ制限のみで記憶を管理する。

Conatusには「何が重要か」を判断する機構が既にある。DriveScorer（不満・締切・機会）とSatisficingJudge（十分かどうか）だ。汎用的なLRUではなく、この既存の動機システムを記憶管理に活用する。

### 7.1 DriveScorer連携

**不満駆動: 高不満の次元に関連する記憶は圧縮を遅延する。**

ギャップが大きい次元は、Conatusが集中的に取り組んでいる領域だ。この次元に関連するShort-termデータは、通常の保持期間を超えても圧縮せずに保持する。

```
compression_delay(dimension):
    dissatisfaction = get_dissatisfaction_score(dimension)
    if dissatisfaction > 0.7:  // 高不満
        return retention_period * 2.0  // 保持期間を2倍に延長
    elif dissatisfaction > 0.4:  // 中不満
        return retention_period * 1.5
    else:
        return retention_period  // 通常
```

### 7.2 締切駆動

**期限が近い次元の記憶はWorking Memoryに優先的に引く。**

締切駆動スコアが高い次元に関連する記憶は、関連性スコア（§5.2）に締切ボーナスを加算する。これにより、期限が迫っている次元の過去の戦略結果や観測パターンがWorking Memoryに入りやすくなる。

```
deadline_bonus(dimension):
    deadline_score = get_deadline_score(dimension)
    return deadline_score * 0.3  // 関連性スコアに最大30%のボーナス
```

### 7.3 機会駆動

**機会スコアが高い状況に関連する過去パターンを優先的に引く。**

機会駆動スコアが高いとき、類似の「好機」パターンをLong-term Memoryから検索する。「前回この種の機会が来たとき何をしたか」の教訓が、今の判断を助ける。

### 7.4 SatisficingJudge連携

**「十分」と判定された次元の詳細記憶は早期にLong-termに移行する。**

SatisficingJudge（`satisficing.md`）が「この次元は十分」と判定した場合、その次元のShort-termデータは保持期間を待たずにLong-term圧縮の対象になる。Conatusが注意を向ける必要がない次元の生データを保持し続ける意味はない。

```
on_satisficing_judgment(dimension, is_satisfied):
    if is_satisfied:
        // この次元のShort-termデータを早期圧縮対象にマーク
        mark_for_early_compression(dimension)
```

---

## 8. 既存設計との統合

本設計と既存の設計ドキュメントの関係を明記する。

### session-and-context.md

Working Memory = `session-and-context.md` §4 のコンテキスト選択アルゴリズムの拡張。既存の優先度付き包含ルール（優先度1-6）はそのまま維持し、優先度6（経験ログの関連抜粋）の選択元として記憶層を導入する。既存のコンテキスト分離原則（§7）も維持する。

### knowledge-acquisition.md

`knowledge-acquisition.md` §6.3 の知識の陳腐化対処は、本設計の能動的忘却ポリシー（§6.1）と補完関係にある。陳腐化検知が「再検証すべき知識」を特定し、忘却ポリシーが「無効化すべき知識」を処理する。知識エントリの `superseded_by` フィールド（`knowledge-acquisition.md` §5.2）は忘却の実装にそのまま使える。

### reporting.md

`reporting.md` §5.1 の `reports/archive/` とレポートの永続性原則（§10: 削除ではなくアーカイブ）を踏襲する。レポート履歴は本設計のLong-term Memoryのアーカイブに統合するが、既存のディレクトリ構造は変更しない。

### state-vector.md

`state-vector.md` §5 の「完了・キャンセルされたサブゴールの状態ベクトルはアーカイブされる」を踏襲する。本設計はアーカイブの具体的な実施方法（教訓抽出→生データ破棄）を定義する。観測履歴の保持深さ（短期ゴール: 10-20観測、長期ゴール: 50-100観測）はShort-term Memoryの設定値としてそのまま使う。

### drive-system.md

`drive-system.md` §3 のイベントアーカイブ（処理済みイベントを `events/archive/` に移動）を踏襲する。イベントデータは本設計の管理対象外とし、既存のアーカイブ方式を維持する。

### mechanism.md

`mechanism.md` §4 の学習パイプライン（経験ログ→分析→フィードバック→改善）のデータソースとして、Short-term/Long-term Memoryが機能する。学習パイプラインの入力はShort-termの生データであり、出力はLong-termの教訓エントリだ。

### curiosity.md

`curiosity.md` §4 の学習フィードバック（蓄積された経験ログによる方向づけ）は、Long-term Memoryの教訓エントリを参照する。好奇心エンジンが「どのドメインで改善余地があったか」を判断するデータソースが、記憶層を通じて構造化される。

### stall-detection.md

`stall-detection.md` §2 の停滞検知は、Short-term Memoryの生データ（特に観測履歴の時系列）を必要とする。停滞が検知された次元のデータは、Drive-based Memory Management（§7.1）により圧縮が遅延される。

---

## 9. ストレージ設計

### 9.1 ディレクトリ構造

```
~/.conatus/
├── memory/
│   ├── short-term/
│   │   ├── goals/
│   │   │   ├── <goal_id>/
│   │   │   │   ├── experience-log.json      # 経験ログ
│   │   │   │   ├── observations.json         # 観測履歴
│   │   │   │   ├── strategies.json           # 戦略履歴
│   │   │   │   └── tasks.json                # タスク履歴
│   │   │   └── ...
│   │   └── index.json                        # Short-term インデックス
│   ├── long-term/
│   │   ├── lessons/
│   │   │   ├── by-goal/
│   │   │   │   └── <goal_id>.json            # ゴール別教訓
│   │   │   ├── by-dimension/
│   │   │   │   └── <dimension_name>.json     # 次元別教訓
│   │   │   └── global.json                   # ゴール横断の教訓
│   │   ├── statistics/
│   │   │   └── <goal_id>.json                # ゴール別統計
│   │   └── index.json                        # Long-term インデックス
│   └── archive/
│       └── <goal_id>/                        # 完了・キャンセルされたゴールのアーカイブ
│           ├── lessons.json
│           └── statistics.json
├── goals/                                    # ゴール状態（domain_knowledge.jsonは本設計の圧縮対象。§3.3参照）
│   └── <goal_id>/
│       └── domain_knowledge.json             # knowledge-acquisition.md §5.2
├── events/                                   # 既存のイベントキュー（変更なし）
├── reports/                                  # 既存のレポート（変更なし）
│   └── archive/
└── ...
```

既存のディレクトリ構造（`goals/`, `events/`, `reports/`）は変更しない。`memory/` ディレクトリを新設し、記憶層のデータを管理する。

### 9.2 ファイル形式

すべてJSON形式。`mechanism.md` §5 の「透明で、人間が読めて、gitで管理できる」原則に従う。

### 9.3 インデックス設計

Short-term/Long-termそれぞれにインデックスファイルを持つ。インデックスはデータの実体ではなく、検索を高速化するためのメタデータだ。

```
// index.json の構造
{
  "version": 1,
  "last_updated": "2026-03-12T09:00:00Z",
  "entries": [
    {
      "id": "entry_abc123",
      "goal_id": "goal_health_01",
      "dimensions": ["respiratory_rate", "activity_level"],
      "tags": ["health", "monitoring", "respiratory"],
      "timestamp": "2026-03-10T14:00:00Z",
      "data_file": "goals/goal_health_01/experience-log.json",
      "entry_id": "exp_20260315_042",
      "last_accessed": "2026-03-11T09:00:00Z",
      "access_count": 3
    }
  ]
}
```

エントリはIDで直接参照する。ファイル構造の変更に影響されない。

インデックスのキー:
- `goal_id`: ゴール別検索
- `dimensions`: 次元別検索
- `tags`: タグベースの関連性検索
- `timestamp`: 時系列検索
- `last_accessed` / `access_count`: 参照頻度に基づく忘却ポリシーの判断

### 9.4 サイズ制限とガベージコレクション

| 層 | サイズ制限 | ガベージコレクション |
|----|-----------|-------------------|
| Short-term | ゴールあたり10MB（デフォルト） | 保持期間超過でLong-term移行 |
| Long-term | 全体で100MB（デフォルト） | 参照頻度最低のエントリからアーカイブ |
| Archive | 制限なし（ストレージ依存） | なし（永続保持） |

サイズ制限に達した場合、保持期間内でも圧縮を前倒しする。ただし、Drive-based Memory Management（§7）による遅延が適用されている場合、その遅延を尊重する（不満スコアが高い次元のデータは、サイズ制限の理由だけでは圧縮しない）。

---

## 10. MVP vs Phase 2

| 項目 | MVP (Phase 1) | Phase 2 |
|------|---------------|---------|
| 記憶層 | 3層構造の基本実装 | 変更なし |
| Short→Long 圧縮 | 設定可能な保持期間 + LLM要約による圧縮 | 圧縮品質の改善（要約の再帰的精緻化） |
| Working Memory選択 | タグの完全一致 + 時系列ソート | 意味的検索（埋め込みベース） |
| 忘却ポリシー | 保持期間ベース + 矛盾検知 | 参照頻度ベースの動的調整 |
| Drive-based管理 | 未実装。保持期間とサイズ制限のみ | DriveScorer/SatisficingJudge連携による動的な圧縮優先度 |
| インデックス | ゴール別・次元別の単純インデックス | 埋め込みベクトルによる意味的インデックス（Stage 12の埋め込み基盤を前提） |
| 統計的要約 | 基本統計（成功率、平均所要時間） | 高度な統計（トレンド分析、異常検知パターン） |
| ストレージ | ファイルベースJSON | 変更なし（MVPと同一） |

### MVPで実装するもの

1. `~/.conatus/memory/` ディレクトリ構造の作成
2. Short-term Memoryの保持期間管理（設定可能なループ数/時間ベース）
3. LLM要約によるShort→Long圧縮（`mechanism.md` §4 の学習パイプラインと統合）
4. タグベースの関連性検索によるWorking Memory選択
5. 基本的な忘却ポリシー（保持期間超過、矛盾する知識の無効化）
6. ゴール完了/キャンセル時の教訓抽出とアーカイブ

### Phase 2で実装するもの

1. Drive-based Memory Management（§7 の全機能）
2. 意味的検索によるWorking Memory選択（Stage 12の埋め込み基盤を前提）
3. 参照頻度に基づく動的な忘却ポリシー
4. Long-term教訓のゴール横断検索

---

## 設計原則のまとめ

| 原則 | 具体的な設計決定 |
|------|----------------|
| 3層で管理する | Working/Short-term/Long-termの明確な分離。各層の責務と寿命が異なる |
| ポリシーとアーキテクチャを分離する | 3層構造がフレームワーク。忘却・選択のポリシーは後から変更可能 |
| 動機が記憶を制御する | 汎用的なLRUではなく、DriveScorer/SatisficingJudgeが圧縮優先度を決める |
| 失敗を優先的に記憶する | 成功パターンより失敗パターンの保持を優先。同じ失敗を繰り返さないために |
| 既存設計を壊さない | session-and-context.md、reporting.md等の既存ルールを踏襲し、拡張として設計する |
| 完璧を求めない | MVPは単純な保持期間 + LLM要約。Drive-based管理はPhase 2で段階的に導入する |
