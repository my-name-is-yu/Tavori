import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── Mock child_process.spawn ───
//
// vi.mock() is hoisted to the top of the file by vitest, so any variables
// referenced inside the factory must themselves be declared via vi.hoisted()
// to be available before the mock factory runs.

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

import { GitHubIssueAdapter } from "../src/adapters/github-issue.js";
import type { AgentTask } from "../src/execution/adapter-layer.js";

// ─── Helpers ───

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    end: vi.fn(),
    on: vi.fn(),
  };
  readonly kill = vi.fn();
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "Fix bug\nThis is a detailed description of the bug.",
    timeout_ms: 10000,
    adapter_type: "github_issue",
    ...overrides,
  };
}

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

// ─── parsePrompt tests ───

describe("GitHubIssueAdapter.parsePrompt", () => {
  let adapter: GitHubIssueAdapter;

  beforeEach(() => {
    adapter = new GitHubIssueAdapter();
  });

  it("parses structured JSON block with title, body, and labels", () => {
    const prompt = "```github-issue\n{\"title\":\"Fix bug\",\"body\":\"Details\",\"labels\":[\"bug\"]}\n```";
    const result = adapter.parsePrompt(prompt);

    expect(result.title).toBe("Fix bug");
    expect(result.body).toBe("Details");
    expect(result.labels).toContain("bug");
  });

  it("merges JSON labels with default labels", () => {
    const prompt = "```github-issue\n{\"title\":\"Improve perf\",\"body\":\"Slow\",\"labels\":[\"performance\"]}\n```";
    const result = adapter.parsePrompt(prompt);

    expect(result.labels).toContain("performance");
    // Default label(s) should also be present
    expect(result.labels.length).toBeGreaterThanOrEqual(1);
  });

  it("parses fallback format: first line as title, rest as body", () => {
    const prompt = "Fix the login bug\nThe login page throws an error when password is empty.";
    const result = adapter.parsePrompt(prompt);

    expect(result.title).toBe("Fix the login bug");
    expect(result.body).toContain("The login page throws an error");
  });

  it("fallback format uses default labels only", () => {
    const prompt = "Fix the login bug\nSome details.";
    const result = adapter.parsePrompt(prompt);

    expect(Array.isArray(result.labels)).toBe(true);
  });

  it("empty prompt returns sensible defaults (no throw)", () => {
    const result = adapter.parsePrompt("");

    expect(typeof result.title).toBe("string");
    expect(typeof result.body).toBe("string");
    expect(Array.isArray(result.labels)).toBe(true);
  });

  it("JSON block with only title gets empty body and default labels", () => {
    const prompt = "```github-issue\n{\"title\":\"Only title here\"}\n```";
    const result = adapter.parsePrompt(prompt);

    expect(result.title).toBe("Only title here");
    expect(result.body).toBe("");
    expect(Array.isArray(result.labels)).toBe(true);
  });

  it("deduplicates labels when JSON and defaults overlap", () => {
    const adapter2 = new GitHubIssueAdapter({ defaultLabels: ["pulseed"] });
    const prompt = "```github-issue\n{\"title\":\"T\",\"body\":\"B\",\"labels\":[\"pulseed\"]}\n```";
    const result = adapter2.parsePrompt(prompt);

    const pulseedCount = result.labels.filter((l) => l === "pulseed").length;
    expect(pulseedCount).toBe(1);
  });
});

// ─── constructor tests ───

describe("GitHubIssueAdapter constructor", () => {
  it("has adapterType 'github_issue'", () => {
    const adapter = new GitHubIssueAdapter();
    expect(adapter.adapterType).toBe("github_issue");
  });

  it("applies default config values without throwing", () => {
    expect(() => new GitHubIssueAdapter()).not.toThrow();
  });

  it("accepts custom config overrides", () => {
    const adapter = new GitHubIssueAdapter({
      repo: "owner/repo",
      defaultLabels: ["custom-label"],
      timeout_ms: 20000,
    });
    expect(adapter.adapterType).toBe("github_issue");
  });
});

// ─── Helpers for dedup-aware tests ───
//
// execute() now fires a `gh issue list` spawn (dedup check) BEFORE the
// issue-create (or repo-detect) spawn. Each execute test that is NOT dry-run
// must queue a dedup child first via makeDedupChild().

/**
 * Queue a fake child for the dedup check that returns no matching issues (empty array).
 * This is the "no duplicate found" case — execution continues normally.
 */
function makeDedupChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  // Emit an empty JSON array so checkOpenIssueExists returns null immediately.
  // We emit synchronously here so the Promise resolves before execute() proceeds.
  // (The close event is what triggers resolution; stdout data just sets the buffer.)
  return child;
}

async function resolveDedupChildNoMatch(child: FakeChildProcess): Promise<void> {
  child.stdout.emit("data", Buffer.from("[]"));
  child.emit("close", 0);
  // Flush the microtask queue so the awaited checkOpenIssueExists() Promise
  // settles and execute() resumes before the caller emits on the create child.
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ─── execute tests ───

describe("GitHubIssueAdapter.execute", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["PULSEED_GITHUB_REPO"];
  });

  it("returns success result with issue URL when gh CLI exits with code 0", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.stdout.emit("data", Buffer.from("https://github.com/owner/repo/issues/42\n"));
    child.emit("close", 0);
    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(result.output).toContain("https://github.com/owner/repo/issues/42");
    expect(result.stopped_reason).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("returns error result when gh CLI exits with non-zero code", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.stderr.emit("data", Buffer.from("gh: not authenticated"));
    child.emit("close", 1);
    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.error).toContain("gh: not authenticated");
  });

  it("returns timeout result when process runs longer than timeout_ms", async () => {
    vi.useFakeTimers();

    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask({ timeout_ms: 500 }));

    // Resolve the dedup check first; use advanceTimersByTimeAsync to flush
    // the setTimeout(0) inside resolveDedupChildNoMatch under fake timers.
    dedupChild.stdout.emit("data", Buffer.from("[]"));
    dedupChild.emit("close", 0);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(501);
    child.emit("close", null);
    const result = await executePromise;
    vi.useRealTimers();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("timeout");
    expect(result.error).toMatch(/Timed out after 500ms/);
  });

  it("dry-run mode returns success without spawning gh", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo", dryRun: true });

    const result = await adapter.execute(makeTask());

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/dry.?run/i);
  });

  it("uses PULSEED_GITHUB_REPO env var when config.repo is empty", async () => {
    process.env["PULSEED_GITHUB_REPO"] = "env-owner/env-repo";
    const adapter = new GitHubIssueAdapter();
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.stdout.emit("data", Buffer.from("https://github.com/env-owner/env-repo/issues/1\n"));
    child.emit("close", 0);
    const result = await executePromise;

    expect(result.success).toBe(true);
    // Verify the repo was passed to gh (check spawn args — find the issue create call)
    const spawnCalls = mockSpawn.mock.calls;
    const createCall = spawnCalls.find(
      ([cmd, args]: [string, string[]]) => cmd === "gh" && args.includes("create")
    );
    expect(createCall).toBeDefined();
    const args: string[] = createCall![1] as string[];
    expect(args.join(" ")).toContain("env-owner/env-repo");
  });

  it("config.repo takes priority over PULSEED_GITHUB_REPO env var", async () => {
    process.env["PULSEED_GITHUB_REPO"] = "env-owner/env-repo";
    const adapter = new GitHubIssueAdapter({ repo: "config-owner/config-repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.stdout.emit("data", Buffer.from("https://github.com/config-owner/config-repo/issues/7\n"));
    child.emit("close", 0);
    await executePromise;

    const spawnCalls = mockSpawn.mock.calls;
    const createCall = spawnCalls.find(
      ([cmd, args]: [string, string[]]) => cmd === "gh" && args.includes("create")
    );
    expect(createCall).toBeDefined();
    const args: string[] = createCall![1] as string[];
    expect(args.join(" ")).toContain("config-owner/config-repo");
    expect(args.join(" ")).not.toContain("env-owner/env-repo");
  });

  it("passes labels as multiple --label args to gh", async () => {
    const adapter = new GitHubIssueAdapter({
      repo: "owner/repo",
      defaultLabels: ["pulseed", "automated"],
    });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(
      makeTask({
        prompt: "```github-issue\n{\"title\":\"T\",\"body\":\"B\",\"labels\":[\"bug\"]}\n```",
      })
    );
    await resolveDedupChildNoMatch(dedupChild);
    child.stdout.emit("data", Buffer.from("https://github.com/owner/repo/issues/99\n"));
    child.emit("close", 0);
    await executePromise;

    const spawnCalls = mockSpawn.mock.calls;
    const createCall = spawnCalls.find(
      ([cmd, args]: [string, string[]]) => cmd === "gh" && args.includes("create")
    );
    expect(createCall).toBeDefined();
    const args: string[] = createCall![1] as string[];

    // --label should appear at least once per label
    const labelFlags = args.filter((a) => a === "--label");
    expect(labelFlags.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-detects repo when config.repo is empty and env var is unset", async () => {
    delete process.env["PULSEED_GITHUB_REPO"];
    const adapter = new GitHubIssueAdapter();

    // Spawn order: dedup check, then gh repo view (auto-detect), then gh issue create
    const dedupChild = makeDedupChild();
    const detectChild = makeFakeChild();
    const createChild = makeFakeChild();

    const executePromise = adapter.execute(makeTask());

    // Resolve dedup check first
    await resolveDedupChildNoMatch(dedupChild);

    // Simulate `gh repo view --json nameWithOwner` output
    detectChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ nameWithOwner: "auto-owner/auto-repo" }))
    );
    detectChild.emit("close", 0);

    // Simulate `gh issue create` output
    createChild.stdout.emit(
      "data",
      Buffer.from("https://github.com/auto-owner/auto-repo/issues/5\n")
    );
    createChild.emit("close", 0);

    const result = await executePromise;
    expect(result.success).toBe(true);
  });
});

// ─── checkOpenIssueExists tests ───

describe("GitHubIssueAdapter.checkOpenIssueExists", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("returns null when gh issue list returns empty array", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkOpenIssueExists("Fix login bug");
    child.stdout.emit("data", Buffer.from("[]"));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("returns issue number when a matching issue exists", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const issues = [{ number: 18, title: "Fix login authentication bug" }];
    const promise = adapter.checkOpenIssueExists("Fix login authentication issue");
    child.stdout.emit("data", Buffer.from(JSON.stringify(issues)));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBe(18);
  });

  it("returns null when existing issue title has low word overlap", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const issues = [{ number: 5, title: "Improve database performance" }];
    const promise = adapter.checkOpenIssueExists("Fix login authentication bug");
    child.stdout.emit("data", Buffer.from(JSON.stringify(issues)));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("returns null when gh exits with non-zero code (fail-open)", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkOpenIssueExists("Some title");
    child.emit("close", 1);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("returns null when gh emits an error (fail-open)", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkOpenIssueExists("Some title");
    child.emit("error", new Error("gh not found"));

    const result = await promise;
    expect(result).toBeNull();
  });

  it("returns null when stdout is not valid JSON (fail-open)", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkOpenIssueExists("Some title");
    child.stdout.emit("data", Buffer.from("not json"));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("includes --repo flag in gh issue list command when repo is configured", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkOpenIssueExists("Fix bug");
    child.stdout.emit("data", Buffer.from("[]"));
    child.emit("close", 0);
    await promise;

    const spawnCalls = mockSpawn.mock.calls;
    const listCall = spawnCalls.find(
      ([cmd, args]: [string, string[]]) => cmd === "gh" && args.includes("list")
    );
    expect(listCall).toBeDefined();
    const args: string[] = listCall![1] as string[];
    expect(args.join(" ")).toContain("owner/repo");
  });
});

// ─── Dedup integration in execute() tests ───

describe("GitHubIssueAdapter.execute dedup", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    delete process.env["PULSEED_GITHUB_REPO"];
  });

  it("skips issue creation when a similar open issue exists", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeFakeChild();

    const issues = [{ number: 18, title: "Fix login authentication bug" }];
    const executePromise = adapter.execute(
      makeTask({ prompt: "Fix login authentication issue" })
    );
    dedupChild.stdout.emit("data", Buffer.from(JSON.stringify(issues)));
    dedupChild.emit("close", 0);

    const result = await executePromise;

    // Only one spawn (the dedup check) — no create spawn
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.stopped_reason).toBe("completed");
    expect(result.output).toMatch(/Skipped.*#18/);
  });

  it("proceeds with creation when dedup check fails with an error (fail-open)", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeFakeChild();
    const createChild = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    dedupChild.emit("error", new Error("gh not found"));
    // Flush microtasks so execute() resumes after checkOpenIssueExists() resolves.
    await new Promise<void>((r) => setTimeout(r, 0));
    createChild.stdout.emit("data", Buffer.from("https://github.com/owner/repo/issues/99\n"));
    createChild.emit("close", 0);

    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(result.output).toContain("https://github.com/owner/repo/issues/99");
  });
});

// ─── checkDuplicate tests ───

describe("GitHubIssueAdapter.checkDuplicate", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("returns true when a matching open issue exists", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const issues = [{ number: 7, title: "Fix login bug" }];
    const promise = adapter.checkDuplicate(makeTask({ prompt: "Fix login bug\nDetailed description." }));
    child.stdout.emit("data", Buffer.from(JSON.stringify(issues)));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("returns false when no matching issue exists", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkDuplicate(makeTask({ prompt: "Add new feature\nSome details." }));
    child.stdout.emit("data", Buffer.from(JSON.stringify([])));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBe(false);
  });

  it("returns false on spawn error (fail-open)", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.checkDuplicate(makeTask({ prompt: "Fix something\nDetails." }));
    child.emit("error", new Error("gh not found"));

    const result = await promise;
    expect(result).toBe(false);
  });

  it("returns false when gh returns no matching issues for a minimal prompt", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    // An empty prompt falls back to title "(no title)" — still triggers a search
    const promise = adapter.checkDuplicate(makeTask({ prompt: "" }));
    child.stdout.emit("data", Buffer.from(JSON.stringify([])));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toBe(false);
  });
});

// ─── listExistingTasks tests ───

describe("GitHubIssueAdapter.listExistingTasks", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("returns list of titles from open issues", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.listExistingTasks();
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify([{ title: "Fix bug" }, { title: "Add feature" }]))
    );
    child.emit("close", 0);

    const result = await promise;
    expect(result).toEqual(["Fix bug", "Add feature"]);
  });

  it("returns empty array when no issues exist", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.listExistingTasks();
    child.stdout.emit("data", Buffer.from("[]"));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("returns empty array on gh CLI error (fail-open)", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.listExistingTasks();
    child.emit("error", new Error("gh not found"));

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("returns empty array when gh exits with non-zero code", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.listExistingTasks();
    child.stderr.emit("data", Buffer.from("authentication required"));
    child.emit("close", 1);

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("returns empty array when stdout is malformed JSON", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const promise = adapter.listExistingTasks();
    child.stdout.emit("data", Buffer.from("not-json"));
    child.emit("close", 0);

    const result = await promise;
    expect(result).toEqual([]);
  });

  it("uses configured label in list command", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo", defaultLabels: ["custom-label"] });
    const child = makeFakeChild();

    const promise = adapter.listExistingTasks();
    child.stdout.emit("data", Buffer.from("[]"));
    child.emit("close", 0);
    await promise;

    const spawnCalls = mockSpawn.mock.calls;
    const listCall = spawnCalls.find(
      ([cmd, args]: [string, string[]]) => cmd === "gh" && args.includes("list")
    );
    expect(listCall).toBeDefined();
    const args: string[] = listCall![1] as string[];
    expect(args.join(" ")).toContain("custom-label");
  });
});

// ─── execute error classification tests ───

describe("GitHubIssueAdapter.execute error classification", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    delete process.env["PULSEED_GITHUB_REPO"];
  });

  it("classifies 'gh not found' spawn error with helpful message", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.emit("error", new Error("spawn gh ENOENT"));
    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gh CLI not found/i);
  });

  it("classifies authentication error with helpful message", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.stderr.emit("data", Buffer.from("not logged into any GitHub hosts"));
    child.emit("close", 1);
    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
  });

  it("classifies repository not found error with helpful message", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/nonexistent-repo" });
    const dedupChild = makeDedupChild();
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);
    child.stderr.emit("data", Buffer.from("repository not found"));
    child.emit("close", 1);
    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Repository not found/i);
  });

  it("returns error when repo auto-detection fails completely", async () => {
    delete process.env["PULSEED_GITHUB_REPO"];
    const adapter = new GitHubIssueAdapter();

    // dedup child, then detect child (gh repo view), then git remote — both fail
    const dedupChild = makeDedupChild();
    const detectChild = makeFakeChild();
    const gitRemoteChild = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    await resolveDedupChildNoMatch(dedupChild);

    // gh repo view fails
    detectChild.stderr.emit("data", Buffer.from("not a github repo"));
    detectChild.emit("close", 1);

    // git remote also fails
    gitRemoteChild.emit("error", new Error("git not found"));

    const result = await executePromise;

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.error).toBeTruthy();
  });
});

// ─── parsePrompt edge cases ───

describe("GitHubIssueAdapter.parsePrompt edge cases", () => {
  let adapter: GitHubIssueAdapter;

  beforeEach(() => {
    adapter = new GitHubIssueAdapter();
  });

  it("falls back to plain text when JSON block is malformed", () => {
    const prompt = "```github-issue\n{invalid json here\n```\nFallback title\nBody text";
    const result = adapter.parsePrompt(prompt);

    // Should fall back to first non-empty line as title
    expect(result.title).toBeTruthy();
    expect(typeof result.title).toBe("string");
    expect(Array.isArray(result.labels)).toBe(true);
  });

  it("JSON block with empty title falls back to (no title)", () => {
    const prompt = "```github-issue\n{\"title\":\"\",\"body\":\"Some body\"}\n```";
    const result = adapter.parsePrompt(prompt);

    expect(result.title).toBe("(no title)");
    expect(result.body).toBe("Some body");
  });

  it("JSON block with non-string title falls back to (no title)", () => {
    const prompt = "```github-issue\n{\"title\":123,\"body\":\"Body\"}\n```";
    const result = adapter.parsePrompt(prompt);

    expect(result.title).toBe("(no title)");
  });

  it("non-string labels in JSON block are filtered out", () => {
    const prompt = "```github-issue\n{\"title\":\"T\",\"labels\":[\"valid\",42,null,\"also-valid\"]}\n```";
    const result = adapter.parsePrompt(prompt);

    expect(result.labels).toContain("valid");
    expect(result.labels).toContain("also-valid");
    expect(result.labels.every((l) => typeof l === "string")).toBe(true);
  });
});
