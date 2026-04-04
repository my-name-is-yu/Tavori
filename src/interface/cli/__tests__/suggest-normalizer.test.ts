import { describe, it, expect } from "vitest";
import { normalizeSuggestPayload } from "../commands/suggest-normalizer.js";

const validSuggestionWithRepoContext = {
  title: "Add tests",
  rationale: "Coverage is low",
  steps: ["Write unit tests"],
  success_criteria: ["Tests pass"],
  repo_context: { path: "src/foo.ts" },
};

const validInput = {
  suggestions: [validSuggestionWithRepoContext],
};

describe("normalizeSuggestPayload fast-path", () => {
  it("preserves repo_context when isSoftwareGoal=true", () => {
    const result = normalizeSuggestPayload(validInput, ".", ".", "context", 3, [], true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toEqual({ path: "src/foo.ts" });
  });

  it("strips repo_context when isSoftwareGoal=false", () => {
    const result = normalizeSuggestPayload(validInput, ".", ".", "context", 3, [], false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toBeUndefined();
    // other fields are preserved
    expect(result.suggestions[0]!.title).toBe("Add tests");
  });

  it("works fine when isSoftwareGoal=false and no repo_context present", () => {
    const inputWithoutRepoContext = {
      suggestions: [
        {
          title: "Improve docs",
          rationale: "Docs are outdated",
          steps: ["Update README"],
          success_criteria: ["README is accurate"],
        },
      ],
    };
    const result = normalizeSuggestPayload(inputWithoutRepoContext, ".", ".", "context", 3, [], false);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.repo_context).toBeUndefined();
    expect(result.suggestions[0]!.title).toBe("Improve docs");
  });
});
