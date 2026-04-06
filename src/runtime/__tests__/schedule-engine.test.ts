import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ScheduleEngine } from "../schedule-engine.js";
import type { ScheduleEntry } from "../types/schedule.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

let tempDir: string;
let engine: ScheduleEngine;

beforeEach(() => {
  tempDir = makeTempDir("schedule-engine-test-");
  engine = new ScheduleEngine(tempDir);
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ─── ScheduleEngine ───

describe("ScheduleEngine", () => {
  it("loads empty entries from fresh directory", async () => {
    const entries = await engine.loadEntries();
    expect(entries).toEqual([]);
  });

  it("adds and persists a heartbeat entry", async () => {
    const entry = await engine.addEntry({
      name: "http-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 30 },
      enabled: true,
      heartbeat: {
        check_type: "http",
        check_config: { url: "http://localhost:3000/health" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(entry.created_at).toBeTruthy();
    expect(entry.next_fire_at).toBeTruthy();
    expect(new Date(entry.next_fire_at).getTime()).toBeGreaterThan(Date.now());

    // Verify persistence via new instance
    const engine2 = new ScheduleEngine(tempDir);
    const loaded = await engine2.loadEntries();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe(entry.id);
    expect(loaded[0]!.name).toBe("http-check");
  });

  it("removes an entry", async () => {
    const entry = await engine.addEntry({
      name: "to-remove",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    await engine.removeEntry(entry.id);
    expect(engine.getEntries()).toHaveLength(0);

    // Verify persistence
    const engine2 = new ScheduleEngine(tempDir);
    const loaded = await engine2.loadEntries();
    expect(loaded).toHaveLength(0);
  });

  it("getDueEntries returns entries past their next_fire_at", async () => {
    await engine.addEntry({
      name: "overdue-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 1 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    // Manipulate next_fire_at to be in the past
    const entries = engine.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await engine.saveEntries();
    await engine.loadEntries();

    const due = engine.getDueEntries();
    expect(due).toHaveLength(1);
  });

  it("getDueEntries skips disabled entries", async () => {
    await engine.addEntry({
      name: "disabled-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 1 },
      enabled: false,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    // Manipulate next_fire_at to be in the past
    const entries = engine.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await engine.saveEntries();
    await engine.loadEntries();

    const due = engine.getDueEntries();
    expect(due).toHaveLength(0);
  });

  it("getDueEntries skips entries not yet due", async () => {
    await engine.addEntry({
      name: "future-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 3600 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    // next_fire_at should be ~1 hour from now, not due yet
    const due = engine.getDueEntries();
    expect(due).toHaveLength(0);
  });
});

// ─── Heartbeat execution ───

describe("Heartbeat execution", () => {
  it("tick executes due heartbeat and records success", async () => {
    const entry = await engine.addEntry({
      name: "success-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    // Set next_fire_at to past
    const entries = engine.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await engine.saveEntries();
    await engine.loadEntries();

    const results = await engine.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("success");

    // Verify counters updated
    const updated = engine.getEntries().find((e) => e.id === entry.id)!;
    expect(updated.total_executions).toBe(1);
    expect(new Date(updated.next_fire_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("tick records failure on heartbeat check failure", async () => {
    const entry = await engine.addEntry({
      name: "fail-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "exit 1" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    // Set next_fire_at to past
    const entries = engine.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await engine.saveEntries();
    await engine.loadEntries();

    const results = await engine.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("failure");

    // Verify consecutive_failures incremented
    const updated = engine.getEntries().find((e) => e.id === entry.id)!;
    expect(updated.consecutive_failures).toBeGreaterThan(0);
  });

  it("tick resets consecutive_failures on success after failures", async () => {
    const entry = await engine.addEntry({
      name: "recovery-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    // Manually set consecutive_failures to 2 and next_fire_at to past
    const entries = engine.getEntries();
    entries[0]!.consecutive_failures = 2;
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await engine.saveEntries();
    await engine.loadEntries();

    const results = await engine.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("success");

    const updated = engine.getEntries().find((e) => e.id === entry.id)!;
    expect(updated.consecutive_failures).toBe(0);
  });

  it("tick skips non-heartbeat layers in Phase 1", async () => {
    const entry = await engine.addEntry({
      name: "cron-entry",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *" },
      enabled: true,
    });

    // Set next_fire_at to past
    const entries = engine.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await engine.saveEntries();
    await engine.loadEntries();

    const results = await engine.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("skipped");
  });
});

// ─── Schedule computation ───

describe("Schedule computation", () => {
  it("computes next_fire_at for interval schedule", async () => {
    const before = Date.now();
    const entry = await engine.addEntry({
      name: "interval-check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "echo ok" },
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    });

    const nextFire = new Date(entry.next_fire_at).getTime();
    // Should be approximately 60 seconds from now (allow ±5s tolerance)
    expect(nextFire).toBeGreaterThanOrEqual(before + 55_000);
    expect(nextFire).toBeLessThanOrEqual(before + 65_000);
  });

  it("computes next_fire_at for cron schedule", async () => {
    const before = Date.now();
    const entry = await engine.addEntry({
      name: "cron-check",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *" },
      enabled: true,
    });

    const nextFire = new Date(entry.next_fire_at).getTime();
    // "every minute" — next fire must be within the next 60 seconds
    expect(nextFire).toBeGreaterThan(before);
    expect(nextFire).toBeLessThanOrEqual(before + 60_000);
  });
});
