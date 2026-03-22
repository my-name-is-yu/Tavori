# Conatus --- 外部データソース統合設計

---

## 1. 概要

Conatusの観測システム（`observation.md` §2 Layer 1）は、機械的観測の手段としてファイルおよびHTTP APIからデータを取得できる。本ドキュメントは外部データソースの抽象化レイヤーを設計する。

**MVPスコープ**: `file` および `http_api` のみ。`database`・IoTは将来フェーズ。

**読み取り専用**: MVPでは書き込み操作は行わない。観測（READ）のみ。

---

## 2. IDataSourceAdapter インターフェース

```
interface IDataSourceAdapter {
  connect(config: DataSourceConfig): Promise<void>
  query(query: DataSourceQuery): Promise<DataSourceResult>
  disconnect(): Promise<void>
  healthCheck(): Promise<{ healthy: boolean; latency_ms?: number; error?: string }>
}
```

| メソッド | 役割 |
|---------|------|
| `connect` | 接続確立・認証情報の検証。データソース登録時に1回呼ぶ |
| `query` | 単一クエリを実行し結果を返す。ObservationEngineから呼ばれる |
| `disconnect` | 接続を切断。プロセス終了・ソース削除時に呼ぶ |
| `healthCheck` | 接続の死活確認。ポーリング前に必ず実行する |

---

## 3. DataSourceType

```
type DataSourceType = "file" | "http_api" | "database" | "custom"
```

| 種別 | MVPサポート | 説明 |
|-----|-----------|------|
| `file` | YES | ローカルファイルの読み取り（JSON/CSV/テキスト） |
| `http_api` | YES | GET/POSTでメトリクスを取得する外部HTTP API |
| `database` | NO (Phase 2) | SQL/NoSQLデータベース |
| `custom` | NO (Phase 2) | プラグインアダプター（IoT、SaaS SDK等） |

---

## 4. DataSourceConfig

データソースの接続情報・ポーリング設定・認証設定を保持する。

```
DataSourceConfig {
  id: string                        // 一意識別子（例: "fitbit_steps"）
  name: string                      // 表示名
  type: DataSourceType
  connection: {
    path?: string                   // file用: 絶対パス
    url?: string                    // http_api用: エンドポイントURL
    method?: "GET" | "POST"         // http_api用: デフォルトGET
    headers?: Record<string, string>
    body_template?: string          // POSTボディのテンプレート（変数: {{dimension_name}}）
  }
  polling?: PollingConfig
  auth?: {
    type: "none" | "api_key" | "basic" | "bearer"
    secret_ref?: string             // ~/.conatus/secrets/<source_id>.json のキー名
  }
  enabled: boolean                  // デフォルト true
  created_at: string                // ISO 8601
  dimension_mapping?: Record<string, string>  // dimension_name → JSONPathまたはJQ式
}
```

---

## 5. PollingConfig

```
PollingConfig {
  interval_ms: number    // 最小 30,000ms（30秒）
  change_threshold?: number  // [0, 1] 変化検知の閾値。この割合以上変化した場合のみ観測ログに記録
}
```

**最小インターバル30秒の根拠**: 外部APIのレート制限に配慮し、不必要なポーリングを防ぐ。

---

## 6. DataSourceQuery

```
DataSourceQuery {
  dimension_name: string    // 観測する次元名
  expression?: string       // JSONPath / JQ式（dimension_mappingを上書き）
  timeout_ms?: number       // デフォルト 10,000ms
}
```

---

## 7. DataSourceResult

```
DataSourceResult {
  value: number | string | boolean | null  // 抽出済みの値
  raw: unknown                             // 生レスポンス（デバッグ・ログ用）
  timestamp: string                        // 観測実行日時（ISO 8601）
  source_id: string                        // DataSourceConfig.id
  metadata?: Record<string, unknown>       // ステータスコード・レイテンシ等
}
```

---

## 8. ObservationEngine との統合

データソース観測は `observation.md` §2 **Layer 1（機械的観測）** に属する。

| 項目 | 値 |
|-----|----|
| 信頼度層 | `mechanical` |
| 信頼度範囲 | [0.85, 1.0] |
| 進捗上限 | 1.0（上限なし） |
| confidence_tier | `"mechanical"` |

### ObservationEngine の呼び出しフロー

```
1. DataSourceRegistry からソースを取得
2. adapter.healthCheck() → 失敗時はconfidenceを大幅引き下げ（0.30）
3. adapter.query(DataSourceQuery) → DataSourceResult を取得
4. dimension_mapping / expression でvalue抽出
5. ObservationLog に記録（layer: "mechanical", method.type: "api_query" or "file_check"）
6. Dimension.current_value を更新
```

### observation_method フィールドへのマッピング

```json
{
  "type": "api_query",
  "source": "<DataSourceConfig.id>",
  "schedule": "<cron式 or null>",
  "endpoint": "<connection.url or connection.path>",
  "confidence_tier": "mechanical"
}
```

---

## 9. 認証モデル

秘密情報はソース設定ファイルに含めない。`~/.conatus/secrets/<source_id>.json` に分離して保存する。

```
~/.conatus/secrets/fitbit_steps.json
{
  "api_key": "Bearer <token>"
}
```

`DataSourceConfig.auth.secret_ref` がキー名を指定する。アダプターは接続時にこのファイルを読み取り、メモリ上でのみ保持する。ファイルのパーミッションは `600` を推奨。

---

## 10. DataSourceRegistry

```
DataSourceRegistry {
  sources: DataSourceConfig[]
}
```

永続化先: `~/.conatus/data-sources.json`

---

## 11. CLI サブコマンド

```
conatus datasource add    # インタラクティブ設定（接続テスト付き）
conatus datasource list   # 登録済みソース一覧
conatus datasource remove <id>
```

`add` 実行時に `adapter.connect()` と `adapter.healthCheck()` を順に呼び、成功した場合のみRegistryに登録する。

---

## 12. MVP と Phase 2 のスコープ

### MVP

- `file` アダプター: JSON/CSV/テキストファイルの読み取り
- `http_api` アダプター: GET/POST、API Key / Bearer / Basic 認証
- ポーリング: interval_ms ベースのタイマー
- CLI: `add / list / remove`

### Phase 2（将来）

- `database` アダプター（PostgreSQL、MySQL、SQLite）
- `custom` プラグインアダプター（IoT SDK、SaaS SDK）
- WebSocket / Server-Sent Events によるリアルタイム観測
- イベント駆動観測との直接統合（`drive-system.md` §3）

---

## 13. 設計上の判断と根拠

**なぜ読み取り専用か**

Conatusの実行境界原則（`execution-boundary.md` §1）により、Conatusは観察・判断のみを行う。外部サービスへの書き込みはエージェントへの委譲タスクとして実行する。

**なぜ secrets を分離するか**

設定ファイル（`data-sources.json`）はデバッグ・共有・バージョン管理が想定される。認証情報の混入リスクを構造的に排除するため、別ファイルに分離する。

**なぜ最小インターバルを30秒にするか**

外部APIの一般的なレート制限（60 req/min）に対して安全マージンを確保する。1秒未満のポーリングはシステムメトリクス専用（Prometheus等）に委譲する。
