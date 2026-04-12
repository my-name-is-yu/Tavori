# Self-Knowledge Tools Design

---

## 1. Why Self-Knowledge Tools Are Necessary

PulSeed has a chat interface. Users naturally ask questions about PulSeed itself -- "What goals do you have?", "What's your trust score?", "What model are you using?" PulSeed should answer these questions accurately, drawing from its actual runtime state rather than hallucinating.

The current grounding mechanism (`src/chat/grounding.ts`) injects a minimal summary (goal titles, provider name, plugin names) into every system prompt. This covers the basics but falls short in two ways:

- **Shallow**: It provides names and summaries, not details. "What's the gap score on goal X?" cannot be answered from a title alone.
- **Static**: Injecting everything "just in case" wastes tokens on every turn, even when the user is asking about something unrelated.

Self-Knowledge Tools solve this by giving the LLM **on-demand access** to PulSeed's internal state. The LLM decides when it needs information and calls the appropriate tool. When no self-knowledge is needed, the token cost is near zero.

---

## 2. Design Choice: Tool Use (Function Calling)

Four approaches were evaluated. Tool use was selected for its simplicity and token efficiency.

| Approach | Mechanism | Pros | Cons | Decision |
|----------|-----------|------|------|----------|
| **A. Tool use** | LLM calls tools when it needs information | Token-efficient (zero cost when unused), LLM decides autonomously, simple implementation | Tool definitions add ~300-600 tokens | **Adopted** |
| B. Dynamic injection | Pre-classify user message, inject relevant info | No tool overhead | Extra LLM call for classification, misclassification risk | Rejected |
| C. RAG | Embed self-knowledge, semantic search | Good for unstructured knowledge | Self-knowledge is structured data; embedding is overkill | Rejected |
| D. Hybrid | Combine approaches | Flexible | Complexity outweighs benefit for this use case | Rejected |

**Why tool use fits**: Self-knowledge is a small, well-defined set of structured queries. The LLM can reliably determine "the user is asking about goals" and call `get_goals`. No semantic search or pre-classification is needed.

---

## 3. Tool Definitions

Phase 1 provides six read-only self-knowledge tools. Phase 2 adds seven write/mutation tools (see Phase 2 section below). Each tool maps to a specific data source within PulSeed.

### 3.1 get_goals

Returns detailed information about all goals.

| Field | Description |
|-------|-------------|
| title | Goal title |
| description | Goal description |
| thresholds | Threshold definitions (min/max/range/present/match) |
| status | Current goal status |
| loop_status | Loop execution status |
| confidence | Observation confidence |
| current_state | Latest observed state |
| gap_score | Calculated gap score |

**Data source**: StateManager

**Use cases**: "What goals do you have?", "What's the progress on goal X?", "Show me the gap scores."

### 3.2 get_sessions

Returns recent session history.

| Field | Description |
|-------|-------------|
| goal_id | Associated goal |
| adapter | Adapter used (e.g., claude-code-cli, openai-codex) |
| status | Session outcome |
| duration | Execution time |
| created_at | Timestamp |

**Data source**: SessionManager (or StateManager session history)

**Parameters**: `limit` (default: 5) -- number of recent sessions to return.

**Use cases**: "What did you do recently?", "Show me the last session.", "How long did the previous run take?"

**Note**: SessionManager dependency is optional. When uninitialized, the handler returns "No session information available."

### 3.3 get_trust_state

Returns the current trust state and its governing rules.

| Field | Description |
|-------|-------------|
| trust_score | Current trust balance value |
| trust_balance_range | [-100, +100] |
| delta_success | +3 per successful verification |
| delta_failure | -10 per failed verification |
| high_trust_threshold | +20 (above this, some approvals are skipped) |
| ethics_gate_level | Current ethics gate level (e.g., L1) |
| execution_boundary | "PulSeed orchestrates goal pursuit. It perceives the world directly through read-only tools (Glob, Grep, Read, Shell, HttpFetch, JsonQuery) and delegates all mutations and complex multi-step work to agents." |

**Data source**: TrustManager + static definitions

**Use cases**: "What's my trust score?", "What constraints do you operate under?", "Can you run commands without approval?"

### 3.4 get_config

Returns runtime configuration.

| Field | Description |
|-------|-------------|
| provider | LLM provider name |
| model | Model identifier |
| default_adapter | Default adapter for task execution |
| pulseed_home_dir | PulSeed home directory path |

**Data source**: `~/.pulseed/provider.json` + runtime configuration

**Use cases**: "What model are you using?", "Show me your config.", "Where do you store state?"

### 3.5 get_plugins

Returns the list of installed plugins.

| Field | Description |
|-------|-------------|
| name | Plugin name |
| type | Plugin type (notifier, adapter, datasource) |
| enabled | Whether the plugin is active |

**Data source**: PluginLoader

**Use cases**: "What plugins are installed?", "Is the Slack notifier enabled?"

### 3.6 get_architecture

Returns a static description of PulSeed's architecture and capabilities.

**Content** (hardcoded string):
- Layer structure (Layer 0-15) with module names
- Module responsibilities summary
- Execution boundary: "PulSeed orchestrates goal pursuit. It perceives the world directly through read-only tools (Glob, Grep, Read, Shell, HttpFetch, JsonQuery) and delegates all mutations and complex multi-step work to agents."
<<<<<<< HEAD
- Runtime shape: CoreLoop (long-lived control) + AgentLoop (bounded execution with tool choice)
=======
- Runtime shape: CoreLoop for long-lived control plus AgentLoop for bounded tool-using execution
>>>>>>> e49c85c9 (implement native agentloop and coreloop phases)
- 4-element model: Goal -> Current State -> Gap -> Constraints

**Data source**: Hardcoded text

**Use cases**: "What is PulSeed?", "How does the core loop work?", "What can you do?", "Explain your architecture."

**Note**: Because this is a static string, it must be manually updated when the architecture changes. The current architecture should describe the dual-loop model rather than a single flat loop.

---

## 4. Relationship to Existing Grounding

Self-Knowledge Tools do **not** replace the existing grounding in `buildSystemPrompt()`. The two layers serve different purposes.

```
System prompt (every turn):
  - Goal titles and statuses (summary)
  - Provider name
  - Plugin names
  -> Gives the LLM basic awareness of "who it is"

Self-Knowledge Tools (on demand):
  - Full goal details with thresholds and gap scores
  - Session history
  - Trust state and rules
  - Configuration details
  - Plugin details
  - Architecture description
  -> Gives the LLM deep access when the user asks
```

The grounding layer ensures PulSeed never says "I don't know what goals I have." The tools layer ensures PulSeed can give a detailed, accurate answer when asked to elaborate.

---

## 5. Implementation

### 5.1 New Files

- `src/chat/self-knowledge-tools.ts` -- Tool definitions (JSON Schema format) and handler functions

### 5.2 Changed Files

- `src/chat/chat-runner.ts` -- Add self-knowledge tools to the `tools` array in LLM calls; handle `tool_call` responses by dispatching to the handler

### 5.3 Interface

```typescript
// Tool definitions for LLM function calling
export function getSelfKnowledgeToolDefinitions(): ToolDefinition[];

// Dispatch a tool call to the appropriate handler
export async function handleSelfKnowledgeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  deps: SelfKnowledgeDeps
): Promise<string>;

// Dependencies injected from the caller
interface SelfKnowledgeDeps {
  stateManager: StateManager;
  trustManager?: TrustManager;  // optional — graceful fallback when unavailable
  pluginLoader?: PluginLoader;  // optional — graceful fallback when unavailable
  homeDir: string;
}
```

**Handler return format**: All handlers return a JSON string. The LLM converts this into natural language in its response. This keeps the handler logic simple (serialize and return) and lets the LLM adapt the presentation to the user's question.

---

## 6. Token Cost Analysis

| Component | Token cost | When |
|-----------|-----------|------|
| Tool definitions (6 tools) | ~300-600 tokens | Every turn (included in tool schema) |
| Tool call result | ~100-500 tokens per call | Only when LLM calls a tool |
| Existing grounding | ~200-400 tokens | Every turn (unchanged) |

The tool definitions add a small fixed cost per turn. This is comparable to a single short paragraph in the system prompt. The key advantage is that detailed information (which could be 1000+ tokens if always injected) is only fetched when needed.

---

## 7. Testing

### 7.1 Unit Tests

`tests/chat/self-knowledge-tools.test.ts`:
- Each of the 6 handlers returns the expected structure
- `get_goals` correctly serializes goal state from StateManager
- `get_sessions` respects the `limit` parameter
- `get_sessions` returns a graceful message when SessionManager is unavailable
- `get_trust_state` includes all required fields
- `get_config` reads from provider.json
- `get_plugins` lists all loaded plugins
- `get_architecture` returns static text containing key terms
- Unknown tool names return an error message (not throw)

### 7.2 Integration Tests

`tests/chat/chat-grounding.test.ts` (additions):
- `getSelfKnowledgeToolDefinitions()` returns valid tool definitions
- Each definition has a name, description, and parameters schema

---

## 8. Design Decisions and Boundaries

**Why not merge tools**: Each tool maps to a distinct data source and concern. A single `get_self_info(category)` tool would work but gives the LLM less information in the tool description about what each category contains. Separate tools with descriptive names help the LLM choose correctly.

**Extensibility**: Adding a new self-knowledge tool requires: (1) add a tool definition, (2) add a handler function, (3) register it in the dispatcher. No changes to the chat runner or grounding are needed.

**Promotion to grounding**: If usage data shows a tool is called on the majority of turns, that information should be promoted to the grounding layer (always injected). This is the inverse of the original design motivation -- if something is always needed, it should always be present.

**No caching**: Self-knowledge queries read live state. Caching would add complexity and risk stale data. The queries are cheap (in-memory reads or single file reads), so caching is unnecessary.

**Error handling**: If a data source is unavailable (e.g., StateManager not initialized), the handler returns a human-readable error string rather than throwing. The LLM can then tell the user "that information is not available right now" instead of crashing the chat.

---

## Phase 2: Mutation Tools

Phase 2 adds 7 write/mutation tools that allow the LLM to modify PulSeed state on behalf of the user.

### Tool Summary

| Tool | Operation | Default Approval | Calls |
|------|-----------|-----------------|-------|
| `set_goal` | Create new goal | `none` | `StateManager.saveGoal()` |
| `update_goal` | Update existing goal fields | `none` | `StateManager.saveGoal()` |
| `archive_goal` | Archive a goal | `required` | `StateManager.archiveGoal()` |
| `delete_goal` | Delete a goal permanently | `required` | `StateManager.deleteGoal()` |
| `toggle_plugin` | Enable/disable a plugin | `required` | `PluginLoader.getPluginState()` + `updatePluginState()` |
| `update_config` | Update provider config | `required` | `saveProviderConfig()` |
| `reset_trust` | Override trust balance | `required` | `TrustManager.setOverride()` |

### Approval Flow

Each mutation tool has a default approval level: `"none"` or `"required"`.

- `"none"`: The operation proceeds immediately without user confirmation.
- `"required"`: The operation calls `approvalFn(description)` before executing. If `approvalFn` returns `false`, the tool returns `{ error: "User denied the operation" }`. If no `approvalFn` is configured, it returns `{ error: "This operation requires approval but no approval handler is configured" }`.

### Config Override

Users can override the default approval level per tool via `approvalConfig` in `ChatRunnerDeps`:

```typescript
approvalConfig: {
  set_goal: "required",   // Elevate read-only default to require approval
  delete_goal: "none",    // Remove requirement (use with caution)
}
```

The effective level resolves as: `approvalConfig?.[toolName] ?? DEFAULT_APPROVAL[toolName]`.

### Implementation

- **New file**: `src/chat/self-knowledge-mutation-tools.ts` — Tool definitions, handlers, dispatcher
- **Changed file**: `src/chat/chat-runner.ts` — Imports mutation tools, merges tool arrays, dispatches mutation calls, adds `trustManager`, `pluginLoader`, `approvalFn`, `approvalConfig` to `ChatRunnerDeps`

### MutationToolDeps Interface

```typescript
interface MutationToolDeps {
  stateManager: StateManager;
  trustManager?: TrustManager;
  pluginLoader?: PluginLoader;
  approvalFn?: (description: string) => Promise<boolean>;
  approvalConfig?: Record<string, ApprovalLevel>;
}
```

All deps except `stateManager` are optional. When a required dep is missing (e.g., `trustManager` for `reset_trust`), the handler returns a descriptive error.
