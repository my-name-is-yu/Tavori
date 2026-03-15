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

import { GitHubIssueDataSourceAdapter } from "../src/adapters/github-issue-datasource.js";
import type { DataSourceConfig, DataSourceQuery } from "../src/types/data-source.js";

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

function makeConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "github-issues",
    name: "GitHub Issues",
    type: "github_issues",
    connection: { repo: "owner/repo" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeQuery(overrides: Partial<DataSourceQuery> = {}): DataSourceQuery {
  return {
    dimension_name: "open_issue_count",
    timeout_ms: 5000,
    ...overrides,
  };
}

function makeFakeChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child);
  return child;
}

/**
 * Emits a JSON payload on stdout and closes the fake process with exit code 0.
 */
function resolveChild(child: FakeChildProcess, payload: unknown): void {
  child.stdout.emit("data", Buffer.from(JSON.stringify(payload)));
  child.emit("close", 0);
}

/**
 * Emits an error on stderr and closes the fake process with a non-zero exit code.
 */
function rejectChild(child: FakeChildProcess, errorMsg: string, code = 1): void {
  child.stderr.emit("data", Buffer.from(errorMsg));
  child.emit("close", code);
}

// ─── query tests ───

describe("GitHubIssueDataSourceAdapter.query", () => {
  let adapter: GitHubIssueDataSourceAdapter;

  beforeEach(() => {
    mockSpawn.mockReset();
    adapter = new GitHubIssueDataSourceAdapter(makeConfig());
  });

  it("open_issue_count returns the count of open issues", async () => {
    const child = makeFakeChild();
    const queryPromise = adapter.query(makeQuery({ dimension_name: "open_issue_count" }));
    // gh returns an array of open issues
    resolveChild(child, [{ number: 1 }, { number: 2 }, { number: 3 }]);
    const result = await queryPromise;

    expect(result.value).toBe(3);
    expect(typeof result.timestamp).toBe("string");
  });

  it("closed_issue_count returns the count of closed issues", async () => {
    const child = makeFakeChild();
    const queryPromise = adapter.query(makeQuery({ dimension_name: "closed_issue_count" }));
    resolveChild(child, [{ number: 10 }, { number: 11 }]);
    const result = await queryPromise;

    expect(result.value).toBe(2);
  });

  it("completion_ratio returns closed / (open + closed)", async () => {
    // First child: open issues query
    const openChild = makeFakeChild();
    // Second child: closed issues query
    const closedChild = makeFakeChild();

    const queryPromise = adapter.query(makeQuery({ dimension_name: "completion_ratio" }));

    resolveChild(openChild, [{ number: 1 }, { number: 2 }]);   // 2 open
    resolveChild(closedChild, [{ number: 10 }, { number: 11 }, { number: 12 }]); // 3 closed

    const result = await queryPromise;

    // 3 / (2 + 3) = 0.6
    expect(result.value).toBeCloseTo(0.6, 5);
  });

  it("total_issue_count returns open + closed", async () => {
    const openChild = makeFakeChild();
    const closedChild = makeFakeChild();

    const queryPromise = adapter.query(makeQuery({ dimension_name: "total_issue_count" }));

    resolveChild(openChild, [{ number: 1 }]);         // 1 open
    resolveChild(closedChild, [{ number: 10 }]);       // 1 closed

    const result = await queryPromise;

    expect(result.value).toBe(2);
  });

  it("returns 0 (not an error) when no issues exist", async () => {
    const child = makeFakeChild();
    const queryPromise = adapter.query(makeQuery({ dimension_name: "open_issue_count" }));
    resolveChild(child, []);
    const result = await queryPromise;

    expect(result.value).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("unknown dimension_name returns null or 0 without throwing", async () => {
    const result = await adapter.query(makeQuery({ dimension_name: "unknown_dimension_xyz" }));

    expect(result.value === null || result.value === 0).toBe(true);
  });

  it("gh CLI error is captured in DataSourceResult", async () => {
    const child = makeFakeChild();
    const queryPromise = adapter.query(makeQuery({ dimension_name: "open_issue_count" }));
    rejectChild(child, "gh: authentication required", 1);
    const result = await queryPromise;

    expect(result.value).toBeNull();
    expect(result.error).toContain("gh: authentication required");
  });
});

// ─── healthCheck tests ───

describe("GitHubIssueDataSourceAdapter.healthCheck", () => {
  let adapter: GitHubIssueDataSourceAdapter;

  beforeEach(() => {
    mockSpawn.mockReset();
    adapter = new GitHubIssueDataSourceAdapter(makeConfig());
  });

  it("returns true when gh auth status exits with code 0", async () => {
    const child = makeFakeChild();
    const healthPromise = adapter.healthCheck();
    child.stdout.emit("data", Buffer.from("Logged in to github.com"));
    child.emit("close", 0);
    const result = await healthPromise;

    expect(result).toBe(true);
  });

  it("returns false when gh auth status fails", async () => {
    const child = makeFakeChild();
    const healthPromise = adapter.healthCheck();
    child.stderr.emit("data", Buffer.from("You are not logged into any GitHub hosts"));
    child.emit("close", 1);
    const result = await healthPromise;

    expect(result).toBe(false);
  });
});

// ─── connect / disconnect tests ───

describe("GitHubIssueDataSourceAdapter connect/disconnect", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("connect resolves without error", async () => {
    const config = makeConfig({ connection: { repo: "my-org/my-repo" } });
    const adapter = new GitHubIssueDataSourceAdapter(config);

    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("sourceId reflects the config id", () => {
    const config1 = makeConfig({ id: "src-1", connection: { repo: "org/repo-1" } });
    const adapter = new GitHubIssueDataSourceAdapter(config1);

    expect(adapter.sourceId).toBe("src-1");
    expect(adapter.config).toBe(config1);
  });

  it("disconnect resolves without throwing", async () => {
    const adapter = new GitHubIssueDataSourceAdapter(makeConfig());
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("disconnect is a no-op (no spawn calls)", async () => {
    const adapter = new GitHubIssueDataSourceAdapter(makeConfig());
    await adapter.disconnect();

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
