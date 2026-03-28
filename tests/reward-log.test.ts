import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isRewardLogEnabled, logRewardComputation } from "../src/drive/reward-log.js";
import type { DriveScore } from "../src/types/drive.js";
import type { CompletionJudgment } from "../src/types/satisficing.js";

// Minimal DriveScore fixture
function makeScore(dimension: string, score: number): DriveScore {
  return {
    dimension_name: dimension,
    dissatisfaction: score,
    deadline: 0,
    opportunity: 0,
    final_score: score,
    dominant_drive: "dissatisfaction",
  };
}

// Minimal CompletionJudgment fixture
function makeJudgment(isComplete: boolean, blocking: string[] = []): CompletionJudgment {
  return {
    is_complete: isComplete,
    blocking_dimensions: blocking,
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
  };
}

describe("isRewardLogEnabled", () => {
  beforeEach(() => {
    delete process.env["PULSEED_REWARD_LOG"];
  });

  it("returns false when env var is not set", () => {
    expect(isRewardLogEnabled()).toBe(false);
  });

  it("returns true when PULSEED_REWARD_LOG=1", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";
    expect(isRewardLogEnabled()).toBe(true);
  });

  it("returns false when PULSEED_REWARD_LOG=0", () => {
    process.env["PULSEED_REWARD_LOG"] = "0";
    expect(isRewardLogEnabled()).toBe(false);
  });

  it("returns false when PULSEED_REWARD_LOG=true (not exactly '1')", () => {
    process.env["PULSEED_REWARD_LOG"] = "true";
    expect(isRewardLogEnabled()).toBe(false);
  });
});

describe("logRewardComputation", () => {
  let stderrOutput: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrOutput = "";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
    delete process.env["PULSEED_REWARD_LOG"];
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env["PULSEED_REWARD_LOG"];
  });

  it("produces no output when disabled (default)", () => {
    logRewardComputation({
      goalId: "g1",
      iteration: 0,
      gapAggregate: 0.5,
      confidenceAvg: 0.8,
      trustScore: null,
      driveScores: [makeScore("coverage", 0.5)],
      completionJudgment: null,
    });

    expect(stderrOutput).toBe("");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("produces exactly one JSON line when enabled", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";

    logRewardComputation({
      goalId: "g1",
      iteration: 3,
      gapAggregate: 0.4,
      confidenceAvg: 0.75,
      trustScore: null,
      driveScores: [makeScore("coverage", 0.4)],
      completionJudgment: makeJudgment(false, ["coverage"]),
    });

    expect(stderrOutput).not.toBe("");
    const lines = stderrOutput.trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("output is valid JSON when enabled", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";

    logRewardComputation({
      goalId: "g42",
      iteration: 1,
      gapAggregate: 0.6,
      confidenceAvg: 0.9,
      trustScore: 50,
      driveScores: [makeScore("tests", 0.6)],
      completionJudgment: makeJudgment(false, ["tests"]),
    });

    expect(() => JSON.parse(stderrOutput.trim())).not.toThrow();
  });

  it("JSON contains all required top-level fields", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";

    logRewardComputation({
      goalId: "goal-xyz",
      iteration: 2,
      gapAggregate: 0.3,
      confidenceAvg: 0.85,
      trustScore: 20,
      driveScores: [makeScore("performance", 0.3)],
      completionJudgment: makeJudgment(false, ["performance"]),
    });

    const parsed = JSON.parse(stderrOutput.trim()) as Record<string, unknown>;

    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("goal_id", "goal-xyz");
    expect(parsed).toHaveProperty("iteration", 2);
    expect(parsed).toHaveProperty("gap_aggregate", 0.3);
    expect(parsed).toHaveProperty("confidence_avg", 0.85);
    expect(parsed).toHaveProperty("trust_score", 20);
    expect(parsed).toHaveProperty("drive_scores");
    expect(parsed).toHaveProperty("top_dimension", "performance");
    expect(parsed).toHaveProperty("is_complete", false);
    expect(parsed).toHaveProperty("blocking_dimensions");
  });

  it("drive_scores array contains expected fields per dimension", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";

    logRewardComputation({
      goalId: "g1",
      iteration: 0,
      gapAggregate: 0.5,
      confidenceAvg: 0.7,
      trustScore: null,
      driveScores: [
        { ...makeScore("dim_a", 0.5), deadline: 0.2, opportunity: 0.1 },
      ],
      completionJudgment: null,
    });

    const parsed = JSON.parse(stderrOutput.trim()) as { drive_scores: Array<Record<string, unknown>> };
    const dimEntry = parsed.drive_scores[0]!;

    expect(dimEntry).toHaveProperty("dimension", "dim_a");
    expect(dimEntry).toHaveProperty("dissatisfaction");
    expect(dimEntry).toHaveProperty("deadline");
    expect(dimEntry).toHaveProperty("opportunity");
    expect(dimEntry).toHaveProperty("final_score");
    expect(dimEntry).toHaveProperty("dominant_drive");
  });

  it("top_dimension is null when driveScores is empty", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";

    logRewardComputation({
      goalId: "g1",
      iteration: 0,
      gapAggregate: 0,
      confidenceAvg: 0,
      trustScore: null,
      driveScores: [],
      completionJudgment: null,
    });

    const parsed = JSON.parse(stderrOutput.trim()) as Record<string, unknown>;
    expect(parsed.top_dimension).toBeNull();
    expect(parsed.is_complete).toBe(false);
    expect(parsed.blocking_dimensions).toEqual([]);
  });

  it("is_complete reflects completion judgment when provided", () => {
    process.env["PULSEED_REWARD_LOG"] = "1";

    logRewardComputation({
      goalId: "g1",
      iteration: 5,
      gapAggregate: 0,
      confidenceAvg: 1,
      trustScore: null,
      driveScores: [],
      completionJudgment: makeJudgment(true),
    });

    const parsed = JSON.parse(stderrOutput.trim()) as Record<string, unknown>;
    expect(parsed.is_complete).toBe(true);
    expect(parsed.blocking_dimensions).toEqual([]);
  });
});
