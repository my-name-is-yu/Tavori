import { describe, it, expect } from "vitest";
import { GoalLoop } from "../../src/orchestrator/goal-loop.js";

describe("GoalLoop guard rails", () => {
  it("stops within 5 iterations with a structured max_iterations stop reason", async () => {
    const loop = new GoalLoop({
      maxIterations: 5,
      maxWallTimeCapSeconds: 120,
      nowMs: () => 0,
    });

    const result = await loop.run(async () => ({ done: false }));

    expect(result.iterations).toBe(5);
    expect(result.stopReason).toEqual({
      code: "max_iterations",
      message: "Goal loop stopped because max iterations were reached.",
      detail: {
        iteration: 5,
        elapsed_ms: 0,
        max_iterations: 5,
        max_wall_time_cap_seconds: 120,
      },
    });
  });

  it("stops at the 120-second wall-time cap with a structured stop reason", async () => {
    let nowMs = 0;
    const loop = new GoalLoop({
      maxIterations: 100,
      maxWallTimeCapSeconds: 120,
      nowMs: () => nowMs,
    });

    const result = await loop.run(async () => {
      nowMs += 30_000;
      return { done: false };
    });

    expect(result.iterations).toBe(4);
    expect(result.elapsedMs).toBe(120_000);
    expect(result.stopReason).toEqual({
      code: "max_wall_time_cap_seconds",
      message: "Goal loop stopped because max wall-time cap was reached.",
      detail: {
        iteration: 4,
        elapsed_ms: 120_000,
        max_iterations: 100,
        max_wall_time_cap_seconds: 120,
      },
    });
  });
});
