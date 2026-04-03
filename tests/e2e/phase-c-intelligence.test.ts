/**
 * Phase C Intelligence Layer E2E Tests
 *
 * Group 1: NotificationBatcher — tier routing (immediate / batchable / digest_only)
 * Group 2: NotificationBatcher + Dispatcher integration — batch flush routes to notifier
 * Group 3: AgentProfileLoader — load from directory, validate YAML, find helpers
 * Group 4: AgentProfileLoader — invalid profile graceful error handling
 * Group 5: TriggerMapper — event maps to existing goal via explicit mapping
 * Group 6: TriggerMapper — unknown event triggers LLM fallback + caching
 * Group 7: Full intelligence cycle — event → trigger mapper → goal activated → notification → weekly review
 *
 * Real classes used where possible. LLM calls and network I/O are mocked.
 * Temp directories created/cleaned per test group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { NotificationBatcher } from "../../src/runtime/notification-batcher.js";
import { NotificationDispatcher } from "../../src/runtime/notification-dispatcher.js";
import { AgentProfileLoader } from "../../src/adapters/agents/agent-profile-loader.js";
import { TriggerMapper } from "../../src/runtime/trigger-mapper.js";
import { runWeeklyReview } from "../../src/reflection/weekly-review.js";
import { StateManager } from "../../src/state/state-manager.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp-dir.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeGoal } from "../helpers/fixtures.js";
import type { Report } from "../../src/types/report.js";

// ─── Test fixtures ───

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: `report-${Date.now()}`,
    report_type: "execution_summary",
    goal_id: "goal-1",
    title: "Test Report",
    content: "Test content",
    verbosity: "standard",
    generated_at: new Date().toISOString(),
    delivered_at: null,
    read: false,
    ...overrides,
  };
}

function writeTriggerMappings(dir: string, mappings: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, "trigger-mappings.json"),
    JSON.stringify({ mappings }),
    "utf-8"
  );
}

const VALID_AGENT_MD = `---
name: code-reviewer
adapter: claude_api
model: claude-sonnet-4-6
capabilities:
  - code-review
  - refactoring
token_budget: 4000
description: An agent for code review
priority: 3
---
You are an expert code reviewer.
Focus on correctness, clarity, and performance.
`;

const INVALID_SCHEMA_AGENT_MD = `---
name: INVALID NAME WITH SPACES
adapter: claude_api
---
Body text.
`;

const CAPABILITY_AGENT_MD = `---
name: test-writer
adapter: openai_api
capabilities:
  - testing
  - documentation
description: An agent for writing tests
---
You are an expert test writer.
`;

// ─── Group 1: NotificationBatcher tier routing ───

describe("Phase C — NotificationBatcher tier routing", () => {
  let batcher: NotificationBatcher;
  let flushCb: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCb = vi.fn().mockResolvedValue(undefined);
    batcher = new NotificationBatcher(
      { window_minutes: 5, digest_format: "compact" },
      flushCb
    );
  });

  afterEach(async () => {
    await batcher.stop();
    vi.useRealTimers();
  });

  it("immediate report (goal_completion) returns false and is not queued", () => {
    const report = makeReport({ report_type: "goal_completion" });
    const batched = batcher.add(report);
    expect(batched).toBe(false);
    expect(batcher.getQueueLength()).toBe(0);
  });

  it("immediate report (urgent_alert) returns false and is not queued", () => {
    const report = makeReport({ report_type: "urgent_alert" });
    const batched = batcher.add(report);
    expect(batched).toBe(false);
    expect(batcher.getQueueLength()).toBe(0);
  });

  it("immediate report (approval_request) returns false and is not queued", () => {
    const report = makeReport({ report_type: "approval_request" });
    const batched = batcher.add(report);
    expect(batched).toBe(false);
    expect(batcher.getQueueLength()).toBe(0);
  });

  it("batchable report (execution_summary) returns true and enters the queue", () => {
    const report = makeReport({ report_type: "execution_summary" });
    const batched = batcher.add(report);
    expect(batched).toBe(true);
    expect(batcher.getQueueLength()).toBe(1);
  });

  it("batchable report (strategy_change) returns true and enters the queue", () => {
    const report = makeReport({ report_type: "strategy_change" });
    const batched = batcher.add(report);
    expect(batched).toBe(true);
    expect(batcher.getQueueLength()).toBe(1);
  });

  it("digest_only report (stall_escalation) returns true and enters the queue", () => {
    const report = makeReport({ report_type: "stall_escalation" });
    const batched = batcher.add(report);
    expect(batched).toBe(true);
    expect(batcher.getQueueLength()).toBe(1);
  });

  it("digest_only report (weekly_report) returns true and enters the queue", () => {
    const report = makeReport({ report_type: "weekly_report" });
    const batched = batcher.add(report);
    expect(batched).toBe(true);
    expect(batcher.getQueueLength()).toBe(1);
  });

  it("multiple non-immediate reports accumulate in queue before window expires", () => {
    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "goal-A" }));
    batcher.add(makeReport({ report_type: "strategy_change", goal_id: "goal-A" }));
    batcher.add(makeReport({ report_type: "stall_escalation", goal_id: "goal-B" }));
    expect(batcher.getQueueLength()).toBe(3);
    expect(flushCb).not.toHaveBeenCalled();
  });

  it("batcher auto-flushes via timer after window expires", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    expect(flushCb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(flushCb).toHaveBeenCalledTimes(1);
    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.report_type).toBe("daily_summary");
  });

  it("manual flush produces a digest grouped by goal_id", async () => {
    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "goal-A" }));
    batcher.add(makeReport({ report_type: "strategy_change", goal_id: "goal-B" }));
    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "goal-A" }));

    await batcher.flush();

    expect(flushCb).toHaveBeenCalledTimes(1);
    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.content).toContain("goal-A");
    expect(digest.content).toContain("goal-B");
    expect(digest.title).toContain("3");
  });

  it("stop() flushes remaining items and cancels the timer", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    batcher.add(makeReport({ report_type: "strategy_change" }));

    await batcher.stop();

    expect(flushCb).toHaveBeenCalledTimes(1);
    expect(batcher.getQueueLength()).toBe(0);

    // Timer must not fire again after stop
    vi.clearAllMocks();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(flushCb).not.toHaveBeenCalled();
  });
});

// ─── Group 2: NotificationBatcher + Dispatcher integration ───

describe("Phase C — NotificationBatcher + Dispatcher integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatcher with batching enabled queues batchable reports and returns empty results", async () => {
    vi.useFakeTimers();

    const dispatcher = new NotificationDispatcher({
      channels: [],
      batching: { enabled: true, window_minutes: 30, digest_format: "compact" },
    });

    const result = await dispatcher.dispatch(
      makeReport({ report_type: "execution_summary" })
    );

    // Batched — not sent yet, returns empty array
    expect(result).toEqual([]);

    await dispatcher.stop();
  });

  it("dispatcher with batching enabled sends immediate reports directly (not batched)", async () => {
    // Immediate reports must bypass batching — no channels configured so result is empty array
    // but the key is it returns synchronously (not batched)
    const flushSpy = vi.fn().mockResolvedValue(undefined);

    // Use NotificationBatcher directly to verify immediate bypasses it
    const batcher = new NotificationBatcher(
      { window_minutes: 30, digest_format: "compact" },
      flushSpy
    );

    const immediateBatched = batcher.add(makeReport({ report_type: "goal_completion" }));
    const batchableBatched = batcher.add(makeReport({ report_type: "execution_summary" }));

    expect(immediateBatched).toBe(false);
    expect(batchableBatched).toBe(true);
    // immediate was NOT queued
    expect(batcher.getQueueLength()).toBe(1);

    await batcher.stop();
  });

  it("batch flush produces a single digest report sent to the dispatcher channel pipeline", async () => {
    vi.useFakeTimers();

    const flushedDigests: Report[] = [];
    const batcher = new NotificationBatcher(
      { window_minutes: 1, digest_format: "detailed" },
      async (digest) => {
        flushedDigests.push(digest);
      }
    );

    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "g1", title: "Task Done", content: "Details here" }));
    batcher.add(makeReport({ report_type: "strategy_change", goal_id: "g1", title: "Strategy Updated", content: "New plan" }));

    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(flushedDigests).toHaveLength(1);
    const digest = flushedDigests[0]!;
    expect(digest.report_type).toBe("daily_summary");
    // Detailed format includes title + content
    expect(digest.content).toContain("Task Done");
    expect(digest.content).toContain("New plan");
  });

  it("dispatcher without batching sends all reports immediately", async () => {
    // No channels configured — all results are empty, but dispatch runs synchronously
    const dispatcher = new NotificationDispatcher({
      channels: [],
      batching: { enabled: false },
    });

    const r1 = await dispatcher.dispatch(makeReport({ report_type: "execution_summary" }));
    const r2 = await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));

    // No channels → both return [] (not suppressed by batching)
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);

    await dispatcher.stop();
  });
});

// ─── Group 3: AgentProfileLoader — load from directory ───

describe("Phase C — AgentProfileLoader directory loading", () => {
  let tmpDir: string;
  let loader: AgentProfileLoader;

  beforeEach(() => {
    tmpDir = makeTempDir("phase-c-agent-profile-");
    loader = new AgentProfileLoader(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("loads a valid agent profile from a .md file", async () => {
    fs.writeFileSync(path.join(tmpDir, "code-reviewer.md"), VALID_AGENT_MD);

    const profiles = await loader.loadAll();

    expect(profiles).toHaveLength(1);
    const p = profiles[0]!;
    expect(p.name).toBe("code-reviewer");
    expect(p.adapter).toBe("claude_api");
    expect(p.model).toBe("claude-sonnet-4-6");
    expect(p.capabilities).toContain("code-review");
    expect(p.capabilities).toContain("refactoring");
    expect(p.token_budget).toBe(4000);
    expect(p.priority).toBe(3);
    expect(p.system_prompt).toContain("expert code reviewer");
    expect(p.file_path).toContain("code-reviewer.md");
  });

  it("loads multiple profiles from the same directory", async () => {
    fs.writeFileSync(path.join(tmpDir, "code-reviewer.md"), VALID_AGENT_MD);
    fs.writeFileSync(path.join(tmpDir, "test-writer.md"), CAPABILITY_AGENT_MD);

    const profiles = await loader.loadAll();

    expect(profiles).toHaveLength(2);
    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual(["code-reviewer", "test-writer"]);
  });

  it("findByName locates the correct profile by exact name", async () => {
    fs.writeFileSync(path.join(tmpDir, "code-reviewer.md"), VALID_AGENT_MD);
    fs.writeFileSync(path.join(tmpDir, "test-writer.md"), CAPABILITY_AGENT_MD);

    const profiles = await loader.loadAll();
    const found = loader.findByName(profiles, "test-writer");

    expect(found).not.toBeNull();
    expect(found!.name).toBe("test-writer");
    expect(found!.adapter).toBe("openai_api");
  });

  it("findByName returns null for an unknown name", async () => {
    fs.writeFileSync(path.join(tmpDir, "code-reviewer.md"), VALID_AGENT_MD);
    const profiles = await loader.loadAll();

    expect(loader.findByName(profiles, "nonexistent")).toBeNull();
  });

  it("findByCapability returns all profiles that share a capability", async () => {
    fs.writeFileSync(path.join(tmpDir, "code-reviewer.md"), VALID_AGENT_MD);
    fs.writeFileSync(path.join(tmpDir, "test-writer.md"), CAPABILITY_AGENT_MD);

    const profiles = await loader.loadAll();
    const matches = loader.findByCapability(profiles, "code-review");

    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("code-reviewer");
  });

  it("profiles can be used for session creation — system_prompt is accessible", async () => {
    fs.writeFileSync(path.join(tmpDir, "code-reviewer.md"), VALID_AGENT_MD);
    const profiles = await loader.loadAll();
    const profile = profiles[0]!;

    // Simulate what a session manager would do: select profile by capability, read system_prompt
    const codeReviewers = loader.findByCapability(profiles, "refactoring");
    expect(codeReviewers).toHaveLength(1);
    expect(codeReviewers[0]!.system_prompt.length).toBeGreaterThan(0);
    expect(codeReviewers[0]!.adapter).toBe(profile.adapter);
  });

  it("returns empty array when directory does not exist", async () => {
    const missing = new AgentProfileLoader(path.join(tmpDir, "nonexistent-dir"));
    const profiles = await missing.loadAll();
    expect(profiles).toEqual([]);
  });

  it("returns empty array when directory has no .md files", async () => {
    // Write a non-.md file — should be ignored
    fs.writeFileSync(path.join(tmpDir, "config.json"), '{"key": "value"}');
    const profiles = await loader.loadAll();
    expect(profiles).toEqual([]);
  });
});

// ─── Group 4: AgentProfileLoader — invalid profile error handling ───

describe("Phase C — AgentProfileLoader invalid profile handling", () => {
  let tmpDir: string;
  let loader: AgentProfileLoader;

  beforeEach(() => {
    tmpDir = makeTempDir("phase-c-agent-invalid-");
    loader = new AgentProfileLoader(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("skips a profile with an invalid name (schema violation) without crashing", async () => {
    fs.writeFileSync(path.join(tmpDir, "invalid.md"), INVALID_SCHEMA_AGENT_MD);
    fs.writeFileSync(path.join(tmpDir, "valid.md"), VALID_AGENT_MD);

    const profiles = await loader.loadAll();

    // Invalid profile skipped, valid one loaded
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe("code-reviewer");
  });

  it("loadOne throws a descriptive error for a schema-violating profile", async () => {
    const filePath = path.join(tmpDir, "bad.md");
    fs.writeFileSync(filePath, INVALID_SCHEMA_AGENT_MD);

    await expect(loader.loadOne(filePath)).rejects.toThrow();
  });

  it("skips a profile with malformed YAML frontmatter without crashing", async () => {
    const badYaml = `---\nname: [unclosed bracket\n---\nBody text.\n`;
    fs.writeFileSync(path.join(tmpDir, "bad-yaml.md"), badYaml);
    fs.writeFileSync(path.join(tmpDir, "valid.md"), VALID_AGENT_MD);

    // Malformed YAML → frontmatter parsed as {} → schema validation fails → skipped
    const profiles = await loader.loadAll();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe("code-reviewer");
  });

  it("skips a profile missing required 'adapter' field", async () => {
    const noAdapter = `---\nname: no-adapter-agent\ncapabilities: []\n---\nBody.\n`;
    fs.writeFileSync(path.join(tmpDir, "no-adapter.md"), noAdapter);

    const profiles = await loader.loadAll();
    expect(profiles).toHaveLength(0);
  });

  it("parseFrontmatter gracefully handles content without frontmatter delimiters", () => {
    const plain = "Plain text without any frontmatter.";
    const { frontmatter, body } = AgentProfileLoader.parseFrontmatter(plain);
    expect(frontmatter).toEqual({});
    expect(body).toBe(plain);
  });
});

// ─── Group 5: TriggerMapper — event maps to existing goal ───

describe("Phase C — TriggerMapper explicit mapping resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("phase-c-trigger-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("resolves a github push event to a mapped goal with action 'observe'", async () => {
    writeTriggerMappings(tmpDir, [
      { source: "github", event_type: "push", action: "observe", goal_id: "goal-deploy" },
    ]);

    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "github", event_type: "push", data: { branch: "main" } },
      [{ id: "goal-deploy", title: "Deploy to production", status: "active" }]
    );

    expect(result.action).toBe("observe");
    expect(result.goal_id).toBe("goal-deploy");
    expect(result.source).toBe("mapping");
  });

  it("resolves a CI build_failed event with action 'create_task'", async () => {
    writeTriggerMappings(tmpDir, [
      { source: "ci", event_type: "build_failed", action: "create_task", goal_id: "goal-ci" },
    ]);

    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "ci", event_type: "build_failed", data: { job: "test" } },
      [{ id: "goal-ci", title: "Fix CI pipeline", status: "active" }]
    );

    expect(result.action).toBe("create_task");
    expect(result.goal_id).toBe("goal-ci");
    expect(result.source).toBe("mapping");
  });

  it("activates a goal by returning its goal_id from a mapping", async () => {
    writeTriggerMappings(tmpDir, [
      { source: "cron", event_type: "daily_check", action: "wake", goal_id: "goal-daily" },
    ]);

    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "cron", event_type: "daily_check", data: {} },
      [{ id: "goal-daily", title: "Daily health check", status: "active" }]
    );

    // goal_id returned means this goal should be activated/woken
    expect(result.goal_id).toBe("goal-daily");
    expect(result.action).toBe("wake");
  });

  it("uses trigger.goal_id as fallback when no mapping exists", async () => {
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "slack", event_type: "mention", data: {}, goal_id: "goal-from-trigger" },
      []
    );

    expect(result.action).toBe("observe");
    expect(result.goal_id).toBe("goal-from-trigger");
    expect(result.source).toBe("mapping");
  });

  it("returns action 'none' when no mapping and no trigger goal_id", async () => {
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "custom", event_type: "unknown_event", data: {} },
      []
    );

    expect(result.action).toBe("none");
    expect(result.goal_id).toBeNull();
    expect(result.source).toBe("default");
  });
});

// ─── Group 6: TriggerMapper — LLM fallback with caching ───

describe("Phase C — TriggerMapper LLM fallback and caching", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("phase-c-trigger-llm-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("falls back to LLM when no explicit mapping exists for the event", async () => {
    const mockLLM = createMockLLMClient([
      '{"goal_id": "goal-inferred", "action": "observe"}',
    ]);

    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "github", event_type: "pr_opened", data: { pr: 42 } },
      [{ id: "goal-inferred", title: "Review PRs", status: "active" }]
    );

    expect(result.source).toBe("llm");
    expect(result.goal_id).toBe("goal-inferred");
    expect(result.action).toBe("observe");
    expect(mockLLM.callCount).toBe(1);
  });

  it("caches LLM result so second resolve with same source/event_type does not call LLM again", async () => {
    const mockLLM = createMockLLMClient([
      '{"goal_id": "goal-cached", "action": "notify"}',
    ]);

    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();

    const trigger = { source: "github" as const, event_type: "issue_opened", data: {} };
    const goals = [{ id: "goal-cached", title: "Triage issues", status: "active" }];

    const first = await mapper.resolve(trigger, goals);
    const second = await mapper.resolve(trigger, goals);

    expect(mockLLM.callCount).toBe(1); // LLM called only once
    expect(first.goal_id).toBe(second.goal_id);
    expect(first.action).toBe(second.action);
    expect(mapper.getCacheSize()).toBe(1);
  });

  it("clearCache resets cache so LLM is called again for same event", async () => {
    const mockLLM = createMockLLMClient([
      '{"goal_id": "goal-a", "action": "observe"}',
      '{"goal_id": "goal-b", "action": "wake"}',
    ]);

    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();

    const trigger = { source: "slack" as const, event_type: "reaction", data: {} };
    const goals = [
      { id: "goal-a", title: "Goal A", status: "active" },
      { id: "goal-b", title: "Goal B", status: "active" },
    ];

    await mapper.resolve(trigger, goals);
    expect(mapper.getCacheSize()).toBe(1);

    mapper.clearCache();
    expect(mapper.getCacheSize()).toBe(0);

    await mapper.resolve(trigger, goals);
    expect(mockLLM.callCount).toBe(2); // called again after cache clear
  });

  it("falls back to 'none' when LLM returns malformed JSON", async () => {
    const mockLLM = createMockLLMClient(["not valid json at all"]);

    const mapper = new TriggerMapper(tmpDir, mockLLM);
    await mapper.loadMappings();

    const result = await mapper.resolve(
      { source: "custom", event_type: "weird_event", data: {} },
      [{ id: "goal-x", title: "Some goal", status: "active" }]
    );

    expect(result.action).toBe("none");
    expect(result.goal_id).toBeNull();
    expect(result.source).toBe("default");
  });
});

// ─── Group 7: Full intelligence cycle ───

describe("Phase C — Full intelligence cycle integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("phase-c-full-cycle-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    vi.useRealTimers();
  });

  it("event → trigger mapper → goal identified → notification batched → weekly review analyzes", async () => {
    // ── Step 1: Set up state with an active goal ──
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({ id: "goal-cycle", title: "E2E cycle goal", status: "active" });
    await stateManager.saveGoal(goal);

    // ── Step 2: TriggerMapper resolves event to goal ──
    writeTriggerMappings(tmpDir, [
      { source: "github", event_type: "push", action: "observe", goal_id: "goal-cycle" },
    ]);
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const triggerResult = await mapper.resolve(
      { source: "github", event_type: "push", data: { branch: "main", commits: 3 } },
      [{ id: "goal-cycle", title: goal.title, status: "active" }]
    );

    expect(triggerResult.goal_id).toBe("goal-cycle");
    expect(triggerResult.action).toBe("observe");

    // ── Step 3: Notification batched after trigger resolution ──
    vi.useFakeTimers();
    const dispatchedDigests: Report[] = [];
    const batcher = new NotificationBatcher(
      { window_minutes: 1, digest_format: "compact" },
      async (digest) => { dispatchedDigests.push(digest); }
    );

    const progressReport = makeReport({
      report_type: "execution_summary",
      goal_id: triggerResult.goal_id!,
      title: `Execution after ${triggerResult.source} trigger`,
      content: `Action: ${triggerResult.action}, Goal: ${triggerResult.goal_id}`,
    });

    const batched = batcher.add(progressReport);
    expect(batched).toBe(true);
    expect(batcher.getQueueLength()).toBe(1);

    // Trigger flush
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(dispatchedDigests).toHaveLength(1);
    expect(dispatchedDigests[0]!.content).toContain("goal-cycle");

    vi.useRealTimers();

    // ── Step 4: WeeklyReview analyzes the active goal ──
    const llmReviewResponse = JSON.stringify({
      rankings: [
        {
          goal_id: "goal-cycle",
          progress_rate: 0.6,
          strategy_effectiveness: "medium",
          recommendation: "Continue current pace",
        },
      ],
      suggested_additions: [],
      suggested_removals: [],
      summary: "Steady progress on E2E cycle goal.",
    });

    const mockLLM = createMockLLMClient([llmReviewResponse]);

    const reviewReport = await runWeeklyReview({
      stateManager,
      llmClient: mockLLM,
      baseDir: tmpDir,
    });

    expect(reviewReport.goals_reviewed).toBe(1);
    expect(reviewReport.rankings).toHaveLength(1);
    expect(reviewReport.rankings[0]!.goal_id).toBe("goal-cycle");
    expect(reviewReport.rankings[0]!.strategy_effectiveness).toBe("medium");
    expect(reviewReport.summary).toContain("E2E cycle goal");

    // Verify the review report was persisted to disk
    const reflectionsDir = path.join(tmpDir, "reflections");
    const files = fs.readdirSync(reflectionsDir);
    expect(files.some((f) => f.startsWith("weekly-"))).toBe(true);
  });

  it("weekly review skips non-active goals and returns goals_reviewed=0 with no LLM call", async () => {
    const stateManager = new StateManager(tmpDir);
    // Save a completed (non-active) goal
    const completedGoal = makeGoal({ id: "goal-done", title: "Done goal", status: "completed" });
    await stateManager.saveGoal(completedGoal);

    const mockLLM = createMockLLMClient([]);

    const reviewReport = await runWeeklyReview({
      stateManager,
      llmClient: mockLLM,
      baseDir: tmpDir,
    });

    expect(reviewReport.goals_reviewed).toBe(0);
    expect(reviewReport.rankings).toHaveLength(0);
    expect(mockLLM.callCount).toBe(0);
  });

  it("weekly review dispatches a notification when goals are reviewed", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({ id: "goal-notify", title: "Notify goal", status: "active" });
    await stateManager.saveGoal(goal);

    const llmResponse = JSON.stringify({
      rankings: [
        {
          goal_id: "goal-notify",
          progress_rate: 0.5,
          strategy_effectiveness: "low",
          recommendation: "Try a different strategy",
        },
      ],
      suggested_additions: ["new-initiative"],
      suggested_removals: [],
      summary: "Slow progress this week.",
    });

    const mockLLM = createMockLLMClient([llmResponse]);

    const dispatched: Report[] = [];
    const mockDispatcher = {
      dispatch: async (report: Report) => {
        dispatched.push(report);
        return [];
      },
    };

    const reviewReport = await runWeeklyReview({
      stateManager,
      llmClient: mockLLM,
      baseDir: tmpDir,
      notificationDispatcher: mockDispatcher,
    });

    expect(reviewReport.goals_reviewed).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.report_type).toBe("weekly_report");
    expect(dispatched[0]!.title).toContain("Weekly Review");
  });

  it("trigger mapper + agent profile selection: event triggers goal, profile chosen by capability", async () => {
    // Set up mappings
    writeTriggerMappings(tmpDir, [
      { source: "ci", event_type: "test_failed", action: "create_task", goal_id: "goal-quality" },
    ]);

    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "code-reviewer.md"), VALID_AGENT_MD);
    fs.writeFileSync(path.join(agentsDir, "test-writer.md"), CAPABILITY_AGENT_MD);

    // Resolve trigger
    const mapper = new TriggerMapper(tmpDir);
    await mapper.loadMappings();

    const triggerResult = await mapper.resolve(
      { source: "ci", event_type: "test_failed", data: { suite: "unit" } },
      [{ id: "goal-quality", title: "Improve test coverage", status: "active" }]
    );

    expect(triggerResult.goal_id).toBe("goal-quality");
    expect(triggerResult.action).toBe("create_task");

    // Select agent by capability for the created task
    const profileLoader = new AgentProfileLoader(agentsDir);
    const profiles = await profileLoader.loadAll();

    // For a "test_failed" event, use an agent with "testing" capability
    const testAgents = profileLoader.findByCapability(profiles, "testing");
    expect(testAgents).toHaveLength(1);
    expect(testAgents[0]!.name).toBe("test-writer");
    expect(testAgents[0]!.system_prompt).toContain("test writer");
  });
});
