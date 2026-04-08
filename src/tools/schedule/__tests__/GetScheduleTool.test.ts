import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetScheduleTool } from "../GetScheduleTool/GetScheduleTool.js";
import type { ToolCallContext } from "../../types.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
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
      check_config: { url: "https://example.com" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    probe: undefined,
    escalation: undefined,
    baseline_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-01-01T01:00:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    cron: undefined,
    goal_trigger: undefined,
    ...overrides,
  };
}

describe("GetScheduleTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: GetScheduleTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
    } as unknown as ScheduleEngine;
    tool = new GetScheduleTool(scheduleEngine);
  });

  it("returns metadata with schedule tags", () => {
    expect(tool.metadata.name).toBe("get_schedule");
    expect(tool.metadata.tags).toContain("schedule");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("schedule");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ schedule_id: "abc" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ schedule_id: "abc" })).toBe(true);
  });

  it("returns the full entry for an exact id match", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        layer: "cron",
        trigger: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        cron: {
          prompt_template: "Summarize status",
          context_sources: ["notes"],
          output_format: "report",
          max_tokens: 2000,
        },
        heartbeat: undefined,
      }),
    ]);

    const result = await tool.call(
      { schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { entry: ScheduleEntry };
    expect(data.entry.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(data.entry.layer).toBe("cron");
  });

  it("resolves a unique id prefix", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      makeEntry("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    ]);

    const result = await tool.call({ schedule_id: "bbbbbbbb" }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as { entry: ScheduleEntry };
    expect(data.entry.id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("returns failure when the schedule is missing", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ]);

    const result = await tool.call({ schedule_id: "missing" }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("returns failure when the schedule id prefix is ambiguous", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("eeee0000-0000-4000-8000-000000000000"),
      makeEntry("eeee1111-1111-4111-8111-111111111111"),
    ]);

    const result = await tool.call({ schedule_id: "eeee" }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("ambiguous");
  });

  it("handles schedule engine errors gracefully", async () => {
    vi.mocked(scheduleEngine.getEntries).mockImplementation(() => {
      throw new Error("engine unavailable");
    });

    const result = await tool.call({ schedule_id: "abc" }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("engine unavailable");
  });
});
