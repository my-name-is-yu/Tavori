import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const GetScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
});
export type GetScheduleInput = z.infer<typeof GetScheduleInputSchema>;

function resolveScheduleEntry(entries: ScheduleEntry[], scheduleId: string): ScheduleEntry | null {
  const exact = entries.find((entry) => entry.id === scheduleId);
  if (exact) {
    return exact;
  }

  const matches = entries.filter((entry) => entry.id.startsWith(scheduleId));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Schedule ID prefix is ambiguous: ${scheduleId}`);
  }

  return null;
}

export class GetScheduleTool implements ITool<GetScheduleInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "get_schedule",
    aliases: ["read_schedule", "show_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = GetScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: GetScheduleInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const entry = resolveScheduleEntry(this.scheduleEngine.getEntries(), input.schedule_id);

      if (!entry) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        success: true,
        data: { entry },
        summary: `Schedule ${entry.id}: ${entry.name} (${entry.layer})`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `GetScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: GetScheduleInput,
    _context?: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: GetScheduleInput): boolean {
    return true;
  }
}
