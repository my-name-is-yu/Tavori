# Tool Integration Design

## 1. Overview

PulSeed has two existing tool systems that need to be unified:

**System A** (`src/tools/`): ITool class-based registry with ToolRegistry, ToolExecutor, ToolPermissionManager. Used by CoreLoop and ObservationEngine. Contains 20+ tools across `filesystem/`, `git/`, `state/`, `network/`, `system/`, `meta/` categories.

**System B** (`src/interface/chat/`): Raw ToolDefinition JSON schemas used by ChatRunner for LLM function calling. Contains 6 self-knowledge read tools and 7 mutation tools.

**Decision**: Integrate System B into System A. ChatRunner adapts ITool instances to ToolDefinition JSON via a `toToolDefinition()` adapter. No third system.

```
┌──────────────────────────────────────┐
│   System A: ITool Registry           │
│   src/tools/ — ToolRegistry,         │
│   ToolExecutor, ToolPermissionManager│
│   (filesystem, git, state, network,  │
│    system, meta + new state tools)   │
└──────────┬───────────────┬───────────┘
           │               │
    ┌──────▼──────┐  ┌─────▼──────────────┐
    │  CoreLoop   │  │  ChatRunner         │
    │  Goal-driven│  │  LLM function calls │
    │  (existing) │  │  via toToolDef()    │
    └─────────────┘  └────────────────────┘
```

**AgentLoop** (interactive): ChatRunner exposes ITool instances as ToolDefinition JSON for LLM function calling. LLM freely picks tools.

**CoreLoop** (autonomous): Fixed sequence using ITool instances directly via ToolExecutor.

---

## 2. Tool Primitives

System A tools implement the existing `ITool` interface from `src/tools/types.ts` (or equivalent). No new tool type abstraction is introduced.

For ChatRunner compatibility, a single adapter converts any ITool to LLM-compatible JSON:

```typescript
// src/tools/tool-definition-adapter.ts
import type { ITool } from './types.js';
import type { ToolDefinition } from '../base/llm/llm-client.js';

export function toToolDefinition(tool: ITool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        ...tool.inputSchema,  // ITool already carries JSON schema properties/required
      },
    },
  };
}
```

ChatRunner calls `registry.getAll().map(toToolDefinition)` to build its tool list. ToolRegistry and ToolExecutor remain unchanged.

---

## 3. Directory Structure

`src/tools/` already exists. New tools are added to the existing `state/` category using the flat-file pattern already established (no per-tool subdirectories needed — see existing `state/goal-state.ts` pattern).

**Current structure (System A, existing):**

```
src/tools/
├── registry.ts             # ToolRegistry
├── executor.ts             # ToolExecutor
├── permission.ts           # ToolPermissionManager
├── concurrency.ts
├── index.ts
├── filesystem/             # read, write, edit, glob, grep, list-dir, json-query, file-validation
├── git/                    # git-diff, git-log
├── state/                  # goal-state, trust-state, session-history, progress-history, knowledge-query
├── network/                # http-fetch, web-search
├── system/                 # shell, env, process-status, sleep, test-runner
├── meta/                   # tool-search
└── builtin/
```

**After Phase 0 migration (new files in `state/`):**

```
src/tools/state/
├── goal-state.ts           # existing (≈ ReadState)
├── trust-state.ts          # existing
├── session-history.ts      # existing
├── progress-history.ts     # existing
├── knowledge-query.ts      # existing (≈ SearchKnowledge)
├── config-tool.ts          # NEW — read config/provider settings
├── plugin-state-tool.ts    # NEW — list active plugins
├── architecture-tool.ts    # NEW — read module map / architecture
├── set-goal-tool.ts        # NEW — create goal (from mutation-tool-defs.ts)
├── update-goal-tool.ts     # NEW — update goal fields (from mutation-tool-defs.ts)
├── archive-goal-tool.ts    # NEW — archive a completed goal (from mutation-tool-defs.ts)
├── delete-goal-tool.ts     # NEW — delete a goal (from mutation-tool-defs.ts)
├── toggle-plugin-tool.ts   # NEW — enable/disable plugin (from mutation-tool-defs.ts)
├── update-config-tool.ts   # NEW — update config key (from mutation-tool-defs.ts)
└── reset-trust-tool.ts     # NEW — reset trust score (from mutation-tool-defs.ts)
```

```
src/tools/
└── tool-definition-adapter.ts   # NEW — toToolDefinition() adapter
```

---

## 4. Tool Inventory

**Existing System A tools (unchanged):**

| Tool | Category | Notes |
|------|----------|-------|
| read, file-write, file-edit, glob, grep, list-dir, json-query, file-validation | filesystem | |
| git-diff, git-log | git | |
| goal-state, trust-state, session-history, progress-history, knowledge-query | state | ≈ System B read tools |
| http-fetch, web-search | network | |
| shell, env, process-status, sleep, test-runner | system | |
| tool-search | meta | |

**New tools added in Phase 0 (migrated from System B):**

| Tool | Category | readOnly | Destructive | Source |
|------|----------|----------|-------------|--------|
| config-tool | state | true | false | self-knowledge-tools.ts |
| plugin-state-tool | state | true | false | self-knowledge-tools.ts |
| architecture-tool | state | true | false | self-knowledge-tools.ts |
| set-goal-tool | state | false | false | mutation-tool-defs.ts |
| update-goal-tool | state | false | false | mutation-tool-defs.ts |
| archive-goal-tool | state | false | false | mutation-tool-defs.ts |
| delete-goal-tool | state | false | false | mutation-tool-defs.ts |
| toggle-plugin-tool | state | false | false | mutation-tool-defs.ts |
| update-config-tool | state | false | false | mutation-tool-defs.ts |
| reset-trust-tool | state | false | true | mutation-tool-defs.ts |

Note: only irreversible/damaging operations (reset-trust-tool) get rich LLM descriptions with risk warnings.

---

## 5. Tool Registration

ToolRegistry already provides `register()` and `getAll()`. New tools are registered at startup alongside existing tools. No changes to registry internals.

```typescript
// src/tools/index.ts (modified)
import { toToolDefinition } from './tool-definition-adapter.js';

export function getAllTools(): ITool[] {
  return registry.getAll();  // existing + new state tools
}

export { toToolDefinition };
```

ChatRunner replaces its hardcoded ToolDefinition arrays:

```typescript
// src/interface/chat/chat-runner.ts (modified)
import { getAllTools, toToolDefinition } from '../../tools/index.js';

const tools = getAllTools().map(toToolDefinition);
```

---

## 6. Real-Time Status Display

Existing tools already emit status through ToolExecutor. Status format follows the existing `∿` symbol pattern used in TUI.

---

## 7. Implementation Phases

**Phase 0: Integration Migration**

Migrate System B into System A. No new functionality — behavior preserved exactly.

1. Add 3 missing read tools to `src/tools/state/`: `config-tool.ts`, `plugin-state-tool.ts`, `architecture-tool.ts` (from `self-knowledge-tools.ts`)
2. Add 7 mutation tools to `src/tools/state/`: set-goal-tool, update-goal-tool, archive-goal-tool, delete-goal-tool, toggle-plugin-tool, update-config-tool, reset-trust-tool (from `mutation-tool-defs.ts` + `self-knowledge-mutation-tools.ts`)
3. Create `src/tools/tool-definition-adapter.ts` — `toToolDefinition(tool: ITool): ToolDefinition`
4. Wire `chat-runner.ts` to use `getAllTools().map(toToolDefinition)` instead of raw definitions
5. Deprecate System B files with re-export shims for backward compatibility

Files: ~11 new (state tools + adapter), 2 modified (chat-runner.ts, tools/index.ts), 3 shims (self-knowledge-tools.ts, mutation-tool-defs.ts, self-knowledge-mutation-tools.ts)

Tests: verify all existing chat-runner and self-knowledge tool tests pass unchanged after migration.

**Phase A: New Tools**

Add tools not currently in System A, using ITool interface.

- RunAdapter — wrap AdapterLayer.run() as ITool
- SpawnSession — wrap SessionManager.spawn() as ITool
- QueryDataSource — wrap ObservationEngine data source query as ITool
- AskHuman, CreatePlan, ReadPlan — interaction tools for AgentLoop

Files: ~5-7 new tools in existing categories | Tests: unit tests per tool + AgentLoop integration

**Phase B: CoreLoop Migration**

Refactor CoreLoop to call tool primitives via ToolExecutor instead of module methods directly. Both loops verified sharing tools correctly.

Files: 3-5 modified (core-loop.ts, observation-engine.ts) | Tests: CoreLoop integration tests

**Phase C: Concurrency & Polish**

Leverage existing concurrency.ts for parallel read-only tool execution. Result overflow to disk. Tool prompt fragments injected into system prompt.

Files: 2-3 modified | Tests: concurrency, overflow

---

## 8. File Impact Summary

| File | Phase | Action |
|------|-------|--------|
| src/tools/tool-definition-adapter.ts | 0 | Create |
| src/tools/state/config-tool.ts | 0 | Create |
| src/tools/state/plugin-state-tool.ts | 0 | Create |
| src/tools/state/architecture-tool.ts | 0 | Create |
| src/tools/state/set-goal-tool.ts | 0 | Create |
| src/tools/state/update-goal-tool.ts | 0 | Create |
| src/tools/state/archive-goal-tool.ts | 0 | Create |
| src/tools/state/delete-goal-tool.ts | 0 | Create |
| src/tools/state/toggle-plugin-tool.ts | 0 | Create |
| src/tools/state/update-config-tool.ts | 0 | Create |
| src/tools/state/reset-trust-tool.ts | 0 | Create |
| src/tools/index.ts | 0 | Modify (export toToolDefinition) |
| src/interface/chat/chat-runner.ts | 0 | Modify (use registry) |
| src/interface/chat/self-knowledge-tools.ts | 0 | Shim (re-export) |
| src/interface/chat/mutation-tool-defs.ts | 0 | Shim (re-export) |
| src/interface/chat/self-knowledge-mutation-tools.ts | 0 | Shim (re-export) |
| src/tools/execution/run-adapter.ts | A | Create |
| src/tools/execution/spawn-session.ts | A | Create |
| src/tools/knowledge/query-data-source.ts | A | Create |
| src/tools/interaction/ask-human.ts | A | Create |
| src/tools/interaction/create-plan.ts | A | Create |
| src/tools/interaction/read-plan.ts | A | Create |
| src/orchestrator/loop/core-loop.ts | B | Modify |
| src/platform/observation/observation-engine.ts | B | Modify |

---

## 9. Test Strategy

- **Unit**: each new tool tested independently with mock dependencies (same pattern as existing state/ tests)
- **Migration**: all existing `self-knowledge-tools.test.ts` and `self-knowledge-mutation-tools.test.ts` pass unchanged
- **Integration (ChatRunner)**: LLM tool calls routed through registry produce same results as before
- **Integration (CoreLoop)**: CoreLoop with tool layer, full round-trip (Phase B)
- **Concurrency**: parallel read-only tools execute simultaneously via existing concurrency.ts (Phase C)
