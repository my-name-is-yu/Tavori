import type { ITool, ToolResult } from "./types.js";

/**
 * Concurrency controller for tool execution.
 *
 * 1. Concurrency safety is INPUT-DEPENDENT, not tool-dependent.
 * 2. Maximum 10 concurrent tool calls (configurable).
 * 3. Sibling abort: for Shell tools, a new invocation can abort a prior one
 *    if both target the same working directory.
 */
export class ConcurrencyController {
  private activeCount = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<{ resolve: () => void }> = [];
  private activeShells: Map<string, AbortController> = new Map();

  constructor(maxConcurrent: number = 10) {
    this.maxConcurrent = maxConcurrent;
  }

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

    let shellAbortController: AbortController | undefined;
    if (tool.metadata.name === "shell") {
      const cwd = (input as Record<string, unknown>)["cwd"] as string ?? ".";
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
        const cwd = (input as Record<string, unknown>)["cwd"] as string ?? ".";
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
