import { describe, expect, it } from "vitest";

describe("src/index.ts exports", () => {
  it("re-exports core symbols from their source modules", async () => {
    const barrel = await import("../index.js");
    const llmModule = await import("../base/llm/llm-client.js");
    const ethicsModule = await import("../platform/traits/ethics-gate.js");
    const stateModule = await import("../base/state/state-manager.js");

    expect(barrel.LLMClient).toBe(llmModule.LLMClient);
    expect(barrel.MockLLMClient).toBe(llmModule.MockLLMClient);
    expect(barrel.extractJSON).toBe(llmModule.extractJSON);
    expect(barrel.EthicsGate).toBe(ethicsModule.EthicsGate);
    expect(barrel.StateManager).toBe(stateModule.StateManager);
  }, 15_000);

  it("re-exports selected utility functions as callable values", async () => {
    const barrel = await import("../index.js");

    expect(typeof barrel.calculateDimensionGap).toBe("function");
    expect(typeof barrel.scoreAllDimensions).toBe("function");
    expect(typeof barrel.buildLLMClient).toBe("function");
  }, 15_000);
});
