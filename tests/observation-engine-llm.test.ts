import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import { GapCalculator } from "../src/drive/gap-calculator.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import type { IDataSourceAdapter } from "../src/observation/data-source-adapter.js";
import type { DataSourceConfig } from "../src/types/data-source.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Fake workspace context (prevents no-evidence guard from zeroing LLM scores) ───

const fakeWorkspaceContext = "File: src/main.ts\nconst quality = 0.75; // measured by linter";
const fakeGitContextFetcher = () => fakeWorkspaceContext;

// ─── Helpers ───

const defaultMethod: ObservationMethod = {
  type: "llm_review",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "independent_review",
};

const selfReportMethod: ObservationMethod = {
  type: "manual",
  source: "self",
  schedule: null,
  endpoint: null,
  confidence_tier: "self_report",
};

function makeDsConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "mock-ds",
    name: "Mock Data Source",
    type: "file",
    connection: { path: "/tmp/mock.json" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockDataSource(
  overrides: Partial<IDataSourceAdapter> = {},
  supportedDimensions: string[] = ["code_quality"]
): IDataSourceAdapter {
  return {
    sourceId: "mock-ds",
    sourceType: "file",
    config: makeDsConfig(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: 0.85,
      raw: { metrics: { quality: 0.85 } },
      timestamp: new Date().toISOString(),
      source_id: "mock-ds",
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    getSupportedDimensions: vi.fn().mockReturnValue(supportedDimensions),
    ...overrides,
  };
}

function createMockLLMClient(
  score: number = 0.75,
  reason: string = "test reason"
): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason }),
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason }),
  };
}

// ─── Tests ───

describe("ObservationEngine LLM observation", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: observeWithLLM returns independent_review observation ───

  describe("observeWithLLM", () => {
    it("returns an independent_review observation entry", async () => {
      const mockLLMClient = createMockLLMClient(0.75, "Good progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-llm-1" });
      await stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-llm-1",
        "dim1",
        "Improve code quality to 80%",
        "Code Quality",
        "min 0.8 (80%)",
        fakeWorkspaceContext
      );

      expect(entry.layer).toBe("independent_review");
      expect(entry.extracted_value).toBe(0.75);
      expect(entry.confidence).toBeGreaterThanOrEqual(0.50);
      expect(entry.confidence).toBeLessThanOrEqual(0.84);
      expect(entry.method.type).toBe("llm_review");
    });

    it("clamps confidence to independent_review range [0.50, 0.84]", async () => {
      // Even if score is at boundary values, confidence should be clamped
      const mockLLMClientHigh = createMockLLMClient(0.99, "Excellent");
      const engineHigh = new ObservationEngine(stateManager, [], mockLLMClientHigh);

      const goal = makeGoal({ id: "goal-clamp-high" });
      await stateManager.saveGoal(goal);

      const entryHigh = await engineHigh.observeWithLLM(
        "goal-clamp-high",
        "dim1",
        "Test goal",
        "Code Quality",
        "min 0.8",
        fakeWorkspaceContext
      );
      expect(entryHigh.confidence).toBeLessThanOrEqual(0.84);
    });

    it("sets method.confidence_tier to independent_review", async () => {
      const mockLLMClient = createMockLLMClient(0.6, "Moderate progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-tier" });
      await stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-tier",
        "dim1",
        "Improve quality",
        "Code Quality",
        "min 0.8",
        fakeWorkspaceContext
      );

      expect(entry.method.confidence_tier).toBe("independent_review");
    });
  });

  // ─── Test 2: observe() uses LLM fallback when no DataSource ───

  describe("observe() with LLM fallback (no DataSource)", () => {
    it("uses LLM observation (independent_review) when no DataSource but git context is available", async () => {
      const mockLLMClient = createMockLLMClient(0.72, "LLM observed value");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient, undefined, { gitContextFetcher: fakeGitContextFetcher });

      const goal = makeGoal({ id: "goal-llm-fallback" });
      await stateManager.saveGoal(goal);

      await engine.observe("goal-llm-fallback", [defaultMethod]);

      const updatedGoal = await stateManager.loadGoal("goal-llm-fallback");
      expect(updatedGoal).not.toBeNull();

      // Check the observation log for the layer used.
      // When no DataSource but git context IS available, layer upgrades to independent_review.
      // self_report is only used when BOTH sourceAvailable=false AND no context.
      const log = await engine.getObservationLog("goal-llm-fallback");
      expect(log.entries.length).toBeGreaterThan(0);

      const lastEntry = log.entries[log.entries.length - 1]!;
      expect(lastEntry.layer).toBe("independent_review");
      expect(lastEntry.goal_id).toBe("goal-llm-fallback");
    });

    it("LLM sendMessage is called when no DataSource available", async () => {
      const mockLLMClient = createMockLLMClient(0.65, "progress noted");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient, undefined, { gitContextFetcher: fakeGitContextFetcher });

      const goal = makeGoal({ id: "goal-llm-called" });
      await stateManager.saveGoal(goal);

      await engine.observe("goal-llm-called", [defaultMethod]);

      expect(mockLLMClient.sendMessage).toHaveBeenCalled();
    });
  });

  // ─── Test 3: DataSource takes priority over LLM ───

  describe("observe() uses DataSource over LLM when DataSource available", () => {
    it("DataSource is queried when it supports the dimension", async () => {
      const mockLLMClient = createMockLLMClient(0.5, "LLM result");
      const mockDs = makeMockDataSource({}, ["dim1"]);
      const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

      const goal = makeGoal({ id: "goal-ds-priority" });
      await stateManager.saveGoal(goal);

      await engine.observe("goal-ds-priority", [defaultMethod]);

      // DataSource query should have been called
      expect(mockDs.query).toHaveBeenCalled();
    });

    it("LLM is NOT called when DataSource handles the dimension", async () => {
      const mockLLMClient = createMockLLMClient(0.5, "LLM result");
      const mockDs = makeMockDataSource({}, ["dim1"]);
      const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

      const goal = makeGoal({ id: "goal-ds-no-llm" });
      await stateManager.saveGoal(goal);

      await engine.observe("goal-ds-no-llm", [defaultMethod]);

      // LLM should NOT have been called
      expect(mockLLMClient.sendMessage).not.toHaveBeenCalled();
    });

    it("observation layer is mechanical when DataSource is used", async () => {
      const mockLLMClient = createMockLLMClient(0.5, "LLM result");
      const mockDs = makeMockDataSource({}, ["dim1"]);
      const engine = new ObservationEngine(stateManager, [mockDs], mockLLMClient);

      const goal = makeGoal({ id: "goal-mechanical-layer" });
      await stateManager.saveGoal(goal);

      await engine.observe("goal-mechanical-layer", [defaultMethod]);

      const log = await engine.getObservationLog("goal-mechanical-layer");
      expect(log.entries.length).toBeGreaterThan(0);

      const lastEntry = log.entries[log.entries.length - 1]!;
      expect(lastEntry.layer).toBe("mechanical");
    });
  });

  // ─── Test 4: Falls back to self_report when no DataSource and no LLM ───

  describe("observe() falls back to self_report when no DataSource and no llmClient", () => {
    it("uses self_report layer when neither DataSource nor LLM is available", async () => {
      const engine = new ObservationEngine(stateManager); // no dataSources, no llmClient

      const goal = makeGoal({ id: "goal-self-report" });
      await stateManager.saveGoal(goal);

      // observe() is currently synchronous but may become async — use await for compatibility
      await Promise.resolve(engine.observe("goal-self-report", [selfReportMethod]));

      const log = await engine.getObservationLog("goal-self-report");
      expect(log.entries.length).toBeGreaterThan(0);

      const lastEntry = log.entries[log.entries.length - 1]!;
      expect(lastEntry.layer).toBe("self_report");
    });

    it("self_report layer preserves the stored current_value", async () => {
      const engine = new ObservationEngine(stateManager);

      const goal = makeGoal({
        id: "goal-self-report-value",
        dimensions: [
          {
            name: "code_quality",
            label: "Code Quality",
            current_value: 0.42,
            threshold: { type: "min", value: 0.8 },
            confidence: 0.3,
            observation_method: selfReportMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      await Promise.resolve(engine.observe("goal-self-report-value", [selfReportMethod]));

      const updatedGoal = await stateManager.loadGoal("goal-self-report-value");
      expect(updatedGoal).not.toBeNull();
      const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
      expect(dim).not.toBeNull();
      expect(dim!.current_value).toBe(0.42); // value preserved
    });
  });

  // ─── Test 5: Integration — LLM observation score used in gap calculation ───

  describe("Integration: LLM observation score flows into GapCalculator", () => {
    it("gap reflects the LLM-observed score", async () => {
      // LLM returns score = 0.72, threshold min = 0.8 → gap should be non-zero
      const mockLLMClient = createMockLLMClient(0.72, "72% quality achieved");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({
        id: "goal-gap-integration",
        dimensions: [
          {
            name: "code_quality",
            label: "Code Quality",
            current_value: 0.5, // initial value — will be updated by LLM observation
            threshold: { type: "min", value: 0.8 },
            confidence: 0.3,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      // Perform LLM observation
      await engine.observeWithLLM(
        "goal-gap-integration",
        "code_quality",
        "Improve code quality to 80%",
        "Code Quality",
        "min 0.8",
        fakeWorkspaceContext
      );

      // Load updated goal
      const updatedGoal = await stateManager.loadGoal("goal-gap-integration");
      expect(updatedGoal).not.toBeNull();

      const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
      expect(dim).not.toBeNull();

      // Compute gap: current_value should now be 0.72 (from LLM), threshold.min = 0.8
      // raw gap = max(0, 0.8 - 0.72) = 0.08
      const { computeRawGap } = await import("../src/drive/gap-calculator.js");
      const rawGap = computeRawGap(dim!.current_value, dim!.threshold);

      // Gap should reflect the LLM score (0.72), not the initial value (0.5)
      // raw gap for LLM score: max(0, 0.8 - 0.72) = 0.08
      expect(dim!.current_value).toBe(0.72);
      expect(rawGap).toBeCloseTo(0.08, 5);
    });

    it("gap is zero when LLM reports score meets the threshold", async () => {
      // LLM returns score = 0.9, threshold min = 0.8 → gap should be zero
      const mockLLMClient = createMockLLMClient(0.9, "90% quality achieved");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({
        id: "goal-gap-zero",
        dimensions: [
          {
            name: "code_quality",
            label: "Code Quality",
            current_value: 0.3,
            threshold: { type: "min", value: 0.8 },
            confidence: 0.3,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      await engine.observeWithLLM(
        "goal-gap-zero",
        "code_quality",
        "Improve code quality to 80%",
        "Code Quality",
        "min 0.8",
        fakeWorkspaceContext
      );

      const updatedGoal = await stateManager.loadGoal("goal-gap-zero");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "code_quality");
      expect(dim).not.toBeNull();

      const { computeRawGap } = await import("../src/drive/gap-calculator.js");
      const rawGap = computeRawGap(dim!.current_value, dim!.threshold);

      expect(dim!.current_value).toBe(0.9);
      expect(rawGap).toBe(0); // 0.9 >= 0.8, so no gap
    });
  });

  // ─── Test 6 (bug #233): previousScore is derived from history, not current_value ───

  describe("observe(): previousScore passed to observeWithLLM (bug #233)", () => {
    it("passes previousScore=null when history is empty, even if current_value is non-zero", async () => {
      // Simulate a verifier-written high value: current_value=0.9 but no prior observations
      const mockLLMClient = createMockLLMClient(0.9, "high value");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient, undefined, {
        gitContextFetcher: fakeGitContextFetcher,
      });

      const goal = makeGoal({
        id: "goal-bug233-empty-history",
        dimensions: [
          {
            name: "dim1",
            label: "Dimension 1",
            current_value: 0.9, // verifier-written — NOT a real prior observation
            threshold: { type: "min", value: 0.8 },
            confidence: 0.8,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [], // no real observations yet
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      // Spy on the instance method to capture the previousScore argument
      const observeWithLLMSpy = vi.spyOn(engine, "observeWithLLM");

      await engine.observe("goal-bug233-empty-history", [defaultMethod]);

      expect(observeWithLLMSpy).toHaveBeenCalled();
      // 6th argument (index 6) is previousScore — must be null, not 0.9
      const callArgs = observeWithLLMSpy.mock.calls[0]!;
      const previousScoreArg = callArgs[6]; // previousScore parameter
      expect(previousScoreArg).toBeNull();
    });

    it("passes previousScore from last history entry, not from current_value", async () => {
      // current_value=0.9 (verifier-written) but last history entry has value=0.55
      const mockLLMClient = createMockLLMClient(0.8, "progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient, undefined, {
        gitContextFetcher: fakeGitContextFetcher,
      });

      const now = new Date().toISOString();
      const goal = makeGoal({
        id: "goal-bug233-history-entries",
        dimensions: [
          {
            name: "dim1",
            label: "Dimension 1",
            current_value: 0.9, // verifier-written — should NOT be used as previousScore
            threshold: { type: "min", value: 0.8 },
            confidence: 0.8,
            observation_method: defaultMethod,
            last_updated: now,
            history: [
              { value: 0.4, timestamp: now, confidence: 0.7, source_observation_id: "obs-1" },
              { value: 0.55, timestamp: now, confidence: 0.7, source_observation_id: "obs-2" },
            ],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
          },
        ],
      });
      await stateManager.saveGoal(goal);

      const observeWithLLMSpy = vi.spyOn(engine, "observeWithLLM");

      await engine.observe("goal-bug233-history-entries", [defaultMethod]);

      expect(observeWithLLMSpy).toHaveBeenCalled();
      const callArgs = observeWithLLMSpy.mock.calls[0]!;
      const previousScoreArg = callArgs[6]; // previousScore parameter
      // Must come from the last history entry (0.55), not from current_value (0.9)
      expect(previousScoreArg).toBe(0.55);
    });
  });

  // ─── Test 7: contextProvider output is included in the LLM prompt ───

  describe("observeWithLLM: workspace context injection", () => {
    it("includes contextProvider output in the LLM prompt", async () => {
      const contextOutput = "File: src/foo.ts\nconst quality = 0.92; // measured";
      const contextProvider = vi.fn().mockResolvedValue(contextOutput);
      const mockLLMClient = createMockLLMClient(0.85, "context provided");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient, contextProvider);

      const goal = makeGoal({ id: "goal-ctx-provider" });
      await stateManager.saveGoal(goal);

      // Call observeWithLLM with the context already provided (simulates observe() flow)
      await engine.observeWithLLM(
        "goal-ctx-provider",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 }),
        contextOutput // pass context directly, as observe() would
      );

      // The LLM prompt should contain the context output
      const sendMessageCalls = (mockLLMClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(sendMessageCalls.length).toBeGreaterThan(0);
      const promptArg: string = sendMessageCalls[0][0][0].content;
      expect(promptArg).toContain("src/foo.ts");
      expect(promptArg).toContain("const quality = 0.92");
    });

    it("falls back to git diff when no workspaceContext is provided", async () => {
      // Inject a fake gitContextFetcher that returns simulated git diff output
      const fakeGitContext =
        "[git diff --stat]\n src/foo.ts | 2 +-\n 1 file changed\n\n" +
        "[git diff]\ndiff --git a/src/foo.ts b/src/foo.ts\n+const x = 1;";
      const gitContextFetcher = vi.fn().mockReturnValue(fakeGitContext);

      const mockLLMClient = createMockLLMClient(0.7, "git diff fallback");
      const engine = new ObservationEngine(
        stateManager,
        [],
        mockLLMClient,
        undefined,
        { gitContextFetcher }
      );

      const goal = makeGoal({ id: "goal-git-fallback" });
      await stateManager.saveGoal(goal);

      // Call with no workspaceContext — should trigger git diff fallback
      await engine.observeWithLLM(
        "goal-git-fallback",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 })
        // no workspaceContext passed
      );

      // gitContextFetcher should have been called
      expect(gitContextFetcher).toHaveBeenCalled();

      // The LLM prompt should contain the fake git diff output
      const sendMessageCalls = (mockLLMClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(sendMessageCalls.length).toBeGreaterThan(0);
      const promptArg: string = sendMessageCalls[0][0][0].content;
      expect(promptArg).toContain("git diff --stat");
      expect(promptArg).toContain("src/foo.ts");
    });

    it("truncates context to 16000 chars max", async () => {
      // Create context that exceeds 16000 chars
      const longContext = "x".repeat(20000);
      const mockLLMClient = createMockLLMClient(0.6, "truncated");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-truncate" });
      await stateManager.saveGoal(goal);

      await engine.observeWithLLM(
        "goal-truncate",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 }),
        longContext
      );

      // Verify the prompt was passed to sendMessage and the context is truncated
      const sendMessageCalls = (mockLLMClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(sendMessageCalls.length).toBeGreaterThan(0);
      const promptArg: string = sendMessageCalls[0][0][0].content;
      // Prompt should contain truncation marker
      expect(promptArg).toContain("(truncated)");
      // The full 5000-char context should NOT appear verbatim
      expect(promptArg).not.toContain("x".repeat(16001));
    });

    it("observation still works when both contextProvider and git diff fail", async () => {
      // Inject a gitContextFetcher that returns empty string (simulates non-git directory)
      const gitContextFetcher = vi.fn().mockReturnValue("");

      const mockLLMClient = createMockLLMClient(0.0, "no evidence available");
      const engine = new ObservationEngine(
        stateManager,
        [],
        mockLLMClient,
        undefined,
        { gitContextFetcher }
      );

      const goal = makeGoal({ id: "goal-no-context" });
      await stateManager.saveGoal(goal);

      // Should NOT throw — falls back gracefully and calls LLM with warning in prompt
      const entry = await engine.observeWithLLM(
        "goal-no-context",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 })
        // no workspaceContext, git context is empty
      );

      expect(entry.layer).toBe("independent_review");
      expect(typeof entry.extracted_value).toBe("number");

      // The prompt should include the "no workspace content" warning
      const sendMessageCalls = (mockLLMClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      expect(sendMessageCalls.length).toBeGreaterThan(0);
      const promptArg: string = sendMessageCalls[0][0][0].content;
      expect(promptArg).toContain("WARNING: No workspace content was provided");
    });
  });

  // ─── Test: sourceAvailable flag controls layer and confidence ───

  describe("observeWithLLM sourceAvailable flag", () => {
    it("uses independent_review layer and confidence=0.70 when sourceAvailable=false but context is available", async () => {
      const mockLLMClient = createMockLLMClient(0.75, "Good progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-no-source-1" });
      await stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-no-source-1",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 }),
        fakeWorkspaceContext,
        null,
        undefined,
        null,
        false // sourceAvailable=false, but fakeWorkspaceContext IS provided
      );

      // Context is available — even without a dataSource, workspace evidence justifies independent_review
      expect(entry.layer).toBe("independent_review");
      expect(entry.confidence).toBe(0.70);
      expect(entry.method.confidence_tier).toBe("independent_review");
    });

    it("uses independent_review layer and confidence=0.70 when sourceAvailable=true with context", async () => {
      const mockLLMClient = createMockLLMClient(0.75, "Good progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-with-source-1" });
      await stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-with-source-1",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 }),
        fakeWorkspaceContext,
        null,
        undefined,
        null,
        true // sourceAvailable
      );

      expect(entry.layer).toBe("independent_review");
      expect(entry.confidence).toBe(0.70);
      expect(entry.method.confidence_tier).toBe("independent_review");
    });

    it("defaults to independent_review behavior when sourceAvailable is not provided", async () => {
      const mockLLMClient = createMockLLMClient(0.75, "Good progress");
      const engine = new ObservationEngine(stateManager, [], mockLLMClient);

      const goal = makeGoal({ id: "goal-default-source" });
      await stateManager.saveGoal(goal);

      const entry = await engine.observeWithLLM(
        "goal-default-source",
        "dim1",
        "Improve code quality",
        "Code Quality",
        JSON.stringify({ type: "min", value: 0.8 }),
        fakeWorkspaceContext
      );

      expect(entry.layer).toBe("independent_review");
      expect(entry.confidence).toBeGreaterThanOrEqual(0.50);
    });
  });
});
