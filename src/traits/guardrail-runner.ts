import type { Logger } from "../runtime/logger.js";
import type {
  IGuardrailHook,
  GuardrailCheckpoint,
  GuardrailContext,
  GuardrailAggregateResult,
} from "../types/guardrail.js";

// ─── GuardrailRunner ───

/**
 * Manages guardrail hook registration and execution at 4 checkpoints:
 * before_model, after_model, before_tool, after_tool.
 *
 * Hooks run in priority order (lower number = runs first).
 * A critical block stops execution immediately.
 */
export class GuardrailRunner {
  private hooks: IGuardrailHook[] = [];
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /** Register a hook. Hooks are kept sorted by priority ascending. */
  register(hook: IGuardrailHook): void {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => a.priority - b.priority);
    this.logger?.info(`[guardrail] registered hook: ${hook.name} @ ${hook.checkpoint} (priority ${hook.priority})`);
  }

  /** Remove a hook by name. */
  unregister(name: string): void {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((h) => h.name !== name);
    if (this.hooks.length < before) {
      this.logger?.info(`[guardrail] unregistered hook: ${name}`);
    }
  }

  /** Return all hooks registered for a given checkpoint. */
  getHooks(checkpoint: GuardrailCheckpoint): IGuardrailHook[] {
    return this.hooks.filter((h) => h.checkpoint === checkpoint);
  }

  /**
   * Run all hooks for the given checkpoint in priority order.
   *
   * - A hook returning allowed=false with severity="critical" stops execution immediately.
   * - modified_input from the last hook that set it is forwarded in the aggregate result.
   * - Overall allowed=true only when every hook allows.
   */
  async run(
    checkpoint: GuardrailCheckpoint,
    context: GuardrailContext
  ): Promise<GuardrailAggregateResult> {
    const applicable = this.getHooks(checkpoint);
    const results = [];
    let overallAllowed = true;
    let modifiedInput: unknown = undefined;

    for (const hook of applicable) {
      let result;
      try {
        result = await hook.execute(context);
      } catch (err) {
        this.logger?.error(`[guardrail] hook ${hook.name} threw: ${String(err)}`);
        result = {
          hook_name: hook.name,
          checkpoint,
          allowed: false,
          severity: "critical" as const,
          reason: `Hook threw an unexpected error: ${String(err)}`,
        };
      }

      results.push(result);

      if (!result.allowed) {
        overallAllowed = false;
      }

      if (result.modified_input !== undefined) {
        modifiedInput = result.modified_input;
        context = { ...context, input: modifiedInput };
      }

      // Critical block: stop immediately
      if (!result.allowed && result.severity === "critical") {
        this.logger?.warn(
          `[guardrail] critical block from hook "${hook.name}" at ${checkpoint}: ${result.reason ?? "(no reason)"}`
        );
        break;
      }
    }

    return {
      allowed: overallAllowed,
      results,
      ...(modifiedInput !== undefined ? { modified_input: modifiedInput } : {}),
    };
  }
}
