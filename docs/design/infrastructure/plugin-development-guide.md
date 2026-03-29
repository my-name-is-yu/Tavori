# Plugin Development Guide

This guide explains how to develop PulSeed plugins.

---

## Plugin Types

PulSeed supports three types of plugins.

| Type | Interface | Purpose |
|------|-----------|---------|
| `data_source` | `IDataSourceAdapter` | Observe state from external APIs or databases |
| `notifier` | `INotifier` | Send PulSeed events to external services |
| `adapter` | `IAdapter` | Agent adapters (e.g., Claude Code CLI) |

---

## Writing plugin.yaml

Place a `plugin.yaml` file in the root directory of your plugin.

```yaml
name: my-notifier           # Required. Lowercase alphanumeric and hyphens only
version: "1.0.0"            # Required. Semver format
type: notifier              # Required. "adapter" | "data_source" | "notifier"
description: "Description"  # Required. Description of the plugin

# Capability declarations (referenced by CapabilityDetector)
capabilities:
  - my_capability           # Required. At least one entry

# data_source only: list of observable dimension names ("*" is a wildcard)
dimensions:
  - "*"

# notifier only: supported event types
supported_events:
  - goal_complete
  - task_blocked
  - approval_needed
  - stall_detected
  - trust_change
  - goal_progress

# Plugin entry point (relative path from plugin directory)
entry_point: "src/index.ts" # Default: "dist/index.js"

# Supported PulSeed version range (semver)
min_pulseed_version: "0.1.0"
max_pulseed_version: "2.0.0" # Optional

# Configuration schema (used by PluginLoader for validation)
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

# Resource access declarations (for security review)
permissions:
  network: true             # If the plugin makes HTTP requests
  file_read: false          # If the plugin reads files
  file_write: false         # If the plugin writes files
  shell: false              # If the plugin executes shell commands

# Required npm packages (PluginLoader checks that these are installed)
dependencies: []
```

---

## IDataSourceAdapter Interface Specification

```typescript
export interface IDataSourceAdapter {
  readonly sourceId: string;       // Unique plugin ID (matches DataSourceConfig.id)
  readonly sourceType: DataSourceType;  // "file" | "http_api" | "database" | "sse" | ...
  readonly config: DataSourceConfig;   // Config passed to connect()

  connect(): Promise<void>;        // Establish connection. Throw on failure
  query(params: DataSourceQuery): Promise<DataSourceResult>;  // Retrieve observed value
  disconnect(): Promise<void>;     // Release connection
  healthCheck(): Promise<boolean>; // true = healthy, false = unhealthy
  getSupportedDimensions?(): string[];  // Optional: list of supported dimension names
}
```

### DataSourceQuery

```typescript
interface DataSourceQuery {
  dimension_name: string;    // Name of the dimension to observe
  expression?: string;       // Query expression (SQL, JQL, JSONPath, etc. — plugin-specific)
  parameters?: Record<string, unknown>;  // Bind parameters
  timeout_ms?: number;       // Timeout in milliseconds
}
```

### DataSourceResult

```typescript
interface DataSourceResult {
  value: number | string | boolean | null;  // Scalar value (used for Gap calculation)
  raw: unknown;              // Raw API response (for debugging)
  timestamp: string;         // ISO 8601 format
  source_id: string;         // Matches DataSourceAdapter.sourceId
}
```

---

## INotifier Interface Specification

```typescript
export interface INotifier {
  readonly name: string;     // Plugin name (matches plugin.yaml name)

  notify(event: NotificationEvent): Promise<void>;  // Send event. Throw on failure
  supports(eventType: NotificationEventType): boolean;  // Whether this event type is handled
}
```

### NotificationEvent

```typescript
interface NotificationEvent {
  type: NotificationEventType;  // Event type
  goal_id: string;              // ID of the related Goal
  timestamp: string;            // ISO 8601 format
  summary: string;              // Human-readable one-line summary
  details: Record<string, unknown>;  // Additional data specific to the event type
  severity: "info" | "warning" | "critical";
}

type NotificationEventType =
  | "goal_progress"    // Goal progress update
  | "goal_complete"    // Goal achieved
  | "task_blocked"     // Task was blocked
  | "approval_needed"  // Human approval required
  | "stall_detected"   // Stall was detected
  | "trust_change";    // Trust score changed significantly
```

---

## Implementation Examples

### data_source Plugin

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
    // Connection establishment logic
    this.connected = true;
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    if (!this.connected) {
      throw new Error(`MyDataSourceAdapter [${this.sourceId}]: not connected`);
    }
    // Query execution logic
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

// Default export used by PluginLoader
export default new MyDataSourceAdapter({
  id: "my-datasource",
  name: "My DataSource",
  type: "http_api",
  connection: { url: process.env["MY_API_URL"] ?? "" },
  enabled: true,
  created_at: new Date().toISOString(),
});
```

### notifier Plugin

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

// Return null if the environment variable is not set (PluginLoader will validate)
const _key = process.env["MY_API_KEY"];
export default _key ? new MyNotifier(_key) : null;
```

---

## Testing (vi.mock Pattern)

### Testing a notifier by mocking fetch

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

### Testing a datasource by mocking an external SDK

```typescript
import { describe, it, expect, vi } from "vitest";

// Use vi.hoisted to define mocks before vi.mock
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

## Installing Plugins

### Local Installation

Place the plugin directory under `~/.pulseed/plugins/`.

```bash
cp -r my-plugin ~/.pulseed/plugins/my-plugin
```

Directory structure:

```
~/.pulseed/plugins/
└── my-plugin/
    ├── plugin.yaml
    ├── src/
    │   └── index.ts    # When entry_point is src/index.ts
    └── dist/
        └── index.js    # After build (when entry_point is dist/index.js)
```

### Installing from npm

```bash
# Install as an npm package
npm install -g @pulseed-plugins/pagerduty-notifier

# Symlink into ~/.pulseed/plugins/
ln -s $(npm root -g)/@pulseed-plugins/pagerduty-notifier ~/.pulseed/plugins/pagerduty-notifier
```

---

## Publishing to npm under the `@pulseed-plugins/` Scope

1. Set the `name` field in `package.json` to `@pulseed-plugins/<plugin-name>`.

2. Add `"pulseed": ">=0.1.0"` to `peerDependencies`.

3. Expose the entry point via the `exports` field.

```json
{
  "name": "@pulseed-plugins/my-notifier",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "peerDependencies": { "pulseed": ">=0.1.0" }
}
```

4. Build the TypeScript source.

```bash
npm run build
```

5. Log in to npm and publish.

```bash
npm login
npm publish --access public
```

---

## Existing Plugins

| Plugin Name | Type | Location | Description |
|-------------|------|----------|-------------|
| `sqlite-datasource` | `data_source` | `examples/plugins/sqlite-datasource/` | SQLite database observation |
| `postgres-datasource` | `data_source` | `examples/plugins/postgres-datasource/` | PostgreSQL database observation |
| `mysql-datasource` | `data_source` | `examples/plugins/mysql-datasource/` | MySQL database observation |
| `websocket-datasource` | `data_source` | `examples/plugins/websocket-datasource/` | WebSocket real-time stream observation |
| `sse-datasource` | `data_source` | `examples/plugins/sse-datasource/` | Server-Sent Events real-time stream observation |
| `jira-datasource` | `data_source` | `examples/plugins/jira-datasource/` | Jira REST API issue count observation |
| `slack-notifier` | `notifier` | `plugins/slack-notifier/` | Event delivery to Slack Webhook |
| `pagerduty-notifier` | `notifier` | `examples/plugins/pagerduty-notifier/` | Incident delivery to PagerDuty Events API v2 |
