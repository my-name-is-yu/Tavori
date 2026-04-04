import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { GlobTool } from "../glob.js";
import type { ToolCallContext } from "../../types.js";

function makeContext(cwd: string): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("GlobTool", () => {
  let tmpDir: string;
  const tool = new GlobTool();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glob-test-"));
    await fs.writeFile(path.join(tmpDir, "file1.ts"), "content1");
    await fs.writeFile(path.join(tmpDir, "file2.ts"), "content2");
    await fs.writeFile(path.join(tmpDir, "other.json"), "{}" );
    await fs.mkdir(path.join(tmpDir, "subdir"));
    await fs.writeFile(path.join(tmpDir, "subdir", "nested.ts"), "nested");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("finds files matching pattern", async () => {
    const result = await tool.call({ pattern: "**/*.ts", limit: 500 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    const files = result.data as string[];
    expect(files.length).toBe(3);
    expect(files.every((f) => f.endsWith(".ts"))).toBe(true);
  });

  it("uses explicit path parameter over context.cwd", async () => {
    const result = await tool.call(
      { pattern: "*.ts", path: tmpDir, limit: 500 },
      makeContext("/tmp")
    );
    expect(result.success).toBe(true);
    const files = result.data as string[];
    expect(files.length).toBe(2);
  });

  it("respects limit parameter", async () => {
    const result = await tool.call({ pattern: "**/*.ts", limit: 1 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    const files = result.data as string[];
    expect(files.length).toBe(1);
    expect(result.summary).toContain("showing first 1");
  });

  it("returns empty array for no matches", async () => {
    const result = await tool.call({ pattern: "**/*.nonexistent", limit: 500 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("handles invalid cwd gracefully", async () => {
    const result = await tool.call(
      { pattern: "**/*.ts", path: "/nonexistent/path/xyz", limit: 500 },
      makeContext("/nonexistent/path/xyz")
    );
    // glob returns empty array for non-existent dirs rather than throwing
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ pattern: "**/*.ts", limit: 500 }, makeContext(tmpDir));
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ pattern: "**/*.ts", limit: 500 })).toBe(true);
  });

  it("includes description with cwd", () => {
    const desc = tool.description({ cwd: "/some/path" });
    expect(desc).toContain("/some/path");
  });

  it("artifacts contains matched file paths", async () => {
    const result = await tool.call({ pattern: "*.json", limit: 500 }, makeContext(tmpDir));
    expect(result.success).toBe(true);
    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!.length).toBe(1);
  });
});
