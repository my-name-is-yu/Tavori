import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import type { ToolExecutor } from "../../tools/executor.js";

// ---------------------------------------------------------------------------
// Create mock BEFORE vi.mock so we have a direct reference.
// ---------------------------------------------------------------------------
// Create mock with custom promisify so that promisify(execFileMock) returns
// { stdout, stderr } just like the real execFile.
const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  // Attach custom promisify implementation that returns { stdout, stderr }
  // matching the real child_process.execFile behavior.
  const customPromisify = (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      fn(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)[Symbol.for("nodejs.util.promisify.custom")] = customPromisify;
  return fn;
});

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

// After the mock is in place, import the module under test.
// promisify(execFileMock) will use the default callback wrapper.
import {
  buildWorkspaceContext,
  buildWorkspaceContextItems,
  buildChatContext,
  selectByTier,
  dimensionNameToSearchTerms,
  type ContextItem,
} from "../context-provider.js";

// Build a callback-style mock compatible with util.promisify.
//  receives (file, args) and returns { stdout } on success or an
// Error instance to simulate a non-zero exit / missing command.
function makeExecFileMock(
  handler: (file: string, args: string[]) => { stdout: string } | Error
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (...callArgs: any[]) => {
    const file: string = callArgs[0];
    const args: string[] = Array.isArray(callArgs[1]) ? callArgs[1] : [];
    const callback = callArgs[callArgs.length - 1];
    const result = handler(file, args);
    // Use queueMicrotask so callback is invoked asynchronously
    // (matches the real execFile behavior that promisify expects).
    queueMicrotask(() => {
      if (result instanceof Error) {
        callback(result, "", "");
      } else {
        callback(null, result.stdout, "");
      }
    });
  };
}

// ─── Mock ToolExecutor factory ───

function createMockExecutor(overrides: Record<string, unknown> = {}): ToolExecutor {
  return {
    execute: vi.fn().mockImplementation((toolName: string, _input: unknown) => {
      const defaults: Record<string, unknown> = {
        grep: { success: true, data: "src/foo.ts
src/bar.ts", summary: "2 files", durationMs: 10 },
        read: { success: true, data: "1	const x = 1;
2	export default x;", summary: "2 lines", durationMs: 5 },
        git_log: { success: true, data: ["abc1234 feat: add feature X", "def5678 fix: resolve bug Y"], summary: "2 commits", durationMs: 8 },
        "test-runner": { success: true, data: { passed: 10, failed: 0, skipped: 0, total: 10, success: true, rawOutput: "✓ 10 tests passed
Done in 1.2s", duration: 1200 }, summary: "10 passed", durationMs: 1200 },
      };
      return Promise.resolve(overrides[toolName] ?? defaults[toolName] ?? { success: false, data: null, summary: "unknown tool", durationMs: 0 });
    }),
  } as unknown as ToolExecutor;
}

describe("dimensionNameToSearchTerms", () => {
  it("returns ['TODO'] for todo_count", () => {
    expect(dimensionNameToSearchTerms("todo_count")).toEqual(["TODO"]);
  });

  it("returns ['FIXME'] for fixme_count", () => {
    expect(dimensionNameToSearchTerms("fixme_count")).toEqual(["FIXME"]);
  });

  it("returns ['test', 'coverage'] for test_coverage", () => {
    expect(dimensionNameToSearchTerms("test_coverage")).toEqual([
      "test",
      "coverage",
    ]);
  });

  it("returns fallback terms for unknown_metric", () => {
    const terms = dimensionNameToSearchTerms("unknown_metric");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).not.toContain("TODO");
    expect(terms).not.toContain("FIXME");
    expect(terms).not.toContain("test");
    expect(terms).toContain("unknown");
  });

  it("returns ['eslint'] for lint_errors", () => {
    expect(dimensionNameToSearchTerms("lint_errors")).toContain("eslint");
  });

  it("returns ['README'] for readme_quality", () => {
    expect(dimensionNameToSearchTerms("readme_quality")).toContain("README");
  });

  it("returns ['error'] for error_count", () => {
    expect(dimensionNameToSearchTerms("error_count")).toContain("error");
  });

  it("returns the full dimension name as fallback when no word is long enough", () => {
    const terms = dimensionNameToSearchTerms("a_b");
    expect(terms.length).toBeGreaterThan(0);
  });
});

describe("buildWorkspaceContext (integration)", () => {
  const projectRoot = path.resolve(__dirname, "../../../..");

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a string result", async () => {
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") {
          return {
            stdout: `${projectRoot}/src/foo.ts
${projectRoot}/src/bar.ts
`,
          };
        }
        if (file === "git") {
          return { stdout: "src/foo.ts | 3 +++
1 file changed" };
        }
        if (file === "npx") {
          return {
            stdout:
              "........

Test Files  1 passed (1)
Tests  10 passed (10)
",
          };
        }
        return { stdout: "" };
      })
    );

    const result = await buildWorkspaceContext("goal-1", "todo_count", {
      cwd: projectRoot,
      maxFileContentLines: 10,
    });
    expect(typeof result).toBe("string");
  });

  it("includes file content sections when grep finds matches", async () => {
    const realFile = path.join(
      projectRoot,
      "src/platform/observation/context-provider.ts"
    );
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") {
          return { stdout: `${realFile}
` };
        }
        if (file === "git") {
          return {
            stdout:
              "src/observation/context-provider.ts | 5 +++++
1 file changed",
          };
        }
        if (file === "npx") {
          return { stdout: "Tests  100 passed (100)
" };
        }
        return { stdout: "" };
      })
    );

    const result = await buildWorkspaceContext("goal-2", "todo_count", {
      cwd: projectRoot,
      maxFileContentLines: 10,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/\[grep "TODO"/);
    expect(result).toMatch(/\[File: .+\]/);
  });

  it("handles a dimension with no grep matches gracefully", async () => {
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") {
          return new Error("grep: no matches");
        }
        if (file === "git") {
          return { stdout: "" };
        }
        if (file === "npx") {
          return { stdout: "Tests  10 passed (10)
" };
        }
        return { stdout: "" };
      })
    );

    const result = await buildWorkspaceContext(
      "goal-3",
      "zzz_xyzzy_nonexistent_9999",
      { cwd: projectRoot, maxFileContentLines: 5 }
    );
    expect(typeof result).toBe("string");
    expect(result).toBeDefined();
  });

  it("respects maxFileContentLines option by limiting lines per file", async () => {
    const realFile = path.join(
      projectRoot,
      "src/platform/observation/context-provider.ts"
    );
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") {
          return { stdout: `${realFile}
` };
        }
        if (file === "git") {
          return {
            stdout: "context-provider.ts | 10 ++++++++++
1 file changed",
          };
        }
        if (file === "npx") {
          return { stdout: "Tests  3412 passed (3412)
" };
        }
        return { stdout: "" };
      })
    );

    const result = await buildWorkspaceContext("goal-4", "test_coverage", {
      cwd: projectRoot,
      maxFileContentLines: 3,
    });
    expect(typeof result).toBe("string");
    const fileSectionRegex =
      /\[File: [^\]]+\]
([\s\S]*?)(?=
\[(?:grep|File|Recent|Test)|$)/g;
    let match: RegExpExecArray | null;
    while ((match = fileSectionRegex.exec(result)) !== null) {
      const fileContent = match[1];
      const nonEmptyLines = fileContent
        .split("
")
        .filter((l) => l.trim() !== "");
      expect(nonEmptyLines.length).toBeLessThanOrEqual(20);
    }
  });

  it("returns fallback message when no context is available at all", async () => {
    execFileMock.mockImplementation(
      makeExecFileMock((_file) => new Error("command not found"))
    );

    const result = await buildWorkspaceContext("goal-5", "unknown_xyz", {
      cwd: "/tmp",
      maxFileContentLines: 5,
    });
    expect(typeof result).toBe("string");
    expect(result).toBe("(No workspace context available)");
  });
});

// ─── Tier-aware context ───

describe("selectByTier", () => {
  const makeItem = (label: string, tier: ContextItem["memory_tier"]): ContextItem => ({
    label,
    content: `content of ${label}`,
    memory_tier: tier,
  });

  it("always includes core items", () => {
    const items: ContextItem[] = [
      makeItem("recall-1", "recall"),
      makeItem("core-1", "core"),
      makeItem("archival-1", "archival"),
    ];
    const selected = selectByTier(items, 1);
    // core is always included even with maxItems=1
    expect(selected.some((i) => i.memory_tier === "core")).toBe(true);
  });

  it("fills remaining slots with recall after core", () => {
    const items: ContextItem[] = [
      makeItem("core-1", "core"),
      makeItem("recall-1", "recall"),
      makeItem("recall-2", "recall"),
      makeItem("archival-1", "archival"),
    ];
    const selected = selectByTier(items, 2);
    expect(selected).toHaveLength(2);
    expect(selected[0].memory_tier).toBe("core");
    expect(selected[1].memory_tier).toBe("recall");
  });

  it("includes archival only when slots remain after core and recall", () => {
    const items: ContextItem[] = [
      makeItem("core-1", "core"),
      makeItem("archival-1", "archival"),
    ];
    const selected = selectByTier(items, 10); // plenty of slots
    const tiers = selected.map((i) => i.memory_tier);
    expect(tiers).toContain("core");
    expect(tiers).toContain("archival");
  });

  it("excludes archival when no slots remain after core and recall", () => {
    const items: ContextItem[] = [
      makeItem("core-1", "core"),
      makeItem("recall-1", "recall"),
      makeItem("archival-1", "archival"),
    ];
    const selected = selectByTier(items, 2);
    expect(selected.some((i) => i.memory_tier === "archival")).toBe(false);
  });

  it("treats items with no tier as recall (backward compat)", () => {
    // Simulate an item where memory_tier might be undefined (backward compat)
    const item = { label: "legacy", content: "data" } as unknown as ContextItem;
    const selected = selectByTier([item], 5);
    // Should be included (treated as recall)
    expect(selected).toHaveLength(1);
  });
});

describe("buildWorkspaceContextItems", () => {
  const projectRoot = path.resolve(__dirname, "../../../..");

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns ContextItem array with memory_tier fields", async () => {
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") return { stdout: "" };
        if (file === "git") return { stdout: "src/foo.ts | 3 +++
1 file changed" };
        if (file === "npx") return { stdout: "Tests  10 passed (10)
" };
        return { stdout: "" };
      })
    );

    const items = await buildWorkspaceContextItems("goal-tier-1", "todo_count", {
      cwd: projectRoot,
    });
    expect(Array.isArray(items)).toBe(true);
    for (const item of items) {
      expect(item).toHaveProperty("memory_tier");
      expect(["core", "recall", "archival"]).toContain(item.memory_tier);
    }
  });

  it("respects maxItems cap via tier-priority selection", async () => {
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") return { stdout: `${projectRoot}/src/observation/context-provider.ts
` };
        if (file === "git") return { stdout: "src/foo.ts | 3 +++
1 file changed" };
        if (file === "npx") return { stdout: "Tests  10 passed (10)
" };
        return { stdout: "" };
      })
    );

    const items = await buildWorkspaceContextItems("goal-tier-2", "todo_count", {
      cwd: projectRoot,
      maxItems: 1,
    });
    expect(items.length).toBeLessThanOrEqual(1);
  });

  it("labels recent-changes items as recall tier", async () => {
    execFileMock.mockImplementation(
      makeExecFileMock((file) => {
        if (file === "grep") return new Error("no matches");
        if (file === "git") return { stdout: "src/foo.ts | 3 +++
1 file changed" };
        if (file === "npx") return { stdout: "Tests  5 passed (5)
" };
        return { stdout: "" };
      })
    );

    const items = await buildWorkspaceContextItems("goal-tier-3", "unknown_xyz", {
      cwd: projectRoot,
    });
    const gitItem = items.find((i) => i.label.includes("Recent changes"));
    expect(gitItem).toBeDefined();
    expect(gitItem?.memory_tier).toBe("recall");
  });
});

// ─── ToolExecutor integration tests ───

describe("collectContextItems with toolExecutor", () => {
  const projectRoot = path.resolve(__dirname, "../../../..");

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls grep/read/git_log/test-runner via toolExecutor", async () => {
    const executor = createMockExecutor();
    const executeFn = executor.execute as ReturnType<typeof vi.fn>;

    const result = await buildWorkspaceContext("goal-tool-1", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(typeof result).toBe("string");
    const calledTools = executeFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledTools).toContain("grep");
    expect(calledTools).toContain("read");
    expect(calledTools).toContain("git_log");
    expect(calledTools).toContain("test-runner");
    // execFileMock should NOT be called when toolExecutor is provided
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("includes grep-matched files in output", async () => {
    const executor = createMockExecutor();

    const result = await buildWorkspaceContext("goal-tool-2", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(result).toMatch(/\[grep "TODO"/);
    expect(result).toMatch(/\[File: /);
  });

  it("includes git log in output", async () => {
    const executor = createMockExecutor();

    const result = await buildWorkspaceContext("goal-tool-3", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(result).toMatch(/Recent changes: git log --oneline/);
    expect(result).toContain("abc1234 feat: add feature X");
  });

  it("includes test status in output", async () => {
    const executor = createMockExecutor();

    const result = await buildWorkspaceContext("goal-tool-4", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(result).toMatch(/\[Test status\]/);
    expect(result).toContain("10 tests passed");
  });

  it("skips gracefully when grep tool fails", async () => {
    const executor = createMockExecutor({
      grep: { success: false, data: null, summary: "grep failed", durationMs: 0 },
    });

    const result = await buildWorkspaceContext("goal-tool-fallback-1", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(typeof result).toBe("string");
    // grep failed → no grep section
    expect(result).not.toMatch(/\[grep "TODO"/);
  });

  it("skips gracefully when git_log tool fails", async () => {
    const executor = createMockExecutor({
      git_log: { success: false, data: null, summary: "git_log failed", durationMs: 0 },
    });

    const result = await buildWorkspaceContext("goal-tool-fallback-2", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(typeof result).toBe("string");
    expect(result).not.toMatch(/Recent changes: git log --oneline/);
  });

  it("skips gracefully when test-runner tool fails", async () => {
    const executor = createMockExecutor({
      "test-runner": { success: false, data: null, summary: "runner failed", durationMs: 0 },
    });

    const result = await buildWorkspaceContext("goal-tool-fallback-3", "todo_count", {
      cwd: projectRoot,
      toolExecutor: executor,
    });

    expect(typeof result).toBe("string");
    expect(result).not.toMatch(/\[Test status\]/);
  });
});

describe("buildChatContext with toolExecutor", () => {
  const projectRoot = path.resolve(__dirname, "../../../..");

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls grep/read/git_log/test-runner for chat context", async () => {
    const executor = createMockExecutor();
    const executeFn = executor.execute as ReturnType<typeof vi.fn>;

    const result = await buildChatContext("fix the todo items in auth module", projectRoot, {
      toolExecutor: executor,
    });

    expect(typeof result).toBe("string");
    const calledTools = executeFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledTools).toContain("git_log");
    expect(calledTools).toContain("test-runner");
    expect(calledTools).toContain("grep");
    expect(calledTools).toContain("read");
  });

  it("includes working directory header in output", async () => {
    const executor = createMockExecutor();

    const result = await buildChatContext("refactor the auth module", projectRoot, {
      toolExecutor: executor,
    });

    expect(result).toContain(`Working directory: ${projectRoot}`);
    expect(result).toContain("Task: refactor the auth module");
  });

  it("includes git log output in chat context", async () => {
    const executor = createMockExecutor();

    const result = await buildChatContext("add tests for login", projectRoot, {
      toolExecutor: executor,
    });

    expect(result).toMatch(/Recent changes: git log --oneline/);
    expect(result).toContain("abc1234 feat: add feature X");
  });

  it("skips gracefully when all tool calls fail", async () => {
    const executor = createMockExecutor({
      grep: { success: false, data: null, summary: "fail", durationMs: 0 },
      read: { success: false, data: null, summary: "fail", durationMs: 0 },
      git_log: { success: false, data: null, summary: "fail", durationMs: 0 },
      "test-runner": { success: false, data: null, summary: "fail", durationMs: 0 },
    });

    const result = await buildChatContext("fix the bug", projectRoot, {
      toolExecutor: executor,
    });

    // Should not throw; basic header info should still be present
    expect(typeof result).toBe("string");
    expect(result).toContain(`Working directory: ${projectRoot}`);
  });
});
