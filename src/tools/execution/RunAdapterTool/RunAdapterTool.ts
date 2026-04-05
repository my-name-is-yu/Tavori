import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { AdapterRegistry, AgentTask } from "../../../orchestrator/execution/adapter-layer.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const RunAdapterInputSchema = z.object({
  adapter_id: z.string().min(1, "adapter_id is required"),
  task_description: z.string().min(1, "task_description is required"),
  goal_id: z.string().optional(),
});
export type RunAdapterInput = z.infer<typeof RunAdapterInputSchema>;

export class RunAdapterTool implements ITool<RunAdapterInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "run-adapter",
    aliases: ["execute_adapter"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RunAdapterInputSchema;

  constructor(private readonly adapterRegistry: AdapterRegistry) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: RunAdapterInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const adapter = this.adapterRegistry.getAdapter(input.adapter_id);
      const task: AgentTask = {
        prompt: input.task_description,
        timeout_ms: 60_000,
        adapter_type: input.adapter_id,
      };
      const result = await adapter.execute(task);
      return {
        success: result.success,
        data: result,
        summary: result.success
          ? `Adapter ${input.adapter_id} completed in ${result.elapsed_ms}ms`
          : `Adapter ${input.adapter_id} failed: ${result.error ?? "unknown error"}`,
        error: result.success ? undefined : (result.error ?? undefined),
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "RunAdapterTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: RunAdapterInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "RunAdapterTool executes an external agent process and requires approval." };
  }

  isConcurrencySafe(_input: RunAdapterInput): boolean {
    return false;
  }
}
