import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceContextProvider } from "../src/observation/workspace-context.js";

// Helper: write a temp file and clean it up after each test
const tmpFiles: string[] = [];

function writeTmpFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  tmpFiles.push(filePath);
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

describe("createWorkspaceContextProvider — external file reading", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-test-ext-"));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("reads a /tmp/ file mentioned in goal description", async () => {
    const tmpPath = path.join("/tmp", `pulseed-test-${Date.now()}.txt`);
    writeTmpFile(tmpPath, "hello from tmp file");

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Check output in ${tmpPath}`
    );

    const result = await provider("goal-1", "quality");
    expect(result).toContain("External file:");
    expect(result).toContain("hello from tmp file");
  });

  it("reads a file under home directory mentioned in goal description", async () => {
    const homePath = path.join(os.homedir(), `.pulseed-test-${Date.now()}.txt`);
    writeTmpFile(homePath, "home dir file content");

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Evaluate ${homePath} for completeness`
    );

    const result = await provider("goal-2", "completeness");
    expect(result).toContain("External file:");
    expect(result).toContain("home dir file content");
  });

  it("does NOT read a file outside allowed prefixes (e.g. /etc/passwd)", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir },
      () => "Inspect /etc/passwd for issues"
    );

    const result = await provider("goal-3", "security");
    // Should not contain /etc/passwd content (root:x:0:0...)
    expect(result).not.toContain("root:");
    expect(result).not.toContain("External file: /etc/passwd");
  });

  it("skips a /tmp/ path that does not exist", async () => {
    const missingPath = "/tmp/pulseed-nonexistent-file-xyz-9999.txt";

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Read output from ${missingPath}`
    );

    const result = await provider("goal-4", "output");
    expect(result).not.toContain("External file: " + missingPath);
  });

  it("skips a file that exceeds externalFileMaxBytes", async () => {
    const largePath = path.join("/tmp", `pulseed-large-${Date.now()}.txt`);
    writeTmpFile(largePath, "x".repeat(100));

    const provider = createWorkspaceContextProvider(
      { workDir, externalFileMaxBytes: 10 }, // limit to 10 bytes
      () => `Read ${largePath}`
    );

    const result = await provider("goal-5", "size");
    expect(result).not.toContain("External file: " + largePath);
  });

  it("does NOT read ~/.ssh/id_rsa (denied prefix)", async () => {
    const sshPath = path.join(os.homedir(), ".ssh", "id_rsa");
    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Inspect ${sshPath} for issues`
    );

    const result = await provider("goal-denied-ssh", "security");
    expect(result).not.toContain(`External file: ${sshPath}`);
  });

  it("does NOT read ~/.aws/credentials (denied prefix)", async () => {
    const awsPath = path.join(os.homedir(), ".aws", "credentials");
    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Read ${awsPath}`
    );

    const result = await provider("goal-denied-aws", "security");
    expect(result).not.toContain(`External file: ${awsPath}`);
  });

  it("does NOT read ~/.gnupg/private-keys-v1.d (denied prefix)", async () => {
    const gnupgPath = path.join(os.homedir(), ".gnupg", "private-keys-v1.d");
    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Check ${gnupgPath}`
    );

    const result = await provider("goal-denied-gnupg", "security");
    expect(result).not.toContain(`External file: ${gnupgPath}`);
  });

  it("does NOT read ~/.config/some-app/token (denied prefix)", async () => {
    const configPath = path.join(os.homedir(), ".config", "some-app", "token");
    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Use token from ${configPath}`
    );

    const result = await provider("goal-denied-config", "security");
    expect(result).not.toContain(`External file: ${configPath}`);
  });

  it("deduplicates the same path mentioned multiple times", async () => {
    const tmpPath = path.join("/tmp", `pulseed-dedup-${Date.now()}.txt`);
    writeTmpFile(tmpPath, "dedup content");

    const provider = createWorkspaceContextProvider(
      { workDir },
      () => `Check ${tmpPath} and also ${tmpPath} again`
    );

    const result = await provider("goal-6", "quality");
    // Should appear exactly once
    const count = (result.match(/dedup content/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe("createWorkspaceContextProvider — relative path exact match", () => {
  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-ws-relpath-"));
    fs.writeFileSync(path.join(tmpWorkDir, "README.md"), "# Test Project", "utf-8");
    fs.writeFileSync(path.join(tmpWorkDir, "package.json"), '{"name":"test"}', "utf-8");
    // Create src/ subdirectory with files
    fs.mkdirSync(path.join(tmpWorkDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpWorkDir, "src", "index.ts"), "export const hello = 'world';", "utf-8");
    fs.writeFileSync(path.join(tmpWorkDir, "src", "core-loop.ts"), "export function coreLoop() {}", "utf-8");
    fs.writeFileSync(path.join(tmpWorkDir, "src", "task-lifecycle.ts"), "export function taskLifecycle() {}", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  });

  it("includes src/index.ts when mentioned in goal description", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Improve src/index.ts API documentation"
    );

    const result = await provider("goal-relpath-1", "quality");
    expect(result).toContain("src/index.ts");
    expect(result).toContain("export const hello = 'world'");
  });

  it("includes multiple explicitly mentioned files", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Fix bugs in src/core-loop.ts and src/task-lifecycle.ts"
    );

    const result = await provider("goal-relpath-2", "quality");
    expect(result).toContain("src/core-loop.ts");
    expect(result).toContain("export function coreLoop()");
    expect(result).toContain("src/task-lifecycle.ts");
    expect(result).toContain("export function taskLifecycle()");
  });

  it("skips a relative path that does not exist in workDir", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Improve src/nonexistent.ts quality"
    );

    const result = await provider("goal-relpath-3", "quality");
    expect(result).not.toContain("src/nonexistent.ts");
  });

  it("path-matched files are included even when maxFiles would be exhausted by keyword matches", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir, maxFiles: 2 },  // tight limit
      () => "Improve src/index.ts API documentation"
    );

    const result = await provider("goal-relpath-4", "quality");
    // README.md and package.json fill the 2 alwaysInclude slots,
    // but src/index.ts (path match) should still appear
    expect(result).toContain("src/index.ts");
    expect(result).toContain("export const hello = 'world'");
  });
});

describe("createWorkspaceContextProvider — small workspace fast path", () => {
  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-ws-small-"));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  });

  it("includes all files when workspace has a single file (hello.ts)", async () => {
    fs.writeFileSync(path.join(tmpWorkDir, "hello.ts"), "console.log('hello');", "utf-8");

    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Make the greeting more friendly"
    );

    const result = await provider("goal-small-1", "output quality");
    expect(result).toContain("hello.ts");
    expect(result).toContain("console.log('hello')");
  });

  it("includes all files when workspace has <= 10 files, even with no keyword match", async () => {
    // Create 5 files with names unrelated to the dimension name
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpWorkDir, `file${i}.ts`), `export const v${i} = ${i};`, "utf-8");
    }

    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Check correctness"
    );

    const result = await provider("goal-small-2", "xyzzy dimension");
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`file${i}.ts`);
      expect(result).toContain(`export const v${i} = ${i}`);
    }
  });

  it("falls back to keyword matching when workspace has more than 10 files", async () => {
    // Create 11 files — 1 matching keyword, 10 unrelated
    for (let i = 1; i <= 10; i++) {
      fs.writeFileSync(path.join(tmpWorkDir, `unrelated${i}.ts`), `// file ${i}`, "utf-8");
    }
    fs.writeFileSync(path.join(tmpWorkDir, "quality-check.ts"), "export function qualityCheck() {}", "utf-8");

    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Check quality"
    );

    const result = await provider("goal-small-3", "quality");
    // With >10 files, keyword matching kicks in; quality-check.ts should match
    expect(result).toContain("quality-check.ts");
    // Not all unrelated files should be included (keyword match is selective)
    // At least the matched file is present
    expect(result).toContain("export function qualityCheck");
  });

  it("respects maxCharsPerFile in small workspace fast path", async () => {
    fs.writeFileSync(path.join(tmpWorkDir, "big.ts"), "x".repeat(10000), "utf-8");

    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir, maxCharsPerFile: 100 },
      () => "Check content"
    );

    const result = await provider("goal-small-4", "content");
    expect(result).toContain("big.ts");
    // Content should be truncated to maxCharsPerFile
    expect(result).toContain("x".repeat(100));
    expect(result).not.toContain("x".repeat(101));
  });
});

describe("createWorkspaceContextProvider — dynamic workDir from goal constraints", () => {
  let defaultWorkDir: string;
  let goalWorkDir: string;

  beforeEach(() => {
    defaultWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-ws-default-"));
    goalWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-ws-goal-"));
    // Default dir has one file
    fs.writeFileSync(path.join(defaultWorkDir, "default.ts"), "const d = 'default';", "utf-8");
    // Goal dir has a different file
    fs.writeFileSync(path.join(goalWorkDir, "goal.ts"), "const g = 'goal workspace';", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(defaultWorkDir, { recursive: true, force: true });
    fs.rmSync(goalWorkDir, { recursive: true, force: true });
  });

  it("uses default workDir when no getGoalConstraints is provided", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: defaultWorkDir },
      () => "Check quality"
    );

    const result = await provider("goal-dyn-1", "quality");
    expect(result).toContain(`# Workspace: ${defaultWorkDir}`);
    expect(result).toContain("default.ts");
    expect(result).not.toContain("goal.ts");
  });

  it("uses workspace_path constraint from goal when getGoalConstraints is provided", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: defaultWorkDir },
      () => "Check quality",
      () => [`workspace_path:${goalWorkDir}`]
    );

    const result = await provider("goal-dyn-2", "quality");
    expect(result).toContain(`# Workspace: ${goalWorkDir}`);
    expect(result).toContain("goal.ts");
    expect(result).not.toContain("default.ts");
  });

  it("falls back to default workDir when goal has no workspace_path constraint", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: defaultWorkDir },
      () => "Check quality",
      () => ["some_other_constraint:value"]
    );

    const result = await provider("goal-dyn-3", "quality");
    expect(result).toContain(`# Workspace: ${defaultWorkDir}`);
    expect(result).toContain("default.ts");
  });

  it("falls back to default workDir when getGoalConstraints returns undefined", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: defaultWorkDir },
      () => "Check quality",
      () => undefined
    );

    const result = await provider("goal-dyn-4", "quality");
    expect(result).toContain(`# Workspace: ${defaultWorkDir}`);
    expect(result).toContain("default.ts");
  });

  it("uses workspace_path constraint resolved asynchronously", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: defaultWorkDir },
      () => "Check quality",
      async () => {
        // Simulates async goal load
        return [`workspace_path:${goalWorkDir}`];
      }
    );

    const result = await provider("goal-dyn-5", "quality");
    expect(result).toContain(`# Workspace: ${goalWorkDir}`);
    expect(result).toContain("goal.ts");
  });
});

describe("createWorkspaceContextProvider — Phase 3 grep content match", () => {
  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-ws-grep-"));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  });

  it("finds a file by content when its name does not match any keyword", async () => {
    // Create enough files to exceed the small workspace fast path (>10)
    for (let i = 1; i <= 10; i++) {
      fs.writeFileSync(path.join(tmpWorkDir, `unrelated${i}.ts`), `// file ${i}`, "utf-8");
    }
    // This file's name ("impl.ts") has no keyword match, but its content contains "TODO"
    fs.writeFileSync(path.join(tmpWorkDir, "impl.ts"), "// TODO: finish this implementation", "utf-8");

    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Track todo count in the project"
    );

    // dimension "todo_count" → dimensionNameToSearchTerms → ["TODO"]
    const result = await provider("goal-grep-1", "todo_count");
    expect(result).toContain("impl.ts");
    expect(result).toContain("TODO: finish this implementation");
  });
});

describe("createWorkspaceContextProvider — existing workspace behavior unchanged", () => {
  let tmpWorkDir: string;

  beforeEach(() => {
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-ws-test-"));
    fs.writeFileSync(path.join(tmpWorkDir, "README.md"), "# Test Project", "utf-8");
    fs.writeFileSync(path.join(tmpWorkDir, "package.json"), '{"name":"test"}', "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  });

  it("includes README.md and package.json in output", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "Improve code quality"
    );

    const result = await provider("goal-ws", "quality");
    expect(result).toContain("README.md");
    expect(result).toContain("package.json");
    expect(result).toContain("# Test Project");
  });

  it("returns workspace header line", async () => {
    const provider = createWorkspaceContextProvider(
      { workDir: tmpWorkDir },
      () => "some goal"
    );

    const result = await provider("goal-header", "dim");
    expect(result).toContain(`# Workspace: ${tmpWorkDir}`);
  });
});
