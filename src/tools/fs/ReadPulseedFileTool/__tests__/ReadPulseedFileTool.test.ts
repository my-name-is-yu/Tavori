import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolCallContext } from "../../../types.js";

// vi.hoisted ensures mockHomedir is available at module-level before vi.mock() runs
const mockHomedir = vi.hoisted(() => vi.fn<[], string>());

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: mockHomedir };
});

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("ReadPulseedFileTool", () => {
  let tmpHome: string;
  let pulseedDir: string;

  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "read-pulseed-test-"));
    pulseedDir = path.join(tmpHome, ".pulseed");
    await fs.mkdir(pulseedDir, { recursive: true });
    await fs.writeFile(path.join(pulseedDir, "provider.json"), '{"model":"gpt-4"}', "utf-8");
    await fs.mkdir(path.join(pulseedDir, "decisions"), { recursive: true });
    await fs.writeFile(path.join(pulseedDir, "decisions", "plan-001.md"), "# Plan", "utf-8");
    mockHomedir.mockReturnValue(tmpHome);
  });

  afterAll(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("reads a file from ~/.pulseed/", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    const result = await tool.call({ path: "provider.json" }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("gpt-4");
  });

  it("reads a nested file", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    const result = await tool.call({ path: "decisions/plan-001.md" }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("# Plan");
  });

  it("returns error for missing file", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    const result = await tool.call({ path: "nonexistent.json" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("blocks path traversal attack", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    const result = await tool.call({ path: "../../etc/passwd" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("~/.pulseed/");
  });

  it("checkPermissions returns allowed", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    const result = await tool.checkPermissions({ path: "provider.json" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    expect(tool.isConcurrencySafe({ path: "provider.json" })).toBe(true);
  });

  it("summary is first 200 chars of content", async () => {
    const { ReadPulseedFileTool } = await import("../ReadPulseedFileTool.js");
    const tool = new ReadPulseedFileTool();
    const result = await tool.call({ path: "provider.json" }, makeContext());
    expect(result.success).toBe(true);
    const content = result.data as string;
    expect(result.summary).toBe(content.slice(0, 200));
  });

  it("Zod rejects missing path field", async () => {
    const { ReadPulseedFileInputSchema } = await import("../ReadPulseedFileTool.js");
    const parsed = ReadPulseedFileInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
