import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopContextAssembler, loadProjectInstructionBlocks } from "../agent-loop-context-assembler.js";
import type { Task } from "../../../../base/types/task.js";

function makeTask(): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "Implement the change",
    rationale: "Needed",
    approach: "Do it safely",
    success_criteria: [{ description: "done", verification_method: "review", is_blocking: true }],
    scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadProjectInstructionBlocks", () => {
  it("loads home and project AGENTS files including overrides", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agents-"));
    const homeDir = path.join(tmpRoot, "home");
    const repoDir = path.join(tmpRoot, "repo");
    const nestedDir = path.join(repoDir, "packages", "app");
    fs.mkdirSync(path.join(homeDir, ".pulseed"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(path.join(homeDir, ".pulseed", "AGENTS.md"), "Home instruction");
    fs.writeFileSync(path.join(homeDir, ".pulseed", "AGENTS.override.md"), "Home override");
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Repo instruction");
    fs.writeFileSync(path.join(nestedDir, "AGENTS.override.md"), "Nested override");
    vi.stubEnv("HOME", homeDir);

    const blocks = await loadProjectInstructionBlocks(nestedDir, 10_000);
    const sources = blocks.map((block) => block.source);

    expect(sources.some((source) => source.endsWith(".pulseed/AGENTS.md"))).toBe(true);
    expect(sources.some((source) => source.endsWith(".pulseed/AGENTS.override.md"))).toBe(true);
    expect(sources.some((source) => source.endsWith("/repo/AGENTS.md"))).toBe(true);
    expect(sources.some((source) => source.endsWith("/packages/app/AGENTS.override.md"))).toBe(true);
  });

  it("skips project instructions when trust_project_instructions is off", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agents-"));
    const homeDir = path.join(tmpRoot, "home");
    const repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(homeDir, ".pulseed"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

    fs.writeFileSync(path.join(homeDir, ".pulseed", "AGENTS.md"), "Home instruction");
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Repo instruction");
    vi.stubEnv("HOME", homeDir);

    const blocks = await loadProjectInstructionBlocks(repoDir, 10_000, { trustProjectInstructions: false });

    expect(blocks.some((block) => block.content.includes("Home instruction"))).toBe(true);
    expect(blocks.some((block) => block.content.includes("Repo instruction"))).toBe(false);
  });
});

describe("AgentLoopContextAssembler", () => {
  it("injects layered AGENTS context into the task prompt", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agents-"));
    const homeDir = path.join(tmpRoot, "home");
    const repoDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(homeDir, ".pulseed"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".pulseed", "AGENTS.md"), "Home instruction");
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Repo instruction");
    vi.stubEnv("HOME", homeDir);

    const assembler = new AgentLoopContextAssembler();
    const assembled = await assembler.assembleTask({
      task: makeTask(),
      cwd: repoDir,
      maxProjectDocChars: 10_000,
    });

    expect(assembled.userPrompt).toContain("Home instruction");
    expect(assembled.userPrompt).toContain("Repo instruction");
  });
});
