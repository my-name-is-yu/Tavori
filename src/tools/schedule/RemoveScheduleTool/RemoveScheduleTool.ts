import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const RemoveScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
});
export type RemoveScheduleInput = z.infer<typeof RemoveScheduleInputSchema>;

export interface RemoveScheduleOutput {
  removed: true;
  entry: {
    id: string;
    name: string;
  };
}

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

export class RemoveScheduleTool implements ITool<RemoveScheduleInput, RemoveScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "remove_schedule",
    aliases: ["delete_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: true,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = RemoveScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: RemoveScheduleInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      if (!context.preApproved) {
        const approved = await context.approvalFn({
          toolName: this.metadata.name,
          input,
          reason: `Remove schedule: ${input.schedule_id}. This cannot be undone.`,
          permissionLevel: "write_local",
          isDestructive: true,
          reversibility: "irreversible",
        });
        if (!approved) {
          return {
            success: false,
            data: null,
            summary: "Schedule removal denied by user",
            error: "User denied schedule removal",
            durationMs: Date.now() - startTime,
          };
        }
      }

      const existingEntry = resolveScheduleEntry(this.scheduleEngine.getEntries(), input.schedule_id);
      if (!existingEntry) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      const removed = await this.scheduleEngine.removeEntry(existingEntry.id);
      if (!removed) {
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
        data: {
          removed: true,
          entry: {
            id: existingEntry.id,
            name: existingEntry.name,
          },
        },
        summary: `Removed schedule: ${existingEntry.name}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `RemoveScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: RemoveScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Removing a persistent schedule is irreversible and requires approval",
    };
  }

  isConcurrencySafe(_input: RemoveScheduleInput): boolean {
    return false;
  }
}
