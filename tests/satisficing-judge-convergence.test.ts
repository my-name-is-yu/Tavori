import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { SatisficingJudge } from "../src/drive/satisficing-judge.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Setup ───

let tempDir: string;
let stateManager: StateManager;
let judge: SatisficingJudge;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  judge = new SatisficingJudge(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helper ───

/**
 * Feed N identical gap values into the ring buffer by calling judgeConvergence N times.
 */
function feedGaps(j: SatisficingJudge, key: string, gaps: number[], threshold: number) {
  let result = { status: "in_progress", gap: 0, variance: null as number | null, window_size: 5, samples_available: 0 };
  for (const gap of gaps) {
    result = j.judgeConvergence(key, gap, threshold);
  }
  return result;
}

// ─── judgeConvergence ───

describe("judgeConvergence: satisficed (gap < threshold)", () => {
  it("returns satisficed when gap is below the threshold", () => {
    const result = judge.judgeConvergence("goal1:dim1", 0.05, 0.10);
    expect(result.status).toBe("satisficed");
    expect(result.gap).toBe(0.05);
  });

  it("gap exactly equal to threshold is NOT satisficed (boundary: < not <=)", () => {
    const result = judge.judgeConvergence("goal1:dim1", 0.10, 0.10);
    // gap == threshold → not satisficed, falls through to convergence check
    // only 1 sample → variance is null → in_progress
    expect(result.status).toBe("in_progress");
  });
});

describe("judgeConvergence: converged_satisficed (flat gap within acceptable range)", () => {
  it("returns converged_satisficed for 5 identical gap values within threshold × 1.5", () => {
    // threshold=0.10, acceptable = 0.10 × 1.5 = 0.15
    // gap=0.13 < 0.15 → converged_satisficed
    const result = feedGaps(judge, "goal1:dim1", [0.13, 0.13, 0.13, 0.13, 0.13], 0.10);
    expect(result.status).toBe("converged_satisficed");
  });

  it("returns converged_satisficed when variance is very small but nonzero", () => {
    // tiny jitter around 0.12, threshold=0.10 → acceptable=0.15
    const result = feedGaps(judge, "goal1:dim1", [0.12, 0.121, 0.119, 0.120, 0.121], 0.10);
    expect(result.status).toBe("converged_satisficed");
    expect(result.variance).not.toBeNull();
    expect(result.variance!).toBeLessThan(0.01);
  });

  it("gap exactly at threshold × 1.5 is converged_satisficed (boundary: <= not <)", () => {
    // threshold=0.10, acceptable=0.15, gap=0.15 → converged_satisficed
    const result = feedGaps(judge, "goal1:dim1", [0.15, 0.15, 0.15, 0.15, 0.15], 0.10);
    expect(result.status).toBe("converged_satisficed");
  });
});

describe("judgeConvergence: stalled (flat gap above acceptable range)", () => {
  it("returns stalled for flat gap values above threshold × 1.5", () => {
    // threshold=0.10, acceptable=0.15; gap=0.20 > 0.15 → stalled
    const result = feedGaps(judge, "goal1:dim1", [0.20, 0.20, 0.20, 0.20, 0.20], 0.10);
    expect(result.status).toBe("stalled");
  });

  it("returns stalled for near-zero variance but high gap", () => {
    // Small jitter at 0.25, threshold=0.10 → acceptable=0.15
    const result = feedGaps(judge, "goal1:dim1", [0.25, 0.251, 0.249, 0.250, 0.251], 0.10);
    expect(result.status).toBe("stalled");
  });
});

describe("judgeConvergence: in_progress (high variance / decreasing)", () => {
  it("returns in_progress when gap is decreasing (high variance)", () => {
    // Decreasing gaps: variance will be large → in_progress
    const result = feedGaps(judge, "goal1:dim1", [0.50, 0.40, 0.30, 0.20, 0.15], 0.10);
    expect(result.status).toBe("in_progress");
    expect(result.variance).not.toBeNull();
    expect(result.variance!).toBeGreaterThanOrEqual(0.01);
  });

  it("returns in_progress when oscillating (high variance)", () => {
    const result = feedGaps(judge, "goal1:dim1", [0.40, 0.20, 0.45, 0.18, 0.42], 0.10);
    expect(result.status).toBe("in_progress");
  });
});

describe("judgeConvergence: ring buffer boundary (fewer than N values)", () => {
  it("returns in_progress with null variance when only 1 sample", () => {
    const result = judge.judgeConvergence("goal1:dim1", 0.20, 0.10);
    expect(result.status).toBe("in_progress");
    expect(result.variance).toBeNull();
    expect(result.samples_available).toBe(1);
  });

  it("returns in_progress with null variance when only 1 sample (< 2 for variance)", () => {
    const result = feedGaps(judge, "goal1:dim1", [0.20], 0.10);
    expect(result.variance).toBeNull();
  });

  it("has variance once 2+ samples present but may not be converged yet", () => {
    const result = feedGaps(judge, "goal1:dim1", [0.20, 0.20], 0.10);
    expect(result.variance).not.toBeNull();
    expect(result.variance).toBe(0); // two identical values → variance=0
    // 2 samples, variance=0, but only 2 of 5 window → should still be checked
    // gap=0.20 > threshold × 1.5 = 0.15 → stalled
    expect(result.status).toBe("stalled");
  });

  it("window_size is always reported as 5 and samples_available grows to max 5", () => {
    const results = [0.20, 0.20, 0.20, 0.20, 0.20, 0.20].map((g) =>
      judge.judgeConvergence("goal1:dim1", g, 0.10)
    );
    expect(results[results.length - 1]!.window_size).toBe(5);
    expect(results[results.length - 1]!.samples_available).toBe(5); // capped at 5
  });
});

describe("judgeConvergence: variance calculation correctness", () => {
  it("computes variance = 0 for identical values", () => {
    const result = feedGaps(judge, "key", [0.3, 0.3, 0.3, 0.3, 0.3], 0.10);
    expect(result.variance).toBe(0);
  });

  it("variance matches manual calculation for known values", () => {
    // values: [0.1, 0.2, 0.3, 0.4, 0.5], mean=0.3
    // squared diffs: [0.04, 0.01, 0, 0.01, 0.04], sum=0.10, variance=0.02
    const result = feedGaps(judge, "key", [0.1, 0.2, 0.3, 0.4, 0.5], 0.10);
    expect(result.variance).toBeCloseTo(0.02, 10);
    // gap=0.5 > threshold=0.10 (satisficed check fails)
    // variance=0.02 >= 0.01 → in_progress
    expect(result.status).toBe("in_progress");
  });
});

describe("judgeConvergence: multiple independent keys do not interfere", () => {
  it("two different keys maintain separate ring buffers", () => {
    feedGaps(judge, "goal1:dim1", [0.20, 0.20, 0.20, 0.20, 0.20], 0.10);
    // goal2:dim1 has fresh buffer with only 1 sample
    const result = judge.judgeConvergence("goal2:dim1", 0.20, 0.10);
    expect(result.samples_available).toBe(1);
    expect(result.variance).toBeNull();
  });
});

describe("clearGapHistory", () => {
  it("resets the ring buffer so next call starts fresh", () => {
    feedGaps(judge, "goal1:dim1", [0.20, 0.20, 0.20, 0.20, 0.20], 0.10);
    judge.clearGapHistory("goal1:dim1");
    const result = judge.judgeConvergence("goal1:dim1", 0.20, 0.10);
    expect(result.samples_available).toBe(1);
    expect(result.variance).toBeNull();
    expect(result.status).toBe("in_progress");
  });
});

describe("judgeConvergence: existing satisficed behavior is unchanged", () => {
  it("satisficed takes priority over convergence check (gap < threshold always wins)", () => {
    // Even if we have 5 flat values below the threshold, it should be satisficed (not converged_satisficed)
    const result = feedGaps(judge, "goal1:dim1", [0.05, 0.05, 0.05, 0.05, 0.05], 0.10);
    expect(result.status).toBe("satisficed");
  });

  it("satisficed does not require full ring buffer", () => {
    const result = judge.judgeConvergence("goal1:dim1", 0.00, 0.10);
    expect(result.status).toBe("satisficed");
    expect(result.samples_available).toBe(1);
  });
});
