import { describe, expect, it, vi } from "vitest";
import { buildEnrichedKnowledgeContext } from "../task/task-context-enricher.js";

vi.mock("../reflection-generator.js", () => ({
  getReflectionsForGoal: vi.fn(),
  formatReflectionsForPrompt: vi.fn(),
}));

import {
  getReflectionsForGoal,
  formatReflectionsForPrompt,
} from "../reflection-generator.js";

describe("buildEnrichedKnowledgeContext", () => {
  it("appends transfer snippets and formatted reflections", async () => {
    vi.mocked(getReflectionsForGoal).mockResolvedValue([{ id: "r1" }] as never);
    vi.mocked(formatReflectionsForPrompt).mockReturnValue("reflection context");

    const result = await buildEnrichedKnowledgeContext({
      goalId: "goal-1",
      knowledgeContext: "base context",
      knowledgeTransfer: {
        detectCandidatesRealtime: vi.fn().mockResolvedValue({
          contextSnippets: ["snippet A", "snippet B"],
        }),
      } as never,
      knowledgeManager: {} as never,
    });

    expect(result).toBe("base context\nsnippet A\nsnippet B\nreflection context");
  });

  it("continues without enrichment when transfer lookup fails", async () => {
    vi.mocked(getReflectionsForGoal).mockResolvedValue([]);
    vi.mocked(formatReflectionsForPrompt).mockReturnValue("");
    const warn = vi.fn();

    const result = await buildEnrichedKnowledgeContext({
      goalId: "goal-2",
      knowledgeContext: "base context",
      knowledgeTransfer: {
        detectCandidatesRealtime: vi.fn().mockRejectedValue(new Error("boom")),
      } as never,
      logger: { warn } as never,
    });

    expect(result).toBe("base context");
    expect(warn).toHaveBeenCalled();
  });
});
