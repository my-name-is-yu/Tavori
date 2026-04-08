import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import {
  ScheduleEngine,
  type ScheduleEntryUpdateInput,
} from "../../../runtime/schedule-engine.js";
import {
  CronConfigSchema,
  EscalationConfigSchema,
  GoalTriggerConfigSchema,
  HeartbeatConfigSchema,
  ProbeConfigSchema,
  ScheduleTriggerSchema,
  type ScheduleEntry,
} from "../../../runtime/types/schedule.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

const hasAtLeastOnePatchField = (
  input: z.infer<typeof UpdateScheduleInputSchemaBase>,
): boolean =>
  input.name !== undefined ||
  input.enabled !== undefined ||
  input.trigger !== undefined ||
  input.heartbeat !== undefined ||
  input.probe !== undefined ||
  input.cron !== undefined ||
  input.goal_trigger !== undefined ||
  input.escalation !== undefined;

const UpdateScheduleInputSchemaBase = z.object({
  schedule_id: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  trigger: ScheduleTriggerSchema.optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
  probe: ProbeConfigSchema.optional(),
  cron: CronConfigSchema.optional(),
  goal_trigger: GoalTriggerConfigSchema.optional(),
  escalation: EscalationConfigSchema.nullish(),
});

export const UpdateScheduleInputSchema = UpdateScheduleInputSchemaBase.refine(
  hasAtLeastOnePatchField,
  {
    message: "At least one patch field must be provided",
  },
);

export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;

export interface UpdateScheduleOutput {
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

export class UpdateScheduleTool implements ITool<UpdateScheduleInput, UpdateScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "update_schedule",
    aliases: ["edit_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = UpdateScheduleInputSchema;

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: UpdateScheduleInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      if (!context.preApproved) {
        const approved = await context.approvalFn({
          toolName: this.metadata.name,
          input,
          reason: `Update schedule: ${input.schedule_id}`,
          permissionLevel: "write_local",
          isDestructive: false,
          reversibility: "reversible",
        });
        if (!approved) {
          return {
            success: false,
            data: null,
            summary: "Schedule update denied by user",
            error: "User denied schedule update",
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

      const patch: ScheduleEntryUpdateInput = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.trigger !== undefined) patch.trigger = input.trigger;
      if (input.heartbeat !== undefined) patch.heartbeat = input.heartbeat;
      if (input.probe !== undefined) patch.probe = input.probe;
      if (input.cron !== undefined) patch.cron = input.cron;
      if (input.goal_trigger !== undefined) patch.goal_trigger = input.goal_trigger;
      if (input.escalation !== undefined) patch.escalation = input.escalation;

      const entry = await this.scheduleEngine.updateEntry(existingEntry.id, patch);
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
        summary: `Updated schedule: ${entry.name} (${entry.layer})`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `UpdateScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: UpdateScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Updating a persistent schedule changes background automation and requires approval",
    };
  }

  isConcurrencySafe(_input: UpdateScheduleInput): boolean {
    return false;
  }
}
