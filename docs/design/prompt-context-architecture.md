# プロンプトコンテキストアーキテクチャ — 階層メモリのLLMプロンプト活用設計

作成日: 2026-03-21
ステータス: 設計提案（未実装）

---

## 1. エグゼクティブサマリー

Conatusは4層階層メモリ（hot/warm/cold/archival）、コンテキストバジェット管理、セマンティック検索、反省ノート、教訓蒸留など豊富なメモリインフラを既に備えている。しかし、これらのインフラとLLMプロンプトの間に「最後の1マイル」の接続が欠けている。本設計は **PromptGateway** という新コンポーネントを導入し、目的別に最適化されたコンテキストを各LLM呼び出しに体系的に注入するパイプラインを定義する。これにより、タスク生成精度の向上、同一失敗パターンの繰り返し防止、観測の安定化を実現する。

---

## 2. 現状の問題

内部LLM呼び出し分析（全31箇所）から、以下の未接続箇所が特定されている。

### 2.1 Critical Gap

| Gap | 現状 | 影響 |
|-----|------|------|
| 長期メモリ教訓がタスク生成に未注入 | `MemoryLifecycleManager`が蒸留した`LessonEntry`はlong-termに保持されるが、`generateTask()`に渡される経路がない | タスク生成LLMが過去の失敗・成功パターンを知らずに新規タスクを生成 |
| 観測プロンプトにディメンション履歴が未注入 | `observeWithLLM()`は`previousScore`（スカラー値1件）のみ使用。`dim.history`の時系列データは未活用 | トレンド（上昇/下降/横ばい）を伝えられず、異常スコアジャンプの検出精度が低下 |

### 2.2 Important Gap

| Gap | 現状 | 影響 |
|-----|------|------|
| `context-budget.ts`がLLM呼び出しに未接続 | `allocateBudget()`等は実装済みだが、実際のプロンプトでは`MAX_CONTEXT_CHARS=4000`の固定値 | トークン超過・不足が制御不能 |
| `ReflectionNote`がタスク生成に未活用 | `formatReflectionsForPrompt()`は実装済みだが`buildTaskGenerationPrompt()`に接続されていない | 「何をしてはいけないか」の情報が活用されない |
| `StrategyTemplateRegistry`が戦略生成に未接続 | 成功戦略テンプレートのセマンティック検索・適応機能は実装済みだが`buildGenerationPrompt()`に渡されない | 別ゴールの成功戦略が新規ゴールに適用されない |

### 2.3 Minor Gap

- `generateTaskGroup()`が`knowledgeContext`/`workspaceContext`を受け取らない
- `CapabilityDetector`結果がタスク生成に未反映
- `llmClassifyTier()`が`ILLMClient`インターフェースと不一致

---

## 3. 先行技術からの学び

10のエージェントフレームワーク調査から、Conatusに適用可能なパターンを5つに絞る。

### 3.1 4層プロンプト構造（全フレームワーク共通）

ほぼ全フレームワークが以下の階層を採用する:

```
[System/Instruction]  -- 静的 or ゆっくり変わる（エージェント定義）
[Memory/Context]      -- 動的に選択・更新（メモリ・ナレッジ）
[History/State]       -- 管理・圧縮の対象
[Current Input/Task]  -- 即時入力
```

Conatusの現状: 多くのLLM呼び出しがシステムプロンプトなし（user-onlyメッセージ）で、Memory/Context層の注入が不十分。

**適用方針**: 全LLM呼び出しを4層構造に統一する。ただしConatusはチャット型エージェントではないため、History層は「ディメンション観測履歴」や「直近タスク結果」に置き換える。

### 3.2 複合スコアリング（Generative Agents / CrewAI）

単純なセマンティック検索ではなく、3要素の複合スコアで検索する:

```
score = w_r * recency_decay + w_i * importance + w_s * semantic_similarity
```

- **Recency**: 最終アクセス時刻からの指数減衰
- **Importance**: エントリの重要度スコア（0-1）
- **Relevance**: クエリ-メモリ間のcosine類似度

**適用方針**: Conatusの`memory-selection.ts`は既に`computeRelevanceScore()`を持つ。これを拡張して`recency`と`importance`の重み付けを加える。既存の`selectForWorkingMemory()`のスコアリングロジックを改良する形で実装。

### 3.3 MemGPTのページイン/アウト

MemGPTの核心は「コアメモリ（常時コンテキスト）」と「外部メモリ（検索でページイン）」の明確な分離:

- **Core Memory**: 常にプロンプトに含まれる固定ブロック（ペルソナ・ユーザー情報）
- **Recall Storage**: 会話履歴全体（テキスト検索でページイン）
- **Archival Storage**: 無限容量ナレッジ（埋め込み検索でページイン）

**適用方針**: Conatusの4層メモリを以下のように対応させる:

| MemGPT | Conatus | プロンプト注入方法 |
|--------|--------|-------------------|
| Core Memory | hot層（ゴール定義・現在状態・アクティブ戦略） | 常時注入（必須スロット） |
| Recall Storage | warm層（直近の観測・タスク結果・反省） | 目的別に選択注入 |
| Archival Storage | cold/archival層（教訓・ナレッジ・テンプレート） | セマンティック検索でページイン |

### 3.4 Reflexion型内省注入

Reflexionの核心: 失敗後に言語的内省を生成し、次の試行のコンテキストに注入する。

```
失敗 → 内省生成（「何が間違っていたか・次は何を試すべきか」）
     → warm層に保存（importance=0.9）
     → 次のタスク生成時にプロンプトに含める
```

**適用方針**: Conatusの`reflection-generator.ts`と`formatReflectionsForPrompt()`は既に実装済み。接続するだけでReflexionパターンが実現する。

### 3.5 DSPyのプログラマティック最適化（将来展望）

DSPyは「プロンプトを可変パラメータとして自動最適化」するアプローチ。Conatusが十分なゴール実行データを蓄積した後に適用可能:

- ゴール達成率をメトリクスに定義
- 各LLM呼び出しをSignatureとして定義
- オプティマイザーがプロンプトを自動改善

**適用方針**: 現段階では採用しない。ただしContextAssemblerの設計をSignature互換にしておくことで、将来の導入を容易にする。

---

## 4. 設計原則

1. **既存インフラの活用**: 新規メモリシステムは作らない。`context-provider.ts`、`memory-tier.ts`、`memory-lifecycle.ts`、`context-budget.ts`を接続する
2. **目的別最適化**: 全LLM呼び出しに同じコンテキストを注入しない。観測・タスク生成・検証で必要な情報は異なる
3. **バジェット制御**: 各スロットにトークンバジェットを割り当て、超過時は優先度低いスロットから削減する
4. **XMLタグ構造化**: XMLタグでプロンプトを構造化し、LLMの参照精度を上げる（モデル別の形式切替は不要）
5. **段階的導入**: 既存の動作を壊さない。各LLM呼び出しを個別に移行可能にする
6. **Context Rot防止**: confidence付きの情報注入、cosine similarity閾値によるノイズ排除

---

## 5. アーキテクチャ設計

### 5.1 PromptGateway（新規コンポーネント）

`src/prompt/` フォルダとして実装する。以下の構造を採用:

```
src/prompt/
├── gateway.ts              # PromptGateway本体（薄いオーケストレータ）
├── context-assembler.ts    # コンテキスト組み立て（メモリ→XMLブロック）
├── slot-definitions.ts     # 目的別スロット定義（どの目的にどの情報を渡すか）
├── formatters.ts           # XMLタグフォーマッタ、トークン切り詰め
├── purposes/               # 目的別のテンプレート＋スキーマ
│   ├── observation.ts      # system prompt + response schema
│   ├── task-generation.ts  # 同上
│   ├── verification.ts
│   ├── strategy.ts
│   └── goal-decomposition.ts
└── index.ts                # re-export
```

**PromptGatewayの責務**（フルライフサイクル）:
1. **コンテキスト組み立て** — 目的別スロット選択、階層メモリからの取得、バジェット制御（`context-assembler.ts`）
2. **プロンプト構築** — システムプロンプト + XMLタグ構造化ユーザーメッセージの生成（`purposes/`から取得）
3. **LLM呼び出し** — `ILLMClient`経由で実行、ログ・トークン追跡
4. **レスポンス解析** — Zodスキーマによるパースと検証

**各LLM呼び出し元はこのインターフェースのみを使う**:

```typescript
interface PromptGatewayInput<T> {
  purpose: ContextPurpose;
  goalId: string;
  dimensionName?: string;
  additionalContext?: Record<string, string>;
  responseSchema: z.ZodSchema<T>;
}

interface PromptGateway {
  execute<T>(input: PromptGatewayInput<T>): Promise<T>;
}
```

呼び出し例:

```typescript
const result = await promptGateway.execute({
  purpose: "task_generation",
  goalId,
  dimensionName,
  additionalContext: { existingTasks, failureContext },
  responseSchema: TaskSchema,
});
```

**ContextAssembler**（`src/prompt/context-assembler.ts`）:

直接呼び出し元には露出しない。PromptGatewayのみが使用する内部コンポーネント。

```typescript
type ContextPurpose =
  | "observation"
  | "task_generation"
  | "verification"
  | "strategy_generation"
  | "goal_decomposition";

interface AssembledContext {
  systemPrompt: string;
  contextBlock: string; // XMLタグ構造化済み
  totalTokensUsed: number;
}
```

**gateway.ts（薄いオーケストレータ）**:

`gateway.ts` は以下を実行するだけで、ロジックは内部コンポーネントに委譲:
1. `context-assembler.ts::build()` でコンテキストを組み立て
2. `purposes/{purpose}.ts` からプロンプトテンプレートを取得
3. LLMを呼び出し
4. レスポンスをパース

**workspace-context.tsの吸収**:
既存の`createWorkspaceContextProvider()`は、`context-assembler.ts`の内部実装として吸収する。外部からは `PromptGateway.execute()` の単一インターフェースのみが公開される。並列システムとして残さない。

### 5.2 目的別コンテキストスロット

各目的に対して、どのスロットを使い、どのメモリ層から取得するかを定義する。

| スロット | 観測 | タスク生成 | 検証 | 戦略 | ゴール分解 |
|---------|------|-----------|------|------|-----------|
| ゴール定義 (hot) | o | o | o | o | o |
| 現在状態 (hot) | o | o | o | o | - |
| ディメンション履歴 (warm) | o | - | - | - | - |
| 直近タスク結果 (warm) | - | o | o | - | - |
| 反省ノート (warm) | - | o | - | - | - |
| 教訓 (cold) | - | o | - | o | - |
| ナレッジ (archival) | - | o | o | o | o |
| 戦略テンプレート (archival) | - | - | - | o | - |
| ワークスペース状態 (warm) | o | o | - | - | - |
| 失敗コンテキスト (warm) | - | o | - | - | - |

`o` = 注入する、`-` = 注入しない

### 5.3 階層メモリ → プロンプト注入パイプライン

```
[LLM呼び出し元]
  │
  ├── purpose + goalId + responseSchema + additionalContext
  │
  ▼
[PromptGateway]
  │
  ├── [ContextAssembler]
  │     ├── 1. バジェット計算 (context-budget.ts: allocateBudget)
  │     ├── 2. hot層: 常時取得（ゴール定義・現在状態）
  │     ├── 3. warm層: 目的別選択取得（観測履歴・反省・ワークスペース）
  │     ├── 4. cold層: 教訓・パターン取得
  │     ├── 5. archival層: セマンティック検索でページイン
  │     ├── 6. バジェット調整（超過時: archival → cold → warm）
  │     └── 7. XMLタグで構造化 → AssembledContext
  │
  ├── システムプロンプト + ユーザーメッセージ構築
  ├── ILLMClient.call() 実行（ログ・トークン追跡）
  └── Zodスキーマでレスポンス解析 → T
```

### 5.4 各メモリ層の役割

| 層 | Conatusでの対応 | プロンプト注入方法 | 取得コスト |
|----|---------------|-------------------|-----------|
| **hot** | ゴール定義、現在状態、アクティブ戦略 | 常時注入（全目的で必須） | O(1) ファイル読み込み |
| **warm** | 直近5件の観測履歴、直近タスク結果、反省ノート、ワークスペース状態 | 目的別に選択注入 | O(1) インメモリ or ファイル |
| **cold** | 蒸留済み教訓（LessonEntry）、学習パターン | セマンティック検索 or タグ検索 | O(n) 検索 |
| **archival** | ナレッジエントリ、戦略テンプレート、DecisionRecord | セマンティック検索（VectorIndex） | O(log n) 埋め込み検索 |

### 5.5 トークンバジェット管理

バジェットは`~/.conatus/config.json`の`llm.contextBudgetTokens`で設定可能。未設定時は4000をデフォルトとする。モデルのコンテキストウィンドウ情報は`provider-config.ts`を参照する。

```
totalBudget (デフォルト: 4000トークン、config.jsonで変更可)
  ├── goalDefinition: 20% (800トークン) -- hot層
  ├── observations:   30% (1200トークン) -- warm層
  ├── knowledge:      30% (1200トークン) -- cold/archival層
  ├── transferKnowledge: 15% (600トークン) -- archival層
  └── meta:            5% (200トークン) -- システムプロンプト等
```

目的によって配分を調整:
- **観測**: observations 40%, knowledge 15%（ワークスペース状態を重視）
- **タスク生成**: knowledge 35%, observations 25%（教訓・反省を重視）
- **検証**: observations 35%, knowledge 25%（タスク結果を重視）

超過時の削減順序: `archival → cold → warm → hot`（hotは削減しない）

### 5.6 XMLタグベースのプロンプト構造化

XMLタグを採用する（モデル別の形式切替は行わない — XMLは全対応モデルで有効）:

```xml
<goal_context>
  Goal: {goal.title}
  Active Strategy: {strategy.hypothesis}
</goal_context>

<current_state>
  {dimension}: {currentValue} (target: {threshold}, gap: {gap})
</current_state>

<recent_observations>
  {formatted_recent_observations_with_timestamps}
</recent_observations>

<lessons_learned>
  {formatted_lessons_from_cold_memory}
</lessons_learned>

<relevant_knowledge>
  {formatted_knowledge_entries_from_archival}
</relevant_knowledge>

<workspace_state>
  {workspace_context_items}
</workspace_state>

<past_reflections>
  {formatted_reflection_notes}
</past_reflections>
```

各タグの内容は目的に応じて選択的に含める（5.2のスロット表に従う）。

---

## 6. 目的別の具体的プロンプト設計（Before/After）

### 6.1 観測（observeWithLLM）

**Before**:
```
You are an objective evaluator of software project progress.
Goal: {goalDescription}
Context (max 4000 chars): {workspaceContext}
```

**After**:
```
You are an objective evaluator of software project progress.

<goal_context>
  Goal: {goal.description}
  Threshold: {thresholdDescription}
</goal_context>

<observation_history>
  Trend (last 5): 2026-03-18: 0.3, 2026-03-19: 0.4, 2026-03-20: 0.45, ...
  Direction: improving
  Previous score: {previousScore}
</observation_history>

<workspace_state>
  {workspaceContext -- ContextAssembler経由、バジェット制御済み}
</workspace_state>
```

**変更点**: ディメンション履歴（warm層）の注入、XMLタグ構造化、バジェット制御

### 6.2 タスク生成（generateTask）

**Before**:
```
System: You are a task generation assistant. ...
Goal: {title} - {description}
Workspace: {workspaceContext}
```

**After**:
```
System: You are a task generation assistant. Given a goal, gap analysis,
and past experience, generate the most effective next task.

<goal_context>
  Goal: {title} - {description}
  Current: {current}, Target: {threshold}, Gap: {gap}
  Active Strategy: {strategy.hypothesis}
</goal_context>

<past_reflections>
  What failed: Direct file modification without running tests
  Suggestion: Always include test execution in task scope
</past_reflections>

<lessons_learned>
  - [HIGH] When gap > 0.5, break into sub-tasks of gap <= 0.2 each
</lessons_learned>

<relevant_knowledge>
  Q: What testing framework does this project use?
  A: Vitest (confidence: 0.95)
</relevant_knowledge>

<constraints>
  Existing tasks (avoid duplication): {existingTasks}
  Last failure context: {failureContext}
</constraints>
```

**変更点**: 反省ノート（warm層）、教訓（cold層）、ナレッジ（archival層）の注入

### 6.3 タスク検証（runLLMReview）

**Before**:
```
System: Review task results objectively against criteria.
Task: {work_description}
Executor output: {output}
```

**After**:
```
System: Review task results objectively. Ignore executor self-assessment.

<task_definition>
  Task: {work_description}, Success criteria: {criteria}
</task_definition>

<execution_result>
  Output (truncated): {output}
  Stop reason: {stopReason}
</execution_result>

<current_state>
  Dimension: {dimension} was {beforeValue}, expected >= {threshold}
</current_state>

<relevant_knowledge>
  {knowledgeEntries -- 正しい状態の定義}
</relevant_knowledge>
```

**変更点**: ディメンションの数値変化（hot層）、ナレッジ（archival層）の注入

### 6.4 戦略生成（generateCandidates）

**Before**:
```
Goal: {goalId}, Current gap: {gapScore}
Past strategies: {pastStrategies}
```

**After**:
```
<goal_context>
  Goal: {goalId}, Current gap: {gapScore}
</goal_context>

<strategy_templates>
  Successful patterns from other goals:
  - Template: "{hypothesis_pattern}" (success rate: 0.8)
</strategy_templates>

<lessons_learned>
  {lessons -- LearningPipelineのパターン}
</lessons_learned>
```

**変更点**: 戦略テンプレート（archival層）、教訓（cold層）の注入

### 6.5 ゴール分解（buildDecompositionPrompt）

**Before**:
```
Goal: {description}
Workspace context: {workspaceContext}
```

**After**:
```
<goal_context>
  Goal: {description}, Constraints: {constraints}
</goal_context>

<relevant_knowledge>
  {domainKnowledge}
</relevant_knowledge>

<workspace_state>
  {workspaceContext}
</workspace_state>
```

**変更点**: ナレッジ（archival層）の注入、XMLタグ構造化

---

## 7. 実装ロードマップ

### Phase A: 基盤（PromptGateway + ContextAssembler実装）

**目標**: コンポーネント実装とユニットテスト

| タスク | ファイル | 依存 |
|--------|---------|------|
| A-1: ContextAssembler本体 | `src/prompt/context-assembler.ts` | context-budget.ts |
| A-2: 目的別スロット定義 | `src/prompt/slot-definitions.ts` | - |
| A-3: XMLタグフォーマッタ | `src/prompt/formatters.ts` | - |
| A-4: PromptGateway本体 | `src/prompt/gateway.ts` | A-1, ILLMClient |
| A-5: 目的別テンプレート群 | `src/prompt/purposes/*.ts` (5ファイル) | A-2 |
| A-6: ユニットテスト | `tests/prompt/context-assembler.test.ts`, `tests/prompt/gateway.test.ts` | A-1〜4 |
| A-7: 統合テスト（パイプライン検証） | `tests/prompt/gateway-integration.test.ts` | A-4 |

A-7はContextAssembler → プロンプト構築 → モックLLM → コンテキストがプロンプトに到達することを検証する。

**推定規模**: 8ファイル + 3テストファイル、各200-300行以内

### Phase B: 接続（既存LLM呼び出しへの統合）

**目標**: 5つの主要LLM呼び出しにPromptGateway（`src/prompt/gateway.ts`）を接続

| タスク | 呼び出し元ファイル | 依存 | 優先度 |
|--------|------------------|------|--------|
| B-1: タスク生成に教訓+反省注入 | `task-lifecycle.ts` | `src/prompt/purposes/task-generation.ts` | P1 |
| B-2: 観測にディメンション履歴注入 | `observation-engine.ts` | `src/prompt/purposes/observation.ts` | P1 |
| B-3: 検証にナレッジ+状態注入 | `task-lifecycle.ts` | `src/prompt/purposes/verification.ts` | P2 |
| B-4: 戦略生成にテンプレート+教訓注入 | `strategy-manager.ts` | `src/prompt/purposes/strategy.ts` | P2 |
| B-5: context-budget.tsの実接続 | `src/prompt/context-assembler.ts` | Phase A-4 | P2 |

**推定規模**: 5-6ファイルの修正、各ファイル20-50行の変更

### Phase C: 最適化

**目標**: 精度改善と効率化

| タスク | ファイル | 優先度 |
|--------|---------|--------|
| C-1: 複合スコアリング（recency+importance+relevance） | `memory-selection.ts` | P2 |
| C-2: 目的別バジェット配分の調整 | `src/prompt/context-assembler.ts` | P3 |
| C-3: Context Rot防止（confidence閾値、cosine similarity閾値） | `src/prompt/context-assembler.ts` | P3 |
| C-4: generateTaskGroupへのコンテキスト追加 | `task-generation.ts` | P3 |

**推定規模**: 3-4ファイルの修正

### Phase D: 残存呼び出しサイトの移行（低優先度）

**目標**: Phase A-Cで移行した5件以外の残り約26箇所（全31件中）を`src/prompt/gateway.ts`パターンに移行する

| タスク | 対象 | 優先度 |
|--------|------|--------|
| D-1: goal-negotiator系LLM呼び出し移行 | `goal-negotiator.ts` 他 | P3 |
| D-2: knowledge-manager系LLM呼び出し移行 | `knowledge-manager.ts` 他 | P3 |
| D-3: その他のLLM呼び出し移行 | 残存箇所 | P4 |

Phase Dは機能的に動作しているコードの機械的な移行であり、Phase A-Cの完了後に着手する。移行により全LLM呼び出しのログ・トークン追跡・構造化が統一される。各呼び出し元は`src/prompt/`から適切な`purposes/*.ts`モジュールをインポートするだけで実装完了。

---

## 8. トレードオフと判断

### 採用した判断

| 判断 | 理由 | トレードオフ |
|------|------|------------|
| XMLタグ構造化を採用（モデル別切替なし） | 対応モデルで一律有効。切替ロジックの複雑化を避ける | - |
| PromptGatewayで完全ライフサイクルを管理 | ログ・トークン追跡・A/Bテストの単一制御点 | コンポーネントが肥大化しないよう目的別テンプレートは別ファイルに分離 |
| workspace-context.tsをContextAssembler内部に吸収 | 外部インターフェースを単一化。並列システムを排除 | 既存の直接呼び出し箇所の修正が必要 |
| バジェットをconfig.jsonで設定可能に | ユーザー環境・モデルにより最適値が異なる | デフォルト4000で十分なケースが多い |
| 既存のallocateBudget配分比率を流用 | 実装コスト最小化 | 目的別に最適な比率は異なる可能性がある（Phase Cで調整） |
| archival層のcosine similarity閾値を0.6に設定 | ノイズ排除と関連情報取得のバランス | 閾値が高すぎると有用な情報を見逃す可能性 |

### 見送った判断

| 見送り事項 | 理由 |
|-----------|------|
| DSPy的プロンプト自動最適化 | 十分な実行データが蓄積されるまで効果が薄い。Phase C以降で再検討 |
| プロンプトテンプレートのYAML外部化 | 現時点ではコード内テンプレートで十分 |
| LLM自律型メモリ管理（MemGPT方式） | Conatusはオーケストレーターであり、メモリ管理はシステム側で制御するほうが予測可能 |
| モデル別プロンプト形式切替（XML/Markdown） | 不要。XMLは全対応モデルで動作する |

### リスクと緩和策

| リスク | 緩和策 |
|--------|--------|
| コンテキスト注入によるトークンコスト増加 | バジェット制御で上限を設定。config.jsonで調整可能 |
| 古い教訓がミスリードする（Context Rot） | importance + recencyの複合スコアで古い低重要度エントリを排除 |
| PromptGatewayの依存が多すぎる（God Object化） | 目的別テンプレートとスキーマを別ファイルに分離。ContextAssemblerの依存はすべてoptional |
| 既存テストへの影響 | Phase Bでは既存のプロンプト構築関数を拡張（置換ではない）。既存テストは壊れない |
