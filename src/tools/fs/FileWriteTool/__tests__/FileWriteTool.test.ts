import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallContext } from "../../../types.js";

vi.mock("node:fs", () => ({
  promises: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
  },
}));

import { FileWriteTool } from "../FileWriteTool.js";
import { promises as fsMock } from "node:fs";

const makeContext = (overrides: Partial<ToolCallContext> = {}): ToolCallContext => ({
  cwd: "/tmp/test",
  goalId: "g1",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => false,
  ...overrides,
});

describe("FileWriteTool", () => {
  let tool: FileWriteTool;

  beforeEach(() => {
    tool = new FileWriteTool();
    vi.clearAllMocks();
  });

  it("writes content to file", async () => {
    const result = await tool.call(
      { path: "output.txt", content: "hello world", createDirs: true },
      makeContext(),
    );
    expect(result.success).toBe(true);
    expect(vi.mocked(fsMock.writeFile)).toHaveBeenCalledWith(
      "/tmp/test/output.txt",
      "hello world",
      "utf-8",
    );
    const data = result.data as { path: string; bytesWritten: number };
    expect(data.bytesWritten).toBe(Buffer.byteLength("hello world"));
  });

  it("creates parent directories when createDirs is true", async () => {
    await tool.call(
      { path: "subdir/output.txt", content: "data", createDirs: true },
      makeContext(),
    );
    expect(vi.mocked(fsMock.mkdir)).toHaveBeenCalledWith("/tmp/test/subdir", { recursive: true });
  });

  it("resolves relative paths against cwd", async () => {
    const result = await tool.call(
      { path: "relative/file.txt", content: "data", createDirs: false },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { path: string };
    expect(data.path).toBe("/tmp/test/relative/file.txt");
  });

  it("blocks path traversal (..)", async () => {
    const result = await tool.call(
      { path: "../../etc/passwd", content: "bad", createDirs: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal");
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it("blocks sensitive file patterns (.env, credentials, etc)", async () => {
    const result = await tool.call(
      { path: ".env", content: "SECRET=1", createDirs: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(".env");
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it("blocks node_modules", async () => {
    const result = await tool.call(
      { path: "node_modules/evil.js", content: "bad", createDirs: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("node_modules");
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it("returns bytesWritten in result data", async () => {
    const result = await tool.call(
      { path: "output.txt", content: "hello", createDirs: false },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { bytesWritten: number };
    expect(data.bytesWritten).toBeGreaterThan(0);
  });

  it("handles write errors gracefully", async () => {
    vi.mocked(fsMock.writeFile).mockRejectedValueOnce(new Error("permission denied"));
    const result = await tool.call(
      { path: "output.txt", content: "data", createDirs: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  it("checkPermissions denies when not preApproved", async () => {
    const result = await tool.checkPermissions(
      { path: "file.txt", content: "data", createDirs: true },
      makeContext({ preApproved: false }),
    );
    expect(result.status).toBe("needs_approval");
  });

  it("checkPermissions allows when preApproved", async () => {
    const result = await tool.checkPermissions(
      { path: "file.txt", content: "data", createDirs: true },
      makeContext({ preApproved: true }),
    );
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns false", () => {
    expect(tool.isConcurrencySafe({ path: "file.txt", content: "data", createDirs: true })).toBe(false);
  });

  it("metadata has write permissionLevel", () => {
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.name).toBe("file_write");
  });
});
