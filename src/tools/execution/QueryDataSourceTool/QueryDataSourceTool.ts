import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const QueryDataSourceInputSchema = z.object({
  goal_id: z.string().min(1, "goal_id is required"),
  dimension_name: z.string().min(1, "dimension_name is required"),
  source_id: z.string().min(1, "source_id is required"),
});
export type QueryDataSourceInput = z.infer<typeof QueryDataSourceInputSchema>;

export class QueryDataSourceTool implements ITool<QueryDataSourceInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "query-data-source",
    aliases: ["observe_datasource"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = QueryDataSourceInputSchema;

  constructor(private readonly observationEngine: ObservationEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: QueryDataSourceInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const entry = await this.observationEngine.observeFromDataSource(
        input.goal_id,
        input.dimension_name,
        input.source_id
      );
      return {
        success: true,
        data: entry,
        summary: `Observed dimension "${input.dimension_name}" from source "${input.source_id}"`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "QueryDataSourceTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: QueryDataSourceInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: QueryDataSourceInput): boolean {
    return true;
  }
}
