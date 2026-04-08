import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import { ScheduleLayerSchema, type ScheduleEntry } from "../../../runtime/types/schedule.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const ListSchedulesInputSchema = z.object({
  layer: ScheduleLayerSchema.optional(),
  enabled: z.boolean().optional(),
  due_only: z.boolean().default(false),
});
export type ListSchedulesInput = z.infer<typeof ListSchedulesInputSchema>;

type ListScheduleEntrySummary = Pick<
  ScheduleEntry,
  "id" | "name" | "layer" | "enabled" | "next_fire_at" | "last_fired_at"
> & {
  trigger_type: ScheduleEntry["trigger"]["type"];
};

export class ListSchedulesTool implements ITool<ListSchedulesInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "list_schedules",
    aliases: ["get_schedules", "show_schedules"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = ListSchedulesInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ListSchedulesInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const entries = input.due_only
        ? await this.scheduleEngine.getDueEntries()
        : this.scheduleEngine.getEntries();

      const filtered = entries.filter((entry) => {
        if (input.layer && entry.layer !== input.layer) {
          return false;
        }
        if (typeof input.enabled === "boolean" && entry.enabled !== input.enabled) {
          return false;
        }
        return true;
      });

      const data = {
        entries: filtered.map<ListScheduleEntrySummary>((entry) => ({
          id: entry.id,
          name: entry.name,
          layer: entry.layer,
          enabled: entry.enabled,
          trigger_type: entry.trigger.type,
          next_fire_at: entry.next_fire_at,
          last_fired_at: entry.last_fired_at,
        })),
      };

      return {
        success: true,
        data,
        summary:
          filtered.length === 0
            ? "No schedule entries found"
            : `Found ${filtered.length} schedule entr${filtered.length === 1 ? "y" : "ies"}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `ListSchedulesTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: ListSchedulesInput,
    _context?: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: ListSchedulesInput): boolean {
    return true;
  }
}
