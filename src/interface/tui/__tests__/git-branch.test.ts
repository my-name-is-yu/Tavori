import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGitBranch } from "../git-branch.js";

describe("getGitBranch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-tui-branch-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not write git errors to stderr outside a repository", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write");

    expect(getGitBranch(tmpDir)).toBe("");
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
