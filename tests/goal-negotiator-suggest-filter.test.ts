import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import { ObservationEngine } from "../src/observation/observation-engine.js";
import { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import type { CapabilityDetector } from "../src/observation/capability-detector.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { PASS_VERDICT_SAFE_JSON as PASS_VERDICT } from "./helpers/ethics-fixtures.js";

function makeSuggestionList(titles: string[]) {
  return JSON.stringify(
    titles.map((title, i) => ({
      title,
      description: `Description for ${title}`,
      rationale: `Rationale for suggestion ${i + 1}`,
      dimensions_hint: [`dim_${i + 1}`],
    }))
  );
}

// ─── Mock CapabilityDetector ───

function makeMockCapabilityDetector(
  impl: (
    goalDescription: string,
    adapterCapabilities: string[]
  ) => Promise<{ gap: { reason: string; missing_capability: { name: string; type: string }; alternatives: string[]; impact_description: string }; acquirable: boolean } | null>
): CapabilityDetector {
  return {
    detectGoalCapabilityGap: vi.fn(impl),
  } as unknown as CapabilityDetector;
}

// ─── Test setup helpers ───

function makeDeps(llmResponses: string[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-filter-test-"));
  const stateManager = new StateManager(tmpDir);
  const llmClient = createMockLLMClient(llmResponses);
  const ethicsGate = new EthicsGate(stateManager, llmClient);
  const observationEngine = new ObservationEngine(stateManager, [], llmClient);
  const negotiator = new GoalNegotiator(stateManager, llmClient, ethicsGate, observationEngine);
  return { negotiator, tmpDir };
}

function cleanup(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Tests ───

describe("GoalNegotiator.suggestGoals() — quality filtering", () => {
  it("filters out duplicate suggestion (exact title match with existing goal)", async () => {
    // 2 suggestions returned; first matches an existing goal, second is new
    const suggestionList = makeSuggestionList(["Increase Test Coverage", "Reduce Build Time"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        existingGoals: ["Increase Test Coverage"],
      });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Reduce Build Time");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("filters out partial duplicate (suggestion title is substring of existing goal)", async () => {
    // "Test Coverage" is a substring of existing goal "Increase Test Coverage"
    const suggestionList = makeSuggestionList(["Test Coverage", "Reduce Build Time"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        existingGoals: ["Increase Test Coverage"],
      });
      // "Test Coverage" is substring of "Increase Test Coverage" — should be filtered
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Reduce Build Time");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("filters out partial duplicate (existing goal title is substring of suggestion)", async () => {
    // "Increase Test Coverage" contains "Test Coverage" (existing goal)
    const suggestionList = makeSuggestionList(["Increase Test Coverage", "Reduce Build Time"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        existingGoals: ["Test Coverage"],
      });
      // "Increase Test Coverage" contains "Test Coverage" — should be filtered
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Reduce Build Time");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("dedup check is case-insensitive", async () => {
    const suggestionList = makeSuggestionList(["increase test coverage", "Reduce Build Time"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        existingGoals: ["Increase Test Coverage"],
      });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Reduce Build Time");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("non-duplicate suggestions pass through dedup check", async () => {
    const suggestionList = makeSuggestionList(["Add Documentation", "Reduce Build Time"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        existingGoals: ["Increase Test Coverage"],
      });
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0]?.title).toBe("Add Documentation");
      expect(suggestions[1]?.title).toBe("Reduce Build Time");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("filters suggestion when CapabilityDetector returns non-acquirable gap", async () => {
    const suggestionList = makeSuggestionList(["Deploy to Kubernetes", "Add Documentation"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    const capabilityDetector = makeMockCapabilityDetector(async (desc) => {
      if (desc.includes("Kubernetes")) {
        return {
          gap: {
            reason: "Kubernetes cluster access is not available",
            missing_capability: { name: "kubernetes_deploy", type: "service" },
            alternatives: [],
            impact_description: "Cannot deploy to Kubernetes",
          },
          acquirable: false,
        };
      }
      return null;
    });

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        capabilityDetector,
      });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Add Documentation");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("keeps suggestion when CapabilityDetector returns acquirable gap", async () => {
    const suggestionList = makeSuggestionList(["Deploy to Kubernetes"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
    ]);

    const capabilityDetector = makeMockCapabilityDetector(async () => {
      return {
        gap: {
          reason: "Kubernetes CLI tool not installed but can be acquired",
          missing_capability: { name: "kubectl", type: "tool" },
          alternatives: [],
          impact_description: "Need to install kubectl first",
        },
        acquirable: true,
      };
    });

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        capabilityDetector,
      });
      // acquirable=true → suggestion should be kept
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Deploy to Kubernetes");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("keeps suggestion when CapabilityDetector returns null (no gap)", async () => {
    const suggestionList = makeSuggestionList(["Add Documentation"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
    ]);

    const capabilityDetector = makeMockCapabilityDetector(async () => null);

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        capabilityDetector,
      });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Add Documentation");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("keeps suggestion when CapabilityDetector throws error (non-blocking)", async () => {
    const suggestionList = makeSuggestionList(["Add Documentation"]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
    ]);

    const capabilityDetector = makeMockCapabilityDetector(async () => {
      throw new Error("LLM service unavailable");
    });

    try {
      const suggestions = await negotiator.suggestGoals("A Node.js project", {
        capabilityDetector,
      });
      // Error is non-blocking: suggestion should be kept
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.title).toBe("Add Documentation");
    } finally {
      cleanup(tmpDir);
    }
  });

  it("passes all suggestions when no capabilityDetector provided", async () => {
    const suggestionList = makeSuggestionList([
      "Add Documentation",
      "Reduce Build Time",
      "Improve Monitoring",
    ]);
    const { negotiator, tmpDir } = makeDeps([
      suggestionList,
      PASS_VERDICT,
      PASS_VERDICT,
      PASS_VERDICT,
    ]);

    try {
      // No capabilityDetector — all pass feasibility check
      const suggestions = await negotiator.suggestGoals("A Node.js project");
      expect(suggestions).toHaveLength(3);
    } finally {
      cleanup(tmpDir);
    }
  });
});
