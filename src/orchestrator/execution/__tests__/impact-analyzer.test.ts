import { describe, it, expect, vi } from "vitest";
import { analyzeImpact } from "../impact-analyzer.js";
import type { ImpactAnalyzerDeps } from "../impact-analyzer.js";
import { ImpactAnalysisSchema } from "../../../base/types/pipeline.js";

// ─── Helpers ───

function makeDeps(responseContent: string): ImpactAnalyzerDeps {
  return {
    llmClient: {
      sendMessage: vi.fn(async () => ({ content: responseContent, usage: { input_tokens: 10, output_tokens: 50 } })),
      parseJSON: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function makeContext(overrides: Partial<Parameters<typeof analyzeImpact>[1]> = {}) {
  return {
    taskDescription: "Add logging to src/auth.ts",
    taskOutput: "Modified src/auth.ts: added 3 log statements.",
    verificationVerdict: "pass",
    targetScope: ["src/auth.ts"],
    ...overrides,
  };
}

// ─── Tests ───

describe("analyzeImpact", () => {
  // 1. Detects side effects in task output
  it("detects side effects when output mentions files outside scope", async () => {
    const response = JSON.stringify({
      verdict: "fail",
      side_effects: ["Modified src/config.ts which was outside expected scope"],
      confidence: "confirmed",
    });
    const deps = makeDeps(response);
    const result = await analyzeImpact(deps, makeContext({
      taskOutput: "Modified src/auth.ts and also updated src/config.ts.",
      targetScope: ["src/auth.ts"],
    }));

    expect(result.verdict).toBe("fail");
    expect(result.side_effects).toHaveLength(1);
    expect(result.side_effects[0]).toContain("src/config.ts");
    expect(result.confidence).toBe("confirmed");
  });

  // 2. Returns clean impact for safe task
  it("returns pass verdict with empty side_effects for a safe task", async () => {
    const response = JSON.stringify({
      verdict: "pass",
      side_effects: [],
      confidence: "confirmed",
    });
    const deps = makeDeps(response);
    const result = await analyzeImpact(deps, makeContext());

    expect(result.verdict).toBe("pass");
    expect(result.side_effects).toHaveLength(0);
    expect(result.confidence).toBe("confirmed");
  });

  // 3. Handles LLM parse failure gracefully
  it("returns fallback result when LLM returns unparseable content", async () => {
    const deps = makeDeps("not valid json at all");
    const result = await analyzeImpact(deps, makeContext());

    expect(result.verdict).toBe("partial");
    expect(result.side_effects).toContain("Unable to analyze impact");
    expect(result.confidence).toBe("uncertain");
  });

  // 3b. Handles LLM call failure gracefully
  it("returns fallback result when LLM call throws", async () => {
    const deps: ImpactAnalyzerDeps = {
      llmClient: {
        sendMessage: vi.fn(async () => { throw new Error("network error"); }),
        parseJSON: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    };
    const result = await analyzeImpact(deps, makeContext());

    expect(result.verdict).toBe("partial");
    expect(result.side_effects).toContain("Unable to analyze impact");
    expect(result.confidence).toBe("uncertain");
    expect(deps.logger.error).toHaveBeenCalled();
  });

  // 4. Validates output against ImpactAnalysisSchema
  it("output always conforms to ImpactAnalysisSchema", async () => {
    const response = JSON.stringify({
      verdict: "partial",
      side_effects: ["Minor formatting change in unrelated file"],
      confidence: "likely",
    });
    const deps = makeDeps(response);
    const result = await analyzeImpact(deps, makeContext());

    // Should not throw
    const parsed = ImpactAnalysisSchema.parse(result);
    expect(parsed.verdict).toBe("partial");
    expect(parsed.confidence).toBe("likely");
  });

  // 4b. Fallback result also conforms to ImpactAnalysisSchema
  it("fallback result also conforms to ImpactAnalysisSchema", async () => {
    const deps = makeDeps("garbage");
    const result = await analyzeImpact(deps, makeContext());

    expect(() => ImpactAnalysisSchema.parse(result)).not.toThrow();
  });

  // 5. Strips markdown code fences from LLM response
  it("handles LLM response wrapped in markdown code fences", async () => {
    const json = JSON.stringify({ verdict: "pass", side_effects: [], confidence: "confirmed" });
    const deps = makeDeps("```json\n" + json + "\n```");
    const result = await analyzeImpact(deps, makeContext());

    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBe("confirmed");
  });
});
