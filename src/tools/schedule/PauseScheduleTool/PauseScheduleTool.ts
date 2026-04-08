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

export const PauseScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
});
export type PauseScheduleInput = z.infer<typeof PauseScheduleInputSchema>;

export interface PauseScheduleOutput {
  entry: ScheduleEntry;
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

export class PauseScheduleTool implements ITool<PauseScheduleInput, PauseScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "pause_schedule",
    aliases: ["disable_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = PauseScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: PauseScheduleInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      if (!context.preApproved) {
        const approved = await context.approvalFn({
          toolName: this.metadata.name,
          input,
          reason: `Pause schedule: ${input.schedule_id}`,
          permissionLevel: "write_local",
          isDestructive: false,
          reversibility: "reversible",
        });
        if (!approved) {
          return {
            success: false,
            data: null,
            summary: "Schedule pause denied by user",
            error: "User denied schedule pause",
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

      const entry = await this.scheduleEngine.updateEntry(existingEntry.id, { enabled: false });
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
        summary: `Paused schedule: ${entry.name}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `PauseScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: PauseScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Pausing a persistent schedule changes background automation and requires approval",
    };
  }

  isConcurrencySafe(_input: PauseScheduleInput): boolean {
    return false;
  }
}
