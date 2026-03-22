# プラグイン開発ガイド

このガイドでは、Conatusプラグインの開発方法を説明する。

---

## プラグインの種類

Conatusは3種類のプラグインをサポートする。

| 種類 | インターフェース | 用途 |
|------|----------------|------|
| `data_source` | `IDataSourceAdapter` | 外部APIやDBから状態を観測する |
| `notifier` | `INotifier` | Conatusイベントを外部サービスに送信する |
| `adapter` | `IAdapter` | エージェントアダプタ（Claude Code CLI等） |

---

## plugin.yaml の書き方

プラグインのルートディレクトリに `plugin.yaml` を配置する。

```yaml
name: my-notifier           # 必須。小文字英数字とハイフンのみ
version: "1.0.0"            # 必須。semver形式
type: notifier              # 必須。"adapter" | "data_source" | "notifier"
description: "説明文"       # 必須。プラグインの説明

# 能力宣言（CapabilityDetectorが参照する）
capabilities:
  - my_capability           # 必須。1件以上

# data_source のみ: 観測可能な次元名リスト（"*" はワイルドカード）
dimensions:
  - "*"

# notifier のみ: サポートするイベント種別
supported_events:
  - goal_complete
  - task_blocked
  - approval_needed
  - stall_detected
  - trust_change
  - goal_progress

# プラグインのエントリポイント（plugin directoryからの相対パス）
entry_point: "src/index.ts" # デフォルト: "dist/index.js"

# Conatusの対応バージョン範囲（semver）
min_conatus_version: "0.1.0"
max_conatus_version: "2.0.0" # 省略可

# 設定スキーマ（config_schema は PluginLoader が検証に使用）
config_schema:
  api_key:
    type: string            # "string" | "number" | "boolean" | "array"
    required: true
    description: "API key"
  timeout_ms:
    type: number
    required: false
    default: 5000
    description: "Request timeout in milliseconds"

# リソースアクセス宣言（セキュリティ審査用）
permissions:
  network: true             # HTTPリクエストを送信する場合
  file_read: false          # ファイルを読む場合
  file_write: false         # ファイルを書く場合
  shell: false              # シェルコマンドを実行する場合

# 必要なnpmパッケージ（PluginLoaderがインストールを確認する）
dependencies: []
```

---

## IDataSourceAdapter インターフェース仕様

```typescript
export interface IDataSourceAdapter {
  readonly sourceId: string;       // プラグインの一意なID（DataSourceConfig.idと一致）
  readonly sourceType: DataSourceType;  // "file" | "http_api" | "database" | "sse" | ...
  readonly config: DataSourceConfig;   // connect()に渡されたconfig

  connect(): Promise<void>;        // 接続確立。失敗時はthrow
  query(params: DataSourceQuery): Promise<DataSourceResult>;  // 観測値取得
  disconnect(): Promise<void>;     // 接続解放
  healthCheck(): Promise<boolean>; // true = 正常、false = 異常
  getSupportedDimensions?(): string[];  // オプション: サポートする次元名リスト
}
```

### DataSourceQuery

```typescript
interface DataSourceQuery {
  dimension_name: string;    // 観測する次元名
  expression?: string;       // クエリ式（SQL, JQL, JSONPath等、プラグイン依存）
  parameters?: Record<string, unknown>;  // バインドパラメータ
  timeout_ms?: number;       // タイムアウト（ミリ秒）
}
```

### DataSourceResult

```typescript
interface DataSourceResult {
  value: number | string | boolean | null;  // スカラー値（ギャップ計算に使用）
  raw: unknown;              // 生のAPIレスポンス（デバッグ用）
  timestamp: string;         // ISO 8601形式
  source_id: string;         // DataSourceAdapter.sourceId と一致
}
```

---

## INotifier インターフェース仕様

```typescript
export interface INotifier {
  readonly name: string;     // プラグイン名（plugin.yamlのnameと一致）

  notify(event: NotificationEvent): Promise<void>;  // イベント送信。失敗時はthrow
  supports(eventType: NotificationEventType): boolean;  // このイベント種別を処理するか
}
```

### NotificationEvent

```typescript
interface NotificationEvent {
  type: NotificationEventType;  // イベント種別
  goal_id: string;              // 関連するゴールID
  timestamp: string;            // ISO 8601形式
  summary: string;              // 人間が読む1行サマリー
  details: Record<string, unknown>;  // イベント種別固有の追加データ
  severity: "info" | "warning" | "critical";
}

type NotificationEventType =
  | "goal_progress"    // ゴールの進捗更新
  | "goal_complete"    // ゴール達成
  | "task_blocked"     // タスクがブロックされた
  | "approval_needed"  // 人間の承認が必要
  | "stall_detected"   // 停滞が検知された
  | "trust_change";    // 信頼スコアが大きく変化した
```

---

## 実装例

### data_source プラグイン

```typescript
// src/index.ts
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
} from "../../../../src/types/data-source.js";
import type { IDataSourceAdapter } from "../../../../src/observation/data-source-adapter.js";

export class MyDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType = "http_api" as const;
  readonly config: DataSourceConfig;

  private connected = false;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    // 接続確立ロジック
    this.connected = true;
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    if (!this.connected) {
      throw new Error(`MyDataSourceAdapter [${this.sourceId}]: not connected`);
    }
    // クエリ実行ロジック
    return {
      value: 42,
      raw: {},
      timestamp: new Date().toISOString(),
      source_id: this.sourceId,
    };
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

// PluginLoaderが使用するデフォルトエクスポート
export default new MyDataSourceAdapter({
  id: "my-datasource",
  name: "My DataSource",
  type: "http_api",
  connection: { url: process.env["MY_API_URL"] ?? "" },
  enabled: true,
  created_at: new Date().toISOString(),
});
```

### notifier プラグイン

```typescript
// src/index.ts
import type {
  INotifier,
  NotificationEvent,
  NotificationEventType,
} from "../../../../src/types/plugin.js";

const SUPPORTED_EVENTS: NotificationEventType[] = ["goal_complete", "task_blocked"];

export class MyNotifier implements INotifier {
  readonly name = "my-notifier";
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("my-notifier: apiKey is required");
    this.apiKey = apiKey;
  }

  supports(eventType: NotificationEventType): boolean {
    return SUPPORTED_EVENTS.includes(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    const response = await fetch("https://api.example.com/notify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ summary: event.summary, severity: event.severity }),
    });

    if (!response.ok) {
      throw new Error(`my-notifier: API returned ${response.status}`);
    }
  }
}

// 環境変数がない場合は null を返す（PluginLoaderが検証する）
const _key = process.env["MY_API_KEY"];
export default _key ? new MyNotifier(_key) : null;
```

---

## テスト方法（vi.mock パターン）

### fetch をモックして notifier をテスト

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MyNotifier } from "../examples/plugins/my-notifier/src/index.js";
import type { NotificationEvent } from "../src/types/plugin.js";

describe("MyNotifier", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the API endpoint", async () => {
    const notifier = new MyNotifier("my-api-key");
    const event: NotificationEvent = {
      type: "task_blocked",
      goal_id: "goal-1",
      timestamp: new Date().toISOString(),
      summary: "Task blocked",
      details: {},
      severity: "warning",
    };

    await notifier.notify(event);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/notify");
  });

  it("throws when API returns non-OK status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "error" });
    const notifier = new MyNotifier("my-api-key");
    await expect(notifier.notify({} as NotificationEvent)).rejects.toThrow("500");
  });
});
```

### 外部SDKをモックして datasource をテスト

```typescript
import { describe, it, expect, vi } from "vitest";

// vi.hoisted でモックを定義し vi.mock より前に使えるようにする
const { mockPool } = vi.hoisted(() => {
  const mockPool = { query: vi.fn().mockResolvedValue({ rows: [{ count: 5 }] }) };
  return { mockPool };
});

vi.mock("some-db-library", () => ({
  default: { Pool: vi.fn().mockReturnValue(mockPool) },
}));

import { MyDbAdapter } from "../examples/plugins/my-db-datasource/src/index.js";
```

---

## プラグインのインストール方法

### ローカルインストール

プラグインディレクトリを `~/.conatus/plugins/` に配置する。

```bash
cp -r my-plugin ~/.conatus/plugins/my-plugin
```

ディレクトリ構造:

```
~/.conatus/plugins/
└── my-plugin/
    ├── plugin.yaml
    ├── src/
    │   └── index.ts    # entry_point が src/index.ts の場合
    └── dist/
        └── index.js    # ビルド後（entry_point が dist/index.js の場合）
```

### npm からインストール

```bash
# npmパッケージとしてインストール
npm install -g @conatus-plugins/pagerduty-notifier

# symlink で~/.conatus/plugins/に配置
ln -s $(npm root -g)/@conatus-plugins/pagerduty-notifier ~/.conatus/plugins/pagerduty-notifier
```

---

## `@conatus-plugins/` スコープでの npm 公開手順

1. `package.json` の `name` を `@conatus-plugins/<plugin-name>` に設定する。

2. `peerDependencies` に `"conatus": ">=0.1.0"` を追加する。

3. `exports` フィールドでエントリポイントを公開する。

```json
{
  "name": "@conatus-plugins/my-notifier",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "peerDependencies": { "conatus": ">=0.1.0" }
}
```

4. TypeScriptをビルドする。

```bash
npm run build
```

5. npm にログインして公開する。

```bash
npm login
npm publish --access public
```

---

## 既存プラグイン一覧

| プラグイン名 | 種類 | 場所 | 説明 |
|------------|------|------|------|
| `sqlite-datasource` | `data_source` | `examples/plugins/sqlite-datasource/` | SQLiteデータベース観測 |
| `postgres-datasource` | `data_source` | `examples/plugins/postgres-datasource/` | PostgreSQLデータベース観測 |
| `mysql-datasource` | `data_source` | `examples/plugins/mysql-datasource/` | MySQLデータベース観測 |
| `websocket-datasource` | `data_source` | `examples/plugins/websocket-datasource/` | WebSocketリアルタイムストリーム観測 |
| `sse-datasource` | `data_source` | `examples/plugins/sse-datasource/` | Server-Sent Eventsリアルタイムストリーム観測 |
| `jira-datasource` | `data_source` | `examples/plugins/jira-datasource/` | Jira REST API issueカウント観測 |
| `slack-notifier` | `notifier` | `plugins/slack-notifier/` | Slack Webhookへのイベント送信 |
| `pagerduty-notifier` | `notifier` | `examples/plugins/pagerduty-notifier/` | PagerDuty Events API v2へのインシデント送信 |
