import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallContext } from "../../../types.js";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import { FileEditTool } from "../FileEditTool.js";
import { promises as fsMock } from "node:fs";

const makeContext = (overrides: Partial<ToolCallContext> = {}): ToolCallContext => ({
  cwd: "/tmp/test",
  goalId: "g1",
  trustBalance: 50,
  preApproved: true,
  approvalFn: async () => false,
  ...overrides,
});

describe("FileEditTool", () => {
  let tool: FileEditTool;

  beforeEach(() => {
    tool = new FileEditTool();
    vi.clearAllMocks();
  });

  it("replaces exact text match", async () => {
    vi.mocked(fsMock.readFile).mockResolvedValueOnce("hello world" as any);
    const result = await tool.call(
      { path: "file.txt", oldText: "world", newText: "there", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(true);
    expect(vi.mocked(fsMock.writeFile)).toHaveBeenCalledWith(
      "/tmp/test/file.txt",
      "hello there",
      "utf-8",
    );
    const data = result.data as { matchesReplaced: number };
    expect(data.matchesReplaced).toBe(1);
  });

  it("fails when oldText not found", async () => {
    vi.mocked(fsMock.readFile).mockResolvedValueOnce("hello world" as any);
    const result = await tool.call(
      { path: "file.txt", oldText: "notfound", newText: "x", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Text not found");
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it("fails when multiple matches and replaceAll is false", async () => {
    vi.mocked(fsMock.readFile).mockResolvedValueOnce("foo bar foo" as any);
    const result = await tool.call(
      { path: "file.txt", oldText: "foo", newText: "baz", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("2 matches");
    expect(vi.mocked(fsMock.writeFile)).not.toHaveBeenCalled();
  });

  it("replaces all matches when replaceAll is true", async () => {
    vi.mocked(fsMock.readFile).mockResolvedValueOnce("foo bar foo" as any);
    const result = await tool.call(
      { path: "file.txt", oldText: "foo", newText: "baz", replaceAll: true },
      makeContext(),
    );
    expect(result.success).toBe(true);
    expect(vi.mocked(fsMock.writeFile)).toHaveBeenCalledWith(
      "/tmp/test/file.txt",
      "baz bar baz",
      "utf-8",
    );
    const data = result.data as { matchesReplaced: number };
    expect(data.matchesReplaced).toBe(2);
  });

  it("returns matchesReplaced count in result data", async () => {
    vi.mocked(fsMock.readFile).mockResolvedValueOnce("line1\nhello world\nline3" as any);
    const result = await tool.call(
      { path: "file.txt", oldText: "hello world", newText: "hi", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const data = result.data as { matchesReplaced: number };
    expect(data.matchesReplaced).toBe(1);
  });

  it("blocks path traversal", async () => {
    const result = await tool.call(
      { path: "../../etc/passwd", oldText: "root", newText: "evil", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal");
    expect(vi.mocked(fsMock.readFile)).not.toHaveBeenCalled();
  });

  it("blocks sensitive files", async () => {
    const result = await tool.call(
      { path: ".env", oldText: "SECRET=1", newText: "SECRET=2", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(".env");
    expect(vi.mocked(fsMock.readFile)).not.toHaveBeenCalled();
  });

  it("handles read errors gracefully", async () => {
    vi.mocked(fsMock.readFile).mockRejectedValueOnce(new Error("file not found"));
    const result = await tool.call(
      { path: "missing.txt", oldText: "x", newText: "y", replaceAll: false },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("file not found");
  });

  it("checkPermissions denies when not preApproved", async () => {
    const result = await tool.checkPermissions(
      { path: "file.txt", oldText: "a", newText: "b", replaceAll: false },
      makeContext({ preApproved: false }),
    );
    expect(result.status).toBe("needs_approval");
  });

  it("metadata is correct", () => {
    expect(tool.metadata.name).toBe("file_edit");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.tags).toContain("edit");
  });
});
