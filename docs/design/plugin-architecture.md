# Plugin Architecture Design

> PulSeed plugins are not "tools users call" — they are "tools PulSeed autonomously selects and uses."
> This document defines the mechanism for extending external service integrations, notifications, and data observation as plugins,
> and how PulSeed autonomously selects them and evaluates their trustworthiness.

> Related: `data-source.md`, `trust-and-safety.md`, `task-lifecycle.md`, `knowledge-acquisition.md`, `execution-boundary.md`

---

## §1 Overview and PulSeedtion

### PulSeed vs Claude Code / OpenClaw

In Claude Code and OpenClaw, plugins are "tools the user explicitly calls." The user runs a command and the tool responds. The user is the active agent.

PulSeed plugins are different. PulSeed's core loop (observe → gap → score → task → execute → verify) runs autonomously without user instructions. Therefore, plugins must also be things **PulSeed autonomously selects and integrates into the core loop**. Not requiring user instructions like "please call this plugin" is the starting point of PulSeed's plugin design.

```
Claude Code / OpenClaw:
  User → "Search Jira" → Jira plugin → returns result to user

PulSeed:
  Core loop → "Which source is optimal for observing this dimension?"
             → Reference plugin manifests
             → Select jira-source based on trust score
             → Pass observation result to gap calculation (no user intervention)
```

### "Thin core, extend with plugins" principle

What belongs in PulSeed's core should be minimal. Use the following criteria:

| Criterion | Location | Example |
|-----------|----------|----|
| Essential to the core loop (observe/gap/score/task/execute/verify) | Core | GapCalculator, DriveScorer |
| Zero external dependencies, highly generic | Can be bundled with core | FileDataSourceAdapter, FileExistenceDataSourceAdapter |
| Depends on specific external services or SaaS | Plugin | JiraAdapter, SlackNotifier, LinearDataSource |
| Future expansion expected but not currently needed | Plugin candidate | Webhook adapter, custom LLM backend |

This principle keeps the PulSeed core small and delegates service-specific logic to plugins.

---

## §2 Plugin Types

PulSeed supports three types of plugins. Each corresponds to an existing or new interface.

### 2.1 adapter plugins (IAdapter implementation)

**Role**: Task execution targets. Adds agents and systems that PulSeed delegates tasks to.

**Corresponding interface**: `IAdapter` in `src/adapter-layer.ts`

```typescript
// Existing interface (unchanged)
interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  listExistingTasks?(): Promise<string[]>;
  checkDuplicate?(task: AgentTask): Promise<boolean>;
}
```

**Lifecycle**:
1. Automatically registered into `AdapterRegistry` when plugin loads
2. Selected by capability matching from `AdapterRegistry` at task generation time
3. Called from `TaskLifecycle.execute()`

**Plugin examples**: GitHub Issue Adapter, Jira Adapter, Linear Adapter, Slack App Adapter, custom CLI agents

### 2.2 data_source plugins (IDataSourceAdapter implementation)

**Role**: Sources for observation data. Used by ObservationEngine to observe the state vector.

**Corresponding interface**: `IDataSourceAdapter` in `src/data-source-adapter.ts`

```typescript
// Existing interface (unchanged)
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

**Lifecycle**:
1. Automatically registered into `DataSourceRegistry` when plugin loads
2. `ObservationEngine.findDataSourceForDimension()` selects based on dimension name and capability matching
3. Called in Layer 1 (mechanical observation) of the observation loop
4. Results are treated as `confidence_tier: "mechanical"` (highest trust)

**Plugin examples**: Jira Data Source, GitHub Data Source, Datadog Metrics, PostgreSQL Data Source, Slack Channel Monitor

### 2.3 notifier plugins (INotifier implementation — new)

**Role**: Notification destinations. Sends notifications when PulSeed detects specific events.

**Corresponding interface**: New definition (added to `src/types/plugin.ts`)

```typescript
interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}

type NotificationEventType =
  | "goal_progress"      // goal progress updated
  | "goal_complete"      // goal achieved
  | "task_blocked"       // task was blocked
  | "approval_needed"    // human approval needed
  | "stall_detected"     // stall detected
  | "trust_change";      // trust score changed significantly

interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string;        // ISO 8601
  summary: string;          // one-line summary for human reading
  details: Record<string, unknown>;  // event-type-specific data
  severity: "info" | "warning" | "critical";
}
```

**Lifecycle**:
1. Automatically registered into `NotifierRegistry` (new) when plugin loads
2. `NotificationDispatcher` selects the appropriate Notifier with `notifier.supports(eventType)`
3. Multiple Notifiers may receive the same event (e.g., simultaneous Slack and email notifications)
4. Do Not Disturb and rate limiting are managed centrally in NotificationDispatcher (plugins do not own this logic)

**Plugin examples**: Slack Notifier, Email Notifier, Discord Notifier, PagerDuty Notifier, LINE Notify

---

## §3 Capability Declaration Schema (Plugin Manifest)

Each plugin includes a manifest file (`plugin.yaml` or `plugin.json`). The manifest is a capability declaration that tells PulSeed's autonomous selection engine "what this plugin can do."

### 3.1 Manifest example

```yaml
# ~/.pulseed/plugins/jira-source/plugin.yaml
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
description: "Observes issue status and sprint progress in a Jira project"
config_schema:
  project_key:
    type: string
    required: true
    description: "Jira project key (e.g., PROJ)"
  base_url:
    type: string
    required: true
    description: "Base URL of the Jira instance"
  auth_type:
    type: string
    enum: ["api_token", "oauth2"]
    default: "api_token"
dependencies:
  - "@atlassian/jira-client@^3.0.0"
entry_point: "dist/index.js"
min_pulseed_version: "1.0.0"
```

```yaml
# ~/.pulseed/plugins/slack-notifier/plugin.yaml
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
description: "Sends PulSeed events to a Slack channel"
config_schema:
  channel:
    type: string
    required: true
    description: "Target Slack channel (e.g., #pulseed-alerts)"
  mention_on_critical:
    type: boolean
    default: true
    description: "Whether to add a mention for critical events"
dependencies:
  - "@slack/web-api@^6.0.0"
entry_point: "dist/index.js"
min_pulseed_version: "1.0.0"
```

### 3.2 Manifest Zod schema definition

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
  name: z.string().regex(/^[a-z0-9-]+$/, "Plugin name must contain only lowercase alphanumerics and hyphens"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.enum(["adapter", "data_source", "notifier"]),

  // Capability declarations (referenced by CapabilityDetector)
  capabilities: z.array(z.string()).min(1),

  // data_source only: list of observable dimension names
  dimensions: z.array(z.string()).optional(),

  // notifier only: supported event types
  supported_events: z.array(z.string()).optional(),

  description: z.string(),
  config_schema: z.record(ConfigFieldSchema).default({}),

  // npm package dependencies
  dependencies: z.array(z.string()).default([]),

  // Plugin entry point (relative path from plugin directory)
  entry_point: z.string().default("dist/index.js"),

  // Required PulSeed version (semver range)
  min_pulseed_version: z.string().optional(),

  // Declared resource access (for security review)
  permissions: z.object({
    network: z.boolean().default(false),
    file_read: z.boolean().default(false),
    file_write: z.boolean().default(false),
    shell: z.boolean().default(false),
  }).default({}),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// Plugin runtime state
export const PluginStateSchema = z.object({
  name: z.string(),
  manifest: PluginManifestSchema,
  status: z.enum(["loaded", "error", "disabled"]),
  error_message: z.string().optional(),
  loaded_at: z.string(),               // ISO 8601
  // Trust score (asymmetric design as in trust-and-safety.md §2)
  trust_score: z.number().int().min(-100).max(100).default(0),
  usage_count: z.number().int().default(0),
  success_count: z.number().int().default(0),
  failure_count: z.number().int().default(0),
});

export type PluginState = z.infer<typeof PluginStateSchema>;
```

---

## §4 Plugin Loader

`PluginLoader` (`src/plugin-loader.ts`) is responsible for plugin discovery, loading, registration, and validation.

### 4.1 Discovery

Plugins are placed as subdirectories under `~/.pulseed/plugins/`.

```
~/.pulseed/plugins/
├── jira-source/
│   ├── plugin.yaml        # manifest (required)
│   ├── dist/
│   │   └── index.js       # entry point
│   └── config.json        # user config (optional)
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

Discovery runs once at startup. Each subdirectory under `~/.pulseed/plugins/` is scanned, and those containing `plugin.yaml` or `plugin.json` are treated as plugin candidates.

### 4.2 Loading

```typescript
class PluginLoader {
  async loadAll(): Promise<PluginState[]> {
    const pluginDirs = await this.discoverPluginDirs();
    const results = await Promise.allSettled(
      pluginDirs.map((dir) => this.loadOne(dir))
    );
    // Failed plugins emit an error log and are skipped
    // They do not crash the PulSeed process
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : this.buildErrorState(pluginDirs[i], r.reason)
    );
  }

  private async loadOne(pluginDir: string): Promise<PluginState> {
    // 1. Load manifest and validate against schema
    const manifest = await this.loadManifest(pluginDir);

    // 2. Dynamic import of entry point
    const entryPath = path.join(pluginDir, manifest.entry_point);
    const module = await import(entryPath);

    // 3. Interface compliance check
    this.validateInterface(manifest.type, module.default);

    // 4. Register with the appropriate Registry
    await this.registerPlugin(manifest, module.default, pluginDir);

    return this.buildSuccessState(manifest);
  }
}
```

### 4.3 Registration

Automatically registers with the appropriate Registry based on plugin type.

| Plugin type | Registry | Registration method |
|------------|---------|-------------------|
| `adapter` | `AdapterRegistry` | `registry.register(adapter)` |
| `data_source` | `DataSourceRegistry` | `registry.register(adapter)` |
| `notifier` | `NotifierRegistry` (new) | `registry.register(name, notifier)` |

### 4.4 Validation

Two types of validation are performed when loading a plugin.

**Manifest validation**: Validates PluginManifest against the Zod schema. Detects missing required fields, type mismatches, and version format errors.

**Interface compliance check**: Confirms that `module.default` has the required methods.

```typescript
function validateInterface(type: PluginType, impl: unknown): void {
  const requiredMethods: Record<PluginType, string[]> = {
    adapter: ["execute", "adapterType"],
    data_source: ["connect", "query", "disconnect", "healthCheck"],
    notifier: ["name", "notify", "supports"],
  };
  for (const method of requiredMethods[type]) {
    if (!(method in (impl as object))) {
      throw new Error(`Plugin is missing required method "${method}"`);
    }
  }
}
```

### 4.5 Error handling

Plugin load failures do not crash the PulSeed process.

```
Plugin load failure cases:
  - plugin.yaml not found or parse error → skip, warning log
  - entry_point file not found → skip, warning log
  - Manifest validation error → skip, error log (with details)
  - Interface compliance violation → skip, error log (with missing method names)
  - dynamic import error (syntax error, etc.) → skip, error log

PulSeed startup behavior:
  - Output list of failed plugins in startup log
  - Enable only successfully loaded plugins and continue startup
  - Use `pulseed plugin list` to check the status of each plugin
```

---

## §5 PulSeed Autonomous Plugin Selection (3 Phases)

PulSeed's ability to autonomously use plugins is strengthened incrementally across three phases.

### Phase 1 — Manual configuration (implemented in M9)

Plugins are explicitly specified within the goal definition. PulSeed simply follows the specification and performs no autonomous selection.

**Example specification in goal definition**:

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

**Behavior**:
- Plugins specified in `plugin_config.data_sources` are used for observation via `DataSourceRegistry`
- Plugins specified in `plugin_config.adapters` are used as task execution targets
- Plugins specified in `plugin_config.notifiers` receive notifications

Phase 1 has zero autonomy. "Which plugins to use" is entirely determined by the user. However, "when to call plugins" is decided by PulSeed within the core loop.

### Phase 2 — Capability auto-matching (implemented in M10)

When no plugins are specified in a goal definition, `CapabilityDetector` automatically selects candidates by referencing plugin manifests.

**Matching logic**:

```
1. Get the list of dimension names from the goal
   Example: ["open_count", "velocity", "cycle_time"]

2. Scan plugin manifests registered in DataSourceRegistry
   - Match manifest's dimensions[] against dimension names
   - Calculate score by the proportion of matched dimensions (e.g., 3/3 = 1.0)

3. Select plugins with score >= threshold (0.5) as candidates

4. LLM suitability confirmation (optional):
   Prompt: "Is the plugin '{plugin name}: {plugin description}'
            appropriate for observing the dimension '{dim}'
            of the goal '{goal description}'? Answer yes/no with reasoning."

5. Suggest candidate plugins to user (run automatically but with notification)
   Or auto-select if trust_score meets the Phase 3 criteria
```

`ObservationEngine.findDataSourceForDimension()` is extended in Phase 2 to account for plugin capability matching.

```typescript
// Extended findDataSourceForDimension (conceptual)
async findDataSourceForDimension(dimensionName: string): Promise<IDataSourceAdapter | null> {
  // Existing: search explicitly configured data sources first
  const explicit = this.registry.findByDimension(dimensionName);
  if (explicit) return explicit;

  // Phase 2 extension: search by plugin manifest's dimensions[]
  const pluginMatch = this.pluginRegistry.findByDimension(dimensionName);
  if (pluginMatch) {
    // Auto-select only if trust score is high enough
    if (pluginMatch.trust_score >= PLUGIN_AUTO_SELECT_THRESHOLD) {
      return pluginMatch.adapter;
    }
    // Below threshold: notify user first, then use
    await this.notifyPluginSuggestion(pluginMatch, dimensionName);
    return pluginMatch.adapter;
  }

  return null;
}
```

### Phase 3 — Trust-based learning selection (implemented in M11)

Use trust scores based on plugin usage history to make smarter autonomous selections.

**Trust score design**

Adopts the same asymmetric design as TrustManager in `trust-and-safety.md` §2.

```
Initial value: 0 (low-trust side)
On success: +Δs = +3 (small success reward)
On failure: -Δf = -10 (large failure penalty)
Range: [-100, +100]
Auto-selection threshold: +20 or above (reached after 7 consecutive successes)
```

Rationale for asymmetry: If an unreliable plugin contaminates observation data, gap calculation accuracy drops and incorrect tasks are generated. Damage to observation quality has cascading effects, so failure penalties are heavy.

**Per-goal-domain trust management**

Plugin trust scores are managed per goal domain. This prevents a track record in "code review goals" from carrying over to trust in "marketing goals."

```
plugin: jira-source
  trust_by_domain:
    software_development: +24   # 8 successes, 0 failures
    project_management: +12     # 4 successes, 0 failures
    marketing: 0                # no usage history
```

**Cross-goal knowledge sharing**

Integration with `KnowledgeManager` allows plugin effectiveness to be learned and shared.

```
jira-source successfully observes the "open_count" dimension in goal A
  → KnowledgeManager records: "jira-source is effective for open_count observation (goal A track record)"
  → When goal B observes the same dimension, jira-source is recommended as a priority candidate
```

**Priority selection algorithm**

When multiple plugins can observe the same dimension, select using the following priority order:

```
1. Explicit configuration (goal_config.plugin_config) takes top priority
2. Plugin with the highest trust_score in the same domain
3. Plugin with an effectiveness record in similar goals in KnowledgeManager
4. New plugins with trust_score = 0 (tie-broken by manifest priority order)
```

**Handling new plugins**

Newly added plugins start at trust_score = 0. Since they have not reached the Phase 3 auto-selection threshold (+20), the user is always notified before first use. Once track record accumulates and the threshold is exceeded, autonomous selection occurs without notification.

---

## §6 INotifier Interface and NotifierRegistry

### 6.1 Interface definition

```typescript
// Added to src/types/plugin.ts

interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}

interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string;           // ISO 8601
  summary: string;             // one-line summary for human reading (used by Notifier for formatting)
  details: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
}

type NotificationEventType =
  | "goal_progress"      // goal progress updated
  | "goal_complete"      // goal achieved
  | "task_blocked"       // task was blocked (escalation)
  | "approval_needed"    // approval request from trust-and-safety.md §4
  | "stall_detected"     // stall detection from stall-detection.md
  | "trust_change";      // trust score of plugin or PulSeed itself changed significantly
```

### 6.2 NotifierRegistry (new)

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

### 6.3 Integration with NotificationDispatcher

`NotificationDispatcher` (existing module) uses NotifierRegistry for routing to plugins.

**Important**: Do Not Disturb, rate limiting, and deduplication logic are managed centrally in `NotificationDispatcher`. Notifier plugins do not own this logic. Plugins are responsible only for "sending" — the decision of "whether to send" is made on the Dispatcher side.

```
NotificationDispatcher.dispatch(event)
  ↓
  Do Not Disturb check (core side)
  ↓
  Rate limit check (core side)
  ↓
  NotifierRegistry.findForEvent(event.type)
  ↓
  Call each INotifier.notify(event) in parallel
  (if one fails, notification to other Notifiers continues)
```

---

## §7 Security and Constraints

### 7.1 Execution model (MVP)

In MVP, plugins run in the same process as PulSeed. No sandbox is applied. The rationale and constraints for this decision are as follows:

| Item | Details |
|------|---------|
| Execution model | Same process (Node.js dynamic import) |
| Sandbox | None (MVP) |
| Trust assumption | Only targets plugins manually installed by the user |
| Future | VM isolate or Worker Threads considered in Phase 2 |

The constraint of same-process execution is that a malicious plugin could directly access PulSeed's internal state. This is acceptable because the user explicitly placed the plugin in `~/.pulseed/plugins/` — an act of explicit trust.

### 7.2 Integration with EthicsGate

Tasks generated by plugins are also subject to `EthicsGate` review. If a plugin-originated task does not pass the ethics gate, the task is rejected and the plugin's trust score is decremented by -10.

```
Task generated by plugin adapter
  ↓
EthicsGate.check(task)  // see goal-ethics.md
  ↓
  Rejected → discard task + plugin trust_score -= 10
  Approved → pass to TaskLifecycle
```

### 7.3 Secret management

Plugin authentication credentials (API keys, etc.) are not included in the manifest. They are separated into a dedicated config file.

```
~/.pulseed/plugins/<plugin-name>/config.json   # user config (may contain API keys, etc.)
```

The recommended permission for this file is `600` (owner read/write only). Plugins read this file at startup and retain it in memory only.

**The manifest's `config_schema`** only declares which fields are required — it does not hold values.

### 7.4 Permission declaration

The manifest's `permissions` field pre-declares the resource access the plugin requires.

```yaml
permissions:
  network: true      # needs external network access (HTTP to Jira API, etc.)
  file_read: false   # no local file reading needed
  file_write: false  # no local file writing needed
  shell: false       # no shell command execution needed
```

In MVP, permission declarations are **informational only** and are not enforced at runtime. They serve as prerequisite information for adding permission enforcement in future phases. Plugins declaring `shell: true` display an explicit warning during `pulseed plugin install`.

---

## §8 Connection to Existing Modules

Clarifying how each existing module connects to the plugin architecture.

| Module | Changes | Connection method |
|--------|---------|------------------|
| `CoreLoop` | No change | Used indirectly via registered adapters and data sources |
| `ObservationEngine` | Add plugin matching to `findDataSourceForDimension()` | Via `DataSourceRegistry` (extended in Phase 2) |
| `TaskLifecycle` | No change | Via `AdapterRegistry` (plugins auto-registered) |
| `NotificationDispatcher` | Add routing from `NotifierRegistry` | Calls `NotifierRegistry.findForEvent()` |
| `CapabilityDetector` | Reference plugin manifests in `detectGoalCapabilityGap()` | Receives manifest list from `PluginLoader` (Phase 2) |
| `TrustManager` | Add plugin trust_score tracking | Updates `PluginState.trust_score` (Phase 3) |
| `KnowledgeManager` | Record and share plugin effectiveness | Receives `onPluginSuccess/Failure()` hooks (Phase 3) |

### Full picture from CoreLoop

```
CoreLoop (unchanged)
    │
    ├── ObservationEngine
    │     └── DataSourceRegistry (includes plugin data_sources)
    │           → jira-source (plugin)
    │           → github-datasource (plugin)
    │           → FileDataSourceAdapter (bundled with core)
    │
    ├── TaskLifecycle
    │     └── AdapterRegistry (includes plugin adapters)
    │           → linear-adapter (plugin)
    │           → ClaudeCodeCLIAdapter (bundled with core)
    │
    └── NotificationDispatcher
          └── NotifierRegistry (includes plugin notifiers)
                → slack-notifier (plugin)
                → email-notifier (plugin)
```

---

## §9 Implementation Roadmap

### M9: Plugin infrastructure (Phase 1)

**Scope**:
- `PluginManifest` Zod schema (`src/types/plugin.ts`)
- `INotifier` interface and `NotificationEvent` type
- `NotifierRegistry` (`src/notifier-registry.ts`)
- `PluginLoader` (`src/plugin-loader.ts`) — discovery, loading, validation, registration
- `NotifierRegistry` integration into `NotificationDispatcher`
- CLI: `pulseed plugin list`, `pulseed plugin install <path>`, `pulseed plugin remove <name>`
- Phase 1 `plugin_config` field support in goal definitions

**Completion criteria**:
- Plugins placed in `~/.pulseed/plugins/` are auto-detected and registered at startup
- Failed plugin loads do not crash PulSeed
- Slack Notifier reference implementation works (E2E test)

### M10: Capability auto-matching (Phase 2)

**Scope**:
- Extend `CapabilityDetector.detectGoalCapabilityGap()` to reference plugin manifests
- Extend `ObservationEngine.findDataSourceForDimension()` with plugin matching
- LLM suitability confirmation prompt
- Plugin suggestion notification format for users

**Completion criteria**:
- Plugins are automatically proposed as candidates via dimension name matching for goals without explicit plugin configuration
- LLM suitability confirmation results are recorded in the log

### M11: Trust-based learning selection (Phase 3)

**Scope**:
- `TrustManager` plugin `trust_score` tracking
- `trust_by_domain` management per goal domain
- Integration with `KnowledgeManager` for plugin effectiveness sharing
- Priority selection algorithm implementation
- Trust score display in `pulseed plugin list`

**Completion criteria**:
- Plugin trust_score is asymmetrically updated based on success/failure
- High-trust plugins are preferred over low-trust plugins for the same dimension
- Cross-goal learning plugin recommendation works

### Future phases

| Phase | Details |
|-------|---------|
| Plugin marketplace | Search and install community plugins with `pulseed plugin search <keyword>` |
| Version management | Enforce `min_pulseed_version` / `max_pulseed_version`, migration support for breaking changes |
| Worker Thread isolation | Isolate from the same process to improve crash resilience |
| Plugin signing | Tamper detection via code signing |

---

## Design Principles Summary

| Principle | Concrete design decision |
|-----------|------------------------|
| PulSeed is the active agent | Plugins are not "called" — they are selected and used by PulSeed |
| Incremental autonomy | Phase 1 (manual) → Phase 2 (capability matching) → Phase 3 (trust learning) |
| Leverage existing interfaces | IAdapter and IDataSourceAdapter are not changed — only the registration path is added |
| Failures do not stop PulSeed | Plugin load failures and execution failures are logged and skipped |
| Trust is asymmetric | Failure penalty > success reward (same design philosophy as TrustManager) |
| Separate secrets | Authentication credentials are not included in manifests — separated to `config.json` |
| Keep the core thin | All external service dependencies belong in plugins. Core contains only generic logic |
