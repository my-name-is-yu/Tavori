import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { GrepTool } from "../grep.js";
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

function findRgBinary(): string | null {
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
  ];
  for (const p of candidates) {
    try {
      execFileSync(p, ["--version"], { timeout: 3000 });
      return p;
    } catch {
      // not found at this path
    }
  }
  // Try PATH as fallback (works if not a shell function)
  try {
    execFileSync("rg", ["--version"], { timeout: 3000 });
    return "rg";
  } catch {
    return null;
  }
}

const RG_BIN = findRgBinary();
const HAS_RG = RG_BIN !== null;

describe("GrepTool", () => {
  let tmpDir: string;
  const tool = new GrepTool();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
    await fs.writeFile(
      path.join(tmpDir, "alpha.ts"),
      'export const hello = "world";\nexport const foo = 42;\n'
    );
    await fs.writeFile(
      path.join(tmpDir, "beta.ts"),
      'import { hello } from "./alpha.js";\nconsole.log(hello);\n'
    );
    await fs.writeFile(path.join(tmpDir, "other.json"), '{"key": "value"}');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!HAS_RG)("files_with_matches mode returns file paths", async () => {
    const result = await tool.call(
      { pattern: "hello", outputMode: "files_with_matches", limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    const output = result.data as string;
    const files = output.split("\n").filter(Boolean);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes("alpha.ts"))).toBe(true);
    expect(files.some((f) => f.includes("beta.ts"))).toBe(true);
  });

  it.skipIf(!HAS_RG)("content mode returns matching lines with line numbers", async () => {
    const result = await tool.call(
      { pattern: "foo", outputMode: "content", limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    const output = result.data as string;
    expect(output).toContain("alpha.ts");
    expect(output).toContain("foo");
  });

  it.skipIf(!HAS_RG)("count mode returns match counts per file", async () => {
    const result = await tool.call(
      { pattern: "hello", outputMode: "count", limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    const output = result.data as string;
    expect(output).toContain(":");
  });

  it.skipIf(!HAS_RG)("case insensitive flag works", async () => {
    const result = await tool.call(
      { pattern: "HELLO", outputMode: "files_with_matches", limit: 250, caseInsensitive: true },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    const output = result.data as string;
    const files = output.split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_RG)("glob filter restricts to matching file types", async () => {
    const result = await tool.call(
      { pattern: "hello", outputMode: "files_with_matches", glob: "*.json", limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    const output = result.data as string;
    expect(output.trim()).toBe("");
  });

  it.skipIf(!HAS_RG)("no matches returns empty result with success", async () => {
    const result = await tool.call(
      { pattern: "ZZZNOMATCHZZZ", outputMode: "files_with_matches", limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
  });

  it.skipIf(!HAS_RG)("context lines option adds surrounding lines", async () => {
    const result = await tool.call(
      { pattern: "foo", outputMode: "content", context: 1, limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.success).toBe(true);
    const output = result.data as string;
    expect(output).toContain("foo");
    expect(output).toContain("--");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions(
      { pattern: "test", outputMode: "files_with_matches", limit: 250, caseInsensitive: false },
      makeContext(tmpDir)
    );
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ pattern: "test", outputMode: "files_with_matches", limit: 250, caseInsensitive: false })).toBe(true);
  });
});
