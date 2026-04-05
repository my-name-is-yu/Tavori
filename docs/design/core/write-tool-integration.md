# Tool Integration Design

## 1. Overview

PulSeed's tool system unifies interactive (AgentLoop) and autonomous (CoreLoop) execution through shared tool primitives, inspired by Claude Code's architecture.

Two loops, one tool layer:

```
┌─────────────────────────────────┐
│       Shared Tool Layer         │
│  ReadState, WriteState, ...     │
└──────────┬──────────┬───────────┘
           │          │
    ┌──────▼─────┐  ┌▼────────────┐
    │  AgentLoop  │  │  CoreLoop   │
    │  LLM-driven │  │  Goal-driven│
    │  free pick  │  │  fixed seq  │
    └─────────────┘  └─────────────┘
```

**AgentLoop** (interactive): LLM freely picks tools, stops at end_turn. Used for single-task, conversational sessions.

**CoreLoop** (autonomous): fixed sequence — ReadState → QueryDataSource → (gap calc in code) → RunAdapter → QueryDataSource (verify). Stops when satisficing judge clears the gap.

**Handoff**: Future `track` command transfers context from AgentLoop to CoreLoop.

---

## 2. Tool Definition Type

Follows Claude Code's `buildTool()` pattern — each tool owns its prompt, UI rendering, and execution:

```typescript
// src/tools/tool-types.ts
import { z } from 'zod';

interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: z.ZodSchema<TInput>;
  isReadOnly?: boolean;          // default: false (safe side)
  isConcurrencySafe?: boolean;   // default: false (exclusive execution)
  isDestructive?: boolean;       // default: false
  statusVerb: string;            // e.g., "Reading state", "Running adapter"
  statusArgKey?: string;         // param key for status display
  maxResultSizeChars?: number;   // overflow → disk + preview
  prompt: () => string;          // system prompt fragment injected per-tool
  call: (input: TInput, ctx: ToolContext) => Promise<ToolResult<TOutput>>;
  renderToolUse?: (input: TInput) => string;    // TUI display
  renderToolResult?: (result: ToolResult<TOutput>) => string;
}

interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;               // errors as data, not exceptions
}

interface ToolContext {
  stateManager: StateManager;
  llmClient: LLMClient;
  approvalFn?: (desc: string) => Promise<boolean>;
  onStatus?: (text: string) => void;
}

function buildTool<TInput, TOutput>(def: ToolDef<TInput, TOutput>): Tool<TInput, TOutput> {
  return {
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    maxResultSizeChars: 50_000,
    ...def,
  };
}
```

---

## 3. Tool Directory Structure

Following Claude Code's pattern, each tool is a directory with 3 files:

```
src/tools/
├── ReadState/
│   ├── read-state.ts     # ToolDef + call()
│   ├── prompt.ts         # System prompt fragment for LLM
│   └── ui.tsx            # renderToolUse + renderToolResult
├── WriteState/
│   ├── write-state.ts
│   ├── prompt.ts
│   └── ui.tsx
├── RunAdapter/
│   ├── run-adapter.ts
│   ├── prompt.ts
│   └── ui.tsx
└── index.ts              # getAllTools() — flat array, no registry class
```

**Three files per tool:**

| File | Responsibility | Example (ReadState) |
|------|---------------|---------------------|
| `<name>.ts` | ToolDef + `call()` implementation | Parse target/id, read from StateManager, return ToolResult |
| `prompt.ts` | LLM system prompt fragment (`prompt()`) | "Read PulSeed state. target: goal|session|trust|config|plugin..." |
| `ui.tsx` | `renderToolUse()` + `renderToolResult()` | Use: `goal:improve-coverage` / Result: `Read 1 goal (3 dimensions)` |

**Render functions:**

- `renderToolUse(input)` — one-line summary shown when tool is called (e.g., `⚡ Reading goal:improve-coverage`)
- `renderToolResult(result)` — summarized result (e.g., `Read 1 goal (3 dimensions)`, NOT the full state dump)
- Both accept `{ verbose: boolean }` for detail level control

Tool addition = new directory + one line in `index.ts`. No registry class changes needed.

---

## 4. Tool Inventory

13 tools across 8 categories. Granularity is CC-level: primitive operations, not domain-composite.

| Tool | Category | readOnly | concurrent | statusVerb |
|------|----------|----------|-----------|------------|
| ReadState | State (read) | true | true | Reading |
| ListStates | State (read) | true | true | Listing |
| WriteState | State (write) | false | false | Updating |
| RunAdapter | Execution | false | false | Running |
| SpawnSession | Execution | false | false | Spawning |
| QueryDataSource | Data | true | true | Querying |
| SearchKnowledge | Knowledge | true | true | Searching |
| WriteKnowledge | Knowledge | false | false | Storing |
| ReadPulseedFile | File | true | true | Reading |
| WritePulseedFile | File | false | false | Writing |
| AskHuman | Interaction | true | false | Asking |
| CreatePlan | Planning | false | false | Planning |
| ReadPlan | Planning | true | true | Reading plan |

Note: only irreversible/damaging operations (delete, reset_trust) get rich LLM descriptions with risk warnings.

---

## 5. Tool Registration

No registry class — CC pattern uses a plain function returning an array:

```typescript
// src/tools/index.ts
export function getAllTools(): Tool[] {
  return [readStateTool, listStatesTool, writeStateTool, runAdapterTool,
          spawnSessionTool, queryDataSourceTool, searchKnowledgeTool,
          writeKnowledgeTool, readPulseedFileTool, writePulseedFileTool,
          askHumanTool, createPlanTool, readPlanTool];
}
```

---

## 6. Real-Time Status Display

Each tool's `statusVerb` + `statusArgKey` generates a one-line status emitted via `ToolContext.onStatus`:

```
⚡ Reading goal:improve-test-coverage
⚡ Running adapter:claude-code-cli
⚡ Searching knowledge:test patterns
```

Separate from spinner verbs (shown during LLM thinking). New TUI component:

```typescript
// src/interface/tui/tool-status.tsx
const ToolStatusLine: FC<{ status: string | null }> = ({ status }) => {
  if (!status) return null;
  return <Text dimColor>  ⚡ {status}</Text>;
};
```

---

## 7. Implementation Phases

**Phase 0: Existing Tool Migration**
Migrate current self-knowledge tools and mutation tools to the new directory structure before adding new tools.

- Create `src/tools/` directory structure
- Create `src/tools/tool-types.ts` — ToolDef, ToolResult, ToolContext, buildTool (from Phase A, moved here)
- Migrate `self-knowledge-tools.ts` (5 read tools) → individual tool directories (ReadState, ListStates)
- Migrate `mutation-tool-defs.ts` + `self-knowledge-mutation-tools.ts` (7 mutation tools) → WriteState directory
- Migrate `tool-metadata.ts` → per-tool `prompt.ts` files
- Old files become re-export shims for backward compatibility
- Wire `getAllTools()` into ChatRunner
- Files: 8-10 new (tool dirs + types), 3 modified (chat-runner, old shims)
- Tests: Verify existing tool behavior unchanged after migration

**Phase A: New Tools + Status Display** (builds on Phase 0's foundation)
Phase 0 already provides tool types and directory structure. Phase A adds new tools.

- Implement: RunAdapter, SpawnSession, QueryDataSource
- Implement: SearchKnowledge, WriteKnowledge, ReadPulseedFile, WritePulseedFile
- Implement: AskHuman, CreatePlan, ReadPlan
- Create `src/interface/tui/tool-status.tsx`
- Files: 10 new, 1 modified | Tests: per-tool unit tests + AgentLoop integration test

**Phase B: CoreLoop Migration**
Refactor CoreLoop to call tool primitives instead of modules directly.

- CoreLoop calls ReadState instead of `stateManager.getGoal()` directly
- CoreLoop calls QueryDataSource instead of `observationEngine.observe()` directly
- Both loops verified sharing tools correctly
- Files: 3-5 modified (core-loop.ts, observation-engine.ts, etc.)
- Tests: CoreLoop integration tests with tool layer

**Phase C: Concurrency & Polish**
Performance optimizations, no API changes.

- Concurrent execution for isConcurrencySafe tools (parallel reads)
- Result overflow to disk (maxResultSizeChars exceeded → disk + preview)
- Tool-owned `prompt()` fragments injected into system prompt
- Deferred tool loading for scale
- Files: 2-3 modified | Tests: concurrency tests, overflow tests

---

## 8. File Impact Summary

| File | Phase | Action |
|------|-------|--------|
| src/tools/tool-types.ts | 0 | Create |
| src/tools/index.ts | 0 | Create |
| src/tools/ReadState/ | 0 | Create (3 files) |
| src/tools/ListStates/ | 0 | Create (3 files) |
| src/tools/WriteState/ | 0 | Create (3 files) |
| src/interface/chat/chat-runner.ts | 0 | Modify (wire tools) |
| src/tools/RunAdapter/ | A | Create (3 files) |
| src/tools/SpawnSession/ | A | Create (3 files) |
| src/tools/QueryDataSource/ | A | Create (3 files) |
| src/tools/SearchKnowledge/ | A | Create (3 files) |
| src/tools/WriteKnowledge/ | A | Create (3 files) |
| src/tools/ReadPulseedFile/ | A | Create (3 files) |
| src/tools/WritePulseedFile/ | A | Create (3 files) |
| src/tools/AskHuman/ | A | Create (3 files) |
| src/tools/CreatePlan/ | A | Create (3 files) |
| src/tools/ReadPlan/ | A | Create (3 files) |
| src/interface/tui/tool-status.tsx | A | Create |
| src/orchestrator/loop/core-loop.ts | B | Modify |
| src/platform/observation/observation-engine.ts | B | Modify |

---

## 9. Test Strategy

- **Unit**: each tool tested independently with mock ToolContext
- **Integration (AgentLoop)**: user input → tool calls → result, end-to-end
- **Integration (CoreLoop)**: CoreLoop with tool layer, full round-trip
- **Concurrency**: parallel read-only tools execute simultaneously; write tools are exclusive
- **Overflow**: results exceeding maxResultSizeChars persisted to disk, preview returned
