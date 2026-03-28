# PulSeed — External Data Source Integration Design

---

## 1. Overview

PulSeed's observation system (`observation.md` §2 Layer 1) can retrieve data from files and HTTP APIs as a means of mechanical observation. This document designs the abstraction layer for external data sources.

**MVP scope**: `file` and `http_api` only. `database` and IoT are deferred to a future phase.

**Read-only**: The MVP performs no write operations. Observation (READ) only.

---

## 2. IDataSourceAdapter Interface

```
interface IDataSourceAdapter {
  connect(config: DataSourceConfig): Promise<void>
  query(query: DataSourceQuery): Promise<DataSourceResult>
  disconnect(): Promise<void>
  healthCheck(): Promise<{ healthy: boolean; latency_ms?: number; error?: string }>
}
```

| Method | Role |
|--------|------|
| `connect` | Establishes connection and validates credentials. Called once when a data source is registered |
| `query` | Executes a single query and returns the result. Called by ObservationEngine |
| `disconnect` | Closes the connection. Called on process termination or source removal |
| `healthCheck` | Checks connection liveness. Must be executed before every polling call |

---

## 3. DataSourceType

```
type DataSourceType = "file" | "http_api" | "database" | "custom"
```

| Type | MVP support | Description |
|------|-------------|-------------|
| `file` | YES | Reads local files (JSON/CSV/text) |
| `http_api` | YES | Fetches metrics from an external HTTP API via GET/POST |
| `database` | NO (Phase 2) | SQL/NoSQL databases |
| `custom` | NO (Phase 2) | Plugin adapters (IoT, SaaS SDKs, etc.) |

---

## 4. DataSourceConfig

Holds connection information, polling configuration, and authentication settings for a data source.

```
DataSourceConfig {
  id: string                        // Unique identifier (e.g., "fitbit_steps")
  name: string                      // Display name
  type: DataSourceType
  connection: {
    path?: string                   // For file: absolute path
    url?: string                    // For http_api: endpoint URL
    method?: "GET" | "POST"         // For http_api: defaults to GET
    headers?: Record<string, string>
    body_template?: string          // Template for POST body (variable: {{dimension_name}})
  }
  polling?: PollingConfig
  auth?: {
    type: "none" | "api_key" | "basic" | "bearer"
    secret_ref?: string             // Key name in ~/.pulseed/secrets/<source_id>.json
  }
  enabled: boolean                  // Default: true
  created_at: string                // ISO 8601
  dimension_mapping?: Record<string, string>  // dimension_name → JSONPath or JQ expression
}
```

---

## 5. PollingConfig

```
PollingConfig {
  interval_ms: number    // Minimum 30,000ms (30 seconds)
  change_threshold?: number  // [0, 1] Change detection threshold. Only recorded in observation log when change exceeds this ratio
}
```

**Rationale for 30-second minimum interval**: Out of respect for external API rate limits and to avoid unnecessary polling.

---

## 6. DataSourceQuery

```
DataSourceQuery {
  dimension_name: string    // Name of the dimension to observe
  expression?: string       // JSONPath / JQ expression (overrides dimension_mapping)
  timeout_ms?: number       // Default: 10,000ms
}
```

---

## 7. DataSourceResult

```
DataSourceResult {
  value: number | string | boolean | null  // Extracted value
  raw: unknown                             // Raw response (for debugging and logging)
  timestamp: string                        // Observation execution time (ISO 8601)
  source_id: string                        // DataSourceConfig.id
  metadata?: Record<string, unknown>       // Status code, latency, etc.
}
```

---

## 8. Integration with ObservationEngine

Data source observation belongs to `observation.md` §2 **Layer 1 (Mechanical Observation)**.

| Property | Value |
|----------|-------|
| Confidence tier | `mechanical` |
| Confidence range | [0.85, 1.0] |
| Progress ceiling | 1.0 (no ceiling) |
| confidence_tier | `"mechanical"` |

### ObservationEngine Call Flow

```
1. Retrieve source from DataSourceRegistry
2. adapter.healthCheck() → On failure, significantly reduce confidence (0.30)
3. adapter.query(DataSourceQuery) → Obtain DataSourceResult
4. Extract value via dimension_mapping / expression
5. Record in ObservationLog (layer: "mechanical", method.type: "api_query" or "file_check")
6. Update Dimension.current_value
```

### Mapping to observation_method Field

```json
{
  "type": "api_query",
  "source": "<DataSourceConfig.id>",
  "schedule": "<cron expression or null>",
  "endpoint": "<connection.url or connection.path>",
  "confidence_tier": "mechanical"
}
```

---

## 9. Authentication Model

Secret information is not included in the source configuration file. It is stored separately in `~/.pulseed/secrets/<source_id>.json`.

```
~/.pulseed/secrets/fitbit_steps.json
{
  "api_key": "Bearer <token>"
}
```

`DataSourceConfig.auth.secret_ref` specifies the key name. The adapter reads this file on connection and retains it in memory only. File permissions of `600` are recommended.

---

## 10. DataSourceRegistry

```
DataSourceRegistry {
  sources: DataSourceConfig[]
}
```

Persistence location: `~/.pulseed/data-sources.json`

---

## 11. CLI Subcommands

```
pulseed datasource add    # Interactive configuration (with connection test)
pulseed datasource list   # List registered sources
pulseed datasource remove <id>
```

During `add`, `adapter.connect()` and `adapter.healthCheck()` are called in sequence. The source is registered only if both succeed.

---

## 12. MVP vs. Phase 2 Scope

### MVP

- `file` adapter: Read JSON/CSV/text files
- `http_api` adapter: GET/POST, API Key / Bearer / Basic authentication
- Polling: Timer based on interval_ms
- CLI: `add / list / remove`

### Phase 2 (future)

- `database` adapter (PostgreSQL, MySQL, SQLite)
- `custom` plugin adapters (IoT SDK, SaaS SDK)
- Real-time observation via WebSocket / Server-Sent Events
- Direct integration with event-driven observation (`drive-system.md` §3)

---

## 13. Design Decisions and Rationale

**Why read-only**

Per PulSeed's execution boundary principle (`execution-boundary.md` §1), PulSeed only observes and judges. Writing to external services is executed as a delegated task to agents.

**Why secrets are separated**

The configuration file (`data-sources.json`) is expected to be used for debugging, sharing, and version control. Separating credentials into a separate file structurally eliminates the risk of secrets leaking into that file.

**Why the minimum interval is 30 seconds**

This provides a safe margin against common external API rate limits (60 req/min). Sub-second polling is delegated to system metrics tools (e.g., Prometheus).
