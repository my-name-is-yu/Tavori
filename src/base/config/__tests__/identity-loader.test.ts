import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (hoisted) ───

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("../../../base/utils/paths.js", () => ({
  getPulseedDirPath: () => "/tmp/fake-pulseed-home",
}));

// Import AFTER mocks are set up (vi.mock is hoisted by vitest)
const {
  loadIdentity,
  clearIdentityCache,
  getAgentName,
  getInternalIdentityPrefix,
  getUserFacingIdentity,
  DEFAULT_SEED,
  DEFAULT_ROOT,
  DEFAULT_USER,
} = await import("../identity-loader.js");

// ─── Helpers ───

function noFiles(): void {
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockImplementation((p: string) => {
    throw new Error(`ENOENT: no such file or directory: ${p}`);
  });
}

function withFile(filename: string, content: string): void {
  mockExistsSync.mockImplementation((p: string) => p.endsWith(filename));
  mockReadFileSync.mockImplementation((p: string) => {
    if (p.endsWith(filename)) return content;
    throw new Error(`ENOENT: ${p}`);
  });
}

function withFiles(files: Record<string, string>): void {
  mockExistsSync.mockImplementation((p: string) =>
    Object.keys(files).some((name) => p.endsWith(name))
  );
  mockReadFileSync.mockImplementation((p: string) => {
    const match = Object.keys(files).find((name) => p.endsWith(name));
    if (match) return files[match];
    throw new Error(`ENOENT: ${p}`);
  });
}

// ─── Tests ───

describe("loadIdentity()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("returns defaults when no files exist", () => {
    noFiles();
    const identity = loadIdentity();
    expect(identity.name).toBe("Seedy");
    expect(identity.seed).toBe(DEFAULT_SEED);
    expect(identity.root).toBe(DEFAULT_ROOT);
    expect(identity.user).toBe(DEFAULT_USER);
  });

  it("reads SEED.md when it exists", () => {
    const custom = `# MySeed
Custom seed content.`;
    withFile("SEED.md", custom);
    const identity = loadIdentity();
    expect(identity.seed).toBe(custom);
  });

  it("reads ROOT.md when it exists", () => {
    const custom = `# MyRoot
Custom root content.`;
    withFile("ROOT.md", custom);
    const identity = loadIdentity();
    expect(identity.root).toBe(custom);
  });

  it("reads USER.md when it exists", () => {
    const custom = `# User
Custom user content.`;
    withFile("USER.md", custom);
    const identity = loadIdentity();
    expect(identity.user).toBe(custom);
  });

  it("caches result — file is only read once", () => {
    noFiles();
    loadIdentity();
    loadIdentity();
    // existsSync (or readFileSync) should not double-call once cached
    const callCount = mockExistsSync.mock.calls.length;
    loadIdentity(); // third call
    expect(mockExistsSync.mock.calls.length).toBe(callCount); // no new calls
  });

  it("combines multiple custom files", () => {
    withFiles({
      "SEED.md": "# CustomSeed",
      "ROOT.md": "custom root",
    });
    const identity = loadIdentity();
    expect(identity.seed).toBe("# CustomSeed");
    expect(identity.root).toBe("custom root");
    expect(identity.user).toBe(DEFAULT_USER);
  });
});

describe("clearIdentityCache()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("forces re-read on next call after clearing cache", () => {
    noFiles();
    loadIdentity(); // prime cache
    const callsAfterFirst = mockReadFileSync.mock.calls.length;

    clearIdentityCache();
    loadIdentity(); // should re-read
    expect(mockReadFileSync.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("getAgentName()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it('returns "Seedy" by default', () => {
    noFiles();
    expect(getAgentName()).toBe("Seedy");
  });

  it("returns custom name from SEED.md heading", () => {
    withFile("SEED.md", `# Pebble
Some content.`);
    expect(getAgentName()).toBe("Pebble");
  });

  it('falls back to "Seedy" when SEED.md has no h1 heading', () => {
    withFile("SEED.md", "No heading here, just content.");
    expect(getAgentName()).toBe("Seedy");
  });
});

describe("getInternalIdentityPrefix()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    noFiles();
  });

  it("returns a string mentioning Seedy and the role", () => {
    const result = getInternalIdentityPrefix("morning planner");
    expect(result).toContain("Seedy");
    expect(result).toContain("morning planner");
  });

  it("returns expected default prefix", () => {
    const result = getInternalIdentityPrefix("morning planner");
    expect(result).toBe("You are Seedy, PulSeed's morning planner. Seedy runs PulSeed, an AI agent orchestration system.");
  });

  it("uses custom agent name when SEED.md sets one", () => {
    withFile("SEED.md", `# Pebble
Content here.`);
    clearIdentityCache();
    const result = getInternalIdentityPrefix("planner");
    expect(result).toContain("Pebble");
  });
});

describe("getUserFacingIdentity()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("contains seed and root content", () => {
    noFiles();
    const result = getUserFacingIdentity();
    expect(result).toContain(DEFAULT_SEED);
    expect(result).toContain(DEFAULT_ROOT);
  });

  it("includes user content when USER.md has real content", () => {
    const customUser = `# User preferences
I prefer concise answers.`;
    withFile("USER.md", customUser);
    const result = getUserFacingIdentity();
    expect(result).toContain(customUser);
  });

  it("omits user section when USER.md is just the template/comments", () => {
    // Template-only USER.md: only HTML comments, no real content
    const templateUser =
      `<!-- This file is auto-generated. Add your preferences below. -->`;
    withFile("USER.md", templateUser);
    clearIdentityCache();
    const result = getUserFacingIdentity();
    // Should not include the template boilerplate in output
    expect(result).not.toContain("auto-generated");
  });

  it("returns a non-empty prompt even when no user files exist", () => {
    noFiles(); // falls back to defaults
    const result = getUserFacingIdentity();
    // Should always contain the default seed and root content
    expect(result).toContain(DEFAULT_SEED.trim());
    expect(result).toContain(DEFAULT_ROOT.trim());
    expect(result.length).toBeGreaterThan(0);
  });
});
