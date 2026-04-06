import { describe, it, expect } from "vitest";
import { makeEmptyIterationResult } from "../core-loop-types.js";
import type { LoopIterationResult } from "../core-loop-types.js";

describe("LoopIterationResult — wait telemetry fields (Gap 6)", () => {
  it("accepts waitSuppressed field", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 0, {
      waitSuppressed: true,
    });
    expect(result.waitSuppressed).toBe(true);
  });

  it("accepts waitExpired field", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 0, {
      waitExpired: true,
    });
    expect(result.waitExpired).toBe(true);
  });

  it("accepts waitStrategyId field", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 0, {
      waitStrategyId: "strategy-abc",
    });
    expect(result.waitStrategyId).toBe("strategy-abc");
  });

  it("leaves wait fields undefined by default", () => {
    const result = makeEmptyIterationResult("goal-1", 0);
    expect(result.waitSuppressed).toBeUndefined();
    expect(result.waitExpired).toBeUndefined();
    expect(result.waitStrategyId).toBeUndefined();
  });

  it("combines all three wait telemetry fields", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 1, {
      waitSuppressed: false,
      waitExpired: true,
      waitStrategyId: "ws-123",
    });
    expect(result.waitSuppressed).toBe(false);
    expect(result.waitExpired).toBe(true);
    expect(result.waitStrategyId).toBe("ws-123");
  });
});
