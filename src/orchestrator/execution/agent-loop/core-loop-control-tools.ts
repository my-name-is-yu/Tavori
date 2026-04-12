import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../../tools/types.js";

export interface CoreLoopControlToolset {
  goalStatus(input: { goalId: string }): Promise<unknown>;
  goalCreate?(input: { description: string }): Promise<unknown>;
  goalPause?(input: { goalId: string }): Promise<unknown>;
  goalResume?(input: { goalId: string }): Promise<unknown>;
  goalCancel?(input: { goalId: string }): Promise<unknown>;
  taskStatus?(input: { goalId: string; taskId?: string }): Promise<unknown>;
  taskPrioritize?(input: { goalId: string; taskId: string; priority: number }): Promise<unknown>;
  runCycle?(input: { goalId: string; maxIterations?: number }): Promise<unknown>;
}

const schemas = {
  core_goal_status: z.object({ goalId: z.string().min(1) }),
  core_goal_create: z.object({ description: z.string().min(1) }),
  core_goal_pause: z.object({ goalId: z.string().min(1) }),
  core_goal_resume: z.object({ goalId: z.string().min(1) }),
  core_goal_cancel: z.object({ goalId: z.string().min(1) }),
  core_task_status: z.object({ goalId: z.string().min(1), taskId: z.string().optional() }),
  core_task_prioritize: z.object({ goalId: z.string().min(1), taskId: z.string().min(1), priority: z.number() }),
  core_run_cycle: z.object({ goalId: z.string().min(1), maxIterations: z.number().int().positive().optional() }),
};

type CoreToolName = keyof typeof schemas;

export function createCoreLoopControlTools(service: CoreLoopControlToolset): ITool[] {
  return [
    new CoreLoopControlTool("core_goal_status", "Read CoreLoop goal status.", "read_only", (input) => service.goalStatus(input), schemas.core_goal_status),
    new CoreLoopControlTool("core_goal_create", "Create a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalCreate, "goalCreate")(input), schemas.core_goal_create),
    new CoreLoopControlTool("core_goal_pause", "Pause a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalPause, "goalPause")(input), schemas.core_goal_pause),
    new CoreLoopControlTool("core_goal_resume", "Resume a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalResume, "goalResume")(input), schemas.core_goal_resume),
    new CoreLoopControlTool("core_goal_cancel", "Cancel a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalCancel, "goalCancel")(input), schemas.core_goal_cancel),
    new CoreLoopControlTool("core_task_status", "Read CoreLoop task status.", "read_only", (input) => requireHandler(service.taskStatus, "taskStatus")(input), schemas.core_task_status),
    new CoreLoopControlTool("core_task_prioritize", "Set CoreLoop task priority.", "write_local", (input) => requireHandler(service.taskPrioritize, "taskPrioritize")(input), schemas.core_task_prioritize),
    new CoreLoopControlTool("core_run_cycle", "Run one bounded CoreLoop cycle.", "write_local", (input) => requireHandler(service.runCycle, "runCycle")(input), schemas.core_run_cycle),
  ];
}

class CoreLoopControlTool<TInput> implements ITool<TInput> {
  readonly metadata: ToolMetadata;

  constructor(
    name: CoreToolName,
    private readonly toolDescription: string,
    permissionLevel: ToolMetadata["permissionLevel"],
    private readonly handler: (input: TInput) => Promise<unknown>,
    readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>,
  ) {
    this.metadata = {
      name,
      aliases: [],
      permissionLevel,
      isReadOnly: permissionLevel === "read_only",
      isDestructive: name === "core_goal_cancel",
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: permissionLevel === "read_only" ? 0 : 1,
      maxOutputChars: 8000,
      tags: ["agentloop", "coreloop"],
    };
  }

  description(): string {
    return this.toolDescription;
  }

  async call(input: TInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.handler(input);
      return {
        success: true,
        data,
        summary: `${this.metadata.name} completed`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `${this.metadata.name} failed`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(_input: TInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (this.metadata.isReadOnly) return { status: "allowed" };
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: `${this.metadata.name} changes CoreLoop state` };
  }

  isConcurrencySafe(_input: TInput): boolean {
    return this.metadata.isReadOnly;
  }
}

function requireHandler<TInput>(handler: ((input: TInput) => Promise<unknown>) | undefined, name: string): (input: TInput) => Promise<unknown> {
  if (!handler) {
    return async () => {
      throw new Error(`CoreLoop control handler is not configured: ${name}`);
    };
  }
  return handler;
}
