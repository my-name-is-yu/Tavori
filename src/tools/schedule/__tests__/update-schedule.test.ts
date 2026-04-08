import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UpdateScheduleInputSchema,
  UpdateScheduleTool,
  type UpdateScheduleOutput,
} from "../UpdateScheduleTool/UpdateScheduleTool.js";
import type { ToolCallContext } from "../../types.js";
import type {
  ScheduleEngine,
  ScheduleEntryUpdateInput,
} from "../../../runtime/schedule-engine.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    ...overrides,
  };
}

function makeEntry(
  id: string,
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return {
    id,
    name: `Schedule ${id}`,
    layer: "cron",
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    enabled: true,
    heartbeat: undefined,
    probe: undefined,
    cron: {
      prompt_template: "Summarize daily changes.",
      context_sources: ["memory://daily"],
      output_format: "notification",
      max_tokens: 1200,
    },
    goal_trigger: undefined,
    escalation: {
      enabled: true,
      target_layer: "goal_trigger",
      target_entry_id: "99999999-9999-4999-8999-999999999999",
      cooldown_minutes: 15,
      max_per_hour: 4,
      circuit_breaker_threshold: 10,
    },
    baseline_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-01-01T09:00:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    ...overrides,
  };
}

describe("UpdateScheduleTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: UpdateScheduleTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
      updateEntry: vi.fn(),
    } as unknown as ScheduleEngine;
    tool = new UpdateScheduleTool(scheduleEngine);
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("update_schedule");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("schedule");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("schedule");
  });

  it("requires at least one patch field", () => {
    const parsed = UpdateScheduleInputSchema.safeParse({
      schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts escalation=null as a valid patch", () => {
    const parsed = UpdateScheduleInputSchema.parse({
      schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      escalation: null,
    });

    expect(parsed.escalation).toBeNull();
  });

  it("checkPermissions returns needs_approval when not pre-approved", async () => {
    const result = await tool.checkPermissions(
      UpdateScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        enabled: false,
      }),
      makeContext(),
    );

    expect(result.status).toBe("needs_approval");
    if (result.status === "needs_approval") {
      expect(result.reason).toContain("background automation");
    }
  });

  it("checkPermissions returns allowed when pre-approved", async () => {
    const result = await tool.checkPermissions(
      UpdateScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        enabled: false,
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns false", () => {
    expect(
      tool.isConcurrencySafe(
        UpdateScheduleInputSchema.parse({
          schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          enabled: false,
        }),
      ),
    ).toBe(false);
  });

  it("resolves a unique prefix and passes the patch to updateEntry without prompting again", async () => {
    const entry = makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      name: "Morning digest",
      enabled: false,
      escalation: undefined,
    });
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      entry,
      makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ]);
    vi.mocked(scheduleEngine.updateEntry).mockResolvedValue(entry);
    const approvalFn = vi.fn().mockResolvedValue(false);
    const input = UpdateScheduleInputSchema.parse({
      schedule_id: "aaaaaaaa",
      name: "Morning digest",
      enabled: false,
      trigger: { type: "interval", seconds: 300 },
      cron: {
        prompt_template: "Summarize the latest activity.",
        context_sources: ["memory://daily"],
        output_format: "report",
        max_tokens: 2000,
      },
      escalation: null,
    });

    const result = await tool.call(input, makeContext({ approvalFn }));

    expect(approvalFn).not.toHaveBeenCalled();
    expect(scheduleEngine.updateEntry).toHaveBeenCalledTimes(1);
    expect(scheduleEngine.updateEntry).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {
        name: "Morning digest",
        enabled: false,
        trigger: { type: "interval", seconds: 300, jitter_factor: 0 },
        cron: {
          prompt_template: "Summarize the latest activity.",
          context_sources: ["memory://daily"],
          output_format: "report",
          max_tokens: 2000,
        },
        escalation: null,
      } satisfies ScheduleEntryUpdateInput,
    );
    expect(result.success).toBe(true);
    expect((result.data as UpdateScheduleOutput).entry).toEqual(entry);
  });

  it("returns failure when the schedule id prefix is ambiguous", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("eeee0000-0000-4000-8000-000000000000"),
      makeEntry("eeee1111-1111-4111-8111-111111111111"),
    ]);

    const result = await tool.call(
      UpdateScheduleInputSchema.parse({
        schedule_id: "eeee",
        enabled: false,
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("ambiguous");
  });

  it("returns failure when the schedule is missing", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ]);

    const result = await tool.call(
      UpdateScheduleInputSchema.parse({
        schedule_id: "missing",
        enabled: false,
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("surfaces updateEntry errors cleanly", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ]);
    vi.mocked(scheduleEngine.updateEntry).mockRejectedValue(new Error("invalid merged entry"));

    const result = await tool.call(
      UpdateScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa",
        enabled: false,
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid merged entry");
  });
});
