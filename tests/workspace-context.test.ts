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
