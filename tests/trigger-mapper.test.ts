import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TriggerMapper } from "../src/runtime/trigger-mapper.js";
import { MockLLMClient } from "../src/llm/llm-client.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

function writeMappings(dir: string, mappings: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, "trigger-mappings.json"),
    JSON.stringify({ mappings }),
    "utf-8"
  );
}

// ─── Tests ───

describe("TriggerMapper.loadMappings", () => {
  it("loads valid mappings from file", async () => {
    const tmpDir = makeTempDir();
    writeMappings(tmpDir, [
      { source: "github", event_type: "push", action: "observe", goal_id: "g1" },
    ]);
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();
    const result = await mapper.resolve(
      { source: "github", event_type: "push", data: {} },
      []
    );
    expect(result.action).toBe("observe");
    expect(result.goal_id).toBe("g1");
    expect(result.source).toBe("mapping");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when mappings file is missing", async () => {
    const tmpDir = makeTempDir();
    const mapper = new TriggerMapper(tmpDir);
    await expect(mapper.loadMappings()).resolves.toBeUndefined();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("TriggerMapper.resolve — explicit mapping match", () => {
  let tmpDir: string;
  let mapper: TriggerMapper;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    writeMappings(tmpDir, [
      { source: "ci", event_type: "build_failed", action: "create_task", goal_id: "g-ci" },
    ]);
    mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();
  });

  it("returns matching mapping action and goal_id", async () => {
    const result = await mapper.resolve(
      { source: "ci", event_type: "build_failed", data: {} },
      []
    );
    expect(result.action).toBe("create_task");
    expect(result.goal_id).toBe("g-ci");
    expect(result.source).toBe("mapping");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("TriggerMapper.resolve — trigger.goal_id fallback", () => {
  it("uses trigger.goal_id with observe action when no mapping", async () => {
    const tmpDir = makeTempDir();
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();
    const result = await mapper.resolve(
      { source: "slack", event_type: "mention", data: {}, goal_id: "goal-fallback" },
      []
    );
    expect(result.action).toBe("observe");
    expect(result.goal_id).toBe("goal-fallback");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("TriggerMapper.resolve — LLM fallback", () => {
  it("returns llm source when LLM resolves successfully", async () => {
    const tmpDir = makeTempDir();
    const mockLLM = new MockLLMClient([
      '{"goal_id": "g-llm", "action": "observe"}',
    ]);
    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();
    const result = await mapper.resolve(
      { source: "custom", event_type: "deploy", data: {} },
      [{ id: "g-llm", title: "Deploy goal", status: "active" }]
    );
    expect(result.source).toBe("llm");
    expect(result.goal_id).toBe("g-llm");
    expect(result.action).toBe("observe");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call LLM on second resolve with same source/event_type (cache hit)", async () => {
    const tmpDir = makeTempDir();
    const mockLLM = new MockLLMClient([
      '{"goal_id": "g-cached", "action": "notify"}',
    ]);
    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();

    const trigger = { source: "github" as const, event_type: "pr_merged", data: {} };
    const goals = [{ id: "g-cached", title: "PR goal", status: "active" }];

    await mapper.resolve(trigger, goals);
    await mapper.resolve(trigger, goals); // second call — should hit cache

    expect(mockLLM.callCount).toBe(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("TriggerMapper.resolve — no mapping, no LLM", () => {
  it("returns action none with default source", async () => {
    const tmpDir = makeTempDir();
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();
    const result = await mapper.resolve(
      { source: "cron", event_type: "tick", data: {} },
      []
    );
    expect(result.action).toBe("none");
    expect(result.goal_id).toBeNull();
    expect(result.source).toBe("default");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("TriggerMapper.clearCache", () => {
  it("resets cache size to 0 after clear", async () => {
    const tmpDir = makeTempDir();
    const mockLLM = new MockLLMClient([
      '{"goal_id": "g1", "action": "observe"}',
    ]);
    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();
    await mapper.resolve(
      { source: "slack" as const, event_type: "message", data: {} },
      [{ id: "g1", title: "Goal 1", status: "active" }]
    );
    expect(mapper.getCacheSize()).toBe(1);
    mapper.clearCache();
    expect(mapper.getCacheSize()).toBe(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
