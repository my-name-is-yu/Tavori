import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListSchedulesTool } from "../ListSchedulesTool/ListSchedulesTool.js";
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

describe("ListSchedulesTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: ListSchedulesTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
      getDueEntries: vi.fn().mockResolvedValue([]),
    } as unknown as ScheduleEngine;
    tool = new ListSchedulesTool(scheduleEngine);
  });

  it("returns metadata with schedule tags", () => {
    expect(tool.metadata.name).toBe("list_schedules");
    expect(tool.metadata.tags).toContain("schedule");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("schedule");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ due_only: false }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ due_only: false })).toBe(true);
  });

  it("returns filtered schedule summaries from getEntries", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("11111111-1111-1111-1111-111111111111"),
      makeEntry("22222222-2222-2222-2222-222222222222", {
        layer: "probe",
        enabled: false,
        trigger: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        probe: {
          data_source_id: "source-1",
          query_params: {},
          change_detector: { mode: "diff", baseline_window: 5 },
          llm_on_change: true,
        },
        heartbeat: undefined,
      }),
    ]);

    const result = await tool.call(
      { layer: "probe", enabled: false, due_only: false },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(scheduleEngine.getEntries).toHaveBeenCalledTimes(1);
    expect(scheduleEngine.getDueEntries).not.toHaveBeenCalled();

    const data = result.data as {
      entries: Array<{ id: string; trigger_type: string; enabled: boolean }>;
    };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({
      id: "22222222-2222-2222-2222-222222222222",
      trigger_type: "cron",
      enabled: false,
    });
  });

  it("uses getDueEntries when due_only is true", async () => {
    vi.mocked(scheduleEngine.getDueEntries).mockResolvedValue([
      makeEntry("33333333-3333-3333-3333-333333333333", {
        last_fired_at: "2026-01-01T00:30:00.000Z",
      }),
    ]);

    const result = await tool.call({ due_only: true }, makeContext());

    expect(result.success).toBe(true);
    expect(scheduleEngine.getDueEntries).toHaveBeenCalledTimes(1);
    expect(scheduleEngine.getEntries).not.toHaveBeenCalled();

    const data = result.data as {
      entries: Array<{ id: string; last_fired_at: string | null }>;
    };
    expect(data.entries[0]?.id).toBe("33333333-3333-3333-3333-333333333333");
    expect(data.entries[0]?.last_fired_at).toBe("2026-01-01T00:30:00.000Z");
  });

  it("returns an empty result when nothing matches", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("44444444-4444-4444-4444-444444444444", { layer: "cron" }),
    ]);

    const result = await tool.call({ layer: "probe", due_only: false }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as { entries: unknown[] };
    expect(data.entries).toHaveLength(0);
    expect(result.summary).toContain("No schedule entries");
  });

  it("handles schedule engine errors gracefully", async () => {
    vi.mocked(scheduleEngine.getDueEntries).mockRejectedValue(new Error("engine unavailable"));

    const result = await tool.call({ due_only: true }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("engine unavailable");
  });
});
