import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallContext } from "../../../types.js";

vi.mock("../../../../base/utils/execFileNoThrow.js", () => ({
  execFileNoThrow: vi.fn(),
}));

import { GitDiffTool } from "../GitDiffTool.js";
import { execFileNoThrow } from "../../../../base/utils/execFileNoThrow.js";

const mockedExecFile = vi.mocked(execFileNoThrow);

const makeContext = (): ToolCallContext => ({
  cwd: "/repo",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

describe("GitDiffTool", () => {
  let tool: GitDiffTool;

  beforeEach(() => {
    tool = new GitDiffTool();
    vi.clearAllMocks();
  });

  it("metadata is correct", () => {
    expect(tool.metadata.name).toBe("git_diff");
    expect(tool.metadata.permissionLevel).toBe("read_only");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.maxConcurrency).toBe(5);
    expect(tool.metadata.tags).toEqual(expect.arrayContaining(["git", "diff", "changes", "verification"]));
  });

  it("returns unstaged diff", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "diff output here\nline2", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "unstaged", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("diff output here");
    expect(mockedExecFile).toHaveBeenCalledWith("git", ["diff"], expect.objectContaining({ cwd: "/repo" }));
  });

  it("returns staged diff", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "staged diff content", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "staged", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("staged diff content");
    expect(mockedExecFile).toHaveBeenCalledWith("git", ["diff", "--cached"], expect.any(Object));
  });

  it("returns commit diff", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "commit diff", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "commit", ref: "abc123", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(mockedExecFile).toHaveBeenCalledWith("git", ["diff", "abc123^..abc123"], expect.any(Object));
  });

  it("filters by path", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "path filtered diff", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "unstaged", path: "src/foo.ts", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(mockedExecFile).toHaveBeenCalledWith("git", ["diff", "--", "src/foo.ts"], expect.any(Object));
  });

  it("truncates long output", async () => {
    const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    mockedExecFile.mockResolvedValue({ stdout: manyLines, stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "unstaged", maxLines: 10 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data as string).toContain("[truncated]");
    const outputLines = (result.data as string).split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(12); // 10 lines + truncated marker + possible trailing newline
  });

  it("rejects invalid ref - semicolon", async () => {
    const result = await tool.call({ target: "branch", ref: "main;rm -rf /", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("rejects invalid ref - dollar sign", async () => {
    const result = await tool.call({ target: "commit", ref: "$(evil)", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
  });

  it("rejects invalid ref - backtick", async () => {
    const result = await tool.call({ target: "branch", ref: "`whoami`", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
  });

  it("rejects path with null byte", async () => {
    const result = await tool.call({ target: "unstaged", path: "src/foo" + String.fromCharCode(0) + "evil", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("null byte");
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("allows path with spaces and special chars (execFile prevents injection)", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "diff output", stderr: "", exitCode: 0 });
    const result = await tool.call({ target: "unstaged", path: "src/foo.ts; rm -rf /", maxLines: 200 }, makeContext());
    // Path is passed safely via execFile args array, not shell-interpolated
    expect(mockedExecFile).toHaveBeenCalled();
  });

  it("handles no changes gracefully", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "unstaged", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
    expect(result.summary).toContain("No changes");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ target: "unstaged", maxLines: 200 }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ target: "unstaged", maxLines: 200 })).toBe(true);
  });

  it("returns head diff with default HEAD ref", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "head diff output", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "head", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("head diff output");
    expect(mockedExecFile).toHaveBeenCalledWith("git", ["diff", "HEAD"], expect.any(Object));
  });

  it("returns head diff with custom ref", async () => {
    mockedExecFile.mockResolvedValue({ stdout: "custom ref diff", stderr: "", exitCode: 0 });

    const result = await tool.call({ target: "head", ref: "main", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(mockedExecFile).toHaveBeenCalledWith("git", ["diff", "main"], expect.any(Object));
  });
});
