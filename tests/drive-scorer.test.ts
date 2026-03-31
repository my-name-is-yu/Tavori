import { describe, it, expect } from "vitest";
import {
  scoreDissatisfaction,
  scoreDeadline,
  scoreOpportunity,
  computeOpportunityValue,
  combineDriveScores,
  scoreAllDimensions,
  rankDimensions,
} from "../src/drive/drive-scorer.js";
import type { DriveConfig, DriveContext } from "../src/types/drive.js";
import type { GapVector } from "../src/types/gap.js";

// Shared default config values (mirrors DriveConfigSchema defaults)
const DEFAULT_CONFIG: DriveConfig = {
  decay_floor: 0.3,
  recovery_time_hours: 24,
  deadline_horizon_hours: 168,
  urgency_steepness: 3.0,
  urgency_override_threshold: 10.0,
  half_life_hours: 12,
};

// ─── scoreDissatisfaction ───

describe("scoreDissatisfaction", () => {
  it("t=0 → score = gap × decay_floor (0.3)", () => {
    const result = scoreDissatisfaction(0.8, 0, DEFAULT_CONFIG);
    // decay_factor at t=0: 0.3 + (1-0.3)*(1-exp(0)) = 0.3 + 0.7*0 = 0.3
    expect(result.decay_factor).toBeCloseTo(0.3, 5);
    expect(result.score).toBeCloseTo(0.8 * 0.3, 5);
  });

  it("t=very large → score ≈ gap × 1.0", () => {
    const result = scoreDissatisfaction(0.6, 10000, DEFAULT_CONFIG);
    // decay_factor → 1.0 as t→∞
    expect(result.decay_factor).toBeCloseTo(1.0, 4);
    expect(result.score).toBeCloseTo(0.6, 4);
  });

  it("t=24h (recovery_time) → correct intermediate decay_factor", () => {
    const result = scoreDissatisfaction(1.0, 24, DEFAULT_CONFIG);
    // decay_factor = 0.3 + 0.7 * (1 - exp(-1)) ≈ 0.3 + 0.7 * 0.6321 ≈ 0.7425
    const expected = 0.3 + 0.7 * (1 - Math.exp(-1));
    expect(result.decay_factor).toBeCloseTo(expected, 5);
    expect(result.score).toBeCloseTo(expected, 5);
  });

  it("gap=0 → score=0 regardless of t", () => {
    const result = scoreDissatisfaction(0, 24, DEFAULT_CONFIG);
    expect(result.score).toBe(0);
  });

  it("gap=1 → max score approaches 1 for large t", () => {
    const result = scoreDissatisfaction(1.0, 10000, DEFAULT_CONFIG);
    expect(result.score).toBeCloseTo(1.0, 4);
  });

  it("negative t is clamped to 0", () => {
    const atZero = scoreDissatisfaction(0.5, 0, DEFAULT_CONFIG);
    const atNeg = scoreDissatisfaction(0.5, -10, DEFAULT_CONFIG);
    expect(atNeg.decay_factor).toBeCloseTo(atZero.decay_factor, 10);
    expect(atNeg.score).toBeCloseTo(atZero.score, 10);
  });

  it("returns correct shape with all required fields", () => {
    const result = scoreDissatisfaction(0.5, 12, DEFAULT_CONFIG);
    expect(result).toHaveProperty("dimension_name");
    expect(result).toHaveProperty("normalized_weighted_gap", 0.5);
    expect(result).toHaveProperty("decay_factor");
    expect(result).toHaveProperty("score");
  });

  it("uses default config when none provided", () => {
    const withDefault = scoreDissatisfaction(0.5, 0);
    const withExplicit = scoreDissatisfaction(0.5, 0, DEFAULT_CONFIG);
    expect(withDefault.score).toBeCloseTo(withExplicit.score, 10);
  });
});

// ─── scoreDeadline ───

describe("scoreDeadline", () => {
  it("T=null → score=0, urgency=0", () => {
    const result = scoreDeadline(0.8, null, DEFAULT_CONFIG);
    expect(result.urgency).toBe(0);
    expect(result.score).toBe(0);
  });

  it("T >= deadline_horizon → urgency=1.0, score=gap×1", () => {
    const result = scoreDeadline(0.7, 168, DEFAULT_CONFIG);
    expect(result.urgency).toBeCloseTo(1.0, 5);
    expect(result.score).toBeCloseTo(0.7, 5);
  });

  it("T > deadline_horizon → also urgency=1.0", () => {
    const result = scoreDeadline(0.5, 500, DEFAULT_CONFIG);
    expect(result.urgency).toBeCloseTo(1.0, 5);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it("T=0 → max urgency = exp(urgency_steepness × 1)", () => {
    const result = scoreDeadline(1.0, 0, DEFAULT_CONFIG);
    // urgency = exp(3.0 * (1 - 0/168)) = exp(3.0)
    const expected = Math.exp(3.0);
    expect(result.urgency).toBeCloseTo(expected, 4);
    expect(result.score).toBeCloseTo(expected, 4);
  });

  it("T < 0 (overdue) → score = cap (urgency at T=0)", () => {
    const atZero = scoreDeadline(1.0, 0, DEFAULT_CONFIG);
    const overdue = scoreDeadline(1.0, -5, DEFAULT_CONFIG);
    expect(overdue.urgency).toBeCloseTo(atZero.urgency, 4);
    expect(overdue.score).toBeCloseTo(atZero.score, 4);
  });

  it("T=84h (half horizon) → correct intermediate urgency", () => {
    const result = scoreDeadline(1.0, 84, DEFAULT_CONFIG);
    // urgency = exp(3.0 * (1 - 84/168)) = exp(3.0 * 0.5) = exp(1.5)
    const expected = Math.exp(1.5);
    expect(result.urgency).toBeCloseTo(expected, 4);
    expect(result.score).toBeCloseTo(expected, 4);
  });

  it("gap=0 → score=0 regardless of deadline", () => {
    const result = scoreDeadline(0, 10, DEFAULT_CONFIG);
    expect(result.score).toBe(0);
  });

  it("returns correct shape with all required fields", () => {
    const result = scoreDeadline(0.5, 48, DEFAULT_CONFIG);
    expect(result).toHaveProperty("dimension_name");
    expect(result).toHaveProperty("normalized_weighted_gap", 0.5);
    expect(result).toHaveProperty("urgency");
    expect(result).toHaveProperty("score");
  });

  it("uses default config when none provided", () => {
    const withDefault = scoreDeadline(0.5, null);
    const withExplicit = scoreDeadline(0.5, null, DEFAULT_CONFIG);
    expect(withDefault.score).toBeCloseTo(withExplicit.score, 10);
  });
});

// ─── scoreOpportunity ───

describe("scoreOpportunity", () => {
  it("t=0 → score = opportunityValue (freshness_decay = 1.0)", () => {
    const result = scoreOpportunity(1.5, 0, DEFAULT_CONFIG);
    expect(result.freshness_decay).toBeCloseTo(1.0, 5);
    expect(result.score).toBeCloseTo(1.5, 5);
  });

  it("t=12h (half_life) → score ≈ opportunityValue / 2", () => {
    const result = scoreOpportunity(1.0, 12, DEFAULT_CONFIG);
    // freshness_decay = exp(-ln(2) * 12 / 12) = exp(-ln(2)) = 0.5
    expect(result.freshness_decay).toBeCloseTo(0.5, 5);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it("t=24h (two half-lives) → score ≈ opportunityValue / 4", () => {
    const result = scoreOpportunity(1.0, 24, DEFAULT_CONFIG);
    expect(result.freshness_decay).toBeCloseTo(0.25, 5);
    expect(result.score).toBeCloseTo(0.25, 5);
  });

  it("t=very large → score ≈ 0", () => {
    const result = scoreOpportunity(2.0, 10000, DEFAULT_CONFIG);
    expect(result.score).toBeCloseTo(0, 5);
  });

  it("opportunityValue=0 → score=0", () => {
    const result = scoreOpportunity(0, 0, DEFAULT_CONFIG);
    expect(result.score).toBe(0);
  });

  it("handles max opportunityValue=2.0 at t=0", () => {
    const result = scoreOpportunity(2.0, 0, DEFAULT_CONFIG);
    expect(result.score).toBeCloseTo(2.0, 5);
  });

  it("negative t is clamped to 0", () => {
    const atZero = scoreOpportunity(1.0, 0, DEFAULT_CONFIG);
    const atNeg = scoreOpportunity(1.0, -5, DEFAULT_CONFIG);
    expect(atNeg.freshness_decay).toBeCloseTo(atZero.freshness_decay, 10);
    expect(atNeg.score).toBeCloseTo(atZero.score, 10);
  });

  it("returns correct shape with all required fields", () => {
    const result = scoreOpportunity(1.0, 6, DEFAULT_CONFIG);
    expect(result).toHaveProperty("dimension_name");
    expect(result).toHaveProperty("opportunity_value", 1.0);
    expect(result).toHaveProperty("freshness_decay");
    expect(result).toHaveProperty("score");
  });

  it("uses default config when none provided", () => {
    const withDefault = scoreOpportunity(1.0, 12);
    const withExplicit = scoreOpportunity(1.0, 12, DEFAULT_CONFIG);
    expect(withDefault.score).toBeCloseTo(withExplicit.score, 10);
  });
});

// ─── computeOpportunityValue ───

describe("computeOpportunityValue", () => {
  it("basic calculation: value = impact × (1 + external + timing)", () => {
    const value = computeOpportunityValue(0.5, 0.25, 0.25);
    // 0.5 × (1 + 0.25 + 0.25) = 0.5 × 1.5 = 0.75
    expect(value).toBeCloseTo(0.75, 5);
  });

  it("all bonuses zero → value = downstreamImpact", () => {
    const value = computeOpportunityValue(0.6, 0, 0);
    expect(value).toBeCloseTo(0.6, 5);
  });

  it("max bonuses: impact=1, external=0.5, timing=0.5 → value=2.0", () => {
    const value = computeOpportunityValue(1.0, 0.5, 0.5);
    expect(value).toBeCloseTo(2.0, 5);
  });

  it("impact=0 → value=0 regardless of bonuses", () => {
    const value = computeOpportunityValue(0, 0.5, 0.5);
    expect(value).toBe(0);
  });

  it("fractional impact with max bonuses", () => {
    const value = computeOpportunityValue(0.5, 0.5, 0.5);
    // 0.5 × (1 + 0.5 + 0.5) = 0.5 × 2.0 = 1.0
    expect(value).toBeCloseTo(1.0, 5);
  });
});

// ─── combineDriveScores ───

describe("combineDriveScores", () => {
  const makeD = (score: number) =>
    scoreDissatisfaction(score > 0 ? 1.0 : 0.0, score > 0 ? 10000 : 0, DEFAULT_CONFIG);
  const makeDeadline = (score: number, urgency?: number) => ({
    dimension_name: "",
    normalized_weighted_gap: score,
    urgency: urgency ?? score,
    score,
  });
  const makeOpp = (score: number) =>
    scoreOpportunity(score, 0, DEFAULT_CONFIG);

  it("dissatisfaction wins when it has the highest score", () => {
    const d = { dimension_name: "", normalized_weighted_gap: 1.0, decay_factor: 1.0, score: 0.9 };
    const dl = { dimension_name: "", normalized_weighted_gap: 0.5, urgency: 1.0, score: 0.5 };
    const o = { dimension_name: "", opportunity_value: 0.3, freshness_decay: 1.0, score: 0.3 };
    const result = combineDriveScores(d, dl, o, DEFAULT_CONFIG);
    expect(result.final_score).toBeCloseTo(0.9, 5);
    expect(result.dominant_drive).toBe("dissatisfaction");
  });

  it("deadline wins when it has the highest score (below override threshold)", () => {
    const d = { dimension_name: "", normalized_weighted_gap: 0.4, decay_factor: 0.3, score: 0.12 };
    const dl = { dimension_name: "", normalized_weighted_gap: 0.8, urgency: 5.0, score: 4.0 };
    const o = { dimension_name: "", opportunity_value: 0.5, freshness_decay: 1.0, score: 0.5 };
    const result = combineDriveScores(d, dl, o, DEFAULT_CONFIG);
    expect(result.final_score).toBeCloseTo(4.0, 5);
    expect(result.dominant_drive).toBe("deadline");
  });

  it("opportunity wins when it has the highest score", () => {
    const d = { dimension_name: "", normalized_weighted_gap: 0.2, decay_factor: 0.3, score: 0.06 };
    const dl = { dimension_name: "", normalized_weighted_gap: 0.3, urgency: 1.0, score: 0.3 };
    const o = { dimension_name: "", opportunity_value: 2.0, freshness_decay: 1.0, score: 2.0 };
    const result = combineDriveScores(d, dl, o, DEFAULT_CONFIG);
    expect(result.final_score).toBeCloseTo(2.0, 5);
    expect(result.dominant_drive).toBe("opportunity");
  });

  it("deadline override when urgency >= urgency_override_threshold (10.0)", () => {
    const d = { dimension_name: "", normalized_weighted_gap: 1.0, decay_factor: 1.0, score: 1.0 };
    const dl = { dimension_name: "", normalized_weighted_gap: 1.0, urgency: 10.0, score: 10.0 };
    const o = { dimension_name: "", opportunity_value: 2.0, freshness_decay: 1.0, score: 2.0 };
    const result = combineDriveScores(d, dl, o, DEFAULT_CONFIG);
    expect(result.final_score).toBeCloseTo(10.0, 5);
    expect(result.dominant_drive).toBe("deadline");
  });

  it("deadline override at urgency exactly equal to threshold", () => {
    const config: DriveConfig = { ...DEFAULT_CONFIG, urgency_override_threshold: 5.0 };
    const d = { dimension_name: "", normalized_weighted_gap: 1.0, decay_factor: 1.0, score: 1.0 };
    const dl = { dimension_name: "", normalized_weighted_gap: 1.0, urgency: 5.0, score: 5.0 };
    const o = { dimension_name: "", opportunity_value: 0.1, freshness_decay: 1.0, score: 0.1 };
    const result = combineDriveScores(d, dl, o, config);
    expect(result.dominant_drive).toBe("deadline");
    expect(result.final_score).toBeCloseTo(5.0, 5);
  });

  it("no deadline override when urgency < threshold", () => {
    const config: DriveConfig = { ...DEFAULT_CONFIG, urgency_override_threshold: 5.0 };
    const d = { dimension_name: "", normalized_weighted_gap: 1.0, decay_factor: 1.0, score: 1.0 };
    const dl = { dimension_name: "", normalized_weighted_gap: 1.0, urgency: 4.99, score: 4.99 };
    const o = { dimension_name: "", opportunity_value: 0.1, freshness_decay: 1.0, score: 0.1 };
    const result = combineDriveScores(d, dl, o, config);
    // max is still deadline at 4.99, but override not triggered
    expect(result.final_score).toBeCloseTo(4.99, 2);
    expect(result.dominant_drive).toBe("deadline");
  });

  it("stores all three raw scores in result", () => {
    const d = { dimension_name: "", normalized_weighted_gap: 0.5, decay_factor: 0.5, score: 0.25 };
    const dl = { dimension_name: "", normalized_weighted_gap: 0.5, urgency: 1.0, score: 0.5 };
    const o = { dimension_name: "", opportunity_value: 0.5, freshness_decay: 0.5, score: 0.25 };
    const result = combineDriveScores(d, dl, o, DEFAULT_CONFIG);
    expect(result.dissatisfaction).toBeCloseTo(0.25, 5);
    expect(result.deadline).toBeCloseTo(0.5, 5);
    expect(result.opportunity).toBeCloseTo(0.25, 5);
  });
});

// ─── scoreAllDimensions ───

describe("scoreAllDimensions", () => {
  const makeGapVector = (): GapVector => ({
    goal_id: "goal-1",
    gaps: [
      {
        dimension_name: "coverage",
        raw_gap: 0.3,
        normalized_gap: 0.3,
        normalized_weighted_gap: 0.3,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
      {
        dimension_name: "performance",
        raw_gap: 0.7,
        normalized_gap: 0.7,
        normalized_weighted_gap: 0.7,
        confidence: 0.6,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  });

  const makeContext = (): DriveContext => ({
    time_since_last_attempt: {
      coverage: 12,
      performance: 48,
    },
    deadlines: {
      coverage: 100,
      performance: null,
    },
    opportunities: {
      coverage: {
        value: 0.5,
        detected_at: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      },
    },
  });

  it("returns one DriveScore per dimension", () => {
    const gv = makeGapVector();
    const ctx = makeContext();
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    expect(scores).toHaveLength(2);
  });

  it("dimension_name is correctly propagated", () => {
    const gv = makeGapVector();
    const ctx = makeContext();
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    const names = scores.map((s) => s.dimension_name);
    expect(names).toContain("coverage");
    expect(names).toContain("performance");
  });

  it("each score has final_score and dominant_drive", () => {
    const gv = makeGapVector();
    const ctx = makeContext();
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    for (const s of scores) {
      expect(s).toHaveProperty("final_score");
      expect(s).toHaveProperty("dominant_drive");
      expect(typeof s.final_score).toBe("number");
      expect(["dissatisfaction", "deadline", "opportunity"]).toContain(s.dominant_drive);
    }
  });

  it("dimension without deadline gets deadline score=0", () => {
    const gv = makeGapVector();
    const ctx = makeContext();
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    const perf = scores.find((s) => s.dimension_name === "performance")!;
    expect(perf.deadline).toBe(0);
  });

  it("dimension without opportunity gets opportunity score=0", () => {
    const gv = makeGapVector();
    const ctx = makeContext();
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    const perf = scores.find((s) => s.dimension_name === "performance")!;
    // performance has no opportunity entry in context
    expect(perf.opportunity).toBe(0);
  });

  it("performance dim (higher gap, longer time since attempt) has higher dissatisfaction", () => {
    const gv = makeGapVector();
    const ctx = makeContext();
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    const coverage = scores.find((s) => s.dimension_name === "coverage")!;
    const performance = scores.find((s) => s.dimension_name === "performance")!;
    // performance: nwg=0.7, t=48h; coverage: nwg=0.3, t=12h
    expect(performance.dissatisfaction).toBeGreaterThan(coverage.dissatisfaction);
  });
});

// ─── rankDimensions ───

describe("rankDimensions", () => {
  const makeScore = (name: string, finalScore: number): import("../src/types/drive.js").DriveScore => ({
    dimension_name: name,
    dissatisfaction: finalScore,
    deadline: 0,
    opportunity: 0,
    final_score: finalScore,
    dominant_drive: "dissatisfaction",
  });

  it("sorts descending by final_score", () => {
    const scores = [
      makeScore("low", 0.1),
      makeScore("high", 0.9),
      makeScore("mid", 0.5),
    ];
    const ranked = rankDimensions(scores);
    expect(ranked[0]!.dimension_name).toBe("high");
    expect(ranked[1]!.dimension_name).toBe("mid");
    expect(ranked[2]!.dimension_name).toBe("low");
  });

  it("does not mutate the original array", () => {
    const scores = [makeScore("a", 0.3), makeScore("b", 0.7)];
    const original = [...scores];
    rankDimensions(scores);
    expect(scores[0]!.dimension_name).toBe(original[0]!.dimension_name);
  });

  it("single element returns same element", () => {
    const scores = [makeScore("only", 0.5)];
    const ranked = rankDimensions(scores);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.dimension_name).toBe("only");
  });

  it("empty array returns empty array", () => {
    const ranked = rankDimensions([]);
    expect(ranked).toHaveLength(0);
  });

  it("equal scores are broken by dimension_name lexicographic ascending", () => {
    const scores = [makeScore("charlie", 0.5), makeScore("alpha", 0.5), makeScore("bravo", 0.5)];
    const ranked = rankDimensions(scores);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((s) => s.dimension_name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("two elements with identical name and score maintain stable relative order (comparator returns 0)", () => {
    // Exercises the `0` branch of the ternary: a.dimension_name === b.dimension_name
    const s1: import("../src/types/drive.js").DriveScore = {
      dimension_name: "same",
      dissatisfaction: 0.5,
      deadline: 0,
      opportunity: 0,
      final_score: 0.5,
      dominant_drive: "dissatisfaction",
    };
    const s2: import("../src/types/drive.js").DriveScore = {
      dimension_name: "same",
      dissatisfaction: 0.5,
      deadline: 0,
      opportunity: 0,
      final_score: 0.5,
      dominant_drive: "dissatisfaction",
    };
    const ranked = rankDimensions([s1, s2]);
    expect(ranked).toHaveLength(2);
    // Both have the same name and score — order is stable (0 returned by comparator)
    ranked.forEach((r) => expect(r.dimension_name).toBe("same"));
  });
});

// ─── scoreAllDimensions — edge cases ───

describe("scoreAllDimensions — edge cases", () => {
  it("dimension missing from time_since_last_attempt defaults timeSince to 0", () => {
    const gv: GapVector = {
      goal_id: "goal-1",
      gaps: [
        {
          dimension_name: "unknown_dim",
          raw_gap: 0.5,
          normalized_gap: 0.5,
          normalized_weighted_gap: 0.5,
          confidence: 0.9,
          uncertainty_weight: 1.0,
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const ctx: DriveContext = {
      time_since_last_attempt: {}, // no entry for "unknown_dim" → defaults to 0
      deadlines: {},
      opportunities: {},
    };

    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    expect(scores).toHaveLength(1);
    // At t=0, decay_factor = decay_floor = 0.3
    expect(scores[0]!.dissatisfaction).toBeCloseTo(0.5 * 0.3, 5);
  });

  it("opportunity explicitly null in context falls back to scoreOpportunity(0, 0)", () => {
    const gv: GapVector = {
      goal_id: "goal-1",
      gaps: [
        {
          dimension_name: "dim_null_opp",
          raw_gap: 0.4,
          normalized_gap: 0.4,
          normalized_weighted_gap: 0.4,
          confidence: 0.8,
          uncertainty_weight: 1.0,
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const ctx: DriveContext = {
      time_since_last_attempt: { dim_null_opp: 0 },
      deadlines: { dim_null_opp: null },
      opportunities: { dim_null_opp: null as any }, // explicitly null → fallback path
    };

    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    expect(scores).toHaveLength(1);
    // opportunity score should be 0 (value=0, freshness_decay=1)
    expect(scores[0]!.opportunity).toBe(0);
  });

  it("empty gaps array returns empty scores", () => {
    const gv: GapVector = {
      goal_id: "goal-1",
      gaps: [],
      timestamp: new Date().toISOString(),
    };
    const ctx: DriveContext = {
      time_since_last_attempt: {},
      deadlines: {},
      opportunities: {},
    };
    const scores = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    expect(scores).toHaveLength(0);
  });

  it("uses default config when none provided", () => {
    const gv: GapVector = {
      goal_id: "goal-1",
      gaps: [
        {
          dimension_name: "dim",
          raw_gap: 0.5,
          normalized_gap: 0.5,
          normalized_weighted_gap: 0.5,
          confidence: 0.8,
          uncertainty_weight: 1.0,
        },
      ],
      timestamp: new Date().toISOString(),
    };
    const ctx: DriveContext = {
      time_since_last_attempt: { dim: 0 },
      deadlines: {},
      opportunities: {},
    };
    const withDefault = scoreAllDimensions(gv, ctx);
    const withExplicit = scoreAllDimensions(gv, ctx, DEFAULT_CONFIG);
    expect(withDefault[0]!.final_score).toBeCloseTo(withExplicit[0]!.final_score, 5);
  });
});
