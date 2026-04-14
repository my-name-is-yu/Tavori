import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdSkills } from "../commands/skills.js";

describe("cmdSkills", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message ?? ""));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists skills from the registry", async () => {
    const registry = {
      list: vi.fn().mockResolvedValue([
        { id: "review", source: "home", description: "Review code" },
      ]),
    };

    const exitCode = await cmdSkills(["list"], registry as never);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("review");
    expect(registry.list).toHaveBeenCalled();
  });

  it("requires a query for search", async () => {
    const exitCode = await cmdSkills(["search"], {} as never);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("query is required");
  });
});
