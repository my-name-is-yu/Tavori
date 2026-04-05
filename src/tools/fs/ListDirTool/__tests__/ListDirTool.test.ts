import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ListDirTool } from "../ListDirTool.js";
import type { ToolCallContext } from "../../../types.js";

function makeContext(cwd = "/tmp"): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("ListDirTool", () => {
  let tmpDir: string;
  const tool = new ListDirTool();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "listdir-test-"));
    await fs.writeFile(path.join(tmpDir, "file1.ts"), "content1");
    await fs.writeFile(path.join(tmpDir, "file2.json"), "{}");
    await fs.writeFile(path.join(tmpDir, ".hidden"), "hidden");
    await fs.mkdir(path.join(tmpDir, "subdir"));
    await fs.writeFile(path.join(tmpDir, "subdir", "nested.ts"), "nested");
    await fs.mkdir(path.join(tmpDir, "subdir", "deep"));
    await fs.writeFile(path.join(tmpDir, "subdir", "deep", "leaf.ts"), "leaf");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("list_dir");
    });

    it("is read_only", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
    });

    it("isReadOnly is true", () => {
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("description", () => {
    it("includes cwd from context", () => {
      const desc = tool.description({ cwd: "/some/path" });
      expect(desc).toContain("/some/path");
    });

    it("returns a non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false })).toBe(true);
    });
  });

  describe("call", () => {
    it("lists files and directories at top level", async () => {
      const result = await tool.call({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      const names = entries.map((e) => e.name);
      expect(names).toContain("file1.ts");
      expect(names).toContain("file2.json");
      expect(names).toContain("subdir");
      // hidden file excluded by default
      expect(names).not.toContain(".hidden");
    });

    it("includes hidden files when includeHidden is true", async () => {
      const result = await tool.call({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: true }, makeContext());
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string }>;
      const names = entries.map((e) => e.name);
      expect(names).toContain(".hidden");
    });

    it("distinguishes file and dir types", async () => {
      const result = await tool.call({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      const entries = result.data as Array<{ name: string; type: string }>;
      const subdir = entries.find((e) => e.name === "subdir");
      const file1 = entries.find((e) => e.name === "file1.ts");
      expect(subdir?.type).toBe("dir");
      expect(file1?.type).toBe("file");
    });

    it("includes size for files", async () => {
      const result = await tool.call({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      const entries = result.data as Array<{ name: string; type: string; size?: number }>;
      const file1 = entries.find((e) => e.name === "file1.ts");
      expect(file1?.size).toBeGreaterThanOrEqual(0);
    });

    it("returns nested entries when recursive is true", async () => {
      const result = await tool.call({ path: tmpDir, recursive: true, maxDepth: 2, includeHidden: false }, makeContext());
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string }>;
      const names = entries.map((e) => e.name);
      // Should include nested file under subdir
      expect(names.some((n) => n.includes("nested.ts"))).toBe(true);
    });

    it("respects maxDepth and does not recurse beyond it", async () => {
      // maxDepth=1 should only list top level, not subdir contents
      const result = await tool.call({ path: tmpDir, recursive: true, maxDepth: 1, includeHidden: false }, makeContext());
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string }>;
      const names = entries.map((e) => e.name);
      expect(names).not.toContain("nested.ts");
      expect(names.some((n) => n.includes("nested.ts"))).toBe(false);
    });

    it("returns error for non-existent path", async () => {
      const result = await tool.call({ path: "/nonexistent/xyz/abc", recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("summary contains entry count", async () => {
      const result = await tool.call({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      expect(result.summary).toContain("entries");
    });

    it("artifacts contains the queried path", async () => {
      const result = await tool.call({ path: tmpDir, recursive: false, maxDepth: 2, includeHidden: false }, makeContext());
      expect(result.artifacts).toContain(tmpDir);
    });
  });
});
