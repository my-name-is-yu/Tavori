import { describe, it, expect, vi } from "vitest";
import {
  CreateScheduleTool,
  CreateScheduleInputSchema,
  type CreateScheduleOutput,
} from "../CreateScheduleTool/CreateScheduleTool.js";
import type { ToolCallContext } from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { ScheduleEntrySchema } from "../../../runtime/types/schedule.js";

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

function makeScheduleEntry() {
  return ScheduleEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "daily digest",
    layer: "cron",
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    enabled: true,
    cron: {
      prompt_template: "Summarize the latest activity.",
      context_sources: ["memory://daily"],
      output_format: "notification",
      max_tokens: 1200,
    },
    escalation: {
      enabled: true,
      target_layer: "goal_trigger",
      target_entry_id: "22222222-2222-4222-8222-222222222222",
      cooldown_minutes: 15,
      max_per_hour: 4,
      circuit_breaker_threshold: 10,
    },
    baseline_results: [],
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-04-09T09:00:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
  });
}

describe("CreateScheduleTool", () => {
  it("has correct metadata", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);

    expect(tool.metadata.name).toBe("create_schedule");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("schedule");
  });

  it("description returns non-empty string", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);

    expect(tool.description()).toBeTruthy();
  });

  it("checkPermissions returns needs_approval", async () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      name: "heartbeat check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 30 },
      heartbeat: {
        check_type: "http",
        check_config: { url: "https://example.com/health" },
      },
    });

    const result = await tool.checkPermissions(input, makeContext());

    expect(result.status).toBe("needs_approval");
    if (result.status === "needs_approval") {
      expect(result.reason).toContain("persistent schedule");
    }
  });

  it("isConcurrencySafe returns false", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      name: "probe watcher",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      probe: {
        data_source_id: "source-1",
        query_params: {},
        change_detector: { mode: "presence", baseline_window: 5 },
      },
    });

    expect(tool.isConcurrencySafe(input)).toBe(false);
  });

  it("applies enabled=true by default at schema level", () => {
    const parsed = CreateScheduleInputSchema.parse({
      name: "daily digest",
      layer: "cron",
      trigger: { type: "cron", expression: "0 9 * * *" },
      cron: {
        prompt_template: "Summarize the latest activity.",
      },
    });

    expect(parsed.enabled).toBe(true);
  });

  it("rejects mismatched layer and config at schema level", () => {
    const parsed = CreateScheduleInputSchema.safeParse({
      name: "bad input",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 15 },
      probe: {
        data_source_id: "source-1",
        query_params: {},
        change_detector: { mode: "presence", baseline_window: 5 },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("calls scheduleEngine.addEntry with the validated input and returns the entry", async () => {
    const entry = makeScheduleEntry();
    const addEntry = vi.fn().mockResolvedValue(entry);
    const tool = new CreateScheduleTool({ addEntry } as unknown as ScheduleEngine);
    const approvalFn = vi.fn().mockResolvedValue(false);
    const input = CreateScheduleInputSchema.parse({
      name: "daily digest",
      layer: "cron",
      trigger: { type: "cron", expression: "0 9 * * *" },
      cron: {
        prompt_template: "Summarize the latest activity.",
        context_sources: ["memory://daily"],
        output_format: "notification",
        max_tokens: 1200,
      },
      escalation: {
        enabled: true,
        target_layer: "goal_trigger",
        target_entry_id: "22222222-2222-4222-8222-222222222222",
      },
    });

    const result = await tool.call(input, makeContext({ approvalFn }));

    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith(input);
    expect(approvalFn).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.summary).toContain("daily digest");
    expect((result.data as CreateScheduleOutput).entry).toEqual(entry);
  });

  it("returns a failure result when scheduleEngine.addEntry throws", async () => {
    const addEntry = vi.fn().mockRejectedValue(new Error("disk full"));
    const tool = new CreateScheduleTool({ addEntry } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      name: "goal resume",
      layer: "goal_trigger",
      trigger: { type: "interval", seconds: 300 },
      enabled: false,
      goal_trigger: {
        goal_id: "goal-123",
        max_iterations: 3,
        skip_if_active: true,
      },
    });

    const result = await tool.call(input, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk full");
    expect(result.summary).toContain("disk full");
  });
});
