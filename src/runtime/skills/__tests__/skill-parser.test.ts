import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { isPathInside, parseSkillFile, toSafeSkillId } from "../skill-parser.js";

describe("skill-parser", () => {
  it("parses frontmatter description without using YAML field lines as body text", () => {
    const parsed = parseSkillFile(
      "---\nname: Review Skill\ndescription: Finds correctness risks.\n---\n# Review\nBody text.\n",
      "/tmp/skills/review/SKILL.md",
      "home",
      "/tmp/skills"
    );

    expect(parsed.name).toBe("Review");
    expect(parsed.description).toBe("Finds correctness risks.");
    expect(parsed.id).toBe("review");
  });

  it("normalizes path-like skill ids", () => {
    expect(toSafeSkillId("../../Team Review!!")).toBe("team-review");
  });

  it("detects path escape attempts", () => {
    const root = path.join("/tmp", "skills");

    expect(isPathInside(root, path.join(root, "imported", "review", "SKILL.md"))).toBe(true);
    expect(isPathInside(root, path.join(root, "..", "pwn", "SKILL.md"))).toBe(false);
  });
});
