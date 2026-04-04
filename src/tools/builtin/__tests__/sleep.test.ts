import { describe, it, expect, beforeEach, vi } from "vitest";
import { SleepTool } from "../sleep.js";
import type { ToolCallContext } from "../../types.js";

const makeContext = (overrides?: Partial<ToolCallContext>): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "g1",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => false,
  ...overrides,
});

describe("SleepTool", () => {
  let tool: SleepTool;

  beforeEach(() => {
    tool = new SleepTool();
  });

  it("sleeps for specified duration", async () => {
    const durationMs = 100;
    const result = await tool.call({ durationMs }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { sleptMs: number };
    expect(data.sleptMs).toBeGreaterThanOrEqual(durationMs - 5); // timer precision tolerance
    expect(data.sleptMs).toBeLessThan(durationMs + 50);
  });

  it("caps at max duration (300000ms)", () => {
    const input = { durationMs: 300001 };
    expect(() => {
      SleepInputSchema.parse(input);
    }).toThrow();
  });

  it("rejects duration under 100ms", () => {
    const input = { durationMs: 50 };
    expect(() => {
      SleepInputSchema.parse(input);
    }).toThrow();
  });

  it("includes reason in summary when provided", async () => {
    const result = await tool.call(
      { durationMs: 100, reason: "waiting for build" },
      makeContext(),
    );
    expect(result.success).toBe(true);
    expect(result.summary).toContain("waiting for build");
  });

  it("omits reason from summary when not provided", async () => {
    const result = await tool.call({ durationMs: 100 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.summary).toContain("Slept");
    expect(result.summary).not.toContain("(");
  });

  it("metadata is correct", () => {
    expect(tool.metadata.name).toBe("sleep");
    expect(tool.metadata.permissionLevel).toBe("read_only");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.maxConcurrency).toBe(10);
    expect(tool.metadata.aliases).toEqual(expect.arrayContaining(["wait", "pause"]));
    expect(tool.metadata.tags).toEqual(expect.arrayContaining(["utility", "wait", "polling"]));
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ durationMs: 100 }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ durationMs: 100 })).toBe(true);
  });

  it("logs sleep start when logger provided", async () => {
    const mockLogger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const context = makeContext({ logger: mockLogger });

    await tool.call({ durationMs: 100, reason: "test poll" }, context);

    expect(mockLogger.debug).toHaveBeenCalledWith("sleep.start", {
      durationMs: 100,
      reason: "test poll",
    });
  });

  it("handles multiple concurrent sleeps", async () => {
    const start = Date.now();
    await Promise.all([
      tool.call({ durationMs: 100 }, makeContext()),
      tool.call({ durationMs: 100 }, makeContext()),
      tool.call({ durationMs: 100 }, makeContext()),
    ]);
    const elapsed = Date.now() - start;
    // All sleeps happen concurrently, so total time should be ~100ms, not 300ms
    expect(elapsed).toBeLessThan(200);
  });
});

import { SleepInputSchema } from "../sleep.js";
