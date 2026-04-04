# PulSeed Tool System Design --- Tools as the Universal Capability Layer

> Date: 2026-04-04
> Status: Draft
> Related: `execution-boundary.md`, `mechanism.md`, `observation.md`, `task-lifecycle.md`, `knowledge-acquisition.md`, `cc-inspired-improvements.md`

---

## 1. Design Philosophy

### 1.1 The Key Insight

PulSeed's core loop has always had a structural bottleneck: every interaction with the real world requires spawning an agent session. Observation? Delegate to an agent. Verification? Delegate to an agent. Knowledge acquisition? Delegate to an agent. Even reading a file to check if it exists requires a full agent round-trip.

This design proposes a fundamental shift: **tools are the universal capability layer that sits beneath every operation in the core loop.** Not "execution capability bolted onto Phase C," but tools as infrastructure that makes observation faster, gap calculation more accurate, knowledge acquisition cheaper, and verification more reliable.

The insight comes from Claude Code's architecture, where tools are not a feature of the agent --- they are the substrate on which everything runs. Glob, Grep, Read, Shell --- these are not "execution tools." They are perception tools, verification tools, knowledge tools. The distinction between "observation" and "execution" dissolves when you realize that running `npm test` is simultaneously an observation (what is the current test state?) and a verification (did the task succeed?).

### 1.2 Why This Is Different from "Add Execution Later"

The previous framing (execution-boundary.md) drew a hard line: "PulSeed thinks. Agents act." This framing was useful for the initial architecture --- it kept PulSeed focused on orchestration. But it created an artificial constraint: PulSeed cannot even *look* at the world directly. It must always ask an agent to look for it.

The new framing: **PulSeed perceives the world directly through tools. Complex reasoning and multi-step work is delegated to agents.**

This is not a relaxation of the execution boundary. It is a *refinement*. The boundary moves from "PulSeed never touches the world" to "PulSeed uses read-only tools for perception; agents handle creative, multi-step work and all mutations."

The difference matters because:

1. **Observation becomes 10-100x cheaper.** Checking if a file exists: tool call (1ms, 0 tokens) vs. agent session (30s, 5000 tokens).
2. **Verification becomes structural.** Running `npm test` directly gives PulSeed mechanical verification without trusting an agent's self-report.
3. **Knowledge acquisition becomes incremental.** Grep the codebase, read a design doc, fetch an API spec --- all without spawning a research agent.
4. **The core loop tightens.** Each iteration can complete faster because perception and verification are direct.

### 1.3 What Stays the Same

The following design principles are unchanged:

- **Satisficing**: Stop when "good enough." Tools make measurement more precise, but the philosophy of not pursuing perfection remains.
- **Trust asymmetry**: Trust balance [-100, +100], Ds=+3, Df=-10. Tools have their own trust tracking.
- **EthicsGate**: All tool invocations pass through the ethics gate. Any tool with side effects follows the same approval flow as agent delegations.
- **Orchestration primacy**: PulSeed's value is in the observe-gap-score-task-execute-verify loop. Tools make the loop faster and more accurate, but they do not replace the loop.
- **Agent delegation for task execution**: Writing features, refactoring modules, creative problem-solving --- these still go to agents. Tools handle perception; agents handle action.

### 1.4 The Execution Boundary, Revised

Old boundary: "PulSeed does LLM calls and state I/O. Everything else is delegated."

New boundary: "PulSeed does LLM calls, state I/O, and read-only tool invocations for perception. All mutations and multi-step work are delegated to agents."

| Category | Old Model | New Model |
|----------|-----------|-----------|
| Read a file | Delegate to agent | `Read` tool |
| Check file existence | Delegate to agent | `Glob` tool |
| Run test suite (read result) | Delegate to agent | `Shell` tool (read-only command) |
| Search codebase | Delegate to agent | `Grep` tool |
| Check API health | Delegate to agent | `HttpFetch` tool (GET only) |
| Fetch metrics | Delegate to agent | `Shell` tool + `JsonQuery` tool |
| Implement a feature | Delegate to agent | **Still delegate to agent** |
| Refactor a module | Delegate to agent | **Still delegate to agent** |
| Write/edit files | Delegate to agent | **Still delegate to agent** |
| Multi-file code change | Delegate to agent | **Still delegate to agent** |
| Creative problem-solving | Delegate to agent | **Still delegate to agent** |

### 1.5 Scope of This Design

**In scope (this document)**:
- Tool system core (registry, executor, permission, concurrency)
- Read-only built-in tools (Glob, Grep, Read, Shell for metrics, HttpFetch GET, JsonQuery)
- Integration with ObservationEngine, GapCalculator, KnowledgeManager, StrategyManager, CoreLoop verification
- Permission model for read-only and read-with-side-effects (Shell) tools

**Future work (not this document)**:
- Mutation tools (Write, Edit, Shell with side effects)
- Direct task execution routing (when PulSeed executes tasks itself)
- Hybrid execution (tools for prep, agent for core work)
- MCP server integration

---

## 2. Architecture Overview

### 2.1 System Diagram

```
                              +----------------------------------------------+
                              |              CoreLoop                         |
                              |  observe -> gap -> score -> task -> verify    |
                              +-------+------+------+------+------+----------+
                                      |      |      |      |      |
                   +------------------+------+------+------+------+----------+
                   |                  |      |      |      |      |          |
             +-----v------+   +------v---+  |  +---v----+ |  +---v-----+   |
             |Observation  |   |   Gap    |  |  |Strategy| |  |Verifi-  |   |
             |  Engine     |   |Calculator|  |  |Manager | |  |cation   |   |
             +-----+-------+   +----+-----+  |  +---+----+ |  +----+----+   |
                   |               |         |      |      |       |         |
                   |               |         |      |      |       |         |
             +-----v---------------v---------v------v------v-------v----+    |
             |                                                          |    |
             |                    ToolSystem                            |    |
             |  +--------------+ +--------------+ +------------------+  |    |
             |  | ToolRegistry | | ToolExecutor | | PermissionMgr    |  |    |
             |  | (3-tier)     | | (5-gate)     | | (3-layer)        |  |    |
             |  +--------------+ +--------------+ +------------------+  |    |
             |                                                          |    |
             |  Read-Only Built-in Tools:                               |    |
             |  +------+ +------+ +------+ +-------+ +-----------+     |    |
             |  | Glob | | Grep | | Read | | Shell | | HttpFetch |     |    |
             |  +------+ +------+ +------+ +-------+ +-----------+     |    |
             |  +-----------+                                           |    |
             |  | JsonQuery |  + MCP tools (future)                     |    |
             |  +-----------+                                           |    |
             +----------------------------------------------------------+    |
                                                                             |
             +---------------------------------------------------------------+
             |                  TaskLifecycle (unchanged)                |
             |  +---------------------------------------------------+   |
             |  | Agent-based execution (existing, all mutations)    |   |
             |  +---------------------------------------------------+   |
             +----------------------------------------------------------+
```

### 2.2 Before/After Comparison

**Before: Observation cycle**
```
CoreLoop -> ObservationEngine -> LLM call (interpret what to observe)
         -> SessionManager -> AdapterLayer -> Agent session (do the observation)
         -> Agent runs commands, reads files, calls APIs
         -> Agent returns results
         -> ObservationEngine -> LLM call (interpret results)
         -> State update

Cost: ~30s, ~10,000 tokens, agent session overhead
```

**After: Observation cycle (tool-enhanced)**
```
CoreLoop -> ObservationEngine -> Tool calls (Glob, Read, Shell, HttpFetch)
         -> Direct results (file contents, command output, API responses)
         -> LLM call (interpret results)
         -> State update
         -> If insufficient -> fallback to agent session (existing path)

Cost: ~2s, ~2,000 tokens, no agent session for common cases
```

**Before: Verification cycle**
```
CoreLoop -> Spawn verification agent session
         -> Agent runs tests, checks files
         -> Agent reports results
         -> CoreLoop interprets

Cost: ~30s, ~8,000 tokens
```

**After: Verification cycle (tool-enhanced)**
```
CoreLoop -> Shell tool (run tests) + Glob tool (check outputs) + Read tool (check content)
         -> Direct results
         -> LLM call (interpret if needed, or pure mechanical check)

Cost: ~5s, ~500 tokens (mechanical checks need no LLM)
```

### 2.3 New File Layout

```
src/
  tools/
    types.ts                    # ITool, ToolResult, ToolPermission interfaces
    registry.ts                 # ToolRegistry (3-tier registration)
    executor.ts                 # ToolExecutor (5-gate pipeline)
    permission.ts               # ToolPermissionManager (3-layer)
    concurrency.ts              # ConcurrencyController
    context-modifier.ts         # ContextModifier handling
    builtin/
      glob.ts                   # GlobTool
      grep.ts                   # GrepTool
      read.ts                   # ReadTool
      shell.ts                  # ShellTool (read-only commands only)
      http-fetch.ts             # HttpFetchTool (GET/HEAD only)
      json-query.ts             # JsonQueryTool
      index.ts                  # Built-in tool catalog
    __tests__/
      registry.test.ts
      executor.test.ts
      permission.test.ts
      concurrency.test.ts
      builtin/
        glob.test.ts
        grep.test.ts
        read.test.ts
        shell.test.ts
        http-fetch.test.ts
        json-query.test.ts
    index.ts                    # Public exports
```

---

## 3. Tool System Core

### 3.1 Tool Interface

The tool interface is adapted from Claude Code's architecture, using Zod for schema validation throughout.

```typescript
// src/tools/types.ts

import { z } from "zod";

// --- Tool Result ---

export const ToolResultSchema = z.object({
  /** Whether the tool invocation succeeded */
  success: z.boolean(),
  /** The output data (type depends on tool) */
  data: z.unknown(),
  /** Human-readable summary of the result */
  summary: z.string(),
  /** Optional error message on failure */
  error: z.string().optional(),
  /** Duration of the tool call in milliseconds */
  durationMs: z.number(),
  /** Optional context modifier: instructions to append to subsequent LLM context */
  contextModifier: z.string().optional(),
  /**
   * Optional output artifacts (file paths read, URLs fetched, etc.)
   * Used by verification to trace what the tool accessed.
   */
  artifacts: z.array(z.string()).optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

// --- Permission Level ---

export const ToolPermissionLevelSchema = z.enum([
  "read_only",      // No side effects: Glob, Grep, Read, HttpFetch(GET), JsonQuery
  "read_metrics",   // Reads with potential side effects (Shell for metrics: spawns processes)
  "write_local",    // Local filesystem writes (future: Write, Edit)
  "execute",        // Arbitrary execution (future: Shell with side effects)
  "write_remote",   // Remote side effects (future: HttpFetch POST/PUT/DELETE)
]);

export type ToolPermissionLevel = z.infer<typeof ToolPermissionLevelSchema>;

// --- Tool Metadata ---

export const ToolMetadataSchema = z.object({
  /** Unique tool name (e.g., "glob", "shell") */
  name: z.string(),
  /** Alternative names for discovery */
  aliases: z.array(z.string()).default([]),
  /** Permission level */
  permissionLevel: ToolPermissionLevelSchema,
  /** Whether this tool is read-only (no side effects) */
  isReadOnly: z.boolean(),
  /** Whether this tool can cause irreversible changes */
  isDestructive: z.boolean(),
  /**
   * Whether to defer loading this tool from the LLM context.
   * Deferred tools are hidden from the LLM tool list until explicitly
   * searched for via a ToolSearch mechanism. This saves context budget
   * for rarely-used tools.
   */
  shouldDefer: z.boolean().default(false),
  /** Whether this tool should always be loaded into context */
  alwaysLoad: z.boolean().default(false),
  /** Maximum concurrent invocations (0 = unlimited) */
  maxConcurrency: z.number().default(0),
  /** Maximum characters of tool output to pass to LLM (excess persisted to disk) */
  maxOutputChars: z.number().default(8000),
  /**
   * Tags for categorization and filtering.
   * Used by the context-filtered tier of the registry.
   */
  tags: z.array(z.string()).default([]),
});

export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;

// --- Tool Interface ---

/**
 * Core tool interface. Every tool (built-in or plugin-provided) implements this.
 *
 * Generic parameters:
 *   TInput  - Zod-validated input type
 *   TOutput - Structured output type (wrapped in ToolResult)
 */
export interface ITool<TInput = unknown, TOutput = unknown> {
  /** Tool metadata (name, permissions, etc.) */
  readonly metadata: ToolMetadata;

  /** Zod schema for input validation (gate 1 of the executor pipeline) */
  readonly inputSchema: z.ZodType<TInput>;

  /**
   * Dynamic description that may change per invocation context.
   * The LLM sees this description when deciding whether to use the tool.
   * Context parameters allow the description to adapt (e.g., showing
   * current working directory for file tools).
   */
  description(context?: ToolDescriptionContext): string;

  /**
   * Execute the tool. Input has already been validated by inputSchema.
   * Returns a ToolResult containing the output and metadata.
   */
  call(input: TInput, context: ToolCallContext): Promise<ToolResult>;

  /**
   * Check whether the tool can be invoked with the given input.
   * This is gate 2 of the executor pipeline (semantic validation).
   * Returns null if OK, or a rejection reason string.
   */
  checkPermissions(
    input: TInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult>;

  /**
   * Whether this tool can be safely invoked concurrently with the given input.
   * This is INPUT-DEPENDENT: e.g., two Read calls to different files = safe;
   * two Shell calls to the same cwd = unsafe (potential interference).
   */
  isConcurrencySafe(input: TInput): boolean;
}

// --- Supporting Types ---

export interface ToolDescriptionContext {
  /** Current working directory (for file-related tools) */
  cwd?: string;
  /** Goal context (so tools can tailor their description) */
  goalId?: string;
  /** Available data sources */
  dataSources?: string[];
}

export interface ToolCallContext {
  /** Current working directory */
  cwd: string;
  /** Goal ID for trust/permission lookups */
  goalId: string;
  /** Trust balance for the current context */
  trustBalance: number;
  /** Whether the user has pre-approved certain operations */
  preApproved: boolean;
  /** Approval callback for interactive permission requests */
  approvalFn: (request: ApprovalRequest) => Promise<boolean>;
  /** Logger instance */
  logger?: import("../runtime/logger.js").Logger;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Timeout in milliseconds (per-tool-call) */
  timeoutMs?: number;
}

export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  reason: string;
  permissionLevel: ToolPermissionLevel;
  isDestructive: boolean;
  reversibility: "reversible" | "irreversible" | "unknown";
}

export const PermissionCheckResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("allowed") }),
  z.object({ status: z.literal("denied"), reason: z.string() }),
  z.object({ status: z.literal("needs_approval"), reason: z.string() }),
]);

export type PermissionCheckResult = z.infer<typeof PermissionCheckResultSchema>;
```

### 3.2 ToolRegistry (3-Tier Registration)

The registry mirrors Claude Code's 3-tier approach: base catalog, context-filtered pool, assembled pool.

```typescript
// src/tools/registry.ts

import { z } from "zod";
import type { ITool, ToolMetadata } from "./types.js";

/**
 * 3-tier tool registry.
 *
 * Tier 1 (Base Catalog): All registered tools. Static after initialization.
 * Tier 2 (Context-Filtered): Subset filtered by current goal context, trust level,
 *         and available capabilities. Recomputed when context changes.
 * Tier 3 (Assembled Pool): Final set of tools presented to the LLM, respecting
 *         context budget (token limit) and deferral rules.
 */
export class ToolRegistry {
  /** Tier 1: All registered tools */
  private baseCatalog: Map<string, ITool> = new Map();

  /** Alias -> canonical name mapping */
  private aliasMap: Map<string, string> = new Map();

  // --- Registration ---

  /**
   * Register a tool in the base catalog (Tier 1).
   * Throws if a tool with the same name or alias already exists.
   */
  register(tool: ITool): void {
    const name = tool.metadata.name;
    if (this.baseCatalog.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.baseCatalog.set(name, tool);

    for (const alias of tool.metadata.aliases) {
      if (this.aliasMap.has(alias) || this.baseCatalog.has(alias)) {
        throw new Error(
          `Alias "${alias}" conflicts with existing tool or alias`,
        );
      }
      this.aliasMap.set(alias, name);
    }
  }

  /**
   * Unregister a tool by name. Used for plugin unloading.
   */
  unregister(name: string): boolean {
    const tool = this.baseCatalog.get(name);
    if (!tool) return false;
    this.baseCatalog.delete(name);
    for (const alias of tool.metadata.aliases) {
      this.aliasMap.delete(alias);
    }
    return true;
  }

  // --- Lookup ---

  /**
   * Get a tool by name or alias from the base catalog.
   */
  get(nameOrAlias: string): ITool | undefined {
    const canonical = this.aliasMap.get(nameOrAlias) ?? nameOrAlias;
    return this.baseCatalog.get(canonical);
  }

  /**
   * List all tools in the base catalog.
   */
  listAll(): ITool[] {
    return [...this.baseCatalog.values()];
  }

  // --- Tier 2: Context Filtering ---

  /**
   * Filter the base catalog by context (goal, trust level, tags).
   * Returns tools available in the current operational context.
   */
  filterByContext(filter: ContextFilter): ITool[] {
    return this.listAll().filter((tool) => {
      // Filter by permission level based on trust
      if (!this.isPermissionAllowed(tool.metadata, filter.trustBalance)) {
        return false;
      }

      // Filter by tags if specified
      if (
        filter.requiredTags &&
        filter.requiredTags.length > 0 &&
        !filter.requiredTags.some((tag) => tool.metadata.tags.includes(tag))
      ) {
        return false;
      }

      // Filter out deferred tools unless explicitly requested
      if (tool.metadata.shouldDefer && !filter.includeDeferred) {
        return false;
      }

      return true;
    });
  }

  // --- Tier 3: Assembly ---

  /**
   * Assemble the final tool pool for LLM presentation.
   * Respects context budget (estimated tokens per tool description).
   */
  assemble(filter: ContextFilter, tokenBudget: number): AssembledPool {
    const filtered = this.filterByContext(filter);

    // Always-load tools first
    const alwaysLoad = filtered.filter((t) => t.metadata.alwaysLoad);
    const optional = filtered.filter((t) => !t.metadata.alwaysLoad);

    let usedTokens = 0;
    const included: ITool[] = [];
    const deferred: ITool[] = [];

    // Always-load tools are included regardless of budget
    for (const tool of alwaysLoad) {
      const est = this.estimateTokens(tool, filter);
      included.push(tool);
      usedTokens += est;
    }

    // Fill remaining budget with optional tools, sorted by relevance
    const sorted = this.sortByRelevance(optional, filter);
    for (const tool of sorted) {
      const est = this.estimateTokens(tool, filter);
      if (usedTokens + est <= tokenBudget) {
        included.push(tool);
        usedTokens += est;
      } else {
        deferred.push(tool);
      }
    }

    return { included, deferred, usedTokens };
  }

  // --- Private Helpers ---

  private isPermissionAllowed(
    metadata: ToolMetadata,
    trustBalance: number,
  ): boolean {
    // Read-only tools are always available
    if (metadata.isReadOnly) return true;
    // Read-metrics tools (Shell for metrics) require moderate trust
    if (metadata.permissionLevel === "read_metrics") return trustBalance >= -50;
    // Future: write/execute tools would have stricter thresholds
    return true;
  }

  private estimateTokens(tool: ITool, filter: ContextFilter): number {
    const desc = tool.description({ cwd: filter.cwd, goalId: filter.goalId });
    return Math.ceil((tool.metadata.name.length + desc.length) / 4) + 50;
  }

  private sortByRelevance(tools: ITool[], filter: ContextFilter): ITool[] {
    return [...tools].sort((a, b) => {
      const aScore = filter.requiredTags
        ? filter.requiredTags.filter((t) => a.metadata.tags.includes(t)).length
        : 0;
      const bScore = filter.requiredTags
        ? filter.requiredTags.filter((t) => b.metadata.tags.includes(t)).length
        : 0;
      return bScore - aScore;
    });
  }
}

// --- Supporting Types ---

export interface ContextFilter {
  /** Trust balance for permission filtering */
  trustBalance: number;
  /** Required tags (at least one must match) */
  requiredTags?: string[];
  /** Whether to include deferred tools */
  includeDeferred?: boolean;
  /** Current working directory */
  cwd?: string;
  /** Current goal ID */
  goalId?: string;
}

export interface AssembledPool {
  /** Tools included in the LLM context */
  included: ITool[];
  /** Tools deferred (available via search but not in context) */
  deferred: ITool[];
  /** Estimated tokens used by included tools */
  usedTokens: number;
}
```

### 3.3 ToolExecutor (5-Gate Pipeline)

```typescript
// src/tools/executor.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
} from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolPermissionManager } from "./permission.js";
import type { ConcurrencyController } from "./concurrency.js";
import type { Logger } from "../runtime/logger.js";

/**
 * 5-gate execution pipeline for tool invocations.
 *
 * Gate 1: Input validation (Zod schema)
 * Gate 2: Semantic validation (tool-specific checkPermissions)
 * Gate 3: Permission check (3-layer permission manager)
 * Gate 4: Input sanitization (path traversal, injection prevention)
 * Gate 5: Concurrency control (input-dependent batching)
 *
 * Only after all 5 gates pass does the tool.call() execute.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly permissionManager: ToolPermissionManager;
  private readonly concurrency: ConcurrencyController;
  private readonly logger?: Logger;

  constructor(deps: ToolExecutorDeps) {
    this.registry = deps.registry;
    this.permissionManager = deps.permissionManager;
    this.concurrency = deps.concurrency;
    this.logger = deps.logger;
  }

  /**
   * Execute a tool through the 5-gate pipeline.
   */
  async execute(
    toolName: string,
    rawInput: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return this.failResult(`Tool "${toolName}" not found`, 0);
    }

    const startTime = Date.now();

    // --- Gate 1: Input Validation (Zod) ---
    const parseResult = tool.inputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      const errors = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return this.failResult(
        `Input validation failed: ${errors}`,
        Date.now() - startTime,
      );
    }
    const input = parseResult.data;

    // --- Gate 2: Semantic Validation (tool-specific) ---
    const semanticResult = await tool.checkPermissions(input, context);
    if (semanticResult.status === "denied") {
      return this.failResult(
        `Permission denied: ${semanticResult.reason}`,
        Date.now() - startTime,
      );
    }

    // --- Gate 3: Permission Manager (3-layer) ---
    const permResult = await this.permissionManager.check(
      tool,
      input,
      context,
    );
    if (permResult.status === "denied") {
      return this.failResult(
        `Permission denied by policy: ${permResult.reason}`,
        Date.now() - startTime,
      );
    }
    if (permResult.status === "needs_approval") {
      const approved = await context.approvalFn({
        toolName: tool.metadata.name,
        input,
        reason: permResult.reason,
        permissionLevel: tool.metadata.permissionLevel,
        isDestructive: tool.metadata.isDestructive,
        reversibility: "reversible", // Read-only tools are always reversible
      });
      if (!approved) {
        return this.failResult(
          `User denied approval: ${permResult.reason}`,
          Date.now() - startTime,
        );
      }
    }

    // --- Gate 4: Input Sanitization ---
    const sanitizeError = this.sanitizeInput(tool, input);
    if (sanitizeError) {
      return this.failResult(
        `Input sanitization failed: ${sanitizeError}`,
        Date.now() - startTime,
      );
    }

    // --- Gate 5: Concurrency Control ---
    const result = await this.concurrency.run(
      tool,
      input,
      async () => {
        if (context.timeoutMs) {
          return this.withTimeout(
            () => tool.call(input, context),
            context.timeoutMs,
          );
        }
        return tool.call(input, context);
      },
    );

    // --- Output Truncation: persist oversized output to disk ---
    if (result.data) {
      const serialized = JSON.stringify(result.data);
      const originalLength = serialized.length;
      if (originalLength > tool.metadata.maxOutputChars) {
        const invocationId = `${tool.metadata.name}-${Date.now()}`;
        const fullPath = `~/.pulseed/tool-output/${invocationId}.json`;
        // persist full result to disk
        await this.stateManager.writeFile(fullPath, serialized);
        result.data = truncateOutput(result.data, tool.metadata.maxOutputChars);
        result.truncated = { fullOutputPath: fullPath, originalChars: originalLength };
      }
    }

    this.logger?.debug(
      `Tool ${toolName} completed in ${result.durationMs}ms`,
    );

    return result;
  }

  /**
   * Execute multiple tool calls, respecting concurrency safety.
   * Safe calls run in parallel; unsafe calls run sequentially.
   *
   * NOTE: executeBatch does NOT preserve ordering between safe and unsafe groups.
   * Safe tools run in parallel first, then unsafe tools run sequentially.
   * If caller requires strict ordering, use sequential execute() calls instead.
   * The concurrency partitioning follows CC's StreamingToolExecutor pattern.
   */
  async executeBatch(
    calls: Array<{ toolName: string; input: unknown }>,
    context: ToolCallContext,
  ): Promise<ToolResult[]> {
    const safe: Array<{ toolName: string; input: unknown; index: number }> = [];
    const unsafe: Array<{ toolName: string; input: unknown; index: number }> = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = this.registry.get(call.toolName);
      if (tool && tool.isConcurrencySafe(call.input)) {
        safe.push({ ...call, index: i });
      } else {
        unsafe.push({ ...call, index: i });
      }
    }

    const results: ToolResult[] = new Array(calls.length);

    // Run safe calls in parallel
    const safeResults = await Promise.all(
      safe.map((c) => this.execute(c.toolName, c.input, context)),
    );
    for (let i = 0; i < safe.length; i++) {
      results[safe[i].index] = safeResults[i];
    }

    // Run unsafe calls sequentially
    for (const c of unsafe) {
      results[c.index] = await this.execute(c.toolName, c.input, context);
    }

    return results;
  }

  // --- Private Helpers ---

  private sanitizeInput(tool: ITool, input: unknown): string | null {
    // Path traversal check for file-based tools
    if (
      tool.metadata.tags.includes("filesystem") &&
      typeof input === "object" &&
      input !== null
    ) {
      const obj = input as Record<string, unknown>;
      for (const key of ["path", "file_path", "filePath", "directory"]) {
        const val = obj[key];
        if (typeof val === "string") {
          if (val.includes("..") && !this.isPathSafe(val)) {
            return `Path traversal detected in ${key}: "${val}"`;
          }
        }
      }
    }

    // Shell injection check for read-only shell commands
    if (tool.metadata.name === "shell" && typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      const cmd = obj["command"];
      if (typeof cmd === "string") {
        const dangerous = ["; rm ", "; curl ", "| bash", "eval ", "$(", "`"];
        for (const pattern of dangerous) {
          if (cmd.includes(pattern)) {
            return `Potentially dangerous shell command detected: "${pattern}"`;
          }
        }
      }
    }

    return null;
  }

  private isPathSafe(p: string): boolean {
    import * as path from "node:path";
    const resolved = path.resolve(p);
    return !resolved.startsWith("/etc") && !resolved.startsWith("/var");
  }

  private async withTimeout(
    fn: () => Promise<ToolResult>,
    timeoutMs: number,
  ): Promise<ToolResult> {
    return Promise.race([
      fn(),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  private failResult(error: string, durationMs: number): ToolResult {
    return {
      success: false,
      data: null,
      summary: error,
      error,
      durationMs,
    };
  }
}

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  permissionManager: ToolPermissionManager;
  concurrency: ConcurrencyController;
  logger?: Logger;
}
```

### 3.4 Concurrency Model

```typescript
// src/tools/concurrency.ts

import type { ITool, ToolResult } from "./types.js";

/**
 * Concurrency controller for tool execution.
 *
 * Key design decisions (adapted from Claude Code):
 * 1. Concurrency safety is INPUT-DEPENDENT, not tool-dependent.
 *    Two Read calls to different files = safe. Two Shell calls = unsafe.
 * 2. Maximum 10 concurrent tool calls (configurable).
 * 3. Sibling abort: for Shell tools, a new invocation can abort a prior one
 *    if both target the same working directory (prevents runaway processes).
 */
export class ConcurrencyController {
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<{ resolve: () => void }> = [];
  /** Active shell processes keyed by cwd, for sibling abort */
  private activeShells: Map<string, AbortController> = new Map();

  constructor(maxConcurrent: number = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Run a tool call, respecting concurrency limits.
   * Queues if the limit is reached.
   */
  async run<TInput>(
    tool: ITool<TInput>,
    input: TInput,
    fn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push({ resolve });
      });
    }

    this.activeCount++;

    // Sibling abort for shell tools
    let shellAbortController: AbortController | undefined;
    if (tool.metadata.name === "shell") {
      const cwd =
        (input as Record<string, unknown>)["cwd"] as string ?? ".";
      const existing = this.activeShells.get(cwd);
      if (existing) {
        existing.abort();
      }
      shellAbortController = new AbortController();
      this.activeShells.set(cwd, shellAbortController);
    }

    try {
      return await fn();
    } finally {
      this.activeCount--;

      if (shellAbortController) {
        const cwd =
          (input as Record<string, unknown>)["cwd"] as string ?? ".";
        if (this.activeShells.get(cwd) === shellAbortController) {
          this.activeShells.delete(cwd);
        }
      }

      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next?.resolve();
      }
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.queue.length;
  }
}
```

### 3.5 Permission Model (3-Layer)

```typescript
// src/tools/permission.ts

import type {
  ITool,
  ToolCallContext,
  PermissionCheckResult,
  ToolPermissionLevel,
} from "./types.js";
import type { EthicsGate } from "../platform/traits/ethics-gate.js";
import type { TrustManager } from "../platform/traits/trust-manager.js";

/**
 * 3-layer permission model for tool invocations.
 *
 * Layer 1: Registry deny-list (static rules, no computation)
 *          Deny beats allow at every layer.
 * Layer 2: Per-call permission check (trust-based + EthicsGate integration)
 * Layer 3: Interactive approval prompt (for operations that need user consent)
 *
 * Integration with existing PulSeed modules:
 * - EthicsGate: Tool calls that spawn processes (Shell) pass through EthicsGate L1.
 * - TrustManager: Tool permission thresholds scale with trust balance.
 */
export class ToolPermissionManager {
  private readonly denyList: PermissionRule[] = [];
  private readonly allowList: PermissionRule[] = [];
  private readonly ethicsGate?: EthicsGate;
  private readonly trustManager?: TrustManager;

  constructor(deps: PermissionManagerDeps) {
    this.ethicsGate = deps.ethicsGate;
    this.trustManager = deps.trustManager;
    this.denyList = deps.denyRules ?? [];
    this.allowList = deps.allowRules ?? [];
  }

  /**
   * Check whether a tool invocation is permitted.
   *
   * Gate order: deny-list -> trust check -> ethics gate -> allow-list -> default
   */
  async check(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    // --- Layer 1: Registry Deny-List ---
    for (const rule of this.denyList) {
      if (this.ruleMatches(rule, tool, input, context)) {
        return { status: "denied", reason: rule.reason };
      }
    }

    // Read-only tools are always allowed after deny-list check
    if (tool.metadata.isReadOnly) {
      return { status: "allowed" };
    }

    // --- Layer 2: Trust-Based + EthicsGate ---

    const trustBalance = context.trustBalance;
    const requiredTrust = this.getRequiredTrust(tool.metadata.permissionLevel);
    if (trustBalance < requiredTrust) {
      return {
        status: "needs_approval",
        reason: `Trust balance (${trustBalance}) below threshold (${requiredTrust}) for ${tool.metadata.permissionLevel} operations`,
      };
    }

    // EthicsGate integration for Shell tool (spawns processes)
    if (tool.metadata.name === "shell" && this.ethicsGate) {
      const description = `Tool "${tool.metadata.name}" invocation: ${JSON.stringify(input).slice(0, 200)}`;
      try {
        const ethicsResult = await this.ethicsGate.check("task", context.goalId, description);
        if (ethicsResult.verdict === "reject") {
          return {
            status: "denied",
            reason: `EthicsGate rejected: ${ethicsResult.reason}`,
          };
        }
      } catch {
        return {
          status: "needs_approval",
          reason: "EthicsGate evaluation failed; manual approval required",
        };
      }
    }

    // --- Layer 3: Allow-List / Default ---
    for (const rule of this.allowList) {
      if (this.ruleMatches(rule, tool, input, context)) {
        return { status: "allowed" };
      }
    }

    // Default for read_metrics (Shell): needs approval unless allow-listed
    if (tool.metadata.permissionLevel === "read_metrics") {
      return {
        status: "needs_approval",
        reason: `Shell command requires approval: ${JSON.stringify(input).slice(0, 100)}`,
      };
    }

    return { status: "allowed" };
  }

  // --- Configuration ---

  addDenyRule(rule: PermissionRule): void {
    this.denyList.push(rule);
  }

  addAllowRule(rule: PermissionRule): void {
    this.allowList.push(rule);
  }

  // --- Private ---

  private getRequiredTrust(level: ToolPermissionLevel): number {
    switch (level) {
      case "read_only":
        return -100; // Always allowed
      case "read_metrics":
        return -50;  // Shell for reading metrics
      case "write_local":
        return -20;  // Future
      case "execute":
        return 0;    // Future
      case "write_remote":
        return 10;   // Future
    }
  }

  private ruleMatches(
    rule: PermissionRule,
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
  ): boolean {
    if (rule.toolName && rule.toolName !== tool.metadata.name) return false;
    if (rule.permissionLevel && rule.permissionLevel !== tool.metadata.permissionLevel)
      return false;
    if (rule.inputMatcher && !rule.inputMatcher(input)) return false;
    if (rule.goalId && rule.goalId !== context.goalId) return false;
    return true;
  }
}

// --- Supporting Types ---

export interface PermissionManagerDeps {
  ethicsGate?: EthicsGate;
  trustManager?: TrustManager;
  denyRules?: PermissionRule[];
  allowRules?: PermissionRule[];
}

export interface PermissionRule {
  /** Match specific tool by name (undefined = match all) */
  toolName?: string;
  /** Match specific permission level */
  permissionLevel?: ToolPermissionLevel;
  /** Custom input matcher function */
  inputMatcher?: (input: unknown) => boolean;
  /** Match specific goal */
  goalId?: string;
  /** Human-readable reason for this rule */
  reason: string;
}
```

### 3.6 ToolResult with contextModifier

When a tool call produces information that should influence subsequent LLM reasoning, it sets the `contextModifier` field. Examples:

- `Read` tool reads a configuration file: `contextModifier` summarizes key settings.
- `Shell` tool runs `npm test`: `contextModifier` contains the pass/fail summary.
- `Grep` tool finds matches: `contextModifier` notes how many files matched.

Context modifiers are appended to the LLM's system prompt for the current iteration, providing grounding data without requiring the full tool output to be in context.

### 3.7 Tool Deferral and Context Budget

Not all tools need to be in the LLM's tool list at all times. The `shouldDefer` flag on tool metadata marks tools that are hidden from the LLM until:

1. The LLM explicitly asks for a tool by name (via a search mechanism).
2. A core loop phase tags the tool as relevant (e.g., verification phase loads `Shell`).

Context budget management:
- Default budget: 2000 tokens for tool descriptions.
- `alwaysLoad` tools are included regardless of budget.
- Remaining budget is filled by relevance-sorted tools.
- Deferred tools are announced as a summary: "Additional tools available: [list of names]. Use ToolSearch to access."

---

## 4. Tool Integration: Observation

### 4.1 How ObservationEngine Uses Tools

Currently, ObservationEngine delegates observation to agents or relies on DataSourceAdapters. With the tool system, ObservationEngine gains a new "direct observation" path that runs before agent delegation.

```
ObservationEngine.observe(dimension)
  |
  +-- Step 1: Check observation_method configuration
  |   Is this dimension configured for mechanical observation?
  |
  +-- Step 2: Direct tool observation (NEW)
  |   Based on observation_method.type:
  |   +-- "file_check" -> Glob tool (existence) + Read tool (content)
  |   +-- "mechanical" -> Shell tool (run command, parse output)
  |   +-- "api_query"  -> HttpFetch tool (GET endpoint, parse response)
  |   +-- other types  -> skip direct observation
  |
  +-- Step 3: DataSourceAdapter observation (existing)
  |   If direct tools insufficient, use registered DataSourceAdapters
  |
  +-- Step 4: Agent delegation (existing, fallback)
  |   If neither tools nor datasources can observe, delegate to agent
  |
  +-- Step 5: LLM interpretation (existing)
      Interpret raw observation data into current_value + confidence
```

### 4.2 Relevant Tools for Observation

| Tool | Observation Use Case | Confidence Tier |
|------|---------------------|-----------------|
| `Glob` | Check if files/directories exist matching a pattern | mechanical (0.95) |
| `Read` | Read file contents to extract current values | mechanical (0.95) |
| `ShellTool` (`shell`) | Run `npm test`, `wc -l`, `git status`, `git log --oneline` | mechanical (0.95) |
| `HttpFetchTool` (`http_fetch`) | Check API health endpoints, fetch metric values | mechanical (0.90) |
| `GrepTool` (`grep`) | Count occurrences, find patterns in codebase | mechanical (0.98) |
| `JsonQueryTool` (`json_query`) | Extract values from JSON config/state files | mechanical (0.98) |

All tool-based observations produce **mechanical-tier confidence** because they are deterministic, repeatable, and leave no room for interpretation of the raw data.

### 4.3 Fallback: Tool-Insufficient Cases

Direct tool observation is insufficient when:

1. **The observation requires multi-step reasoning**: e.g., "evaluate code quality" requires reading multiple files, understanding architecture, applying judgment. This still delegates to an independent review session (Layer 2).
2. **The observation requires external credentials not available to tools**: e.g., proprietary API with OAuth flow. The agent has the credentials configured in its adapter.
3. **The observation target is qualitative**: e.g., "user satisfaction," "team morale." These require human input or specialized agent analysis.

In these cases, ObservationEngine falls back to the existing agent delegation path. The tool system does not replace agents --- it handles the common case (mechanical observation) directly.

### 4.4 Data Flow

```
+-----------------+
|  Dimension      |  observation_method: { type: "mechanical", ... }
|  Config         |
+--------+--------+
         |
         v
+---------------------------------------------------------+
|  ObservationEngine                                       |
|                                                          |
|  1. Map observation_method.type -> tool name             |
|     "file_check" -> ["glob", "read"]                     |
|     "mechanical" -> ["shell"]                            |
|     "api_query"  -> ["http_fetch"]                       |
|                                                          |
|  2. Build tool input from observation_method             |
|     endpoint -> file path or URL                         |
|     source   -> command to run                           |
|                                                          |
|  3. ToolExecutor.execute(toolName, input, ctx)           |
|                                                          |
|  4. Parse ToolResult.data into observation value         |
|     (deterministic parsing, no LLM needed)               |
|                                                          |
|  5. If parsing ambiguous -> LLM interpretation           |
|     (existing path, but now with raw data)               |
+---------+------------------------------------------------+
          |
          v
+-----------------+
|  State          |  current_value, confidence updated
|  Vector         |
+-----------------+
```

### 4.5 ObservationEngine Changes

```typescript
// Addition to ObservationEngine class

interface ToolObservationResult {
  rawData: unknown;
  parsedValue: number | string | boolean | null;
  confidence: number;
  toolName: string;
  durationMs: number;
}

/**
 * Attempt direct tool-based observation for a dimension.
 * Returns null if the dimension's observation method is not tool-compatible.
 */
async observeWithTools(
  dimension: Dimension,
  context: ToolCallContext,
): Promise<ToolObservationResult | null> {
  const method = dimension.observation_method;
  if (!method) return null;

  switch (method.type) {
    case "file_check": {
      if (!method.endpoint) return null;
      const result = await this.toolExecutor.execute(
        "glob",
        { pattern: method.endpoint },
        context,
      );
      if (!result.success) return null;
      const files = result.data as string[];
      return {
        rawData: files,
        parsedValue: files.length > 0 ? 1 : 0,
        confidence: 0.98,
        toolName: "glob",
        durationMs: result.durationMs,
      };
    }

    case "mechanical": {
      if (!method.endpoint) return null;
      const result = await this.toolExecutor.execute(
        "shell",
        { command: method.endpoint, timeoutMs: 30_000 },
        context,
      );
      if (!result.success) return null;
      return {
        rawData: result.data,
        parsedValue: null, // Requires parsing logic per dimension
        confidence: 0.95,
        toolName: "shell",
        durationMs: result.durationMs,
      };
    }

    case "api_query": {
      if (!method.endpoint) return null;
      const result = await this.toolExecutor.execute(
        "http_fetch",
        { url: method.endpoint, method: "GET" },
        context,
      );
      if (!result.success) return null;
      return {
        rawData: result.data,
        parsedValue: null, // Requires parsing logic per dimension
        confidence: 0.90,
        toolName: "http_fetch",
        durationMs: result.durationMs,
      };
    }

    default:
      return null;
  }
}
```

### 4.6 Shell Tool Allow-List for Observation

To avoid requiring interactive approval for every observation Shell call, ObservationEngine pre-registers allow-list rules for known safe commands:

```typescript
// During ToolSystem initialization for a goal
function registerObservationAllowRules(
  permissionManager: ToolPermissionManager,
  dimensions: Dimension[],
): void {
  for (const dim of dimensions) {
    const method = dim.observation_method;
    if (method?.type === "mechanical" && method.endpoint) {
      permissionManager.addAllowRule({
        toolName: "shell",
        inputMatcher: (input) => {
          const cmd = (input as { command: string }).command;
          return cmd === method.endpoint;
        },
        reason: `Observation command for dimension "${dim.name}"`,
      });
    }
  }
}
```

This means: if a Shell command was explicitly configured as an observation method for a dimension, it runs without approval. Arbitrary Shell commands still require approval.

---

## 5. Tool Integration: Gap Calculation

### 5.1 How GapCalculator Uses Tools

Currently, GapCalculator operates entirely on the state vector --- it computes gaps from stored `current_value` and `target_value`. The tool system enables GapCalculator to **directly verify values** when the stored state is stale or uncertain.

```
GapCalculator.calculate(dimension)
  |
  +-- Step 1: Compute gap from state vector (existing)
  |   gap = normalize(target - current)
  |
  +-- Step 2: Confidence check
  |   If confidence < staleness_threshold (e.g., 0.6):
  |
  +-- Step 3: Direct measurement via tools (NEW)
  |   "Is test coverage > 80%?" -> Shell `npx vitest --coverage` -> parse
  |   "Does config file exist?" -> Glob `~/.pulseed/config.json` -> boolean
  |   "Is API responding?" -> HttpFetch `GET /health` -> status code
  |
  +-- Step 4: Update state with fresh measurement
  |   Overwrite current_value with tool result
  |   Set confidence to mechanical tier
  |
  +-- Step 5: Recompute gap with updated values
```

### 5.2 Direct Measurement Examples

| Dimension | Measurement Tool | Command / Input | Parsing |
|-----------|-----------------|-----------------|---------|
| test_coverage | Shell | `npx vitest run --coverage --reporter=json` | Extract `coverageMap.total.lines.pct` |
| line_count | Shell | `wc -l src/**/*.ts` | Sum of line counts |
| file_exists | Glob | `pattern: "dist/index.js"` | `matches.length > 0` |
| api_health | HttpFetch | `GET /api/health` | `statusCode === 200` |
| dependency_count | Shell | `npm ls --depth=0 --json` | Count `dependencies` keys |
| git_behind | Shell | `git rev-list --count HEAD..origin/main` | Parse integer |
| config_value | JsonQuery | `file: "package.json", query: "version"` | Direct value |

### 5.3 Staleness Threshold

Gap calculation triggers direct measurement only when:

1. `confidence < 0.6` (observation data is uncertain)
2. `last_observed_at` is older than the dimension's observation interval
3. The dimension has a tool-compatible observation method

This avoids redundant tool calls when the state is fresh and high-confidence.

### 5.4 GapCalculator Changes

```typescript
// Addition to GapCalculator

interface DirectMeasurement {
  value: number | string | boolean;
  confidence: number;
  measuredAt: Date;
  toolUsed: string;
}

/**
 * Attempt direct measurement of a dimension's current value using tools.
 * Returns null if the dimension cannot be measured directly.
 */
async measureDirectly(
  dimension: Dimension,
  toolExecutor: ToolExecutor,
  context: ToolCallContext,
): Promise<DirectMeasurement | null> {
  const method = dimension.observation_method;
  if (!method?.endpoint) return null;

  if (!["file_check", "mechanical", "api_query"].includes(method.type)) {
    return null;
  }

  const toolName =
    method.type === "file_check" ? "glob"
    : method.type === "mechanical" ? "shell"
    : method.type === "api_query" ? "http_fetch"
    : null;

  if (!toolName) return null;

  const input = this.buildToolInput(method);
  const result = await toolExecutor.execute(toolName, input, context);

  if (!result.success) return null;

  return {
    value: this.parseToolOutput(result.data, dimension),
    confidence: toolName === "shell" ? 0.95 : toolName === "http_fetch" ? 0.90 : 0.98,
    measuredAt: new Date(),
    toolUsed: toolName,
  };
}

private buildToolInput(
  method: ObservationMethod,
): Record<string, unknown> {
  switch (method.type) {
    case "file_check":
      return { pattern: method.endpoint };
    case "mechanical":
      return { command: method.endpoint, timeoutMs: 30_000 };
    case "api_query":
      return { url: method.endpoint, method: "GET" };
    default:
      return {};
  }
}

private parseToolOutput(
  data: unknown,
  dimension: Dimension,
): number | string | boolean {
  // For file_check: array of matches -> boolean
  if (Array.isArray(data)) return data.length > 0;

  // For shell output: attempt numeric parse, fall back to string
  if (typeof data === "object" && data !== null && "stdout" in data) {
    const stdout = (data as { stdout: string }).stdout.trim();
    const num = Number(stdout);
    if (!isNaN(num)) return num;
    return stdout;
  }

  // For HTTP response: status code check
  if (typeof data === "object" && data !== null && "statusCode" in data) {
    return (data as { statusCode: number }).statusCode === 200;
  }

  return String(data);
}
```

---

## 6. Tool Integration: Knowledge Acquisition

### 6.1 How KnowledgeManager Uses Tools

Currently, all knowledge acquisition is delegated to research agents (knowledge-acquisition.md Section 4: "Execution of knowledge acquisition tasks is fully delegated to agents"). The tool system enables KnowledgeManager to perform direct research for common cases:

```
KnowledgeManager.acquireKnowledge(question)
  |
  +-- Step 1: Check if answer exists in local knowledge base
  |   (existing: search domain_knowledge.json)
  |
  +-- Step 2: Direct codebase research via tools (NEW)
  |   +-- Grep: search for patterns, function definitions, usage
  |   +-- Read: read design docs, READMEs, configuration files
  |   +-- Glob: discover file structure, find relevant files
  |   +-- JsonQuery: extract values from package.json, config files
  |
  +-- Step 3: Direct web research via tools (NEW)
  |   +-- HttpFetch: fetch documentation pages, API specs
  |   +-- Parse fetched content for relevant information
  |
  +-- Step 4: LLM synthesis
  |   Feed tool results to LLM for answer synthesis
  |   Produce KnowledgeEntry with confidence based on source quality
  |
  +-- Step 5: If insufficient -> generate investigation task (existing)
  |   Delegate to research agent for deeper investigation
  |
  +-- Step 6: Persist to domain_knowledge.json (existing)
```

### 6.2 When to Use Tools vs. Delegate

| Investigation Need | Use Tools | Delegate to Agent |
|-------------------|-----------|-------------------|
| "What is the file structure of this project?" | Glob + tree command | --- |
| "What does this function do?" | Read the source file | --- |
| "How is this pattern used across the codebase?" | Grep for the pattern | --- |
| "What does this API endpoint return?" | HttpFetch the endpoint | --- |
| "What are best practices for X?" | --- | Research agent (web search) |
| "How should we architect this system?" | --- | Research agent (analysis) |
| "What do users think about feature Y?" | --- | Research agent (surveys) |
| "What does this documentation say?" | HttpFetch + Read | If complex, delegate |

The heuristic: **if the knowledge can be obtained from local files or simple HTTP requests, use tools. If it requires multi-step reasoning, web search, or human interaction, delegate.**

### 6.3 Tool-Based Research Flow

```typescript
/**
 * Attempt to answer a knowledge question using tools before delegating.
 * Returns acquired knowledge entries, or empty array if tools insufficient.
 */
async acquireWithTools(
  question: string,
  goalId: string,
  toolExecutor: ToolExecutor,
  llmClient: ILLMClient,
  context: ToolCallContext,
): Promise<KnowledgeEntry[]> {
  // Step 1: Use LLM to plan which tools to invoke
  const planResponse = await llmClient.sendMessage([
    {
      role: "system",
      content: `You are a research planner. Given a question, plan tool calls to gather information.
Available read-only tools: glob (find files), grep (search content), read (read file), http_fetch (GET URL), json_query (query JSON file), shell (read-only commands like wc, git log, npm ls).
Return a JSON array of { toolName, input } objects. Return [] if the question cannot be answered with these tools.`,
    },
    {
      role: "user",
      content: `Question: ${question}\nWorkspace: ${context.cwd}`,
    },
  ]);

  let toolCalls: Array<{ toolName: string; input: unknown }>;
  try {
    toolCalls = JSON.parse(planResponse.content);
  } catch {
    return []; // LLM could not plan tool calls
  }

  if (toolCalls.length === 0) return [];

  // Step 2: Execute planned tool calls
  const results = await toolExecutor.executeBatch(toolCalls, context);

  // Step 3: Filter to successful results
  const successfulResults = results
    .filter((r) => r.success)
    .map((r) => r.summary + "\n" + String(r.data).slice(0, 2000));

  if (successfulResults.length === 0) return [];

  // Step 4: LLM synthesis
  const synthesisResponse = await llmClient.sendMessage([
    {
      role: "system",
      content: `Synthesize the following tool outputs to answer the question. Return a JSON object with: { answer: string, confidence: number (0-1), tags: string[] }`,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nTool outputs:\n${successfulResults.join("\n---\n")}`,
    },
  ]);

  try {
    const synthesis = JSON.parse(synthesisResponse.content);
    return [
      {
        entry_id: crypto.randomUUID(),
        question,
        answer: synthesis.answer,
        sources: toolCalls.map((tc) => ({
          type: "data_analysis" as const,
          reference: `tool:${tc.toolName}`,
          reliability: "high" as const,
        })),
        confidence: Math.min(synthesis.confidence, 0.92), // Cap: tool results are mechanical but LLM synthesis adds uncertainty
        acquired_at: new Date().toISOString(),
        acquisition_task_id: "tool_direct",
        superseded_by: null,
        tags: synthesis.tags ?? [],
      },
    ];
  } catch {
    return [];
  }
}
```

### 6.4 Integration with Knowledge Persistence

Tool-acquired knowledge follows the same persistence path as agent-acquired knowledge:

```typescript
const entry: KnowledgeEntry = {
  entry_id: generateUUID(),
  question: "What is the current test coverage?",
  answer: "87.3% line coverage across 196 test files",
  sources: [
    {
      type: "data_analysis",
      reference: "shell: npx vitest run --coverage",
      reliability: "high",
    },
  ],
  confidence: 0.92,
  acquired_at: new Date().toISOString(),
  acquisition_task_id: "tool_direct", // Special ID for tool-based acquisition
  superseded_by: null,
  tags: ["test_coverage", "quality"],
};
```

### 6.5 Cost Comparison

| Acquisition Method | Token Cost | Latency | Confidence |
|-------------------|------------|---------|------------|
| Tool: Grep codebase | ~100 tokens (LLM interpretation) | <2s | 0.90 |
| Tool: Read design doc | ~500 tokens (LLM summary) | <1s | 0.85 |
| Tool: HttpFetch API doc | ~300 tokens (LLM interpretation) | <5s | 0.80 |
| Agent: Research session | ~8,000-15,000 tokens | 30-120s | 0.60-0.80 |

Tool-based acquisition is 10-100x cheaper for simple research tasks.

---

## 7. Tool Integration: Strategy & Planning

### 7.1 Grounding Context for Strategy Selection

Strategy selection currently relies on the LLM's general knowledge about "what approaches work." With tools, StrategyManager can provide **grounded context** about the actual workspace:

```
StrategyManager.selectStrategy(gap, dimension)
  |
  +-- Step 1: Gather workspace context via tools (NEW)
  |   +-- Glob: "What files exist in this project?"
  |   +-- Read: "What does package.json say? What frameworks?"
  |   +-- Shell: "git log --oneline -10" -> recent changes
  |   +-- Grep: "How is this dimension currently implemented?"
  |   +-- Assemble workspace summary for LLM
  |
  +-- Step 2: Include workspace context in strategy prompt
  |   LLM sees actual project structure, not just abstract goal
  |
  +-- Step 3: Generate strategy hypotheses (existing, but better informed)
  |
  +-- Step 4: Evaluate strategies with grounded data
      "Strategy A: add tests" -> Shell: "npx vitest --listTests" -> know what exists
```

### 7.2 WorkspaceContext

```typescript
interface WorkspaceContext {
  /** Project root files (package.json, tsconfig.json, etc.) */
  rootFiles: string[];
  /** Source file tree (depth-limited) */
  sourceTree: string[];
  /** Recent git activity */
  recentCommits: string[];
  /** Available scripts (from package.json) */
  scripts: Record<string, string>;
  /** Dependencies */
  dependencies: string[];
  /** Test file structure */
  testFiles: string[];
}

/**
 * Build workspace context using tools.
 * This context is injected into strategy selection prompts.
 */
async function buildWorkspaceContext(
  toolExecutor: ToolExecutor,
  context: ToolCallContext,
): Promise<WorkspaceContext> {
  // Run multiple tool calls in parallel (all read-only, concurrency-safe)
  const [rootGlob, srcGlob, gitLog, pkgRead, testGlob] =
    await toolExecutor.executeBatch(
      [
        { toolName: "glob", input: { pattern: "*", path: context.cwd } },
        { toolName: "glob", input: { pattern: "src/**/*.ts", path: context.cwd } },
        { toolName: "shell", input: { command: "git log --oneline -10" } },
        { toolName: "read", input: { file_path: `${context.cwd}/package.json` } },
        { toolName: "glob", input: { pattern: "**/*.test.ts", path: context.cwd } },
      ],
      context,
    );

  const pkg = pkgRead.success ? JSON.parse(pkgRead.data as string) : {};

  return {
    rootFiles: rootGlob.success ? (rootGlob.data as string[]) : [],
    sourceTree: srcGlob.success ? (srcGlob.data as string[]) : [],
    recentCommits: gitLog.success
      ? (gitLog.data as { stdout: string }).stdout.split("\n")
      : [],
    scripts: pkg.scripts ?? {},
    dependencies: Object.keys(pkg.dependencies ?? {}),
    testFiles: testGlob.success ? (testGlob.data as string[]) : [],
  };
}
```

### 7.3 Better Strategy Generation

With workspace context, the LLM generates more specific strategies:

**Without tools:**
> Strategy: "Improve test coverage for the authentication module."

**With tools (knowing the actual codebase):**
> Strategy: "Add unit tests for `src/platform/traits/trust-manager.ts` --- the file has 120 lines of production code but no dedicated test file. Focus on `recordSuccess`, `recordFailure`, and `getBalance` methods. Use vitest with the mock patterns established in `src/platform/traits/__tests__/ethics-gate-core.test.ts`."

### 7.4 Workspace Context Caching

WorkspaceContext is relatively expensive to build (5 parallel tool calls). It should be cached per CoreLoop iteration and invalidated when:

1. A task execution completes (files may have changed)
2. An observation detects external changes
3. The iteration counter advances

```typescript
class WorkspaceContextCache {
  private cached: WorkspaceContext | null = null;
  private cachedAtIteration: number = -1;

  async get(
    iteration: number,
    toolExecutor: ToolExecutor,
    context: ToolCallContext,
  ): Promise<WorkspaceContext> {
    if (this.cached && this.cachedAtIteration === iteration) {
      return this.cached;
    }
    this.cached = await buildWorkspaceContext(toolExecutor, context);
    this.cachedAtIteration = iteration;
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedAtIteration = -1;
  }
}
```

---

## 8. Tool Integration: Verification

### 8.1 Direct Verification via Tools

The task verification flow (task-lifecycle.md Section 5) currently uses a 3-layer structure: mechanical verification, task reviewer, executor self-report. The tool system dramatically improves Layer 1 (mechanical verification) by making it direct rather than requiring a verification agent session.

```
CoreLoop.verify(taskResult)
  |
  +-- Layer 1: Mechanical Verification via Tools (ENHANCED)
  |   +-- Shell: run test suite -> pass/fail + coverage numbers
  |   +-- Glob: check output files exist as expected
  |   +-- Read: verify file contents match expected patterns
  |   +-- Shell: run type checker (tsc --noEmit)
  |   +-- Shell: run linter
  |   +-- HttpFetch: check API endpoint responds correctly
  |   +-- All results are deterministic, no LLM needed
  |
  +-- Layer 2: Task Reviewer (existing, unchanged)
  |   Independent LLM session evaluates artifacts
  |
  +-- Layer 3: Executor Self-Report (existing, unchanged)
      Reference information from the executing agent
```

### 8.2 Verification Speed Comparison

| Verification Step | Before (Agent) | After (Tool) | Speedup |
|-------------------|---------------|-------------|---------|
| Run test suite | 30-60s (session overhead + execution) | 5-15s (direct execution) | 2-4x |
| Check file existence | 15-30s (agent round-trip) | <100ms (Glob) | 150-300x |
| Read file content | 15-30s (agent round-trip) | <100ms (Read) | 150-300x |
| Check API health | 15-30s (agent round-trip) | 1-3s (HttpFetch) | 5-10x |
| Run type checker | 30-60s (agent round-trip) | 10-20s (Shell) | 2-3x |

The most dramatic improvement is for simple checks (file existence, content verification) which drop from agent-session timescale (seconds) to tool-call timescale (milliseconds).

### 8.3 Verification Criteria to Tool Mapping

```typescript
/**
 * Map success criteria to verification tool calls.
 * Each criterion is checked independently; all blocking criteria must pass.
 */
function mapCriteriaToToolCalls(
  criteria: Criterion[],
): Array<{
  criterion: Criterion;
  toolName: string;
  input: unknown;
  canVerify: boolean;
}> {
  return criteria.map((criterion) => {
    const method = criterion.verification_method;

    // Pattern matching on verification_method strings
    if (method.startsWith("run ") || method.startsWith("execute ")) {
      const command = method.replace(/^(run|execute)\s+/, "");
      return { criterion, toolName: "shell", input: { command }, canVerify: true };
    }

    if (method.startsWith("check file ") || method.startsWith("file exists ")) {
      const pattern = method.replace(/^(check file|file exists)\s+/, "");
      return { criterion, toolName: "glob", input: { pattern }, canVerify: true };
    }

    if (method.startsWith("read ") || method.startsWith("verify content ")) {
      const filePath = method.replace(/^(read|verify content)\s+/, "");
      return {
        criterion,
        toolName: "read",
        input: { file_path: filePath },
        canVerify: true,
      };
    }

    if (method.startsWith("fetch ") || method.startsWith("check endpoint ")) {
      const url = method.replace(/^(fetch|check endpoint)\s+/, "");
      return {
        criterion,
        toolName: "http_fetch",
        input: { url, method: "GET" },
        canVerify: true,
      };
    }

    // Unknown verification method: cannot verify with tools, defer to Layer 2
    return { criterion, toolName: "__skip__", input: null, canVerify: false };
  });
}
```

### 8.4 Verification Integration in CoreLoop

```typescript
// Addition to CoreLoop verification phase

async verifyWithTools(
  task: Task,
  toolExecutor: ToolExecutor,
  context: ToolCallContext,
): Promise<{ mechanicalPassed: boolean; details: VerificationDetail[] }> {
  const mappings = mapCriteriaToToolCalls(task.success_criteria);
  const verifiable = mappings.filter((m) => m.canVerify);

  if (verifiable.length === 0) {
    // No tool-verifiable criteria; fall through to existing verification
    return { mechanicalPassed: true, details: [] };
  }

  // Execute all verification tool calls (read-only, safe to parallelize)
  const results = await toolExecutor.executeBatch(
    verifiable.map((m) => ({ toolName: m.toolName, input: m.input })),
    context,
  );

  const details: VerificationDetail[] = verifiable.map((m, i) => ({
    criterion: m.criterion,
    toolResult: results[i],
    passed: results[i].success,
  }));

  // All blocking criteria must pass
  const blockingFailed = details.some(
    (d) => d.criterion.is_blocking && !d.passed,
  );

  return { mechanicalPassed: !blockingFailed, details };
}

interface VerificationDetail {
  criterion: Criterion;
  toolResult: ToolResult;
  passed: boolean;
}
```

### 8.5 Reduced Iteration Latency

With tool-based verification, the CoreLoop completes iterations significantly faster:

| Phase | Before | After | Savings |
|-------|--------|-------|---------|
| Observe | 30-60s | 2-10s | 20-50s |
| Gap calculation | <1s | <1s (+ optional 2-5s for stale refresh) | ~0s |
| Drive scoring | <1s | <1s | --- |
| Task generation | 5-10s | 5-10s | --- |
| Execute (agent) | 60-300s | 60-300s (unchanged) | --- |
| Verify | 30-60s | 5-20s | 25-40s |
| **Total** | **~130-430s** | **~75-340s** | **~45-90s per iteration** |

For observation-only iterations (no task execution), the savings are proportionally larger: from ~60-120s down to ~5-15s.

---

## 9. Tool Integration: Task Execution (Future Work)

> **Note**: This section describes future work that builds on the tool system established in Sections 3-8. It is NOT part of the current implementation scope. The concepts are documented here for architectural completeness and to inform the design of the read-only tool system.

### 9.1 Concept: Execution Routing

In the future, PulSeed could gain mutation tools (Write, Edit, Shell with side effects) and route simple tasks directly through tools rather than agent sessions:

- **Simple tasks** (single file edit, config change): Direct tool execution
- **Medium tasks**: Tool-based preparation + agent delegation
- **Complex tasks**: Full agent delegation (unchanged)

### 9.2 Concept: Complexity Scoring

A complexity scoring function would assess whether a task can be handled directly:

```
Complexity factors:
  - Number of target dimensions
  - Scope size (files to modify)
  - Success criteria count
  - Estimated duration
  - Reversibility requirements
```

Tasks scoring below a threshold could be executed via a sequence of tool calls planned by the LLM.

### 9.3 Concept: Mutation Tool Interfaces

Future mutation tools would follow the same ITool interface but with:
- `permissionLevel: "write_local"` or `"execute"`
- `isDestructive: true`
- `isConcurrencySafe(): false` (writes are never safe to parallelize)
- Mandatory approval via `approvalFn` for all invocations

The permission model (Section 3.5) already accounts for these levels; the thresholds are defined but the tools are not yet implemented.

### 9.4 Prerequisites for Task Execution

Before implementing direct task execution:
1. Read-only tool integration must be stable and proven (Phases 1-2)
2. Tool trust tracking must demonstrate reliable permission management
3. Rollback mechanisms for failed tool sequences must be designed
4. The complexity scoring algorithm must be validated against real tasks

---

## 10. Built-in Tools

### 10.1 GlobTool

```typescript
// src/tools/builtin/glob.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../types.js";
import { glob } from "glob";

export const GlobInputSchema = z.object({
  /** Glob pattern to match (e.g., "**/*.ts", "src/**/index.ts") */
  pattern: z.string().min(1),
  /** Directory to search in. Defaults to cwd. */
  path: z.string().optional(),
  /** Maximum number of results to return */
  limit: z.number().default(500),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

export class GlobTool implements ITool<GlobInput, string[]> {
  readonly metadata: ToolMetadata = {
    name: "glob",
    aliases: ["find_files", "ls_glob"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    tags: ["filesystem", "search", "observation"],
  };

  readonly inputSchema = GlobInputSchema;

  description(context?: ToolDescriptionContext): string {
    const cwd = context?.cwd ?? process.cwd();
    return `Find files matching a glob pattern. Current directory: ${cwd}. Returns an array of matching file paths sorted by modification time.`;
  }

  async call(input: GlobInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? context.cwd;

    try {
      const matches = await glob(input.pattern, {
        cwd: searchPath,
        absolute: true,
        nodir: false,
      });

      const limited = matches.slice(0, input.limit);

      return {
        success: true,
        data: limited,
        summary: `Found ${matches.length} files matching "${input.pattern}"${matches.length > input.limit ? ` (showing first ${input.limit})` : ""}`,
        durationMs: Date.now() - startTime,
        artifacts: limited,
      };
    } catch (err) {
      return {
        success: false,
        data: [],
        summary: `Glob failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
```

### 10.2 GrepTool

```typescript
// src/tools/builtin/grep.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
} from "../types.js";

export const GrepInputSchema = z.object({
  /** Regular expression pattern to search for */
  pattern: z.string().min(1),
  /** File or directory to search in. Defaults to cwd. */
  path: z.string().optional(),
  /** Glob filter for file types (e.g., "*.ts") */
  glob: z.string().optional(),
  /** Output mode */
  outputMode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches"),
  /** Maximum results */
  limit: z.number().default(250),
  /** Case insensitive */
  caseInsensitive: z.boolean().default(false),
  /** Lines of context before/after matches */
  context: z.number().optional(),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

export class GrepTool implements ITool<GrepInput, string> {
  readonly metadata: ToolMetadata = {
    name: "grep",
    aliases: ["search", "rg"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    tags: ["filesystem", "search", "observation", "knowledge"],
  };

  readonly inputSchema = GrepInputSchema;

  description(): string {
    return "Search file contents using regular expressions (backed by ripgrep). Returns matching lines or file paths.";
  }

  async call(input: GrepInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? context.cwd;

    try {
      const args: string[] = ["--no-heading"];
      if (input.caseInsensitive) args.push("-i");
      if (input.glob) args.push("--glob", input.glob);
      if (input.context) args.push("-C", String(input.context));

      switch (input.outputMode) {
        case "files_with_matches":
          args.push("-l");
          break;
        case "count":
          args.push("-c");
          break;
        case "content":
          args.push("-n");
          break;
      }

      args.push("--max-count", String(input.limit));
      args.push(input.pattern, searchPath);

      const { execFileNoThrow } = await import(
        "../../base/utils/execFileNoThrow.js"
      );
      const result = await execFileNoThrow("rg", args, { timeout: 30_000 });

      const output = result.stdout.trim();
      const lines = output ? output.split("\n") : [];

      return {
        success: true,
        data: output,
        summary: `Found ${lines.length} ${input.outputMode === "files_with_matches" ? "files" : "matches"} for pattern "${input.pattern}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: "",
        summary: `Grep failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
```

### 10.3 ReadTool

```typescript
// src/tools/builtin/read.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
} from "../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const ReadInputSchema = z.object({
  /** Absolute path to the file to read */
  file_path: z.string().min(1),
  /** Starting line number (0-based offset) */
  offset: z.number().min(0).optional(),
  /** Number of lines to read */
  limit: z.number().min(1).default(2000),
});

export type ReadInput = z.infer<typeof ReadInputSchema>;

export class ReadTool implements ITool<ReadInput, string> {
  readonly metadata: ToolMetadata = {
    name: "read",
    aliases: ["cat", "view"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 0,
    tags: ["filesystem", "observation", "knowledge"],
  };

  readonly inputSchema = ReadInputSchema;

  description(): string {
    return "Read the contents of a file. Supports line offset and limit for large files. Returns file contents with line numbers.";
  }

  async call(input: ReadInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(context.cwd, input.file_path);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");

      const start = input.offset ?? 0;
      const end = Math.min(start + input.limit, lines.length);
      const selected = lines.slice(start, end);

      const formatted = selected
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n");

      return {
        success: true,
        data: formatted,
        summary: `Read ${end - start} lines from ${path.basename(filePath)} (lines ${start + 1}-${end} of ${lines.length})`,
        durationMs: Date.now() - startTime,
        artifacts: [filePath],
      };
    } catch (err) {
      return {
        success: false,
        data: "",
        summary: `Read failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    input: ReadInput,
  ): Promise<PermissionCheckResult> {
    const basename = path.basename(input.file_path);
    const sensitivePatterns = [".env", "credentials", "secret", "private_key"];
    if (sensitivePatterns.some((p) => basename.toLowerCase().includes(p))) {
      return {
        status: "needs_approval",
        reason: `Reading potentially sensitive file: ${basename}`,
      };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
```

### 10.4 ShellTool (Read-Only Mode)

```typescript
// src/tools/builtin/shell.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
} from "../types.js";

export const ShellInputSchema = z.object({
  /** The shell command to execute */
  command: z.string().min(1),
  /** Working directory. Defaults to context cwd. */
  cwd: z.string().optional(),
  /** Timeout in milliseconds (default: 120000 = 2 minutes) */
  timeoutMs: z.number().default(120_000),
  /** Optional description for audit logging */
  description: z.string().optional(),
});

export type ShellInput = z.infer<typeof ShellInputSchema>;

export interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shell tool for running read-only commands (metrics, tests, git queries).
 *
 * This tool is classified as "read_metrics" permission level because it
 * spawns processes (which have inherent side effects like CPU/memory usage),
 * but is restricted to commands that do not modify state.
 *
 * Commands with side effects (rm, git push, npm publish) are blocked by the
 * permission system. Future mutation-capable Shell is out of scope.
 */
export class ShellTool implements ITool<ShellInput, ShellOutput> {
  readonly metadata: ToolMetadata = {
    name: "shell",
    aliases: ["bash", "exec", "run"],
    permissionLevel: "read_metrics",
    isReadOnly: false, // Spawns processes, not strictly read-only
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 3,
    tags: ["observation", "verification", "knowledge"],
  };

  readonly inputSchema = ShellInputSchema;

  description(): string {
    return "Execute a read-only shell command and return stdout, stderr, and exit code. Use for running tests, querying metrics, git status, and system queries. Mutation commands are blocked.";
  }

  async call(input: ShellInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwd = input.cwd ?? context.cwd;

    try {
      const { execFileNoThrow } = await import(
        "../../base/utils/execFileNoThrow.js"
      );

      const shell = process.env.SHELL ?? "/bin/zsh";
      const result = await execFileNoThrow(shell, ["-c", input.command], {
        cwd,
        timeout: input.timeoutMs,
      });

      const output: ShellOutput = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };

      return {
        success: result.exitCode === 0,
        data: output,
        summary:
          result.exitCode === 0
            ? `Command succeeded (exit 0)${result.stdout.length > 0 ? `: ${result.stdout.slice(0, 200)}` : ""}`
            : `Command failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        error:
          result.exitCode !== 0 ? result.stderr.slice(0, 500) : undefined,
        durationMs: Date.now() - startTime,
        contextModifier:
          result.exitCode === 0
            ? `Shell output: ${result.stdout.slice(0, 500)}`
            : undefined,
      };
    } catch (err) {
      return {
        success: false,
        data: { stdout: "", stderr: (err as Error).message, exitCode: -1 },
        summary: `Shell execution failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    input: ShellInput,
  ): Promise<PermissionCheckResult> {
    const cmd = input.command.trim();

    // SAFE_PATTERNS: read-only commands that are always safe
    const SAFE_PATTERNS = [
      /^(cat|head|tail|wc|ls|pwd|echo|date|hostname|which|type|file)\b/,
      /^git\s+(status|log|diff|show|branch|rev-parse|rev-list|describe|tag\s+-l)\b/,
      /^npm\s+(ls|list|view|info|outdated|audit)\b/,
      /^npx\s+vitest\s+(run|list|--reporter)/,
      /^npx\s+tsc\s+--noEmit/,
      /^rg\s/,
      /^find\s/,
      /^du\s/,
      /^df\s/,
      /^tree\s/,
    ];

    // DENY_PATTERNS: mutation commands that are always denied in read-only mode
    const DENY_PATTERNS = [
      /\brm\s/,
      /\bmv\s/,
      /\bcp\s/,
      /\bmkdir\s/,
      /\btouch\s/,
      /\bchmod\s/,
      /\bchown\s/,
      /\bgit\s+(push|commit|merge|rebase|reset|checkout|clean|stash)\b/,
      /\bnpm\s+(install|uninstall|publish|run|exec)\b/,
      /\bcurl\s.*(-X\s*(POST|PUT|DELETE|PATCH)|-d\s)/,
      /\bwget\s/,
      /\bsudo\s/,
      /\bmkfs\b/,
      /\bdd\s+if=/,
      /\bshutdown\b/,
      /\breboot\b/,
      />/,  // Any output redirection
      /\|.*\b(tee|dd|rm|mv)\b/, // Piped to mutating commands
    ];

    // Split compound commands and check each segment
    const segments = cmd.split(/\s*(?:&&|\|\||;)\s*/);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      if (DENY_PATTERNS.some(p => p.test(trimmed))) {
        return { status: "denied", reason: `Denied command segment: ${trimmed}` };
      }
    }
    // Then check each segment against safe patterns
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      if (!SAFE_PATTERNS.some(p => p.test(trimmed))) {
        return { status: "needs_approval", reason: `Unknown command segment requires approval: ${trimmed}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(input: ShellInput): boolean {
    const cmd = input.command.trim();
    const readOnlyPatterns = [
      /^(cat|head|tail|wc|ls|pwd|echo|date)\b/,
      /^git\s+(status|log|diff|show|branch)\b/,
      /^rg\s/,
      /^find\s/,
    ];
    return readOnlyPatterns.some((re) => re.test(cmd));
  }
}
```

### 10.5 HttpFetchTool (GET/HEAD Only)

```typescript
// src/tools/builtin/http-fetch.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
} from "../types.js";

export const HttpFetchInputSchema = z.object({
  /** URL to fetch */
  url: z.string().url(),
  /** HTTP method (read-only: GET and HEAD only) */
  method: z.enum(["GET", "HEAD"]).default("GET"),
  /** Request headers */
  headers: z.record(z.string()).optional(),
  /** Timeout in milliseconds */
  timeoutMs: z.number().default(30_000),
  /** Maximum response body size in bytes (default: 1MB) */
  maxResponseBytes: z.number().default(1_048_576),
});

export type HttpFetchInput = z.infer<typeof HttpFetchInputSchema>;

export interface HttpFetchOutput {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
}

/**
 * HTTP fetch tool for read-only requests (GET/HEAD).
 * Used for API health checks, fetching documentation, reading metrics endpoints.
 *
 * Mutation methods (POST/PUT/DELETE/PATCH) are NOT supported in the current
 * scope. They will be added as part of the future mutation tools initiative.
 */
export class HttpFetchTool implements ITool<HttpFetchInput, HttpFetchOutput> {
  readonly metadata: ToolMetadata = {
    name: "http_fetch",
    aliases: ["fetch", "curl", "http"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 5,
    tags: ["network", "observation", "knowledge"],
  };

  readonly inputSchema = HttpFetchInputSchema;

  description(): string {
    return "Make read-only HTTP requests (GET/HEAD) to fetch data from URLs. Use for checking API health, fetching documentation, and reading metrics endpoints.";
  }

  async call(
    input: HttpFetchInput,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        input.timeoutMs,
      );

      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const body = input.method === "HEAD" ? "" : await response.text();
      const truncatedBody =
        body.length > input.maxResponseBytes
          ? body.slice(0, input.maxResponseBytes) + "\n[truncated]"
          : body;

      const output: HttpFetchOutput = {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: truncatedBody,
        ok: response.ok,
      };

      return {
        success: response.ok,
        data: output,
        summary: `${input.method} ${input.url} -> ${response.status} (${truncatedBody.length} bytes)`,
        error: response.ok
          ? undefined
          : `HTTP ${response.status}: ${truncatedBody.slice(0, 200)}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { statusCode: 0, headers: {}, body: "", ok: false },
        summary: `HTTP fetch failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    input: HttpFetchInput,
  ): Promise<PermissionCheckResult> {
    // Block internal network access at low trust
    const url = new URL(input.url);
    const isInternal =
      ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(
        url.hostname,
      ) ||
      url.hostname.startsWith("192.168.") ||
      url.hostname.startsWith("10.");

    if (isInternal) {
      return {
        status: "needs_approval",
        reason: `Fetching from internal address: ${input.url}`,
      };
    }

    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true; // GET/HEAD are always safe
  }
}
```

### 10.6 JsonQueryTool

```typescript
// src/tools/builtin/json-query.ts

import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
} from "../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const JsonQueryInputSchema = z.object({
  /** Path to the JSON file to query */
  file_path: z.string().min(1),
  /**
   * Dot-notation query path.
   * Supports array indices: "items[0].name"
   * Examples: "dependencies.zod", "scripts.build", "version"
   */
  query: z.string().min(1),
});

export type JsonQueryInput = z.infer<typeof JsonQueryInputSchema>;

export class JsonQueryTool implements ITool<JsonQueryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "json_query",
    aliases: ["jq", "json_read"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    tags: ["filesystem", "observation", "knowledge"],
  };

  readonly inputSchema = JsonQueryInputSchema;

  description(): string {
    return 'Query a JSON file using dot-notation path (e.g., "dependencies.zod", "scripts.build", "[0].name"). Returns the value at the specified path.';
  }

  async call(
    input: JsonQueryInput,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(context.cwd, input.file_path);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const json = JSON.parse(content);

      const value = this.queryPath(json, input.query);

      return {
        success: true,
        data: value,
        summary: `${input.query} = ${JSON.stringify(value).slice(0, 200)}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `JSON query failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  private queryPath(obj: unknown, query: string): unknown {
    const parts = query.split(".").flatMap((part) => {
      const match = part.match(/^(.+?)\[(\d+)]$/);
      if (match) return [match[1], match[2]];
      return [part];
    });

    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === "object") {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return current;
  }
}
```

### 10.7 Tool Summary Table

| Tool | Permission Level | Read-Only | Destructive | Concurrency | Always Load | Tags |
|------|-----------------|-----------|-------------|-------------|-------------|------|
| `glob` | read_only | yes | no | unlimited | yes | filesystem, search, observation |
| `grep` | read_only | yes | no | unlimited | yes | filesystem, search, observation, knowledge |
| `read` | read_only | yes | no | unlimited | yes | filesystem, observation, knowledge |
| `shell` | read_metrics | no* | no | 3 | yes | observation, verification, knowledge |
| `http_fetch` | read_only | yes | no | 5 | no (deferred) | network, observation, knowledge |
| `json_query` | read_only | yes | no | unlimited | no (deferred) | filesystem, observation, knowledge |

*Shell is not strictly read-only (it spawns processes) but is restricted to read-only commands by the permission system.

---

## 11. Permission & Safety Model

### 11.1 Three-Layer Integration

```
+------------------------------------------------------------+
| Layer 1: Static Deny-List                                  |
|   - System paths (/etc, /usr, /bin, /var)                  |
|   - Dangerous shell commands (rm, mv, git push, npm publish)|
|   - Sensitive file reads (.env, credentials)               |
|   - Output redirection (>)                                 |
|   DENY BEATS ALLOW                                         |
+------------------------------------------------------------+
| Layer 2: Trust-Based + EthicsGate                          |
|   - Trust balance -> permission threshold mapping:         |
|     read_only:     always allowed (trust >= -100)          |
|     read_metrics:  trust >= -50                            |
|   - EthicsGate L1 (hardcoded blocklist) for Shell tool     |
|   - Unknown shell commands require approval                |
+------------------------------------------------------------+
| Layer 3: Interactive Approval                              |
|   - approvalFn callback (injected via DI)                  |
|   - Default: deny (same as existing approvalFn pattern)    |
|   - Observation commands auto-approved via allow-list      |
|   - Approval is per-invocation, not blanket                |
+------------------------------------------------------------+
```

### 11.2 Trust-Based Escalation

| Trust Balance | Read-Only Tools | Shell (read_metrics) |
|--------------|----------------|---------------------|
| +50 to +100 | auto-allowed | auto-allowed (safe commands) |
| 0 to +49 | auto-allowed | auto-allowed (safe commands) |
| -49 to -1 | auto-allowed | auto-allowed (safe commands) |
| -50 to -100 | auto-allowed | needs approval for all |

Note: "safe commands" means commands matching the safe-command regex list in ShellTool.checkPermissions. Unknown commands always require approval regardless of trust.

### 11.3 Tool Trust Tracking

Each tool invocation updates the trust balance via the existing TrustManager:

```typescript
async function updateToolTrust(
  trustManager: TrustManager,
  toolName: string,
  result: ToolResult,
): Promise<void> {
  const domain = `tool:${toolName}`;
  if (result.success) {
    await trustManager.recordSuccess(domain); // +3
  } else {
    await trustManager.recordFailure(domain); // -10
  }
}
```

This uses the existing trust asymmetry (Ds=+3, Df=-10). Repeated tool failures cause the trust for that tool domain to drop, eventually requiring manual approval.

### 11.4 Shell Command Safety Classification

The Shell tool uses a 3-tier command classification:

1. **Safe (auto-allowed)**: Commands that are definitively read-only: `cat`, `wc`, `ls`, `git log`, `git status`, `npx vitest run`, `rg`, `find`
2. **Denied**: Commands that are definitively mutations: `rm`, `mv`, `git push`, `npm publish`, output redirection (`>`)
3. **Unknown (needs approval)**: Everything else. User decides per invocation.

Over time, the allow-list and deny-list can be extended via configuration. Observation-specific commands are auto-approved when they match the dimension's configured `observation_method.endpoint`.

### 11.5 Input-Level Permission Rules

```typescript
// Example: auto-approve observation commands for a specific goal
permissionManager.addAllowRule({
  toolName: "shell",
  inputMatcher: (input) => {
    const cmd = (input as { command: string }).command;
    return cmd === "npx vitest run --reporter=json";
  },
  reason: "Test execution observation is always allowed",
});

// Example: block fetching from specific domains
permissionManager.addDenyRule({
  toolName: "http_fetch",
  inputMatcher: (input) => {
    const url = (input as { url: string }).url;
    return url.includes("internal-company.example.com");
  },
  reason: "Cannot fetch from internal company URLs",
});
```

---

## 12. Impact on Existing Modules

### 12.1 Module-by-Module Changes

| Module | Change Description | Change Size |
|--------|--------------------|-------------|
| **ObservationEngine** | Add `observeWithTools()` method; tool-first fallback chain | Medium (new method + call-site change) |
| **GapCalculator** | Add `measureDirectly()` for stale-data refresh | Small (optional path, no existing logic changes) |
| **KnowledgeManager** | Add tool-based research before agent delegation | Medium (new method + priority ordering) |
| **StrategyManager** | Accept workspace context from tools | Small (context injection, no logic changes) |
| **CoreLoop** | Wire ToolExecutor into deps; use tools in verify phase | Medium (new dep + verification enhancement) |
| **TaskLifecycle** | No changes (agent delegation path unchanged) | None |
| **EthicsGate** | No changes (tools call EthicsGate, not the reverse) | None |
| **TrustManager** | No changes (tools call TrustManager, not the reverse) | None |
| **AdapterLayer** | No changes (agent path remains intact) | None |
| **SessionManager** | Minor: include tool-gathered context in sessions | Small |
| **ReportingEngine** | Add tool execution events to reports | Small |
| **CoreLoopDeps** | Add `toolExecutor?: ToolExecutor` field | Trivial |

### 12.2 CoreLoopDeps Extension

```typescript
export interface CoreLoopDeps extends ObservationDeps, TreeDeps, StallDeps, TaskCycleDeps {
  // ... existing fields ...

  /**
   * Optional ToolExecutor for direct tool-based operations.
   * When provided, CoreLoop uses tools for observation, verification,
   * and knowledge acquisition. When absent, all operations fall through
   * to agent delegation (backward-compatible).
   */
  toolExecutor?: ToolExecutor;

  /**
   * Optional ToolRegistry for context-aware tool assembly.
   * Used by StrategyManager for workspace context gathering.
   */
  toolRegistry?: ToolRegistry;
}
```

### 12.3 Migration Strategy

Each integration point is **independent**. They can be implemented and shipped in any order:

1. **Observation integration** does not depend on verification integration.
2. **Verification integration** does not depend on observation integration.
3. **Knowledge integration** does not depend on any other integration.
4. **Strategy grounding** depends on having tools but not on other integrations.

This means the tool system provides incremental value: even with just Glob + Read + Grep integrated into observation, PulSeed becomes significantly faster at perceiving the world.

### 12.4 Backward Compatibility

The `toolExecutor` field on CoreLoopDeps is optional. When not provided:
- ObservationEngine skips `observeWithTools()` and uses existing paths.
- GapCalculator skips `measureDirectly()` and uses stored values only.
- KnowledgeManager skips tool-based research and delegates to agents.
- CoreLoop verification uses existing agent-based verification.

This means the tool system is a **purely additive** change. No existing behavior is modified. Tools only activate when explicitly provided.

---

## 13. Design Doc Updates Required

### 13.1 execution-boundary.md

**Section 1 (Core Principle)**: Revise from "PulSeed does not execute on its own" to "PulSeed perceives the world directly through read-only tools; all mutations and multi-step work are delegated to agents."

**Section 2 (What PulSeed Does Directly)**: Add row:

| What PulSeed does directly | Purpose |
|---------------------------|---------|
| Read-only tool invocations | Perceive the world: check files (Glob, Read), search code (Grep), run metrics commands (Shell), check API health (HttpFetch), query configs (JsonQuery) |

**Section 3 (What PulSeed Delegates)**: Keep all existing delegation categories. Clarify that data collection for simple, mechanical cases is now handled by tools rather than agents.

**Section 6 (Shorthand mapping)**: Add entries:
- "PulSeed checked the tests" = "PulSeed ran `npx vitest run` via Shell tool and parsed the output"
- "PulSeed read the config" = "PulSeed used the Read tool to access the configuration file"

### 13.2 mechanism.md

**Section 2.1 (Observation)**: Add note that mechanical observation (highest trust layer) can now be performed directly via tools, without agent sessions.

**Section 2.5 (Knowledge Acquisition)**: Add note that simple codebase research uses tools (Grep, Read, Glob) before agent delegation.

**Section 6 (Execution Boundary)**: Update to reflect the refined boundary.

### 13.3 docs/design/core/observation.md

**Section 2 (Three-Layer Architecture)**: Add that Layer 1 (mechanical observation) is enhanced by direct tool invocation. Tools provide the same confidence tier as existing mechanical observation but with dramatically lower latency and cost.

**Section 5 (Observation Method Schema)**: Add tool mapping for each `type` value:
- `"file_check"` -> GlobTool + ReadTool
- `"mechanical"` -> ShellTool
- `"api_query"` -> HttpFetchTool

### 13.4 docs/design/knowledge/knowledge-acquisition.md

**Section 4 (Means of Knowledge Acquisition)**: Replace "fully delegated to agents" with: "Tool-based research is attempted first for questions answerable from local files or simple HTTP requests. Agent delegation is the fallback for questions requiring multi-step reasoning, web search, or human interaction."

### 13.5 docs/design/core/self-knowledge.md

**Section 3.3, 3.6**: Replace hardcoded strings with tool-based discovery (Glob, Read) of actual capabilities.

### 13.6 docs/vision.md

**Section 5.8 (Delegation Layer)**: Add note that PulSeed now has a perception tool layer beneath the delegation layer, enabling direct observation without agent sessions.

### 13.7 docs/runtime.md

**Section 1 (Separation premise)**: Refine. The separation is now "PulSeed (with read-only tools) vs. agents (for mutations and complex work)" rather than "PulSeed vs. all external interaction."

---

## 14. Implementation Roadmap

### Phase 1: Tool System Core + Read-Only Tools

**Goal**: Establish the tool infrastructure and implement all read-only built-in tools.

**Deliverables**:
- `src/tools/types.ts` --- Core interfaces (ITool, ToolResult, ToolMetadata)
- `src/tools/registry.ts` --- ToolRegistry with 3-tier filtering
- `src/tools/executor.ts` --- ToolExecutor with 5-gate pipeline
- `src/tools/permission.ts` --- ToolPermissionManager (3-layer)
- `src/tools/concurrency.ts` --- ConcurrencyController
- `src/tools/builtin/glob.ts` --- GlobTool
- `src/tools/builtin/read.ts` --- ReadTool
- `src/tools/builtin/grep.ts` --- GrepTool
- `src/tools/builtin/json-query.ts` --- JsonQueryTool
- Full test coverage for all above

**Estimated size**: ~1200 lines of production code, ~800 lines of tests

**Value**: Tool system is functional. Read-only tools can be used programmatically but are not yet integrated into the core loop.

**Dependencies**: None (standalone new module).

### Phase 2: Observation + Knowledge Integration + Shell/HttpFetch

**Goal**: Connect tools to the observation and knowledge systems. Add Shell and HttpFetch tools.

**Deliverables**:
- `src/tools/builtin/shell.ts` --- ShellTool (read-only mode)
- `src/tools/builtin/http-fetch.ts` --- HttpFetchTool (GET/HEAD only)
- ObservationEngine: `observeWithTools()` method + tool-first fallback chain
- KnowledgeManager: tool-based research path (`acquireWithTools()`)
- Observation allow-list auto-registration from dimension configs
- CoreLoopDeps: add `toolExecutor` and `toolRegistry` fields
- Integration tests: observation with tools, knowledge acquisition with tools

**Estimated size**: ~800 lines production, ~600 lines tests

**Value**: Observation and knowledge acquisition become 10-100x faster for mechanical/codebase cases. This is the biggest single improvement in core loop performance.

**Dependencies**: Phase 1.

### Phase 3: Gap Calculation + Verification + Strategy Grounding

**Goal**: Complete read-only tool integration across all remaining core loop operations.

**Deliverables**:
- GapCalculator: `measureDirectly()` for stale-data refresh
- CoreLoop verification: tool-based Layer 1 mechanical verification
- StrategyManager: workspace context gathering (`buildWorkspaceContext()`)
- WorkspaceContextCache for per-iteration caching
- Integration tests: verification with tools, strategy with workspace context

**Estimated size**: ~600 lines production, ~500 lines tests

**Value**: Verification latency drops dramatically. Gap calculation becomes more accurate with fresh measurements. Strategy selection is grounded in actual workspace state.

**Dependencies**: Phase 2.

### Future Phase: Mutation Tools + Task Execution Routing

**Goal**: Add mutation tools and enable direct task execution for simple tasks.

**Scope** (high-level, to be detailed in a separate design doc):
- WriteTool, EditTool, Shell with side effects
- Complexity scoring and execution routing
- Hybrid execution (tools for prep, agent for core work)
- Rollback mechanisms for failed tool sequences

**Dependencies**: Phases 1-3 must be stable. Requires a separate design document.

### Phase Summary

| Phase | Est. Lines | Est. Duration | Key Value |
|-------|-----------|---------------|-----------|
| Phase 1 | ~2000 | 1-2 sessions | Tool infrastructure exists |
| Phase 2 | ~1400 | 1-2 sessions | Observation + knowledge 10-100x faster |
| Phase 3 | ~1100 | 1 session | Verification + gap + strategy grounded |
| **Total (current scope)** | **~4500** | **3-5 sessions** | **Full read-only tool integration** |
| Future | TBD | TBD | Mutation tools + direct execution |

---

## 15. Design Decisions (Resolved)

### 15.1 MCP Integration

**Decision** (resolved): Design ITool with MCP-compatible JSON-serializable input/output schemas (via Zod). MCP server implementation deferred to separate design doc. Follow CC's `assembleToolPool()` pattern: built-in tools sorted alphabetically as first block, plugin/external tools as second block — never interleave (preserves prompt cache breakpoints). Name collisions: built-in wins.

**CC Reference**: CC uses `assembleToolPool()` to compose the tool list sent to the LLM, with strict ordering rules to preserve prompt cache breakpoints.

**Rationale**: MCP compatibility via Zod schemas is zero-cost at design time. Deferred server implementation avoids scope creep. Strict tool ordering is critical for prompt cache efficiency — interleaving built-in and external tools would invalidate cache on every plugin change.

### 15.2 Tool Output Size Limits

**Decision** (resolved): Each tool defines `maxOutputChars` limit. When exceeded: full output persisted to disk (`~/.pulseed/tool-output/<invocation-id>.json`), LLM receives truncated version with `[truncated: N more lines — full output at <path>]`. Default limit: 8000 chars (~2000 tokens). This improves on CC's approach (CC has no intelligent truncation — known bug #12054 where 580k tokens crashed a session).

**CC Reference**: CC lacks intelligent truncation — bug #12054 documents a session crash caused by 580k tokens from untruncated tool output.

**Rationale**: Persisting full output to disk preserves data while protecting context budget. The truncation suffix gives the LLM a retrieval path if it needs the full output. 8000 chars is conservative enough to prevent runaway context growth.

### 15.3 Caching

**Decision** (resolved): Implement per-iteration cache keyed by `(toolName, JSON.stringify(input))`. Cache expires at end of each CoreLoop iteration. All read-only tools are cacheable. ShellTool results cacheable only for safe-list commands. This is a PulSeed differentiation — CC does NOT cache tool results (only API-level prompt caching). PulSeed's core loop calls the same tools multiple times per iteration (observe → gap → verify), making caching high-value.

**CC Reference**: CC performs API-level prompt caching only. No tool result caching. PulSeed's multi-phase iteration pattern (observe → gap → verify) makes in-iteration caching significantly more valuable than in CC's single-pass model.

**Rationale**: The same `glob` or `grep` call is likely to appear in observation, gap calculation, and verification within a single iteration. Caching eliminates redundant filesystem I/O and reduces latency by 2-3x for read-heavy iterations.

### 15.4 Relationship to DataSourceAdapter

**Decision** (resolved): Coexist for now. DataSourceAdapters are per-goal configured observation sources with specific query semantics. Tools are general-purpose capabilities. In a future phase, provide `DataSourceToolAdapter` wrapper to unify under ITool interface. No schema changes to existing DataSourceAdapter.

**CC Reference**: N/A — CC does not have a DataSourceAdapter concept.

**Rationale**: Forcing a migration now would break the existing observation pipeline with no immediate benefit. The `DataSourceToolAdapter` wrapper pattern allows gradual unification without disrupting existing goal configurations.

### 15.5 Plugin-Provided Tools

**Decision** (resolved): ITool interface designed to be implementable by external code. Not in current scope. Future: extend PluginLoader to discover and register plugin-provided tools in ToolRegistry. Plugin-provided tools use `shouldDefer: true` by default (following CC's pattern — MCP tools deferred when combined descriptions exceed ~10% of context budget).

**CC Reference**: CC defers MCP/external tools when their combined descriptions exceed ~10% of the context budget. MCP tools are loaded as a second block after built-in tools in `assembleToolPool()`.

**Rationale**: Deferring plugin tools by default is safe — they can always be explicitly loaded. The 10% context budget threshold prevents plugin sprawl from crowding out goal and knowledge context.

### 15.5b Self-Knowledge Tools Relationship

**Decision** (resolved): Self-knowledge tools (`get_goals`, `get_sessions`, `get_trust_state`, etc.) and core loop tools (Glob, Grep, Read, Shell, etc.) are separate layers:
- Self-knowledge: introspection into PulSeed's internal state, used by chat UI via LLM function calling
- Core loop tools: perception of external world, used by ObservationEngine/GapCalculator/etc. directly

Future unification path: re-implement self-knowledge tools as ITool instances registered in ToolRegistry with `mode: chat` filter. Core loop tools registered with `mode: core` filter. `assembleToolPool()` filters by mode, following CC's `getTools(permissionContext)` pattern.

**CC Reference**: CC uses `getTools(permissionContext)` to filter the tool pool by permission context before assembling the tool list for each LLM call.

**Rationale**: Keeping the layers separate now avoids refactoring the chat UI and core loop simultaneously. The `mode` filter approach provides a clean unification path without breaking either consumer.

### 15.6 Token Budget Allocation

**Decision** (resolved): 6 built-in read-only tools ≈ 450 tokens for descriptions — always loaded (no deferral needed). Follow CC reference: core tools (7) use ~8.1k tokens pre-loaded; secondary tools deferred. PulSeed's 6 tools are well under budget. When plugin tools are added in future, apply 10% context budget threshold for deferral.

**CC Reference**: CC pre-loads 7 core tools at ~8.1k tokens and defers secondary tools. The 10% context budget threshold for deferral is derived from CC's MCP tool loading behavior.

**Rationale**: At ~450 tokens, PulSeed's 6 built-in tools consume less than 1.5% of a 32K context budget — well below the deferral threshold. Pre-loading all built-ins eliminates the complexity of conditional loading for minimal budget savings.

### 15.7 Shell Command Discovery

**Decision** (resolved): Start with static safe-command and deny-command regex lists. Log all Shell invocations with command, outcome, and approval status. Follow CC's pattern: speculative classification runs before permission check (Bash-only optimization). Compound commands decomposed and each segment checked independently (CC's fix for `&&` chaining bypass, issue #28784). Learning mechanism deferred — consider after accumulating usage data.

**CC Reference**: CC performs speculative shell classification before the permission check as a Bash-only optimization. CC issue #28784 fixed a security bypass where `&&`-chained commands could smuggle denied commands past a safe prefix.

**Rationale**: Static lists are auditable and predictable. Compound command decomposition is a security requirement, not an optimization — `safe_cmd && denied_cmd` must be blocked. Learning mechanism deferred until we have real usage data to learn from.

### 15.8 Observation Method Evolution

**Decision** (resolved): No schema changes needed. Existing `observation_method.type` maps cleanly to tools:
- `type: file_check` + `endpoint` → `GlobTool({ pattern: endpoint })`
- `type: mechanical` + `endpoint` → `ShellTool({ command: endpoint })`
- `type: api_query` + `endpoint` → `HttpFetchTool({ url: endpoint })`

**CC Reference**: N/A — CC does not have an observation method schema.

**Rationale**: Zero schema migration cost. The existing `type` and `endpoint` fields carry sufficient information to route to the correct tool. ObservationEngine can perform the mapping internally without exposing tool concepts to goal configuration.

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **Tool** | A single-purpose capability that PulSeed can invoke directly (no agent session). All current tools are read-only. |
| **ToolSystem** | The combination of ToolRegistry, ToolExecutor, and ToolPermissionManager. |
| **Direct observation** | Observation performed via tools rather than agent delegation. |
| **Read-only tool** | A tool that gathers information without modifying state: Glob, Grep, Read, HttpFetch(GET), JsonQuery, Shell(safe commands). |
| **Read-metrics tool** | Shell tool in read-only mode: spawns processes (technically a side effect) but restricted to commands that do not modify state. |
| **Context modifier** | A string appended to LLM context after a tool call, summarizing the tool's output. |
| **Deferred tool** | A tool hidden from the LLM's tool list until explicitly searched for, saving context budget. |
| **5-gate pipeline** | The sequence of checks before a tool call executes: Zod validation, semantic check, permission check, input sanitization, concurrency control. |
| **Observation allow-list** | Auto-registered permission rules that allow Shell commands configured as dimension observation methods to run without interactive approval. |

## Appendix B: Integration with cc-inspired-improvements.md

This design document implements several items from the Claude Code-inspired improvements plan:

| CC-Inspired Item | How This Design Addresses It |
|------------------|------------------------------|
| MCP client integration | ToolSystem provides the foundation; MCP tools can be registered as ITool implementations |
| Tool concurrency model | ConcurrencyController implements CC's input-dependent batching and sibling abort |
| Permission system | 3-layer permission model adapted from CC's registry deny > per-call check > interactive prompt |
| Tool deferral | `shouldDefer` flag on ToolMetadata mirrors CC's lazy tool loading |
| Dynamic tool descriptions | `description(context)` method mirrors CC's per-invocation dynamic descriptions |
