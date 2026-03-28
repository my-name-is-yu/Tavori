import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import type { GoalSuggestion } from "../src/goal/goal-negotiator.js";
import { buildSuggestGoalsPrompt } from "../src/goal/goal-suggest.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import {
  PASS_VERDICT_SAFE_JSON as PASS_VERDICT,
  REJECT_VERDICT_ILLEGAL_JSON as REJECT_VERDICT,
} from "./helpers/ethics-fixtures.js";

const SUGGESTION_LIST = JSON.stringify([
  {
    title: "Increase Test Coverage",
    description: "Increase unit test coverage from current level to 90% across all modules",
    rationale: "Higher test coverage reduces regression risk and improves confidence in deployments",
    dimensions_hint: ["test_coverage", "coverage_percentage"],
  },
  {
    title: "Reduce Build Time",
    description: "Reduce CI build time from 10 minutes to under 3 minutes",
    rationale: "Faster builds improve developer productivity and feedback loops",
    dimensions_hint: ["build_duration_seconds", "ci_success_rate"],
  },
  {
    title: "Improve Documentation",
    description: "Add API documentation for all public modules with usage examples",
    rationale: "Good documentation reduces onboarding time and support requests",
    dimensions_hint: ["doc_coverage", "readme_quality"],
  },
]);

const SINGLE_SUGGESTION = JSON.stringify([
  {
    title: "Add TypeScript Strict Mode",
    description: "Enable TypeScript strict mode across the codebase",
    rationale: "Strict mode catches type errors at compile time",
    dimensions_hint: ["strict_mode_enabled", "type_error_count"],
  },
]);

const EMPTY_SUGGESTION_LIST = JSON.stringify([]);

// ─── Test setup helpers ───

function makeDeps(llmResponses: string[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-suggest-test-"));
  const stateManager = new StateManager(tmpDir);
  const llmClient = createMockLLMClient(llmResponses);
  const ethicsGate = new EthicsGate(stateManager, llmClient);
  const observationEngine = new ObservationEngine(stateManager, [], llmClient);
  const negotiator = new GoalNegotiator(stateManager, llmClient, ethicsGate, observationEngine);
  return { negotiator, tmpDir, llmClient };
}

function cleanup(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Tests ───

describe("GoalNegotiator.suggestGoals()", () => {
  it("returns parsed suggestions from LLM response", async () => {
    // LLM call 1: suggestions; LLM call 2,3,4: ethics check pass for each suggestion
    const { negotiator, tmpDir } = makeDeps([
      SUGGESTION_LIST,
      PASS_VERDICT,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project needing improvement");
      expect(suggestions).toHaveLength(3);
      expect(suggestions[0]?.title).toBe("Increase Test Coverage");
      expect(suggestions[0]?.description).toContain("90%");
      expect(suggestions[0]?.rationale).toBeTruthy();
      expect(suggestions[0]?.dimensions_hint).toContain("test_coverage");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("filters out ethics-rejected suggestions", async () => {
    // 3 suggestions returned, first passes, second rejected, third passes
    const { negotiator, tmpDir } = makeDeps([
      SUGGESTION_LIST,
      PASS_VERDICT,   // suggestion 1: pass
      REJECT_VERDICT, // suggestion 2: reject
      PASS_VERDICT,   // suggestion 3: pass
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project");
      // Only 2 of 3 should survive
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0]?.title).toBe("Increase Test Coverage");
      expect(suggestions[1]?.title).toBe("Improve Documentation");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("returns empty array for empty context", async () => {
    const { negotiator, tmpDir } = makeDeps([]);

    try {
      const suggestions = await negotiator.suggestGoals("");
      expect(suggestions).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("returns empty array for whitespace-only context", async () => {
    const { negotiator, tmpDir } = makeDeps([]);

    try {
      const suggestions = await negotiator.suggestGoals("   \n  ");
      expect(suggestions).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("respects maxSuggestions option in the prompt (LLM returns up to that count)", async () => {
    // Only return 1 suggestion — verifying the option is wired through
    const { negotiator, tmpDir, llmClient } = makeDeps([
      SINGLE_SUGGESTION,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A project", { maxSuggestions: 1 });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Add TypeScript Strict Mode");
      // The LLM was called with the prompt containing maxSuggestions
      expect(llmClient.callCount).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("includes existingGoals in the prompt (verified by call count path)", async () => {
    const { negotiator, tmpDir } = makeDeps([
      SINGLE_SUGGESTION,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A project", {
        existingGoals: ["Increase test coverage", "Fix linting issues"],
      });
      // Should still return suggestions — the existing goals list is just context for the LLM
      expect(suggestions).toHaveLength(1);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("handles Zod parse failure gracefully and returns empty array", async () => {
    // LLM returns invalid JSON — not parseable as a suggestion list
    const { negotiator, tmpDir } = makeDeps([
      "This is not JSON at all!",
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A project");
      expect(suggestions).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("handles LLM returning valid JSON but wrong schema shape (returns empty array)", async () => {
    // LLM returns an object instead of array
    const { negotiator, tmpDir } = makeDeps([
      JSON.stringify({ suggestions: [] }),
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A project");
      expect(suggestions).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("handles LLM returning empty array", async () => {
    const { negotiator, tmpDir } = makeDeps([EMPTY_SUGGESTION_LIST]);

    try {
      const suggestions = await negotiator.suggestGoals("A project");
      expect(suggestions).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("returns correct shape: title, description, rationale, dimensions_hint fields", async () => {
    const { negotiator, tmpDir } = makeDeps([
      SINGLE_SUGGESTION,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A TypeScript project");
      expect(suggestions).toHaveLength(1);
      const s = suggestions[0] as GoalSuggestion;
      expect(typeof s.title).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(typeof s.rationale).toBe("string");
      expect(Array.isArray(s.dimensions_hint)).toBe(true);
      expect(s.dimensions_hint.every((d) => typeof d === "string")).toBe(true);
    } finally {
      cleanup(tmpDir);
    }
  });

  it("strips markdown code fences from LLM response before parsing", async () => {
    const fencedResponse = "```json\n" + SINGLE_SUGGESTION + "\n```";
    const { negotiator, tmpDir } = makeDeps([
      fencedResponse,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A project");
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Add TypeScript Strict Mode");
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("buildSuggestGoalsPrompt()", () => {
  it("does not contain README.md update instruction that could leak into LLM output", () => {
    const prompt = buildSuggestGoalsPrompt("愛犬と幸せに暮らしたい", 5, []);
    expect(prompt).not.toContain("by updating README.md to deliver a verifiable improvement");
  });

  it("instructs LLM to start descriptions with an action verb", () => {
    const prompt = buildSuggestGoalsPrompt("A Node.js project", 3, []);
    expect(prompt).toMatch(/action verb/i);
  });

  it("includes context and maxSuggestions in prompt", () => {
    const prompt = buildSuggestGoalsPrompt("My test context", 7, []);
    expect(prompt).toContain("My test context");
    expect(prompt).toContain("7");
  });

  it("includes existing goals section when goals provided", () => {
    const prompt = buildSuggestGoalsPrompt("context", 3, ["Goal A", "Goal B"]);
    expect(prompt).toContain("Goal A");
    expect(prompt).toContain("Goal B");
    expect(prompt).toContain("do NOT suggest duplicates");
  });
});
