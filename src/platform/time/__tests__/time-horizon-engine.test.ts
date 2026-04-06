import { describe, it, expect, beforeEach } from "vitest";
import { TimeHorizonEngine } from "../time-horizon-engine.js";
import type { GapObservation } from "../../../base/types/time-horizon.js";

// Helper: build a history array with evenly-spaced timestamps
// startIso: start time ISO string, gapValues: array of normalizedGap values
// intervalHours: hours between observations
function makeHistory(
  gapValues: number[],
  intervalHours: number,
  startIso?: string
): GapObservation[] {
  const base = startIso ? new Date(startIso).getTime() : Date.now() - gapValues.length * intervalHours * 3_600_000;
  return gapValues.map((normalizedGap, i) => ({
    timestamp: new Date(base + i * intervalHours * 3_600_000).toISOString(),
    normalizedGap,
  }));
}

// A deadline N hours in the future
function deadlineInHours(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

// A start time N hours in the past
function startHoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

// ─── EMA velocity calculation ─────────────────────────────────────────────────

describe("EMA velocity calculation", () => {
  const engine = new TimeHorizonEngine();

  it("basic: steady progress calculates positive velocity", () => {
    // gap drops 0.1 per hour over 5 observations at 1h intervals
    const history = makeHistory([0.5, 0.4, 0.3, 0.2, 0.1], 1);
    const result = engine.evaluatePacing("g1", 0.1, null, history);
    expect(result.velocityPerHour).toBeGreaterThan(0);
    expect(result.velocityPerHour).toBeCloseTo(0.1, 3);
  });

  it("single observation produces zero velocity (no pairs)", () => {
    const history = makeHistory([0.5], 1);
    const result = engine.evaluatePacing("g1", 0.5, null, history);
    expect(result.velocityPerHour).toBe(0);
  });

  it("two observations produce a single point velocity", () => {
    // gap goes from 0.8 to 0.4 in 2 hours → velocity = 0.2/h
    const history = makeHistory([0.8, 0.4], 2);
    const result = engine.evaluatePacing("g1", 0.4, null, history);
    expect(result.velocityPerHour).toBeCloseTo(0.2, 5);
  });

  it("zero elapsed time between observations is skipped", () => {
    const ts = new Date().toISOString();
    const history: GapObservation[] = [
      { timestamp: ts, normalizedGap: 0.8 },
      { timestamp: ts, normalizedGap: 0.6 }, // same timestamp → skip
    ];
    const result = engine.evaluatePacing("g1", 0.6, null, history);
    expect(result.velocityPerHour).toBe(0);
  });

  it("negative velocity (regression) is preserved", () => {
    // gap is increasing
    const history = makeHistory([0.2, 0.3, 0.4, 0.5], 1);
    const result = engine.evaluatePacing("g1", 0.5, null, history);
    expect(result.velocityPerHour).toBeLessThan(0);
  });

  it("EMA weights recent observations more than old ones", () => {
    // First 3 observations: slow (0.01/h), last 3: fast (0.1/h)
    // EMA should reflect the recent fast pace more
    const slow = makeHistory([0.9, 0.89, 0.88], 1);
    const fastBase = new Date(new Date(slow[2].timestamp).getTime() + 3_600_000).getTime();
    const fastPart: GapObservation[] = [
      { timestamp: new Date(fastBase).toISOString(), normalizedGap: 0.78 },
      { timestamp: new Date(fastBase + 3_600_000).toISOString(), normalizedGap: 0.68 },
    ];
    const history = [...slow, ...fastPart];
    const result = engine.evaluatePacing("g1", 0.68, null, history);
    // velocity should be closer to 0.1 than to 0.01
    expect(result.velocityPerHour).toBeGreaterThan(0.05);
  });
});

// ─── Pacing evaluation — all 5 statuses ──────────────────────────────────────

describe("evaluatePacing — status classification", () => {
  const engine = new TimeHorizonEngine();

  it("ahead: pacing_ratio < 0.8", () => {
    // velocity = 0.1/h, currentGap=0.2, deadline in 10h → required=0.02, ratio=0.2
    const history = makeHistory([0.8, 0.7, 0.6, 0.5], 1);
    const deadline = deadlineInHours(10);
    const result = engine.evaluatePacing("g1", 0.2, deadline, history);
    expect(result.status).toBe("ahead");
    expect(result.pacingRatio).not.toBeNull();
    expect(result.pacingRatio!).toBeLessThan(0.8);
  });

  it("on_track: pacing_ratio 0.8 - 1.2", () => {
    // velocity = 0.1/h, currentGap=0.1, deadline in 1h → required=0.1, ratio=1.0
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const deadline = deadlineInHours(1);
    const result = engine.evaluatePacing("g1", 0.1, deadline, history);
    expect(result.status).toBe("on_track");
  });

  it("behind: pacing_ratio 1.2 - 2.0", () => {
    // velocity = 0.1/h, currentGap=0.15, deadline in 1h → ratio=1.5
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const deadline = deadlineInHours(1);
    const result = engine.evaluatePacing("g1", 0.15, deadline, history);
    expect(result.status).toBe("behind");
    expect(result.pacingRatio!).toBeGreaterThanOrEqual(1.2);
    expect(result.pacingRatio!).toBeLessThan(2.0);
  });

  it("critical: pacing_ratio >= 2.0", () => {
    // velocity = 0.1/h, currentGap=0.3, deadline in 1h → ratio=3.0
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const deadline = deadlineInHours(1);
    const result = engine.evaluatePacing("g1", 0.3, deadline, history);
    expect(result.status).toBe("critical");
    expect(result.pacingRatio!).toBeGreaterThanOrEqual(2.0);
  });

  it("no_deadline when deadline=null", () => {
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const result = engine.evaluatePacing("g1", 0.2, null, history);
    expect(result.status).toBe("no_deadline");
    expect(result.pacingRatio).toBeNull();
    expect(result.timeRemainingHours).toBeNull();
  });

  it("recommendation is maintain_course when ahead", () => {
    const history = makeHistory([0.8, 0.7, 0.6, 0.5], 1);
    const deadline = deadlineInHours(10);
    const result = engine.evaluatePacing("g1", 0.2, deadline, history);
    expect(result.recommendation).toBe("maintain_course");
  });

  it("recommendation is escalate_to_user when critical with high confidence", () => {
    // Need 3+ observations for confidence >= 1.0
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const deadline = deadlineInHours(1); // ratio=3.0
    const result = engine.evaluatePacing("g1", 0.3, deadline, history);
    expect(result.status).toBe("critical");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.recommendation).toBe("escalate_to_user");
  });

  it("recommendation is consider_strategy_change when critical with low confidence", () => {
    // Use 1 observation for low confidence (confidence = 1/3 < 0.6)
    const deadline = deadlineInHours(1);
    const history1 = makeHistory([0.5], 1);
    const result1 = engine.evaluatePacing("g1", 0.5, deadline, history1);
    // velocity = 0, pacing_ratio = Infinity → critical, confidence = 1/3 = 0.33
    expect(result1.status).toBe("critical");
    expect(result1.confidence).toBeLessThan(0.6);
    expect(result1.recommendation).toBe("consider_strategy_change");
  });

  it("recommendation behind with high confidence → consider_strategy_change", () => {
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const deadline = deadlineInHours(1); // ratio = 1.5
    const result = engine.evaluatePacing("g1", 0.15, deadline, history);
    expect(result.status).toBe("behind");
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.recommendation).toBe("consider_strategy_change");
  });

  it("recommendation behind with low confidence → increase_effort", () => {
    const history = makeHistory([0.5, 0.4], 1); // 2 obs, confidence = 2/3 = 0.67
    // Need confidence < 0.6 → use 1 obs but behind requires velocity > 0
    // Use engine with min_observations=5 to force low confidence
    const eng2 = new TimeHorizonEngine({ min_observations_for_projection: 10 });
    const history2 = makeHistory([0.5, 0.4, 0.3, 0.2], 1); // 4 obs, conf=4/10=0.4
    const deadline = deadlineInHours(1);
    const result2 = eng2.evaluatePacing("g1", 0.15, deadline, history2);
    expect(result2.status).toBe("behind");
    expect(result2.confidence).toBeLessThan(0.6);
    expect(result2.recommendation).toBe("increase_effort");
  });
});

// ─── No deadline ──────────────────────────────────────────────────────────────

describe("no_deadline goal", () => {
  const engine = new TimeHorizonEngine();

  it("returns no_deadline status", () => {
    const history = makeHistory([0.5, 0.4, 0.3], 1);
    const result = engine.evaluatePacing("g1", 0.3, null, history);
    expect(result.status).toBe("no_deadline");
  });

  it("velocity_declining emits sustainable_pace_declining", () => {
    // Need >10 fast observations (to exceed window_size=10) then slow ones so
    // historical EMA > recent EMA by >30%
    // 14 fast obs: gap drops 0.1/h; then 10 slow obs: gap drops 0.005/h
    const fastGaps = Array.from({ length: 15 }, (_, i) => 1.0 - i * 0.1);
    const slowGaps = Array.from({ length: 10 }, (_, i) => fastGaps[14] - (i + 1) * 0.005);
    const allGaps = [...fastGaps, ...slowGaps];
    const history = makeHistory(allGaps, 1);
    const last = allGaps[allGaps.length - 1];
    const result = engine.evaluatePacing("g1", last, null, history);
    expect(result.status).toBe("no_deadline");
    expect(result.recommendation).toBe("sustainable_pace_declining");
  });

  it("stable velocity emits sustainable_pace_ok", () => {
    // Constant velocity throughout
    const history = makeHistory([0.7, 0.6, 0.5, 0.4, 0.3, 0.2], 1);
    const result = engine.evaluatePacing("g1", 0.2, null, history);
    expect(result.status).toBe("no_deadline");
    expect(result.recommendation).toBe("sustainable_pace_ok");
  });
});

// ─── Zero/negative velocity edge cases ───────────────────────────────────────

describe("zero and negative velocity", () => {
  const engine = new TimeHorizonEngine();

  it("zero velocity → critical status with deadline", () => {
    // No progress
    const history = makeHistory([0.5, 0.5, 0.5, 0.5], 1);
    const deadline = deadlineInHours(5);
    const result = engine.evaluatePacing("g1", 0.5, deadline, history);
    expect(result.status).toBe("critical");
    expect(result.velocityPerHour).toBeCloseTo(0, 5);
  });

  it("negative velocity → critical status", () => {
    const history = makeHistory([0.2, 0.3, 0.4, 0.5], 1);
    const deadline = deadlineInHours(10);
    const result = engine.evaluatePacing("g1", 0.5, deadline, history);
    expect(result.status).toBe("critical");
  });
});

// ─── Completion projection ────────────────────────────────────────────────────

describe("projectCompletion", () => {
  const engine = new TimeHorizonEngine();

  it("positive velocity produces estimated date", () => {
    const result = engine.projectCompletion(0.1, 0, 0.5);
    // 0.5 / 0.1 = 5 hours
    expect(result.estimatedDate).not.toBeNull();
    const estMs = new Date(result.estimatedDate!).getTime();
    const expectedMs = Date.now() + 5 * 3_600_000;
    expect(Math.abs(estMs - expectedMs)).toBeLessThan(5000);
  });

  it("zero velocity returns null estimatedDate and isAchievable=false", () => {
    const result = engine.projectCompletion(0, 0, 0.5);
    expect(result.estimatedDate).toBeNull();
    expect(result.isAchievable).toBe(false);
    expect(result.confidenceInterval).toBeNull();
  });

  it("negative velocity returns null and isAchievable=false", () => {
    const result = engine.projectCompletion(-0.05, 0.01, 0.5);
    expect(result.estimatedDate).toBeNull();
    expect(result.isAchievable).toBe(false);
  });

  it("confidence interval: optimistic sooner, pessimistic later", () => {
    const result = engine.projectCompletion(0.1, 0.02, 0.5);
    expect(result.confidenceInterval).not.toBeNull();
    const { optimistic, pessimistic } = result.confidenceInterval!;
    expect(new Date(optimistic).getTime()).toBeLessThan(new Date(pessimistic).getTime());
  });

  it("stddev=0 → optimistic == pessimistic approximately", () => {
    const result = engine.projectCompletion(0.1, 0, 0.5);
    expect(result.confidenceInterval).not.toBeNull();
    const { optimistic, pessimistic } = result.confidenceInterval!;
    // Same velocity for both, within 1ms rounding
    expect(Math.abs(new Date(optimistic).getTime() - new Date(pessimistic).getTime())).toBeLessThan(5);
  });
});

// ─── suggestObservationInterval ──────────────────────────────────────────────

describe("suggestObservationInterval", () => {
  const engine = new TimeHorizonEngine();
  const base = 60_000; // 1 minute base

  function makePacing(status: string): Parameters<typeof engine.suggestObservationInterval>[0] {
    return {
      status: status as any,
      velocityPerHour: 0.1,
      velocityStddev: 0,
      projectedCompletionDate: null,
      timeRemainingHours: null,
      pacingRatio: null,
      confidence: 1,
      recommendation: "maintain_course" as any,
    };
  }

  it("critical → 1.0x base", () => {
    expect(engine.suggestObservationInterval(makePacing("critical"), base)).toBe(base * 1.0);
  });

  it("behind → 0.5x base (more frequent)", () => {
    expect(engine.suggestObservationInterval(makePacing("behind"), base)).toBe(base * 0.5);
  });

  it("on_track → 1.0x base", () => {
    expect(engine.suggestObservationInterval(makePacing("on_track"), base)).toBe(base * 1.0);
  });

  it("ahead → 2.0x base (less frequent)", () => {
    expect(engine.suggestObservationInterval(makePacing("ahead"), base)).toBe(base * 2.0);
  });

  it("no_deadline → 1.5x base", () => {
    expect(engine.suggestObservationInterval(makePacing("no_deadline"), base)).toBe(base * 1.5);
  });

  it("custom config multiplier is respected", () => {
    const custom = new TimeHorizonEngine({
      observation_interval_multipliers: {
        critical: 0.25,
        behind: 0.5,
        on_track: 1.0,
        ahead: 3.0,
        no_deadline: 1.5,
      },
    });
    expect(custom.suggestObservationInterval(makePacing("ahead"), base)).toBe(base * 3.0);
    expect(custom.suggestObservationInterval(makePacing("critical"), base)).toBe(base * 0.25);
  });
});

// ─── getTimeBudget + canAffordWait ────────────────────────────────────────────

describe("getTimeBudget", () => {
  const engine = new TimeHorizonEngine();

  it("with deadline: computes totalHours, remainingHours, percentElapsed", () => {
    const start = startHoursAgo(4);
    const deadline = deadlineInHours(6);
    const budget = engine.getTimeBudget(deadline, start, 0.5, 1.0, 0.05);
    expect(budget.totalHours).toBeCloseTo(10, 1);
    expect(budget.elapsedHours).toBeCloseTo(4, 1);
    expect(budget.remainingHours).toBeCloseTo(6, 1);
    expect(budget.percentElapsed).toBeCloseTo(0.4, 2);
    expect(budget.percentGapRemaining).toBeCloseTo(0.5, 3);
  });

  it("without deadline: totalHours, remainingHours, percentElapsed are null", () => {
    const start = startHoursAgo(2);
    const budget = engine.getTimeBudget(null, start, 0.5, 1.0, 0.05);
    expect(budget.totalHours).toBeNull();
    expect(budget.remainingHours).toBeNull();
    expect(budget.percentElapsed).toBeNull();
    expect(budget.elapsedHours).toBeGreaterThan(0);
  });

  it("canAffordWait returns false if velocity <= 0", () => {
    const start = startHoursAgo(2);
    const deadline = deadlineInHours(10);
    const budget = engine.getTimeBudget(deadline, start, 0.5, 1.0, 0);
    expect(budget.canAffordWait(1)).toBe(false);
    const budget2 = engine.getTimeBudget(deadline, start, 0.5, 1.0, -0.1);
    expect(budget2.canAffordWait(1)).toBe(false);
  });

  it("canAffordWait returns true if no deadline", () => {
    const start = startHoursAgo(2);
    const budget = engine.getTimeBudget(null, start, 0.5, 1.0, 0.1);
    expect(budget.canAffordWait(100)).toBe(true);
  });

  it("canAffordWait returns false if wait would consume all time", () => {
    const start = startHoursAgo(1);
    const deadline = deadlineInHours(2); // 2 hours remaining
    // gap=0.2, velocity=0.1 → required after 2h wait: 0.2/0 = Infinity
    const budget = engine.getTimeBudget(deadline, start, 0.2, 1.0, 0.1);
    expect(budget.canAffordWait(3)).toBe(false); // wait exceeds remaining time
  });

  it("canAffordWait returns true when wait is affordable", () => {
    const start = startHoursAgo(1);
    const deadline = deadlineInHours(50); // lots of time
    // gap=0.1, velocity=0.1 → require 1h; after 1h wait still 49h → ratio << 2
    const budget = engine.getTimeBudget(deadline, start, 0.1, 1.0, 0.1);
    expect(budget.canAffordWait(1)).toBe(true);
  });

  it("canAffordWait returns false when wait would push ratio above critical", () => {
    const start = startHoursAgo(1);
    const deadline = deadlineInHours(2.1); // 2.1h remaining
    // gap=0.4, velocity=0.1 → required=0.19/h, ratio=1.9 (behind)
    // after wait of 1h: remaining=1.1, required=0.4/1.1=0.36, ratio=3.6 → critical (>= 2.0)
    const budget = engine.getTimeBudget(deadline, start, 0.4, 1.0, 0.1);
    expect(budget.canAffordWait(1)).toBe(false);
  });

  it("percentGapRemaining = currentGap / initialGap", () => {
    const start = startHoursAgo(1);
    const budget = engine.getTimeBudget(null, start, 0.3, 0.9, 0.1);
    expect(budget.percentGapRemaining).toBeCloseTo(0.3 / 0.9, 5);
  });
});

// ─── Custom config overrides ──────────────────────────────────────────────────

describe("custom config overrides", () => {
  it("custom pacing_thresholds shift status boundaries", () => {
    const custom = new TimeHorizonEngine({
      pacing_thresholds: { ahead: 0.5, behind: 1.0, critical: 1.5 },
    });
    // ratio=0.6 → with defaults: on_track; with custom: on_track (between 0.5 and 1.0)
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1);
    const deadline = deadlineInHours(10); // ratio ≈ 0.2/0.1 = 0.2 → ahead
    const result = custom.evaluatePacing("g1", 0.2, deadline, history);
    // ratio = (0.2/10) / 0.1 = 0.2 → < 0.5 → still ahead
    expect(result.status).toBe("ahead");

    // For behind: gap=0.12, deadline in 1h → ratio=1.2 → default: on_track, custom: behind
    const result2 = custom.evaluatePacing("g1", 0.12, deadlineInHours(1), history);
    // ratio = (0.12/1) / 0.1 = 1.2 → >= custom.behind(1.0), < custom.critical(1.5) → behind
    expect(result2.status).toBe("behind");
  });

  it("custom velocity_ema_alpha affects velocity", () => {
    const slowAlpha = new TimeHorizonEngine({ velocity_ema_alpha: 0.05 });
    const fastAlpha = new TimeHorizonEngine({ velocity_ema_alpha: 0.99 });
    // Fast recent velocity
    const slowHistory = makeHistory([0.9, 0.89, 0.88, 0.87], 1);
    const lastTs = new Date(slowHistory[3].timestamp).getTime();
    const recentHistory: GapObservation[] = [
      ...slowHistory,
      { timestamp: new Date(lastTs + 3_600_000).toISOString(), normalizedGap: 0.77 },
    ];
    const slowResult = slowAlpha.evaluatePacing("g1", 0.77, null, recentHistory);
    const fastResult = fastAlpha.evaluatePacing("g1", 0.77, null, recentHistory);
    // fast alpha reacts more to latest observation; both should see the big drop
    expect(fastResult.velocityPerHour).toBeGreaterThan(slowResult.velocityPerHour);
  });
});

// ─── Insufficient observations ────────────────────────────────────────────────

describe("insufficient observations", () => {
  const engine = new TimeHorizonEngine();

  it("1 observation → confidence = 1/3", () => {
    const history = makeHistory([0.5], 1);
    const result = engine.evaluatePacing("g1", 0.5, null, history);
    expect(result.confidence).toBeCloseTo(1 / 3, 5);
  });

  it("2 observations → confidence = 2/3", () => {
    const history = makeHistory([0.5, 0.4], 1);
    const result = engine.evaluatePacing("g1", 0.4, null, history);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
  });

  it("3 observations → confidence = 1.0 (exactly at min)", () => {
    const history = makeHistory([0.5, 0.4, 0.3], 1);
    const result = engine.evaluatePacing("g1", 0.3, null, history);
    expect(result.confidence).toBe(1.0);
  });

  it("projectedCompletionDate is null when below min observations threshold", () => {
    const history = makeHistory([0.5, 0.4], 1); // 2 obs < default 3
    const result = engine.evaluatePacing("g1", 0.4, null, history);
    expect(result.projectedCompletionDate).toBeNull();
  });

  it("projectedCompletionDate is null for perpetual goals regardless of observation count", () => {
    // §6.2: perpetual goals (deadline=null) never get a burn-down projection
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1); // 4 obs >= 3
    const result = engine.evaluatePacing("g1", 0.2, null, history);
    expect(result.projectedCompletionDate).toBeNull();
  });

  it("projectedCompletionDate provided for deadline goals at/above min observations", () => {
    const history = makeHistory([0.5, 0.4, 0.3, 0.2], 1); // 4 obs >= 3
    const deadline = deadlineInHours(10);
    const result = engine.evaluatePacing("g1", 0.2, deadline, history);
    expect(result.projectedCompletionDate).not.toBeNull();
  });
});

// ─── New tests for review fixes ───────────────────────────────────────────────

describe("TimeBudgetWithWait — canAffordWait method presence", () => {
  const engine = new TimeHorizonEngine();

  it("getTimeBudget return value has canAffordWait as a function", () => {
    const start = startHoursAgo(1);
    const budget = engine.getTimeBudget(deadlineInHours(10), start, 0.5, 1.0, 0.1);
    expect(typeof budget.canAffordWait).toBe("function");
  });
});

describe("perpetual goal — projectedCompletionDate always null", () => {
  const engine = new TimeHorizonEngine();

  it("deadline=null always returns projectedCompletionDate: null", () => {
    // Even with enough observations and positive velocity
    const history = makeHistory([0.5, 0.4, 0.3, 0.2, 0.1], 1);
    const result = engine.evaluatePacing("g1", 0.1, null, history);
    expect(result.status).toBe("no_deadline");
    expect(result.projectedCompletionDate).toBeNull();
  });
});

describe("isVelocityDeclining — historicalEma <= 0 returns true", () => {
  const engine = new TimeHorizonEngine();

  it("zero velocity history → sustainable_pace_declining recommendation", () => {
    // Flat history (no progress) → historical EMA = 0 → isVelocityDeclining=true
    const history = makeHistory([0.5, 0.5, 0.5, 0.5, 0.5], 1);
    const result = engine.evaluatePacing("g1", 0.5, null, history);
    expect(result.status).toBe("no_deadline");
    expect(result.recommendation).toBe("sustainable_pace_declining");
  });

  it("negative velocity history → sustainable_pace_declining recommendation", () => {
    // Increasing gap → historical EMA < 0 → isVelocityDeclining=true
    const history = makeHistory([0.2, 0.3, 0.4, 0.5, 0.6], 1);
    const result = engine.evaluatePacing("g1", 0.6, null, history);
    expect(result.status).toBe("no_deadline");
    expect(result.recommendation).toBe("sustainable_pace_declining");
  });
});

describe("canAffordWait — critical threshold inclusive", () => {
  it("exactly at critical threshold returns true (<=, not <)", () => {
    // critical threshold default = 2.0
    // Set up: after wait, newPacingRatio == exactly 2.0 → should return true
    // gap=0.2, remaining=1h after wait
    // newRequiredVelocity = 0.2/1 = 0.2
    // velocity = 0.1 → ratio = 0.2/0.1 = 2.0 == critical → should be true
    const start = startHoursAgo(1);
    const deadline = deadlineInHours(2); // 2h remaining
    // After 1h wait: 1h left. gap=0.1, velocity=0.1 → ratio = 0.1/1 / 0.1 = 1.0 (not exact)
    // Need: gap / (remaining - wait) / velocity == 2.0
    // 0.2 / (2 - 1) / 0.1 = 0.2 / 1 / 0.1 = 2.0 exactly
    const engine = new TimeHorizonEngine();
    const budget = engine.getTimeBudget(deadline, start, 0.2, 1.0, 0.1);
    expect(budget.canAffordWait(1)).toBe(true); // ratio == 2.0 → <=, returns true
  });
});
