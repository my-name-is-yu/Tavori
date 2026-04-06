// src/tools/executor.ts

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
} from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolPermissionManager } from "./permission.js";
import type { ConcurrencyController } from "./concurrency.js";

/**
 * 5-gate execution pipeline for tool invocations.
 *
 * Gate 1: Input validation (Zod schema)
 * Gate 2: Semantic validation (tool-specific checkPermissions)
 * Gate 3: Permission check (3-layer permission manager)
 * Gate 4: Input sanitization (path traversal, injection prevention)
 * Gate 5: Concurrency control (input-dependent batching)
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly permissionManager: ToolPermissionManager;
  private readonly concurrency: ConcurrencyController;

  constructor(deps: ToolExecutorDeps) {
    this.registry = deps.registry;
    this.permissionManager = deps.permissionManager;
    this.concurrency = deps.concurrency;
  }

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
    const logger = context.logger;
    const callId = context.callId;
    const sessionId = context.sessionId;

    logger?.debug("tool.call.start", { tool: toolName, callId, sessionId });

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
    const permResult = await this.permissionManager.check(tool, input, context);
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
        reversibility: "reversible",
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
    let result: ToolResult;
    try {
      result = await this.concurrency.run(
        tool,
        input,
        async () => {
          if (context.dryRun) {
            return {
              success: true,
              data: null,
              summary: "dry-run: skipped",
              durationMs: 0,
            };
          }
          const callFn = () => tool.call(input, context);
          const isSafe = tool.isConcurrencySafe(input);
          if (context.timeoutMs) {
            return this.withTimeout(
              () => this.callWithRetry(callFn, tool.metadata.name, isSafe, context),
              context.timeoutMs,
            );
          }
          return this.callWithRetry(callFn, tool.metadata.name, isSafe, context);
        },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger?.warn("tool.call.failure", { tool: toolName, callId, error });
      throw err;
    }

    // --- Output Truncation ---
    if (result.data) {
      const serialized = JSON.stringify(result.data);
      if (serialized.length > tool.metadata.maxOutputChars) {
        const originalLength = serialized.length;
        const truncatedStr = serialized.slice(0, tool.metadata.maxOutputChars);
        const overflowDir = join(homedir(), ".pulseed", "tmp");
        mkdirSync(overflowDir, { recursive: true });
        const overflowPath = join(overflowDir, `overflow-${randomUUID()}.json`);
        writeFileSync(overflowPath, serialized, "utf-8");
        result.data = truncatedStr;
        result.summary = `${result.summary} [truncated: ${originalLength - tool.metadata.maxOutputChars} chars omitted]`;
        result.truncated = { originalChars: originalLength, overflowPath };
      }
    }

    logger?.debug("tool.call.success", { tool: toolName, callId, durationMs: Date.now() - startTime });
    return result;
  }

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
    if (tool.metadata.name === "shell" && typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      const cmd = obj["command"];
      if (typeof cmd === "string") {
        const dangerous = ["; rm ", "; curl ", "| bash", "eval ", "$(", "\`", "&&", "||", "> /", ">> ", "\n"];
        for (const pattern of dangerous) {
          if (cmd.includes(pattern)) {
            return `Potentially dangerous shell command detected: "${pattern}"`;
          }
        }
      }
    }

    return null;
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

  /**
   * Retry a tool call for transient network/IO errors.
   * Only retries if the tool is concurrency-safe (idempotent).
   * Backoff: 500ms, 1000ms.
   */
  private async callWithRetry(
    fn: () => Promise<ToolResult>,
    toolName: string,
    isSafe: boolean,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const TRANSIENT_PATTERNS = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "fetch failed",
      "socket hang up",
    ];
    const BACKOFFS = [500, 1000];

    const isTransient = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
    };

    const attempts = isSafe ? BACKOFFS.length + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isSafe || !isTransient(err) || attempt >= BACKOFFS.length) {
          const errMsg = err instanceof Error ? err.message : String(err);
          context.logger?.warn("tool.call.failure", { tool: toolName, callId: context.callId, error: errMsg });
          return {
            success: false,
            data: null,
            summary: `Tool ${toolName} failed: ${errMsg}`,
            error: errMsg,
            durationMs: 0,
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, BACKOFFS[attempt]));
      }
    }

    const exhaustedMsg = `Tool ${toolName} failed after retries`;
    context.logger?.warn("tool.call.failure", { tool: toolName, callId: context.callId, error: exhaustedMsg });
    return {
      success: false,
      data: null,
      summary: exhaustedMsg,
      error: exhaustedMsg,
      durationMs: 0,
    };
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
}
