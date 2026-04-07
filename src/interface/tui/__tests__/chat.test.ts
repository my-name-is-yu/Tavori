import { describe, expect, it } from "vitest";
import { getMatchingSuggestions } from "../chat.js";

describe("getMatchingSuggestions", () => {
  it("hides suggestions for an exact slash command so enter can submit", () => {
    expect(getMatchingSuggestions("/help", [])).toEqual([]);
    expect(getMatchingSuggestions("/config", [])).toEqual([]);
  });

  it("keeps suggestions for partial slash commands", () => {
    const matches = getMatchingSuggestions("/he", []);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.name).toBe("/help");
  });

  it("hides goal suggestions when a goal arg is fully typed", () => {
    expect(getMatchingSuggestions("/run improve-tests", ["improve-tests"])).toEqual([]);
    expect(getMatchingSuggestions("/start Improve-Tests", ["improve-tests"])).toEqual([]);
  });

  it("keeps goal suggestions for partial goal args", () => {
    const matches = getMatchingSuggestions("/run improve", ["improve-tests"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      name: "/run",
      description: "improve-tests",
      type: "goal",
    });
  });
});
