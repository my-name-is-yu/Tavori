import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../src/state/state-manager.js";
import { StallDetector } from "../src/drive/stall-detector.js";
import type { StallTaskHistoryEntry } from "../src/drive/stall-detector.js";
import { makeTempDir } from "./helpers/temp-dir.js";

let tempDir: string;
let stateManager: StateManager;
let detector: StallDetector;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  detector = new StallDetector(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("detectRepetitivePatterns", () => {
  it("returns not repetitive when history is too short", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "did something" },
      { strategy_id: "s1", output: "did something" },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(false);
    expect(result.pattern).toBeNull();
  });

  it("detects identical_actions when same strategy and similar output repeated 3+ times", () => {
    const output = "Ran the test suite and updated 3 files with the same approach each time.";
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "strategy-abc", output },
      { strategy_id: "strategy-abc", output },
      { strategy_id: "strategy-abc", output },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(true);
    expect(result.pattern).toBe("identical_actions");
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("detects oscillating pattern when outputs alternate A→B→A→B", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "output-alpha" },
      { strategy_id: "s2", output: "output-beta" },
      { strategy_id: "s1", output: "output-alpha" },
      { strategy_id: "s2", output: "output-beta" },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(true);
    expect(result.pattern).toBe("oscillating");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects no_change when outputs repeatedly say no changes made", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "Checked files. No changes made." },
      { strategy_id: "s1", output: "Reviewed code. No changes made to the codebase." },
      { strategy_id: "s2", output: "Inspected state. No changes made at this time." },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(true);
    expect(result.pattern).toBe("no_change");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("returns not repetitive for genuinely different outputs", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "Updated authentication module with OAuth2 support" },
      { strategy_id: "s2", output: "Refactored database layer to use connection pooling" },
      { strategy_id: "s3", output: "Added rate limiting middleware to API endpoints" },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(false);
    expect(result.pattern).toBeNull();
  });

  it("does not flag identical_actions when strategy_id is null", () => {
    const output = "Ran command. Exit code 0.";
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: null, output },
      { strategy_id: null, output },
      { strategy_id: null, output },
    ];
    const result = detector.detectRepetitivePatterns(history);
    // null strategy_id should not trigger identical_actions
    expect(result.pattern).not.toBe("identical_actions");
  });
});
