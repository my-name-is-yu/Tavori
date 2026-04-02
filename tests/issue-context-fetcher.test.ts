import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractIssueNumbers, fetchIssueContext } from "../src/execution/issue-context-fetcher.js";

// ─── Mock execFileNoThrow ───
vi.mock("../src/utils/execFileNoThrow.js", () => ({
  execFileNoThrow: vi.fn(),
}));

import { execFileNoThrow } from "../src/utils/execFileNoThrow.js";
const mockExec = vi.mocked(execFileNoThrow);

// ─── extractIssueNumbers ───
describe("extractIssueNumbers", () => {
  it("extracts a bare issue number", () => {
    expect(extractIssueNumbers("#123")).toEqual([123]);
  });

  it("extracts from prose text", () => {
    expect(extractIssueNumbers("Fix #456 and close #789")).toEqual([456, 789]);
  });

  it("extracts from 'issue #NNN' pattern", () => {
    expect(extractIssueNumbers("See issue #101")).toEqual([101]);
  });

  it("extracts from parenthetical reference", () => {
    expect(extractIssueNumbers("(#202)")).toEqual([202]);
  });

  it("does NOT match hex color #fff", () => {
    expect(extractIssueNumbers("color: #fff")).toEqual([]);
  });

  it("does NOT match hex color #abc123", () => {
    expect(extractIssueNumbers("background: #abc123")).toEqual([]);
  });

  it("does NOT match mixed hex like #1a2b3c", () => {
    expect(extractIssueNumbers("#1a2b3c")).toEqual([]);
  });

  it("deduplicates repeated issue numbers", () => {
    expect(extractIssueNumbers("#42 and again #42")).toEqual([42]);
  });

  it("returns empty array when no issues found", () => {
    expect(extractIssueNumbers("no issues here")).toEqual([]);
  });

  it("handles multiple issues in one string", () => {
    const result = extractIssueNumbers("refs #1, #2, #3, #4");
    expect(result).toEqual([1, 2, 3, 4]);
  });
});

// ─── fetchIssueContext ───
describe("fetchIssueContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty string when no issue numbers found", async () => {
    const result = await fetchIssueContext("no issues in this text");
    expect(result).toBe("");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns formatted context for a single issue", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify({ title: "Fix the bug", body: "Detailed description" }),
      stderr: "",
      exitCode: 0,
    });

    const result = await fetchIssueContext("Fix #123 now");
    expect(result).toContain("## Referenced Issue #123");
    expect(result).toContain("Title: Fix the bug");
    expect(result).toContain("Detailed description");
  });

  it("returns formatted context for multiple issues", async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ title: "Issue one", body: "Body one" }),
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ title: "Issue two", body: "Body two" }),
        stderr: "",
        exitCode: 0,
      });

    const result = await fetchIssueContext("See #10 and #20");
    expect(result).toContain("## Referenced Issue #10");
    expect(result).toContain("## Referenced Issue #20");
  });

  it("limits to first 3 issues", async () => {
    mockExec.mockResolvedValue({
      stdout: JSON.stringify({ title: "T", body: "B" }),
      stderr: "",
      exitCode: 0,
    });

    await fetchIssueContext("#1 #2 #3 #4 #5");
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("gracefully degrades when execFileNoThrow throws", async () => {
    mockExec.mockRejectedValueOnce(new Error("gh not found"));
    const result = await fetchIssueContext("Fix #99");
    expect(result).toBe("");
  });

  it("gracefully degrades when gh returns non-zero exit code", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "not found",
      exitCode: 1,
    });
    const result = await fetchIssueContext("Fix #99");
    expect(result).toBe("");
  });

  it("gracefully degrades when JSON parse fails", async () => {
    mockExec.mockResolvedValueOnce({
      stdout: "not valid json",
      stderr: "",
      exitCode: 0,
    });
    const result = await fetchIssueContext("Fix #99");
    expect(result).toBe("");
  });

  it("truncates long issue body to 3000 chars", async () => {
    const longBody = "x".repeat(5000);
    mockExec.mockResolvedValueOnce({
      stdout: JSON.stringify({ title: "Long issue", body: longBody }),
      stderr: "",
      exitCode: 0,
    });

    const result = await fetchIssueContext("#77");
    // The body in result should be truncated; full 5000 char body should not appear
    expect(result).not.toContain("x".repeat(3001));
    expect(result).toContain("x".repeat(100)); // partial body is present
  });

  it("deduplicates issue numbers before fetching", async () => {
    mockExec.mockResolvedValue({
      stdout: JSON.stringify({ title: "Dup", body: "body" }),
      stderr: "",
      exitCode: 0,
    });

    await fetchIssueContext("#55 and #55 again #55");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("skips failed issues and returns context for successful ones", async () => {
    mockExec
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ title: "Good issue", body: "Good body" }),
        stderr: "",
        exitCode: 0,
      });

    const result = await fetchIssueContext("#1 #2");
    expect(result).not.toContain("## Referenced Issue #1");
    expect(result).toContain("## Referenced Issue #2");
    expect(result).toContain("Good issue");
  });
});
