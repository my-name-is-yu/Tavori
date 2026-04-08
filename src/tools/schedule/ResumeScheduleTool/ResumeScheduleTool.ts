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

export const ResumeScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
});
export type ResumeScheduleInput = z.infer<typeof ResumeScheduleInputSchema>;

export interface ResumeScheduleOutput {
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

export class ResumeScheduleTool implements ITool<ResumeScheduleInput, ResumeScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "resume_schedule",
    aliases: ["enable_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = ResumeScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ResumeScheduleInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
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

      const entry = await this.scheduleEngine.updateEntry(existingEntry.id, { enabled: true });
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
        summary: `Resumed schedule: ${entry.name}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `ResumeScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: ResumeScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Resuming a persistent schedule changes background automation and requires approval",
    };
  }

  isConcurrencySafe(_input: ResumeScheduleInput): boolean {
    return false;
  }
}
