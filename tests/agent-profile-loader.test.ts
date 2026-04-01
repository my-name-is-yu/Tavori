import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentProfileLoader } from "../src/adapters/agent-profile-loader.js";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

const VALID_MD = `---
name: test-agent
adapter: claude_api
model: claude-sonnet-4-6
capabilities:
  - code-review
  - refactoring
token_budget: 4000
description: A test agent
priority: 5
---
You are a helpful code reviewer.
Focus on correctness and style.
`;

const VALID_MD_2 = `---
name: another-agent
adapter: openai_api
capabilities:
  - code-review
  - testing
description: Another agent
---
You are a testing expert.
`;

const INVALID_YAML_MD = `---
name: [bad yaml
---
Body text.
`;

const INVALID_SCHEMA_MD = `---
name: INVALID NAME WITH SPACES
adapter: claude_api
---
Body text.
`;

describe("AgentProfileLoader", () => {
  let tmpDir: string;
  let loader: AgentProfileLoader;

  beforeEach(() => {
    tmpDir = makeTempDir("agent-profile-test-");
    loader = new AgentProfileLoader(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  // ─── loadAll ───

  it("loadAll returns empty array when directory has no .md files", async () => {
    const profiles = await loader.loadAll();
    expect(profiles).toEqual([]);
  });

  it("loadAll returns empty array when directory does not exist", async () => {
    const missing = new AgentProfileLoader(path.join(tmpDir, "nonexistent"));
    const profiles = await missing.loadAll();
    expect(profiles).toEqual([]);
  });

  it("loadAll returns one profile for a single valid file", async () => {
    fs.writeFileSync(path.join(tmpDir, "test-agent.md"), VALID_MD);
    const profiles = await loader.loadAll();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("test-agent");
    expect(profiles[0].adapter).toBe("claude_api");
    expect(profiles[0].model).toBe("claude-sonnet-4-6");
    expect(profiles[0].capabilities).toEqual(["code-review", "refactoring"]);
    expect(profiles[0].token_budget).toBe(4000);
    expect(profiles[0].priority).toBe(5);
    expect(profiles[0].system_prompt).toContain("helpful code reviewer");
  });

  it("loadAll skips invalid file and returns valid ones without crash", async () => {
    fs.writeFileSync(path.join(tmpDir, "valid.md"), VALID_MD);
    fs.writeFileSync(path.join(tmpDir, "invalid-schema.md"), INVALID_SCHEMA_MD);
    const profiles = await loader.loadAll();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("test-agent");
  });

  it("loadAll skips file with invalid YAML without crash", async () => {
    fs.writeFileSync(path.join(tmpDir, "bad-yaml.md"), INVALID_YAML_MD);
    const profiles = await loader.loadAll();
    expect(profiles).toHaveLength(0);
  });

  // ─── parseFrontmatter ───

  it("parseFrontmatter extracts frontmatter and body correctly", () => {
    const { frontmatter, body } = AgentProfileLoader.parseFrontmatter(VALID_MD);
    expect(frontmatter["name"]).toBe("test-agent");
    expect(frontmatter["adapter"]).toBe("claude_api");
    expect(body).toContain("helpful code reviewer");
  });

  it("parseFrontmatter returns empty frontmatter when no --- delimiter", () => {
    const content = "Just plain text\nno frontmatter here";
    const { frontmatter, body } = AgentProfileLoader.parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  it("parseFrontmatter returns empty frontmatter when closing --- is missing", () => {
    const content = "---\nname: test\nno closing delimiter";
    const { frontmatter, body } = AgentProfileLoader.parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  // ─── findByName ───

  it("findByName returns the correct profile", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), VALID_MD);
    fs.writeFileSync(path.join(tmpDir, "b.md"), VALID_MD_2);
    const profiles = await loader.loadAll();
    const found = loader.findByName(profiles, "another-agent");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("another-agent");
  });

  it("findByName returns null when name does not exist", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), VALID_MD);
    const profiles = await loader.loadAll();
    expect(loader.findByName(profiles, "nonexistent")).toBeNull();
  });

  // ─── findByCapability ───

  it("findByCapability returns all profiles with matching capability", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), VALID_MD);
    fs.writeFileSync(path.join(tmpDir, "b.md"), VALID_MD_2);
    const profiles = await loader.loadAll();
    const matches = loader.findByCapability(profiles, "code-review");
    expect(matches).toHaveLength(2);
  });

  it("findByCapability returns empty array when no profiles match", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), VALID_MD);
    const profiles = await loader.loadAll();
    const matches = loader.findByCapability(profiles, "nonexistent-capability");
    expect(matches).toHaveLength(0);
  });

  it("findByCapability returns subset when only some profiles match", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.md"), VALID_MD);
    fs.writeFileSync(path.join(tmpDir, "b.md"), VALID_MD_2);
    const profiles = await loader.loadAll();
    const matches = loader.findByCapability(profiles, "testing");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("another-agent");
  });
});
