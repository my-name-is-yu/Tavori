import { describe, it, expect } from "vitest";
import { inferDimensionsFromTitle, formatInferredDimensions } from "../commands/goal-infer.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../tests/helpers/mock-llm.js";

describe("inferDimensionsFromTitle", () => {
  it("returns parsed dimensions when LLM returns valid JSON array", async () => {
    const validResponse = JSON.stringify([
      { name: "fluency_score", type: "min", value: "80" },
      { name: "vocab_count", type: "min", value: "3000" },
    ]);
    const llm = createSingleMockLLMClient(validResponse);

    const result = await inferDimensionsFromTitle("英語ペラペラになりたい", llm);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "fluency_score", type: "min", value: "80" });
    expect(result[1]).toEqual({ name: "vocab_count", type: "min", value: "3000" });
  });

  it("returns empty array when LLM returns invalid JSON", async () => {
    const llm = createSingleMockLLMClient("this is not json at all");

    const result = await inferDimensionsFromTitle("some goal", llm);

    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns empty array", async () => {
    const llm = createSingleMockLLMClient("[]");

    const result = await inferDimensionsFromTitle("some goal", llm);

    expect(result).toEqual([]);
  });

  it("returns empty array when LLM call throws", async () => {
    const llm = {
      sendMessage: async () => {
        throw new Error("network error");
      },
      parseJSON: () => {
        throw new Error("should not be called");
      },
    };

    const result = await inferDimensionsFromTitle("some goal", llm);

    expect(result).toEqual([]);
  });

  it("sanitizes unknown threshold types and skips invalid entries", async () => {
    const responseWithBadType = JSON.stringify([
      { name: "good_dim", type: "min", value: "10" },
      { name: "bad_dim", type: "exact", value: "100" }, // invalid type
    ]);
    const llm = createSingleMockLLMClient(responseWithBadType);

    const result = await inferDimensionsFromTitle("test goal", llm);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("good_dim");
  });

  it("handles markdown code block response", async () => {
    const wrapped = "```json\n[{\"name\": \"score\", \"type\": \"max\", \"value\": \"5\"}]\n```";
    const llm = createSingleMockLLMClient(wrapped);

    const result = await inferDimensionsFromTitle("keep errors low", llm);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "score", type: "max", value: "5" });
  });

  it("supports all valid threshold types", async () => {
    const allTypes = JSON.stringify([
      { name: "a", type: "min", value: "1" },
      { name: "b", type: "max", value: "10" },
      { name: "c", type: "range", value: "5-15" },
      { name: "d", type: "present", value: "true" },
      { name: "e", type: "match", value: "published" },
    ]);
    const llm = createSingleMockLLMClient(allTypes);

    const result = await inferDimensionsFromTitle("complex goal", llm);

    expect(result).toHaveLength(5);
    expect(result.map((r) => r.type)).toEqual(["min", "max", "range", "present", "match"]);
  });
});

describe("formatInferredDimensions", () => {
  it("formats dimensions as numbered list", () => {
    const dims = [
      { name: "fluency_score", type: "min" as const, value: "80" },
      { name: "vocab_count", type: "min" as const, value: "3000" },
    ];

    const output = formatInferredDimensions(dims);

    expect(output).toContain("1.");
    expect(output).toContain("fluency_score");
    expect(output).toContain("[min]");
    expect(output).toContain("80");
    expect(output).toContain("2.");
    expect(output).toContain("vocab_count");
    expect(output).toContain("3000");
  });

  it("returns empty string for empty array", () => {
    expect(formatInferredDimensions([])).toBe("");
  });

  it("includes type and threshold in output", () => {
    const dims = [{ name: "error_count", type: "max" as const, value: "0" }];

    const output = formatInferredDimensions(dims);

    expect(output).toContain("[max]");
    expect(output).toContain("threshold: 0");
  });
});
