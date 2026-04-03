import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { gatherNegotiationContext } from "../src/goal/goal-negotiator.js";
import { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { PASS_VERDICT_SIMPLE_JSON as PASS_VERDICT } from "./helpers/ethics-fixtures.js";

// ─── Helpers ───

function makeSrcWithTodos(dir: string): void {
  const srcDir = path.join(dir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "core.ts"),
    `// TODO: add retry logic\nexport function core() {}\n`,
    "utf-8"
  );
  fs.writeFileSync(
    path.join(srcDir, "utils.ts"),
    `// FIXME: handle timeout\nexport function utils() {}\n`,
    "utf-8"
  );
  fs.writeFileSync(
    path.join(srcDir, "other.ts"),
    `export function other() {}\n`,
    "utf-8"
  );
}

const DIMENSIONS_RESPONSE = JSON.stringify([
  {
    name: "todo_count",
    label: "TODO Count",
    threshold_type: "max",
    threshold_value: 0,
    observation_method_hint: "grep -rn TODO src/",
  },
]);

const FEASIBILITY_RESPONSE = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "Achievable.",
  key_assumptions: [],
  main_risks: [],
});

const RESPONSE_MESSAGE = "Your goal has been accepted.";

// ─── Tests: gatherNegotiationContext ───

describe("gatherNegotiationContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns workspace info for a real directory with TypeScript files", async () => {
    makeSrcWithTodos(tmpDir);

    const result = await gatherNegotiationContext("fix code quality", tmpDir);

    // Should contain project structure info
    expect(result).toContain("Workspace Context");
    expect(result).toContain("TypeScript files in src/");
  });

  it("includes TODO count when goal mentions TODO", async () => {
    makeSrcWithTodos(tmpDir);

    const result = await gatherNegotiationContext(
      "TODOとFIXMEを解消する",
      tmpDir
    );

    expect(result).toContain("TODO");
    expect(result).toContain("occurrences");
  });

  it("includes FIXME count when goal mentions FIXME", async () => {
    makeSrcWithTodos(tmpDir);

    const result = await gatherNegotiationContext(
      "resolve all FIXME comments in the codebase",
      tmpDir
    );

    expect(result).toContain("FIXME");
    expect(result).toContain("occurrences");
  });

  it("includes sample TODO match lines when TODO is mentioned", async () => {
    makeSrcWithTodos(tmpDir);

    const result = await gatherNegotiationContext(
      "remove all TODO comments",
      tmpDir
    );

    // Should include at least the sample match from core.ts
    expect(result).toMatch(/core\.ts.*TODO|TODO.*core\.ts/);
  });

  it("returns empty string when src/ directory does not exist", async () => {
    // tmpDir has no src/ subdirectory
    const result = await gatherNegotiationContext("fix quality", tmpDir);

    // Either empty or minimal — should not throw
    expect(typeof result).toBe("string");
  });

  it("returns empty string gracefully on complete failure", async () => {
    // Non-existent directory
    const result = await gatherNegotiationContext(
      "anything",
      "/nonexistent/path/that/does/not/exist"
    );

    expect(typeof result).toBe("string");
    // Should not throw, just return empty or partial
  });

  it("does not include TODO section when goal has no TODO/FIXME mention", async () => {
    makeSrcWithTodos(tmpDir);

    const result = await gatherNegotiationContext(
      "improve test coverage",
      tmpDir
    );

    // Should NOT have sample TODO matches section (no TODO keyword in goal)
    expect(result).not.toContain("Sample TODO matches");
    expect(result).not.toContain("Sample FIXME matches");
  });
});

// ─── Tests: buildDecompositionPrompt via negotiate() ───

describe("negotiate() with workspaceContext", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let observationEngine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    observationEngine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes workspaceContext to the LLM decomposition call", async () => {
    // LLM calls (shared): ethics(1) + decomposition(2) + feasibility(3) + response(4)
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      DIMENSIONS_RESPONSE,
      FEASIBILITY_RESPONSE,
      RESPONSE_MESSAGE,
    ]);

    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const sendMessageSpy = vi.spyOn(mockLLM, "sendMessage");

    const negotiator = new GoalNegotiator(
      stateManager,
      mockLLM,
      ethicsGate,
      observationEngine
    );

    const ctx = "=== Workspace Context ===\nProject structure: 3 TypeScript files in src/";
    await negotiator.negotiate("fix all TODO comments", {
      workspaceContext: ctx,
    });

    // Find the decomposition call (second call: after ethics check)
    const calls = sendMessageSpy.mock.calls;
    const decompositionCall = calls.find((call) => {
      const content = call[0][0]?.content ?? "";
      return content.includes("Decompose this goal") || content.includes("Decompose the following goal");
    });

    expect(decompositionCall).toBeDefined();
    const prompt = decompositionCall![0][0]!.content as string;
    expect(prompt).toContain("Workspace");
    expect(prompt).toContain("Workspace Context");
    expect(prompt).toContain("measurable from this codebase");
  });

  it("omits workspace section from prompt when workspaceContext is not provided", async () => {
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      DIMENSIONS_RESPONSE,
      FEASIBILITY_RESPONSE,
      RESPONSE_MESSAGE,
    ]);

    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const sendMessageSpy = vi.spyOn(mockLLM, "sendMessage");

    const negotiator = new GoalNegotiator(
      stateManager,
      mockLLM,
      ethicsGate,
      observationEngine
    );

    await negotiator.negotiate("improve code quality");

    const calls = sendMessageSpy.mock.calls;
    const decompositionCall = calls.find((call) => {
      const content = call[0][0]?.content ?? "";
      return content.includes("Decompose this goal") || content.includes("Decompose the following goal");
    });

    expect(decompositionCall).toBeDefined();
    const prompt = decompositionCall![0][0]!.content as string;
    expect(prompt).not.toContain("Workspace Context");
    expect(prompt).not.toContain("measurable from this codebase");
  });

  it("omits workspace section when workspaceContext is empty string", async () => {
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      DIMENSIONS_RESPONSE,
      FEASIBILITY_RESPONSE,
      RESPONSE_MESSAGE,
    ]);

    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const sendMessageSpy = vi.spyOn(mockLLM, "sendMessage");

    const negotiator = new GoalNegotiator(
      stateManager,
      mockLLM,
      ethicsGate,
      observationEngine
    );

    await negotiator.negotiate("improve code quality", {
      workspaceContext: "",
    });

    const calls = sendMessageSpy.mock.calls;
    const decompositionCall = calls.find((call) => {
      const content = call[0][0]?.content ?? "";
      return content.includes("Decompose this goal") || content.includes("Decompose the following goal");
    });

    expect(decompositionCall).toBeDefined();
    const prompt = decompositionCall![0][0]!.content as string;
    expect(prompt).not.toContain("Workspace Context");
  });

  it("negotiate() succeeds and returns a goal with workspaceContext provided", async () => {
    const mockLLM = createMockLLMClient([
      PASS_VERDICT,
      DIMENSIONS_RESPONSE,
      FEASIBILITY_RESPONSE,
      RESPONSE_MESSAGE,
    ]);

    const ethicsGate = new EthicsGate(stateManager, mockLLM);
    const negotiator = new GoalNegotiator(
      stateManager,
      mockLLM,
      ethicsGate,
      observationEngine
    );

    const ctx =
      "=== Workspace Context ===\nProject structure: 10 TypeScript files in src/\nKeywords found:\n  - \"TODO\": 5 occurrences across 3 files\nSample TODO matches:\n  src/core.ts:10: // TODO: fix this";

    const { goal } = await negotiator.negotiate("resolve all TODO comments", {
      workspaceContext: ctx,
    });

    expect(goal).toBeDefined();
    expect(goal.dimensions.length).toBeGreaterThan(0);
    expect(goal.dimensions[0]!.name).toBe("todo_count");
  });
});
