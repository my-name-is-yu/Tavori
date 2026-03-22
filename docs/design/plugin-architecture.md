# プラグインアーキテクチャ設計

> Conatusのプラグインは「ユーザーが使うツール」ではなく「Conatusが自律的に選択・活用するツール」だ。
> 本ドキュメントは、外部サービス連携・通知・データ観測をプラグインとして拡張するための
> 仕組みと、Conatusがそれらをどのように自律的に選択・信頼評価するかを定義する。

> 関連: `data-source.md`, `trust-and-safety.md`, `task-lifecycle.md`, `knowledge-acquisition.md`, `execution-boundary.md`

---

## §1 概要と動機

### Conatus vs Claude Code / OpenClaw

Claude CodeやOpenClawにおけるプラグインは「ユーザーが明示的に呼び出すツール」だ。ユーザーがコマンドを実行し、ツールが応答する。主体はユーザーにある。

Conatusにおけるプラグインは異なる。Conatusのコアループ（観測 → ギャップ → スコア → タスク → 実行 → 検証）はユーザーの指示なしに自律的に動く。したがって、プラグインも**Conatusが自律的に選択し、コアループの中に統合して使いこなす**ものでなければならない。「このプラグインを呼んでください」というユーザー指示を必要としないことが、Conatusのプラグイン設計の出発点だ。

```
Claude Code / OpenClaw:
  ユーザー → 「Jiraを検索して」 → Jiraプラグイン → 結果をユーザーに返す

Conatus:
  コアループ → 「この次元の観測に最適なソースはどれか？」
             → プラグインマニフェストを参照
             → 信頼スコアに基づいてjira-sourceを選択
             → 観測結果をギャップ計算に渡す（ユーザー介入なし）
```

### 「コアは薄く、拡張はプラグインで」の原則

Conatusのコアに含めるべきものは最小限だ。以下の基準で判断する。

| 判断基準 | 帰属先 | 例 |
|---------|--------|----|
| コアループ（観測/ギャップ/スコア/タスク/実行/検証）に必須 | コア | GapCalculator, DriveScorer |
| 外部サービスへの依存ゼロ、汎用性が高い | コア同梱可 | FileDataSourceAdapter, FileExistenceDataSourceAdapter |
| 特定の外部サービス・SaaSに依存 | プラグイン | JiraAdapter, SlackNotifier, LinearDataSource |
| 将来の拡張が予見されるが現時点では不要 | プラグイン候補 | Webhookアダプター, カスタムLLMバックエンド |

この原則により、Conatusのコアは小さく保たれ、サービス固有のロジックはプラグインに委譲される。

---

## §2 プラグイン種別

Conatusは3種類のプラグインをサポートする。それぞれ既存のインターフェースまたは新規インターフェースに対応する。

### 2.1 adapterプラグイン（IAdapter実装）

**役割**: タスクの実行先。Conatusがタスクを委譲するエージェント・システムを追加する。

**対応インターフェース**: `src/adapter-layer.ts` の `IAdapter`

```typescript
// 既存インターフェース（変更なし）
interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  listExistingTasks?(): Promise<string[]>;
  checkDuplicate?(task: AgentTask): Promise<boolean>;
}
```

**ライフサイクル**:
1. プラグインロード時に `AdapterRegistry` へ自動登録
2. タスク生成時に `AdapterRegistry` から能力マッチングで選択
3. `TaskLifecycle.execute()` から呼び出される

**プラグイン例**: GitHub Issue Adapter, Jira Adapter, Linear Adapter, Slack App Adapter, カスタムCLIエージェント

### 2.2 data_sourceプラグイン（IDataSourceAdapter実装）

**役割**: 観測データの取得源。ObservationEngineが状態ベクトルを観測するために使う。

**対応インターフェース**: `src/data-source-adapter.ts` の `IDataSourceAdapter`

```typescript
// 既存インターフェース（変更なし）
interface IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType;
  readonly config: DataSourceConfig;
  connect(): Promise<void>;
  query(params: DataSourceQuery): Promise<DataSourceResult>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getSupportedDimensions?(): string[];
}
```

**ライフサイクル**:
1. プラグインロード時に `DataSourceRegistry` へ自動登録
2. `ObservationEngine.findDataSourceForDimension()` が次元名と能力のマッチングで選択
3. 観測ループの Layer 1（機械的観測）で呼び出される
4. 結果は `confidence_tier: "mechanical"` として扱われる（最高信頼度）

**プラグイン例**: Jira Data Source, GitHub Data Source, Datadog Metrics, PostgreSQL Data Source, Slack Channel Monitor

### 2.3 notifierプラグイン（INotifier実装・新規）

**役割**: イベント通知の送信先。Conatusが特定のイベントを検知した際に通知を送る。

**対応インターフェース**: 新規定義（`src/types/plugin.ts` に追加）

```typescript
interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}

type NotificationEventType =
  | "goal_progress"      // ゴールの進捗更新
  | "goal_complete"      // ゴール達成
  | "task_blocked"       // タスクがブロックされた
  | "approval_needed"    // 人間の承認が必要
  | "stall_detected"     // 停滞が検知された
  | "trust_change";      // 信頼スコアが大きく変化した

interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string;        // ISO 8601
  summary: string;          // 人間が読む1行サマリー
  details: Record<string, unknown>;  // イベント種別固有のデータ
  severity: "info" | "warning" | "critical";
}
```

**ライフサイクル**:
1. プラグインロード時に `NotifierRegistry`（新規）へ自動登録
2. `NotificationDispatcher` が `notifier.supports(eventType)` で適切なNotifierを選択
3. 複数のNotifierが同一イベントを受け取ることがある（例: Slackと Email の同時通知）
4. Do Not Disturb・レート制限は NotificationDispatcher 側で一元管理（プラグイン側は持たない）

**プラグイン例**: Slack Notifier, Email Notifier, Discord Notifier, PagerDuty Notifier, LINE Notify

---

## §3 能力記述スキーマ（Plugin Manifest）

各プラグインはマニフェストファイル（`plugin.yaml` または `plugin.json`）を同梱する。マニフェストは「このプラグインは何ができるか」をConatusの自律選択エンジンに伝えるための能力宣言だ。

### 3.1 マニフェストの例

```yaml
# ~/.conatus/plugins/jira-source/plugin.yaml
name: jira-source
version: "1.0.0"
type: data_source
capabilities:
  - issue_tracking
  - sprint_progress
  - backlog_management
dimensions:
  - open_count
  - closed_count
  - velocity
  - completion_ratio
  - cycle_time
description: "Jira projectのissue状態とスプリント進捗を観測する"
config_schema:
  project_key:
    type: string
    required: true
    description: "Jiraプロジェクトキー（例: PROJ）"
  base_url:
    type: string
    required: true
    description: "JiraインスタンスのベースURL"
  auth_type:
    type: string
    enum: ["api_token", "oauth2"]
    default: "api_token"
dependencies:
  - "@atlassian/jira-client@^3.0.0"
entry_point: "dist/index.js"
min_conatus_version: "1.0.0"
```

```yaml
# ~/.conatus/plugins/slack-notifier/plugin.yaml
name: slack-notifier
version: "2.1.0"
type: notifier
capabilities:
  - slack_notification
  - channel_messaging
supported_events:
  - goal_complete
  - approval_needed
  - stall_detected
  - task_blocked
description: "ConatusのイベントをSlackチャンネルに通知する"
config_schema:
  channel:
    type: string
    required: true
    description: "通知先Slackチャンネル（例: #conatus-alerts）"
  mention_on_critical:
    type: boolean
    default: true
    description: "criticalイベントでメンションを付けるか"
dependencies:
  - "@slack/web-api@^6.0.0"
entry_point: "dist/index.js"
min_conatus_version: "1.0.0"
```

### 3.2 マニフェストのZodスキーマ定義

```typescript
// src/types/plugin.ts

import { z } from "zod";

const ConfigFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "array"]),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "プラグイン名は小文字英数字とハイフンのみ"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.enum(["adapter", "data_source", "notifier"]),

  // 能力宣言（CapabilityDetectorが参照する）
  capabilities: z.array(z.string()).min(1),

  // data_sourceのみ: 観測可能な次元名リスト
  dimensions: z.array(z.string()).optional(),

  // notifierのみ: サポートするイベント種別
  supported_events: z.array(z.string()).optional(),

  description: z.string(),
  config_schema: z.record(ConfigFieldSchema).default({}),

  // npm依存パッケージ
  dependencies: z.array(z.string()).default([]),

  // プラグインのエントリポイント（plugin directoryからの相対パス）
  entry_point: z.string().default("dist/index.js"),

  // 必要なConatusのバージョン（semver range）
  min_conatus_version: z.string().optional(),

  // 宣言するリソースアクセス（セキュリティ審査用）
  permissions: z.object({
    network: z.boolean().default(false),
    file_read: z.boolean().default(false),
    file_write: z.boolean().default(false),
    shell: z.boolean().default(false),
  }).default({}),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// プラグインの実行時状態
export const PluginStateSchema = z.object({
  name: z.string(),
  manifest: PluginManifestSchema,
  status: z.enum(["loaded", "error", "disabled"]),
  error_message: z.string().optional(),
  loaded_at: z.string(),               // ISO 8601
  // 信頼スコア（trust-and-safety.md §2 と同じ非対称設計）
  trust_score: z.number().int().min(-100).max(100).default(0),
  usage_count: z.number().int().default(0),
  success_count: z.number().int().default(0),
  failure_count: z.number().int().default(0),
});

export type PluginState = z.infer<typeof PluginStateSchema>;
```

---

## §4 プラグインローダー

`PluginLoader`（`src/plugin-loader.ts`）はプラグインの発見・読み込み・登録・検証を担う。

### 4.1 ディスカバリー（Discovery）

プラグインは `~/.conatus/plugins/` 以下のサブディレクトリとして配置する。

```
~/.conatus/plugins/
├── jira-source/
│   ├── plugin.yaml        # マニフェスト（必須）
│   ├── dist/
│   │   └── index.js       # エントリポイント
│   └── config.json        # ユーザー設定（optional）
├── slack-notifier/
│   ├── plugin.yaml
│   ├── dist/
│   │   └── index.js
│   └── config.json
└── linear-adapter/
    ├── plugin.yaml
    └── dist/
        └── index.js
```

ディスカバリーは起動時に1回実行される。`~/.conatus/plugins/` 内の各サブディレクトリを走査し、`plugin.yaml` または `plugin.json` が存在するものをプラグイン候補とみなす。

### 4.2 読み込み（Loading）

```typescript
class PluginLoader {
  async loadAll(): Promise<PluginState[]> {
    const pluginDirs = await this.discoverPluginDirs();
    const results = await Promise.allSettled(
      pluginDirs.map((dir) => this.loadOne(dir))
    );
    // 失敗したプラグインはエラーログを出力してスキップ
    // Conatus本体のクラッシュは引き起こさない
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : this.buildErrorState(pluginDirs[i], r.reason)
    );
  }

  private async loadOne(pluginDir: string): Promise<PluginState> {
    // 1. マニフェスト読み込み・スキーマ検証
    const manifest = await this.loadManifest(pluginDir);

    // 2. エントリポイントを dynamic import
    const entryPath = path.join(pluginDir, manifest.entry_point);
    const module = await import(entryPath);

    // 3. インターフェース準拠チェック
    this.validateInterface(manifest.type, module.default);

    // 4. 対応するRegistryへ登録
    await this.registerPlugin(manifest, module.default, pluginDir);

    return this.buildSuccessState(manifest);
  }
}
```

### 4.3 登録（Registration）

プラグイン種別に応じて対応するRegistryへ自動登録する。

| プラグイン種別 | 登録先 | 登録メソッド |
|--------------|--------|------------|
| `adapter` | `AdapterRegistry` | `registry.register(adapter)` |
| `data_source` | `DataSourceRegistry` | `registry.register(adapter)` |
| `notifier` | `NotifierRegistry`（新規） | `registry.register(name, notifier)` |

### 4.4 検証（Validation）

プラグインロード時に2種類の検証を行う。

**マニフェスト検証**: ZodスキーマでPluginManifestを検証する。必須フィールドの欠落・型不一致・バージョン形式エラーを検出する。

**インターフェース準拠チェック**: `module.default` が必要なメソッドを持つかを確認する。

```typescript
function validateInterface(type: PluginType, impl: unknown): void {
  const requiredMethods: Record<PluginType, string[]> = {
    adapter: ["execute", "adapterType"],
    data_source: ["connect", "query", "disconnect", "healthCheck"],
    notifier: ["name", "notify", "supports"],
  };
  for (const method of requiredMethods[type]) {
    if (!(method in (impl as object))) {
      throw new Error(`プラグインに必須メソッド "${method}" がありません`);
    }
  }
}
```

### 4.5 エラーハンドリング

プラグインのロード失敗はConatus本体をクラッシュさせない。

```
プラグインロード失敗のケース:
  - plugin.yamlが存在しない / 解析エラー → スキップ、警告ログ
  - entry_point ファイルが存在しない → スキップ、警告ログ
  - マニフェスト検証エラー → スキップ、エラーログ（内容付き）
  - インターフェース準拠違反 → スキップ、エラーログ（欠落メソッド名付き）
  - dynamic import エラー（構文エラー等） → スキップ、エラーログ

Conatus起動時の動作:
  - 失敗したプラグインの一覧を起動ログに出力
  - 成功したプラグインのみ有効化して起動を続行
  - `conatus plugin list` で各プラグインの状態を確認可能
```

---

## §5 Conatusによるプラグイン自律選択（3フェーズ）

Conatusがプラグインを自律的に活用する能力は、3つのフェーズで段階的に強化される。

### Phase 1 — 手動設定（M9で実装）

ゴール定義の中でプラグインを明示的に指定する。Conatusはその指定に従うだけで、自律的な選択は行わない。

**ゴール定義での指定例**:

```json
{
  "goal_id": "reduce-jira-backlog",
  "dimensions": [
    { "name": "open_count", "threshold": { "type": "max", "value": 10 } }
  ],
  "plugin_config": {
    "data_sources": ["jira-source"],
    "adapters": ["jira-adapter"],
    "notifiers": ["slack-notifier"]
  }
}
```

**動作**:
- `plugin_config.data_sources` に指定されたプラグインを `DataSourceRegistry` 経由で観測に使用
- `plugin_config.adapters` に指定されたプラグインをタスク実行先として使用
- `plugin_config.notifiers` に指定されたプラグインに通知を送る

Phase 1の自律性はゼロだ。「どのプラグインを使うか」はすべてユーザーが決める。ただし「プラグインをいつ呼ぶか」はConatusがコアループの中で判断する。

### Phase 2 — 能力自動マッチング（M10で実装）

ゴール定義にプラグインが指定されていない場合、`CapabilityDetector` がプラグインマニフェストを参照して自動的に候補を選択する。

**マッチングロジック**:

```
1. ゴールの次元名リストを取得
   例: ["open_count", "velocity", "cycle_time"]

2. DataSourceRegistryに登録済みのプラグインマニフェストを走査
   - マニフェストの dimensions[] と次元名を照合
   - マッチした次元の割合でスコアを計算（例: 3/3 = 1.0）

3. スコア閾値（0.5）以上のプラグインを候補として選定

4. LLMによる適合性確認（オプション）:
   プロンプト: "ゴール「{goal description}」の次元「{dim}」を
               観測するのにプラグイン「{plugin name}: {plugin description}」
               は適切か？理由とともに yes/no で答えてください"

5. 候補プラグインをユーザーに提案（自動実行するが通知する）
   または trust_score が Phase 3 の基準を満たす場合は自動選択
```

`ObservationEngine.findDataSourceForDimension()` は Phase 2 でプラグインの能力マッチングを加味するように拡張される。

```typescript
// 拡張後のfindDataSourceForDimension（概念）
async findDataSourceForDimension(dimensionName: string): Promise<IDataSourceAdapter | null> {
  // 既存: 明示的に設定されたデータソースを先に検索
  const explicit = this.registry.findByDimension(dimensionName);
  if (explicit) return explicit;

  // Phase 2拡張: プラグインマニフェストの dimensions[] で検索
  const pluginMatch = this.pluginRegistry.findByDimension(dimensionName);
  if (pluginMatch) {
    // 信頼スコアが十分高い場合のみ自動選択
    if (pluginMatch.trust_score >= PLUGIN_AUTO_SELECT_THRESHOLD) {
      return pluginMatch.adapter;
    }
    // 閾値未満の場合はユーザーに提案してから使用
    await this.notifyPluginSuggestion(pluginMatch, dimensionName);
    return pluginMatch.adapter;
  }

  return null;
}
```

### Phase 3 — 信頼ベース学習選択（M11で実装）

プラグインの使用履歴に基づく信頼スコアを用いて、より賢い自律選択を行う。

**信頼スコア設計**

`trust-and-safety.md` §2 のTrustManagerと同じ非対称設計を採用する。

```
初期値: 0（低トラスト側）
成功時: +Δs = +3（成功報酬は小さく）
失敗時: -Δf = -10（失敗ペナルティは大きく）
範囲: [-100, +100]
自動選択閾値: +20以上（7回連続成功で到達）
```

非対称性の理由: 信頼性の低いプラグインが観測データを汚染すると、ギャップ計算の精度が下がり、誤ったタスクが生成される。観測品質の毀損は連鎖的な影響を持つため、失敗ペナルティを重くする。

**ゴール種別ごとの信頼管理**

プラグインの信頼スコアはゴールドメインごとに管理する。「コードレビュー系ゴール」でうまく動いた実績が「マーケティング系ゴール」の信頼に転用されることを防ぐ。

```
plugin: jira-source
  trust_by_domain:
    software_development: +24   # 8回成功、0回失敗
    project_management: +12     # 4回成功、0回失敗
    marketing: 0                # 使用実績なし
```

**クロスゴール知識共有**

`KnowledgeManager` との統合により、プラグインの有効性を学習・共有する。

```
ゴールAでjira-sourceが "open_count" 次元の観測に成功
  → KnowledgeManagerが記録: "jira-sourceはopen_count観測に有効（ゴールA実績）"
  → ゴールBで同じ次元を観測する際、jira-sourceを優先候補として推薦
```

**優先選択のアルゴリズム**

同じ次元を観測できる複数のプラグインが候補の場合、以下の優先順位で選択する。

```
1. 明示設定（goal_config.plugin_config）が最優先
2. 同一ドメインの trust_score が最も高いプラグイン
3. KnowledgeManager に類似ゴールでの有効性記録があるプラグイン
4. trust_score = 0 の新規プラグイン（同点の場合はマニフェストの優先度順）
```

**新規プラグインの扱い**

新たに追加されたプラグインは trust_score = 0 からスタートする。Phase 3 の自動選択閾値（+20）には達していないため、初回は必ずユーザーに通知してから使用する。実績が積み上がり自動選択閾値を超えると、通知なしに自律選択される。

---

## §6 INotifierインターフェースとNotifierRegistry

### 6.1 インターフェース定義

```typescript
// src/types/plugin.ts に追加

interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}

interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string;           // ISO 8601
  summary: string;             // 人間が読む1行サマリー（Notifierが整形に使う）
  details: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
}

type NotificationEventType =
  | "goal_progress"      // ゴールの進捗が更新された
  | "goal_complete"      // ゴールが達成された
  | "task_blocked"       // タスクがブロックされた（エスカレーション）
  | "approval_needed"    // trust-and-safety.md §4 の承認要求
  | "stall_detected"     // stall-detection.md の停滞検知
  | "trust_change";      // プラグインまたはConatus本体の信頼スコアが大きく変化
```

### 6.2 NotifierRegistry（新規）

```typescript
// src/notifier-registry.ts

class NotifierRegistry {
  private notifiers: Map<string, INotifier> = new Map();

  register(name: string, notifier: INotifier): void {
    this.notifiers.set(name, notifier);
  }

  findForEvent(eventType: NotificationEventType): INotifier[] {
    return Array.from(this.notifiers.values()).filter((n) =>
      n.supports(eventType)
    );
  }
}
```

### 6.3 NotificationDispatcherとの統合

`NotificationDispatcher`（既存モジュール）は NotifierRegistry を使ってプラグインへのルーティングを行う。

**重要**: Do Not Disturb・レート制限・重複抑制のロジックは `NotificationDispatcher` 側で一元管理する。Notifierプラグインはこれらのロジックを持たない。プラグインは「送信する」だけを担い、「送るべきか」の判断はDispatcher側が行う。

```
NotificationDispatcher.dispatch(event)
  ↓
  DoNotDisturbチェック（コア側）
  ↓
  レート制限チェック（コア側）
  ↓
  NotifierRegistry.findForEvent(event.type)
  ↓
  各INotifier.notify(event) を並列呼び出し
  （いずれかが失敗しても他のNotifierへの通知は続行）
```

---

## §7 セキュリティと制約

### 7.1 実行モデル（MVP）

MVPではプラグインはConatus本体と同一プロセスで動作する。サンドボックスは設けない。この決定の根拠と制約は以下だ。

| 事項 | 内容 |
|------|------|
| 実行モデル | 同一プロセス（Node.js dynamic import） |
| サンドボックス | なし（MVP） |
| 信頼前提 | ユーザーが手動でインストールしたプラグインのみ対象 |
| 将来 | Phase 2でVM isolateまたはWorker Threadsを検討 |

同一プロセス実行の制約として、悪意あるプラグインはConatusの内部状態に直接アクセスできる。これを許容できるのは「ユーザーが自ら `~/.conatus/plugins/` に配置した」という明示的な信頼行為があるためだ。

### 7.2 EthicsGateとの連携

プラグインが生成するタスクも `EthicsGate` の審査対象だ。プラグイン由来のタスクが倫理ゲートを通過しない場合、タスクは拒否され、プラグインの信頼スコアを -10 する。

```
プラグインadapterが生成したタスク
  ↓
EthicsGate.check(task)  // goal-ethics.md参照
  ↓
  拒否 → タスク廃棄 + プラグインのtrust_score -= 10
  承認 → TaskLifecycleに渡す
```

### 7.3 秘密情報の管理

プラグインの認証情報（APIキー等）はマニフェストに含めない。専用の設定ファイルに分離する。

```
~/.conatus/plugins/<plugin-name>/config.json   # ユーザー設定（APIキー等を含む）
```

このファイルのパーミッションは `600`（オーナーのみ読み書き可）を推奨する。プラグインは起動時にこのファイルを読み込み、メモリ上でのみ保持する。

**マニフェストの `config_schema`** はどのフィールドが必要かを宣言するだけで、値は持たない。

### 7.4 権限宣言

マニフェストの `permissions` フィールドでプラグインが要求するリソースアクセスを事前宣言する。

```yaml
permissions:
  network: true      # 外部ネットワークアクセスが必要（Jira APIへのHTTP等）
  file_read: false   # ローカルファイル読み取り不要
  file_write: false  # ローカルファイル書き込み不要
  shell: false       # シェルコマンド実行不要
```

MVPでは権限宣言は**情報提供目的**であり、実行時の強制はしない。将来フェーズで権限エンフォースメントを追加する際の前提情報として機能する。`shell: true` を宣言するプラグインは `conatus plugin install` 時に明示的な警告を表示する。

---

## §8 既存モジュールとの接続

各既存モジュールがプラグインアーキテクチャとどのように接続するかを整理する。

| モジュール | 変更内容 | 接続方法 |
|-----------|---------|---------|
| `CoreLoop` | 変更なし | 登録済みアダプター・データソースを通じて間接的に使用 |
| `ObservationEngine` | `findDataSourceForDimension()` にプラグインマッチングを追加 | `DataSourceRegistry` 経由（Phase 2で拡張） |
| `TaskLifecycle` | 変更なし | `AdapterRegistry` 経由（プラグインは自動登録済み） |
| `NotificationDispatcher` | `NotifierRegistry` からのルーティングを追加 | `NotifierRegistry.findForEvent()` を呼び出す |
| `CapabilityDetector` | `detectGoalCapabilityGap()` でプラグインマニフェストを参照 | `PluginLoader` からマニフェスト一覧を受け取る（Phase 2） |
| `TrustManager` | プラグイン用の trust_score 追跡を追加 | `PluginState.trust_score` を更新（Phase 3） |
| `KnowledgeManager` | プラグイン有効性の記録・共有 | `onPluginSuccess/Failure()` フックを受け取る（Phase 3） |

### CoreLoopからの全体像

```
CoreLoop（変更なし）
    │
    ├── ObservationEngine
    │     └── DataSourceRegistry（プラグインdata_sourceを含む）
    │           → jira-source（プラグイン）
    │           → github-datasource（プラグイン）
    │           → FileDataSourceAdapter（コア同梱）
    │
    ├── TaskLifecycle
    │     └── AdapterRegistry（プラグインadapterを含む）
    │           → linear-adapter（プラグイン）
    │           → ClaudeCodeCLIAdapter（コア同梱）
    │
    └── NotificationDispatcher
          └── NotifierRegistry（プラグインnotifierを含む）
                → slack-notifier（プラグイン）
                → email-notifier（プラグイン）
```

---

## §9 実装ロードマップ

### M9: プラグイン基盤（Phase 1）

**スコープ**:
- `PluginManifest` Zodスキーマ（`src/types/plugin.ts`）
- `INotifier` インターフェース・`NotificationEvent` 型
- `NotifierRegistry`（`src/notifier-registry.ts`）
- `PluginLoader`（`src/plugin-loader.ts`）— ディスカバリー・ロード・検証・登録
- `NotificationDispatcher` への `NotifierRegistry` 統合
- CLI: `conatus plugin list`, `conatus plugin install <path>`, `conatus plugin remove <name>`
- Phase 1のゴール定義での `plugin_config` フィールドサポート

**完了基準**:
- `~/.conatus/plugins/` に配置されたプラグインが起動時に自動検出・登録される
- ロード失敗プラグインがConatusのクラッシュを引き起こさない
- Slack Notifier参照実装が動作する（E2Eテスト）

### M10: 能力自動マッチング（Phase 2）

**スコープ**:
- `CapabilityDetector.detectGoalCapabilityGap()` のプラグインマニフェスト参照拡張
- `ObservationEngine.findDataSourceForDimension()` のプラグインマッチング拡張
- LLMによる適合性確認プロンプト
- ユーザーへのプラグイン提案通知フォーマット

**完了基準**:
- プラグインが未指定のゴールで次元名マッチングによりプラグインが自動候補化される
- LLM適合性確認の結果がログに記録される

### M11: 信頼ベース学習選択（Phase 3）

**スコープ**:
- `TrustManager` のプラグイン用 `trust_score` 追跡
- ゴールドメインごとの `trust_by_domain` 管理
- `KnowledgeManager` とのプラグイン有効性共有統合
- 優先選択アルゴリズムの実装
- `conatus plugin list` での信頼スコア表示

**完了基準**:
- プラグインの成功/失敗に応じて trust_score が非対称更新される
- 高信頼プラグインが同一次元の低信頼プラグインより優先選択される
- クロスゴール学習でプラグイン推薦が機能する

### 将来フェーズ

| フェーズ | 内容 |
|---------|------|
| プラグインマーケットプレイス | `conatus plugin search <keyword>` でコミュニティプラグインを検索・インストール |
| バージョン管理 | `min_conatus_version` / `max_conatus_version` の強制、破壊的変更の移行支援 |
| Worker Thread隔離 | 同一プロセスから分離し、クラッシュ耐性を向上 |
| プラグイン署名 | コード署名による改ざん検知 |

---

## 設計原則のまとめ

| 原則 | 具体的な設計決定 |
|------|----------------|
| Conatusが主体 | プラグインは「呼ばれる」のではなく「Conatusが選択して使う」 |
| 段階的な自律化 | Phase 1（手動）→ Phase 2（能力マッチング）→ Phase 3（信頼学習） |
| 既存インターフェースを活かす | IAdapter・IDataSourceAdapterは変更せず、登録経路を追加するだけ |
| 失敗はConatusを止めない | プラグインロード失敗・実行失敗はエラーログで記録してスキップ |
| 信頼は非対称 | 失敗ペナルティ > 成功報酬（TrustManagerと同じ設計思想） |
| 秘密情報の分離 | マニフェストに認証情報を含めない。`config.json` に分離 |
| コアは薄く | 外部サービス依存はすべてプラグイン。コアは汎用ロジックのみ |
