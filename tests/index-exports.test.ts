import { describe, expect, it } from "vitest";

describe("src/index.ts exports", () => {
  it("re-exports core symbols from their source modules", async () => {
    const barrel = await import("../src/index.js");
    const llmModule = await import("../src/llm/llm-client.js");
    const ethicsModule = await import("../src/traits/ethics-gate.js");
    const stateModule = await import("../src/state/state-manager.js");

    expect(barrel.LLMClient).toBe(llmModule.LLMClient);
    expect(barrel.MockLLMClient).toBe(llmModule.MockLLMClient);
    expect(barrel.extractJSON).toBe(llmModule.extractJSON);
    expect(barrel.EthicsGate).toBe(ethicsModule.EthicsGate);
    expect(barrel.StateManager).toBe(stateModule.StateManager);
  });

  it("re-exports selected utility functions as callable values", async () => {
    const barrel = await import("../src/index.js");

    expect(typeof barrel.calculateDimensionGap).toBe("function");
    expect(typeof barrel.scoreAllDimensions).toBe("function");
    expect(typeof barrel.buildLLMClient).toBe("function");
  });
});
