import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RemoveScheduleInputSchema,
  RemoveScheduleTool,
  type RemoveScheduleOutput,
} from "../RemoveScheduleTool/RemoveScheduleTool.js";
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
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "http",
      check_config: { url: "https://example.com/health" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    probe: undefined,
    cron: undefined,
    goal_trigger: undefined,
    escalation: undefined,
    baseline_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-01-01T00:01:00.000Z",
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

describe("RemoveScheduleTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: RemoveScheduleTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
      removeEntry: vi.fn(),
    } as unknown as ScheduleEngine;
    tool = new RemoveScheduleTool(scheduleEngine);
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("remove_schedule");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isDestructive).toBe(true);
    expect(tool.metadata.tags).toContain("destructive");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("delete");
  });

  it("checkPermissions returns needs_approval when not pre-approved", async () => {
    const result = await tool.checkPermissions(
      RemoveScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      makeContext(),
    );

    expect(result.status).toBe("needs_approval");
  });

  it("checkPermissions returns allowed when pre-approved", async () => {
    const result = await tool.checkPermissions(
      RemoveScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns false", () => {
    expect(
      tool.isConcurrencySafe(
        RemoveScheduleInputSchema.parse({
          schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ),
    ).toBe(false);
  });

  it("returns failure when the user denies approval", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ]);

    const result = await tool.call(
      RemoveScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa",
      }),
      makeContext({
        approvalFn: vi.fn().mockResolvedValue(false),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("denied");
    expect(scheduleEngine.removeEntry).not.toHaveBeenCalled();
  });

  it("resolves a unique prefix, looks up the name, and removes the canonical id", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { name: "Digest schedule" }),
      makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ]);
    vi.mocked(scheduleEngine.removeEntry).mockResolvedValue(true);

    const result = await tool.call(
      RemoveScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa",
      }),
      makeContext({
        approvalFn: vi.fn().mockResolvedValue(true),
      }),
    );

    expect(scheduleEngine.removeEntry).toHaveBeenCalledTimes(1);
    expect(scheduleEngine.removeEntry).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      removed: true,
      entry: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Digest schedule",
      },
    } satisfies RemoveScheduleOutput);
  });

  it("returns failure when the schedule id prefix is ambiguous", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("eeee0000-0000-4000-8000-000000000000"),
      makeEntry("eeee1111-1111-4111-8111-111111111111"),
    ]);

    const result = await tool.call(
      RemoveScheduleInputSchema.parse({
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
      RemoveScheduleInputSchema.parse({
        schedule_id: "missing",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("returns failure when removeEntry returns false", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ]);
    vi.mocked(scheduleEngine.removeEntry).mockResolvedValue(false);

    const result = await tool.call(
      RemoveScheduleInputSchema.parse({
        schedule_id: "aaaaaaaa",
      }),
      makeContext({ preApproved: true }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("aaaaaaaa");
  });
});
