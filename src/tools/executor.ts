// src/tools/executor.ts

import * as path from "node:path";
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

    // --- Output Truncation ---
    if (result.data) {
      const serialized = JSON.stringify(result.data);
      if (serialized.length > tool.metadata.maxOutputChars) {
        const truncated = serialized.slice(0, tool.metadata.maxOutputChars);
        result.data = truncated;
        result.summary = `${result.summary} [truncated: ${serialized.length - tool.metadata.maxOutputChars} chars omitted]`;
      }
    }

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

    if (tool.metadata.name === "shell" && typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      const cmd = obj["command"];
      if (typeof cmd === "string") {
        const dangerous = ["; rm ", "; curl ", "| bash", "eval ", "$(", "\`"];
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
}
