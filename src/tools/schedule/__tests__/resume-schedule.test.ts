import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResumeScheduleInputSchema,
  ResumeScheduleTool,
  type ResumeScheduleOutput,
} from "../ResumeScheduleTool/ResumeScheduleTool.js";
import type { ToolCallContext } from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
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
    enabled: false,
    heartbeat: undefined,
    probe: undefined,
    cron: {
      prompt_template: "Summarize daily changes.",
      context_sources: ["memory://daily"],
      output_format: "notification",
      max_tokens: 1200,
    },
    goal_trigger: undefined,
    escalation: undefined,
    baseline_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-01-02T09:00:00.000Z",
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

describe("ResumeScheduleTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: ResumeScheduleTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
      updateEntry: vi.fn(),
    } as unknown as ScheduleEngine;
    tool = new ResumeScheduleTool(scheduleEngine);
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("resume_schedule");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("automation");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("Re-enable");
  });

  it("checkPermissions returns needs_approval when not pre-approved", async () => {
    const result = await tool.checkPermissions(
      ResumeScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      makeContext(),
    );

    expect(result.status).toBe("needs_approval");
  });

  it("checkPermissions returns allowed when pre-approved", async () => {
    const result = await tool.checkPermissions(
      ResumeScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns false", () => {
    expect(
      tool.isConcurrencySafe(
        ResumeScheduleInputSchema.parse({
          schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ),
    ).toBe(false);
  });

  it("resolves a unique prefix and resumes the canonical schedule id without prompting again", async () => {
    const entry = makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      name: "Morning digest",
      enabled: true,
      next_fire_at: "2026-01-03T09:00:00.000Z",
    });
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ]);
    vi.mocked(scheduleEngine.updateEntry).mockResolvedValue(entry);
    const approvalFn = vi.fn().mockResolvedValue(false);

    const result = await tool.call(
      ResumeScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa",
      }),
      makeContext({ approvalFn }),
    );

    expect(approvalFn).not.toHaveBeenCalled();
    expect(scheduleEngine.updateEntry).toHaveBeenCalledTimes(1);
    expect(scheduleEngine.updateEntry).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { enabled: true },
    );
    expect(result.success).toBe(true);
    expect((result.data as ResumeScheduleOutput).entry).toEqual(entry);
    expect(((result.data as ResumeScheduleOutput).entry.next_fire_at)).toBe("2026-01-03T09:00:00.000Z");
  });

  it("returns failure when the schedule id prefix is ambiguous", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("eeee0000-0000-4000-8000-000000000000"),
      makeEntry("eeee1111-1111-4111-8111-111111111111"),
    ]);

    const result = await tool.call(
      ResumeScheduleInputSchema.parse({
        schedule_id: "eeee",
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
      ResumeScheduleInputSchema.parse({
        schedule_id: "missing",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });
});
