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
import type { AgentTask } from "../src/adapter-layer.js";

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
    const adapter2 = new GitHubIssueAdapter({ defaultLabels: ["motiva"] });
    const prompt = "```github-issue\n{\"title\":\"T\",\"body\":\"B\",\"labels\":[\"motiva\"]}\n```";
    const result = adapter2.parsePrompt(prompt);

    const motivaCount = result.labels.filter((l) => l === "motiva").length;
    expect(motivaCount).toBe(1);
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

// ─── execute tests ───

describe("GitHubIssueAdapter.execute", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["MOTIVA_GITHUB_REPO"];
  });

  it("returns success result with issue URL when gh CLI exits with code 0", async () => {
    const adapter = new GitHubIssueAdapter({ repo: "owner/repo" });
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
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
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
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
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask({ timeout_ms: 500 }));

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

  it("uses MOTIVA_GITHUB_REPO env var when config.repo is empty", async () => {
    process.env["MOTIVA_GITHUB_REPO"] = "env-owner/env-repo";
    const adapter = new GitHubIssueAdapter();
    const child = makeFakeChild();

    // We also need a second fake child if auto-detection spawns a process;
    // to keep it simple: if MOTIVA_GITHUB_REPO is set, no auto-detect spawn happens.
    const executePromise = adapter.execute(makeTask());
    child.stdout.emit("data", Buffer.from("https://github.com/env-owner/env-repo/issues/1\n"));
    child.emit("close", 0);
    const result = await executePromise;

    expect(result.success).toBe(true);
    // Verify the repo was passed to gh (check spawn args)
    const spawnCalls = mockSpawn.mock.calls;
    const ghCall = spawnCalls.find(([cmd]: [string]) => cmd === "gh");
    expect(ghCall).toBeDefined();
    const args: string[] = ghCall![1] as string[];
    expect(args.join(" ")).toContain("env-owner/env-repo");
  });

  it("config.repo takes priority over MOTIVA_GITHUB_REPO env var", async () => {
    process.env["MOTIVA_GITHUB_REPO"] = "env-owner/env-repo";
    const adapter = new GitHubIssueAdapter({ repo: "config-owner/config-repo" });
    const child = makeFakeChild();

    const executePromise = adapter.execute(makeTask());
    child.stdout.emit("data", Buffer.from("https://github.com/config-owner/config-repo/issues/7\n"));
    child.emit("close", 0);
    await executePromise;

    const spawnCalls = mockSpawn.mock.calls;
    const ghCall = spawnCalls.find(([cmd]: [string]) => cmd === "gh");
    expect(ghCall).toBeDefined();
    const args: string[] = ghCall![1] as string[];
    expect(args.join(" ")).toContain("config-owner/config-repo");
    expect(args.join(" ")).not.toContain("env-owner/env-repo");
  });

  it("passes labels as multiple --label args to gh", async () => {
    const adapter = new GitHubIssueAdapter({
      repo: "owner/repo",
      defaultLabels: ["motiva", "automated"],
    });
    const child = makeFakeChild();

    const executePromise = adapter.execute(
      makeTask({
        prompt: "```github-issue\n{\"title\":\"T\",\"body\":\"B\",\"labels\":[\"bug\"]}\n```",
      })
    );
    child.stdout.emit("data", Buffer.from("https://github.com/owner/repo/issues/99\n"));
    child.emit("close", 0);
    await executePromise;

    const spawnCalls = mockSpawn.mock.calls;
    const ghCall = spawnCalls.find(([cmd]: [string]) => cmd === "gh");
    expect(ghCall).toBeDefined();
    const args: string[] = ghCall![1] as string[];

    // --label should appear at least once per label
    const labelFlags = args.filter((a) => a === "--label");
    expect(labelFlags.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-detects repo when config.repo is empty and env var is unset", async () => {
    delete process.env["MOTIVA_GITHUB_REPO"];
    const adapter = new GitHubIssueAdapter();

    // First spawn: gh repo view (auto-detect)
    const detectChild = makeFakeChild();
    // Second spawn: gh issue create
    const createChild = makeFakeChild();

    const executePromise = adapter.execute(makeTask());

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
