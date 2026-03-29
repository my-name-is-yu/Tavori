import { describe, it, expect } from "vitest";
import {
  sanitizeThresholdTypes,
  sanitizeThresholdValues,
  sanitizeLLMJson,
} from "../src/llm/json-sanitizer.js";

// ─── sanitizeThresholdTypes ───

describe("sanitizeThresholdTypes", () => {
  it("leaves valid threshold_type values unchanged", () => {
    const input = `{"threshold_type": "min"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "min"}`);
  });

  it("maps 'exact' to 'match'", () => {
    const input = `{"threshold_type": "exact"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "match"}`);
  });

  it("maps 'scale' to 'min'", () => {
    const input = `{"threshold_type": "scale"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "min"}`);
  });

  it("maps 'qualitative' to 'min'", () => {
    const input = `{"threshold_type": "qualitative"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "min"}`);
  });

  it("maps 'boolean' to 'present'", () => {
    const input = `{"threshold_type": "boolean"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "present"}`);
  });

  it("maps 'percentage' to 'min'", () => {
    const input = `{"threshold_type": "percentage"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "min"}`);
  });

  it("maps 'count' to 'min'", () => {
    const input = `{"threshold_type": "count"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "min"}`);
  });

  it("maps unknown values to 'min' as fallback", () => {
    const input = `{"threshold_type": "totally_unknown"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "min"}`);
  });

  it("sanitizes multiple occurrences in the same string", () => {
    const input = `[{"threshold_type": "exact"}, {"threshold_type": "min"}, {"threshold_type": "boolean"}]`;
    const result = sanitizeThresholdTypes(input);
    expect(result).toContain(`"threshold_type": "match"`);
    expect(result).toContain(`"threshold_type": "min"`);
    expect(result).toContain(`"threshold_type": "present"`);
  });

  it("handles whitespace around the colon", () => {
    const input = `{"threshold_type" :  "exact"}`;
    expect(sanitizeThresholdTypes(input)).toBe(`{"threshold_type": "match"}`);
  });
});

// ─── sanitizeThresholdValues ───

describe("sanitizeThresholdValues", () => {
  it("nulls out object threshold_value for 'present' threshold_type", () => {
    const input = JSON.stringify({
      threshold_type: "present",
      threshold_value: { type: "present" },
    });
    const result = JSON.parse(sanitizeThresholdValues(input));
    expect(result.threshold_value).toBeNull();
  });

  it("leaves non-object threshold_value for 'present' unchanged", () => {
    const input = JSON.stringify({ threshold_type: "present", threshold_value: null });
    const result = JSON.parse(sanitizeThresholdValues(input));
    expect(result.threshold_value).toBeNull();
  });

  it("does not touch threshold_value for non-present threshold_type", () => {
    const input = JSON.stringify({ threshold_type: "min", threshold_value: { nested: true } });
    const result = JSON.parse(sanitizeThresholdValues(input));
    expect(result.threshold_value).toEqual({ nested: true });
  });

  it("recursively sanitizes arrays of dimensions", () => {
    const input = JSON.stringify([
      { threshold_type: "present", threshold_value: { foo: "bar" } },
      { threshold_type: "min", threshold_value: 80 },
    ]);
    const result = JSON.parse(sanitizeThresholdValues(input));
    expect(result[0].threshold_value).toBeNull();
    expect(result[1].threshold_value).toBe(80);
  });

  it("returns raw string unchanged when JSON is invalid", () => {
    const invalid = "not valid json {{";
    expect(sanitizeThresholdValues(invalid)).toBe(invalid);
  });
});

// ─── sanitizeLLMJson ───

describe("sanitizeLLMJson", () => {
  it("removes trailing commas before }", () => {
    const input = `{"a": 1,}`;
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result).toEqual({ a: 1 });
  });

  it("removes trailing commas before ]", () => {
    const input = `[1, 2, 3,]`;
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result).toEqual([1, 2, 3]);
  });

  it("replaces NaN with null", () => {
    const input = `{"value": NaN}`;
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result.value).toBeNull();
  });

  it("replaces Infinity with null", () => {
    const input = `{"value": Infinity}`;
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result.value).toBeNull();
  });

  it("replaces -Infinity with null", () => {
    const input = `{"value": -Infinity}`;
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result.value).toBeNull();
  });

  it("sanitizes threshold_type enum drift", () => {
    const input = JSON.stringify({ threshold_type: "exact", threshold_value: "v1.0" });
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result.threshold_type).toBe("match");
  });

  it("sanitizes threshold_value object for present type", () => {
    const input = JSON.stringify({ threshold_type: "present", threshold_value: { type: "present" } });
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result.threshold_value).toBeNull();
  });

  it("applies all sanitizers in combination", () => {
    const input = `[{"threshold_type": "boolean", "threshold_value": {"type":"present"}, "score": NaN,}]`;
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result[0].threshold_type).toBe("present");
    expect(result[0].threshold_value).toBeNull();
    expect(result[0].score).toBeNull();
  });

  it("passes through already-clean JSON unchanged (semantically)", () => {
    const clean = { threshold_type: "min", threshold_value: 80, score: 0.9 };
    const input = JSON.stringify(clean);
    const result = JSON.parse(sanitizeLLMJson(input));
    expect(result).toEqual(clean);
  });
});
