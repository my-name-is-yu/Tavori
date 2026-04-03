import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createWorkspaceContextProvider,
} from "../src/observation/workspace-context.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { StateManager } from "../src/state/state-manager.js";
import type { Goal } from "../src/types/goal.js";
import type { ObservationMethod } from "../src/types/core.js";
import type { ILLMClient } from "../src/llm/llm-client.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

// ─── Helpers ───

const defaultMethod: ObservationMethod = {
  type: "llm_review",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "independent_review",
};

const codeQualityDimension = {
  name: "code_quality",
  label: "Code Quality",
  current_value: 0.5,
  threshold: { type: "min" as const, value: 0.8 },
  confidence: 0.3,
  observation_method: defaultMethod,
  last_updated: new Date().toISOString(),
  history: [],
  weight: 1.0,
  uncertainty_weight: null,
  state_integrity: "ok" as const,
  dimension_mapping: null,
};

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

// ─── Group 1: createWorkspaceContextProvider ───

describe("createWorkspaceContextProvider", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns workspace context with keyword-matched files", async () => {
    // Create files where some names match goal description keywords
    fs.writeFileSync(path.join(tmpDir, "reporting-engine.ts"), "export class ReportingEngine {}");
    fs.writeFileSync(path.join(tmpDir, "auth-service.ts"), "export class AuthService {}");
    fs.writeFileSync(path.join(tmpDir, "database.ts"), "export class Database {}");

    // Goal description contains "reporting" — only reporting-engine.ts should be filename-matched
    const provider = createWorkspaceContextProvider(
      { workDir: tmpDir, maxFiles: 3 },
      (goalId) => goalId === "goal-1" ? "improve reporting quality" : undefined
    );

    const ctx = await provider("goal-1", "quality_score");
    expect(ctx).toContain("reporting-engine.ts");
  });

  it("always includes README.md and package.json regardless of keywords", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# My Project\nThis is a README.");
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name": "my-project", "version": "1.0.0"}');
    fs.writeFileSync(path.join(tmpDir, "unrelated.ts"), "export const x = 1;");

    // Goal description has no keywords matching README or package
    const provider = createWorkspaceContextProvider(
      { workDir: tmpDir, maxFiles: 5 },
      () => "improve xyz dimension"
    );

    const ctx = await provider("goal-readme", "xyz_dimension");
    expect(ctx).toContain("README.md");
    expect(ctx).toContain("package.json");
  });

  it("respects maxFiles limit for keyword-matched files", async () => {
    // Create enough files to exceed the small-workspace fast path (>10),
    // so keyword-based filtering is used and the maxFiles cap is respected.
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(tmpDir, `metric-module-${i}.ts`), `export const m${i} = ${i};`);
    }

    const provider = createWorkspaceContextProvider(
      { workDir: tmpDir, maxFiles: 3 },
      () => "improve metric accuracy"
    );

    const ctx = await provider("goal-limit", "accuracy");

    // Count how many ## headings for metric files appear
    const metricMatches = (ctx.match(/## metric-module-/g) ?? []).length;
    expect(metricMatches).toBeLessThanOrEqual(3);
  });

  it("handles empty workspace gracefully", async () => {
    // tmpDir exists but has no files
    const provider = createWorkspaceContextProvider(
      { workDir: tmpDir, maxFiles: 5 },
      () => "some goal description"
    );

    const ctx = await provider("goal-empty", "some_dimension");
    expect(ctx).toContain(`# Workspace: ${tmpDir}`);
    // Should not throw; context is valid string
    expect(typeof ctx).toBe("string");
  });

  it("excludes node_modules and .git directories from file search", async () => {
    // Create files inside excluded directories
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "some-package.ts"), "export const pkg = true;");
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0");

    // Create a normal file to confirm the provider works
    fs.writeFileSync(path.join(tmpDir, "src-file.ts"), "export const x = 1;");

    const provider = createWorkspaceContextProvider(
      { workDir: tmpDir, maxFiles: 10 },
      () => "some package config"
    );

    const ctx = await provider("goal-exclude", "some_dimension");
    // The directory listing may mention excluded dirs, but their file contents must NOT be included
    expect(ctx).not.toContain("some-package.ts");
    // .git config file content must not be included either
    expect(ctx).not.toContain("repositoryformatversion");
  });
});

// ─── Group 2: ObservationEngine contextProvider integration ───

describe("ObservationEngine contextProvider integration", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("contextProvider receives goalId and dimensionName", async () => {
    const contextProvider = vi.fn().mockResolvedValue("mock workspace context");
    const mockLLMClient = createMockLLMClient(0.7, "context received");

    const engine = new ObservationEngine(stateManager, [], mockLLMClient, contextProvider);

    const goal = makeGoal({ id: "goal-ctx-args", dimensions: [codeQualityDimension] });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-ctx-args", [defaultMethod]);

    expect(contextProvider).toHaveBeenCalled();
    const [calledGoalId, calledDimName] = contextProvider.mock.calls[0] as [string, string];
    expect(calledGoalId).toBe("goal-ctx-args");
    expect(calledDimName).toBe("code_quality");
  });

  it("context is passed to observeWithLLM prompt", async () => {
    const workspaceContextText = "=== UNIQUE_WORKSPACE_MARKER_FOR_TEST ===";
    const contextProvider = vi.fn().mockResolvedValue(workspaceContextText);

    let capturedPrompt: string | undefined;
    const mockLLMClient: ILLMClient = {
      sendMessage: vi.fn().mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
        capturedPrompt = messages[0]?.content ?? "";
        return {
          content: JSON.stringify({ score: 0.7, reason: "ok" }),
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn().mockReturnValue({ score: 0.7, reason: "ok" }),
    };

    const engine = new ObservationEngine(stateManager, [], mockLLMClient, contextProvider);

    const goal = makeGoal({ id: "goal-prompt-ctx", dimensions: [codeQualityDimension] });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-prompt-ctx", [defaultMethod]);

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toContain(workspaceContextText);
  });

  it("previous score is included in prompt when dimension has observation history", async () => {
    const contextProvider = vi.fn().mockResolvedValue("");

    let capturedPrompt: string | undefined;
    const mockLLMClient: ILLMClient = {
      sendMessage: vi.fn().mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
        capturedPrompt = messages[0]?.content ?? "";
        return {
          content: JSON.stringify({ score: 0.8, reason: "improved" }),
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn().mockReturnValue({ score: 0.8, reason: "improved" }),
    };

    const now = new Date().toISOString();
    const goal = makeGoal({
      id: "goal-prev-score",
      dimensions: [
        {
          name: "code_quality",
          label: "Code Quality",
          current_value: 0.63,
          threshold: { type: "min", value: 0.8 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: now,
          history: [{ value: 0.63, timestamp: now, confidence: 0.5, source_observation_id: "obs-seed-1" }],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const engine = new ObservationEngine(stateManager, [], mockLLMClient, contextProvider);
    await engine.observe("goal-prev-score", [defaultMethod]);

    expect(capturedPrompt).toBeDefined();
    // The prompt should mention the previous score (0.63)
    expect(capturedPrompt).toContain("Previous score");
    expect(capturedPrompt).toContain("0.63");
  });

  it("context is cached per dimension within a single observe() call", async () => {
    // Goal with two dimensions that have the same name — provider should only be called once per unique dim
    const now = new Date().toISOString();
    const goal: Goal = {
      id: "goal-cache-test",
      parent_id: null,
      node_type: "goal",
      title: "Cache Test Goal",
      description: "Test context caching",
      status: "active",
      dimensions: [
        {
          name: "code_quality",
          label: "Code Quality A",
          current_value: 0.5,
          threshold: { type: "min", value: 0.8 },
          confidence: 0.3,
          observation_method: defaultMethod,
          last_updated: now,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
        {
          name: "code_quality",
          label: "Code Quality B",
          current_value: 0.5,
          threshold: { type: "min", value: 0.8 },
          confidence: 0.3,
          observation_method: defaultMethod,
          last_updated: now,
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
        },
      ],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: [],
      children_ids: [],
      target_date: null,
      origin: null,
      pace_snapshot: null,
      deadline: null,
      confidence_flag: null,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      created_at: now,
      updated_at: now,
    };

    await stateManager.saveGoal(goal);

    const contextProvider = vi.fn().mockResolvedValue("cached context");
    const mockLLMClient = createMockLLMClient(0.7, "ok");

    const engine = new ObservationEngine(stateManager, [], mockLLMClient, contextProvider);

    // Pass two methods so both dimensions are observed
    await engine.observe("goal-cache-test", [defaultMethod, defaultMethod]);

    // contextProvider should have been called once for "code_quality" (cached on second call)
    expect(contextProvider).toHaveBeenCalledTimes(1);
    expect(contextProvider).toHaveBeenCalledWith("goal-cache-test", "code_quality");
  });
});
