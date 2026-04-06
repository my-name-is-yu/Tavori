import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ScheduleEngine } from "../schedule-engine.js";
import { detectChange } from "../change-detector.js";
import type { ScheduleEntry } from "../types/schedule.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

let tempDir: string;
let engine: ScheduleEngine;

beforeEach(() => {
  tempDir = makeTempDir("schedule-engine-test-");
  engine = new ScheduleEngine({ baseDir: tempDir });
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
    const engine2 = new ScheduleEngine({ baseDir: tempDir });
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
    const engine2 = new ScheduleEngine({ baseDir: tempDir });
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

    const due = await engine.getDueEntries();
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

    const due = await engine.getDueEntries();
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
    const due = await engine.getDueEntries();
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
    expect(result!.status).toBe("ok");

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
    expect(result!.status).toBe("down");

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
    expect(result!.status).toBe("ok");

    const updated = engine.getEntries().find((e) => e.id === entry.id)!;
    expect(updated.consecutive_failures).toBe(0);
  });

  it("tick routes cron entry without config to error (Phase 3)", async () => {
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
    // Phase 3: cron entries are now executed — without a cron config they return error
    expect(result!.status).toBe("error");
    expect(result!.error_message).toContain("No cron config");
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
    // Should be approximately 60 seconds from now (allow +/-5s tolerance)
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
    // "every minute" -- next fire must be within the next 60 seconds
    expect(nextFire).toBeGreaterThan(before);
    expect(nextFire).toBeLessThanOrEqual(before + 60_000);
  });
});

// ─── ChangeDetector ───

describe("ChangeDetector", () => {
  it("threshold mode detects value exceeding threshold", () => {
    const result = detectChange("threshold", 150, [], 100);
    expect(result.changed).toBe(true);
    expect(result.details).toContain("threshold exceeded");
  });

  it("threshold mode returns no change when below threshold", () => {
    const result = detectChange("threshold", 50, [], 100);
    expect(result.changed).toBe(false);
    expect(result.details).toContain("threshold ok");
  });

  it("diff mode detects changed result vs baseline", () => {
    const result = detectChange("diff", { count: 2 }, [{ count: 1 }]);
    expect(result.changed).toBe(true);
    expect(result.details).toContain("changed");
  });

  it("diff mode returns no change when result matches baseline", () => {
    const result = detectChange("diff", { count: 1 }, [{ count: 1 }]);
    expect(result.changed).toBe(false);
  });

  it("diff mode returns no change when no baseline", () => {
    const result = detectChange("diff", { count: 1 }, []);
    expect(result.changed).toBe(false);
    expect(result.details).toContain("no baseline");
  });

  it("presence mode detects non-empty result", () => {
    const result = detectChange("presence", "some data", []);
    expect(result.changed).toBe(true);
    expect(result.details).toContain("non-empty");
  });

  it("presence mode returns no change for empty result", () => {
    const result = detectChange("presence", "", []);
    expect(result.changed).toBe(false);
  });

  it("presence mode returns no change for null result", () => {
    const result = detectChange("presence", null, []);
    expect(result.changed).toBe(false);
  });
});

// ─── Probe execution ───

function makeMockAdapter(value: unknown): IDataSourceAdapter {
  return {
    sourceId: "test-source",
    sourceType: "file",
    config: { id: "test-source", type: "file", connection: {}, enabled: true, refresh_interval_seconds: 60 },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    query: vi.fn().mockResolvedValue({
      value,
      raw: value,
      timestamp: new Date().toISOString(),
      source_id: "test-source",
    }),
  };
}

function makeProbeEntry(overrides: Partial<ScheduleEntry> = {}): Omit<
  ScheduleEntry,
  "id" | "created_at" | "updated_at" | "last_fired_at" | "next_fire_at" |
  "consecutive_failures" | "last_escalation_at" | "baseline_results" |
  "total_executions" | "total_tokens_used"
> {
  return {
    name: "test-probe",
    layer: "probe",
    trigger: { type: "interval", seconds: 60 },
    enabled: true,
    probe: {
      data_source_id: "test-source",
      query_params: {},
      change_detector: { mode: "diff", baseline_window: 5 },
      llm_on_change: false,
    },
    ...overrides,
  };
}

describe("Probe execution", () => {
  it("executeProbe returns ok when no change detected", async () => {
    const adapter = makeMockAdapter("same-value");
    const registry = new Map([["test-source", adapter]]);
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    const entry = await eng.addEntry(makeProbeEntry());

    // Pre-populate baseline so diff sees "no change"
    const entries = eng.getEntries();
    entries[0]!.baseline_results = ["same-value"];
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("ok");
    expect(result!.change_detected).toBe(false);
  });

  it("executeProbe detects threshold change", async () => {
    const adapter = makeMockAdapter(200);
    const registry = new Map([["test-source", adapter]]);
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    const entry = await eng.addEntry(makeProbeEntry({
      probe: {
        data_source_id: "test-source",
        query_params: {},
        change_detector: { mode: "threshold", threshold_value: 100, baseline_window: 5 },
        llm_on_change: false,
      },
    }));

    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.status).toBe("ok");
    expect(result!.change_detected).toBe(true);
  });

  it("executeProbe detects diff change", async () => {
    const adapter = makeMockAdapter({ count: 2 });
    const registry = new Map([["test-source", adapter]]);
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    const entry = await eng.addEntry(makeProbeEntry());

    const entries = eng.getEntries();
    entries[0]!.baseline_results = [{ count: 1 }];
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.status).toBe("ok");
    expect(result!.change_detected).toBe(true);
  });

  it("executeProbe detects presence change", async () => {
    const adapter = makeMockAdapter("new alert");
    const registry = new Map([["test-source", adapter]]);
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    const entry = await eng.addEntry(makeProbeEntry({
      probe: {
        data_source_id: "test-source",
        query_params: {},
        change_detector: { mode: "presence", baseline_window: 5 },
        llm_on_change: false,
      },
    }));

    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.status).toBe("ok");
    expect(result!.change_detected).toBe(true);
  });

  it("executeProbe calls LLM on change when llm_on_change is true", async () => {
    const adapter = makeMockAdapter({ count: 5 });
    const registry = new Map([["test-source", adapter]]);
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "Significant change detected.",
        usage: { input_tokens: 20, output_tokens: 22 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeProbeEntry({
      probe: {
        data_source_id: "test-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: true,
      },
    }));

    const entries = eng.getEntries();
    entries[0]!.baseline_results = [{ count: 1 }];
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.status).toBe("ok");
    expect(result!.change_detected).toBe(true);
    expect(result!.tokens_used).toBeGreaterThan(0);
    expect(mockLlm.sendMessage).toHaveBeenCalledOnce();
  });

  it("executeProbe skips LLM when llm_on_change is false", async () => {
    const adapter = makeMockAdapter({ count: 5 });
    const registry = new Map([["test-source", adapter]]);
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({ content: "ok", usage: { total_tokens: 10 } }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeProbeEntry({
      probe: {
        data_source_id: "test-source",
        query_params: {},
        change_detector: { mode: "presence", baseline_window: 5 },
        llm_on_change: false,
      },
    }));

    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    await eng.tick();
    expect(mockLlm.sendMessage).not.toHaveBeenCalled();
  });

  it("executeProbe returns error when data source not found", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });

    const entry = await eng.addEntry(makeProbeEntry());
    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.status).toBe("error");
    expect(result!.error_message).toContain("not found");
  });

  it("executeProbe updates baseline_results", async () => {
    const adapter = makeMockAdapter("new-value");
    const registry = new Map([["test-source", adapter]]);
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    const entry = await eng.addEntry(makeProbeEntry());
    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    await eng.tick();

    const updated = eng.getEntries().find((e) => e.id === entry.id)!;
    expect(updated.baseline_results).toHaveLength(1);
    expect(updated.baseline_results[0]).toBe("new-value");
  });
});

// ─── Escalation ───

describe("Escalation", () => {
  it("circuit breaker disables entry after threshold failures", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });

    const entry = await eng.addEntry({
      name: "failing-probe",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      probe: {
        data_source_id: "missing-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: false,
      },
      escalation: {
        enabled: true,
        circuit_breaker_threshold: 2,
        cooldown_minutes: 0,
        max_per_hour: 100,
      },
    });

    // Fire twice to hit circuit breaker threshold
    const setDue = () => {
      const entries = eng.getEntries();
      const idx = entries.findIndex((e) => e.id === entry.id);
      if (idx !== -1) entries[idx]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    };

    setDue();
    await eng.saveEntries();
    await eng.loadEntries();
    await eng.tick();

    setDue();
    await eng.saveEntries();
    await eng.loadEntries();
    await eng.tick();

    const updated = eng.getEntries().find((e) => e.id === entry.id)!;
    expect(updated.enabled).toBe(false);
  });

  it("escalation triggers on consecutive failures", async () => {
    const notifications: Record<string, unknown>[] = [];
    const eng = new ScheduleEngine({
      baseDir: tempDir,
      notificationDispatcher: {
        dispatch: async (r) => { notifications.push(r); },
      },
    });

    await eng.addEntry({
      name: "failing-entry",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      probe: {
        data_source_id: "missing-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: false,
      },
      escalation: {
        enabled: true,
        circuit_breaker_threshold: 10,
        cooldown_minutes: 0,
        max_per_hour: 100,
      },
    });

    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    expect(results[0]!.status).toBe("escalated");
    expect(notifications.some((n) => n["report_type"] === "schedule_escalation")).toBe(true);
  });

  it("escalation respects cooldown", async () => {
    const notifications: Record<string, unknown>[] = [];
    const eng = new ScheduleEngine({
      baseDir: tempDir,
      notificationDispatcher: {
        dispatch: async (r) => { notifications.push(r); },
      },
    });

    const entry = await eng.addEntry({
      name: "cooldown-entry",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      probe: {
        data_source_id: "missing-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: false,
      },
      escalation: {
        enabled: true,
        circuit_breaker_threshold: 100,
        cooldown_minutes: 60,
        max_per_hour: 100,
      },
    });

    // Set last_escalation_at to recent (within cooldown)
    const entries = eng.getEntries();
    const idx = entries.findIndex((e) => e.id === entry.id);
    entries[idx]!.last_escalation_at = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    entries[idx]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    // Should NOT escalate due to cooldown
    expect(results[0]!.status).not.toBe("escalated");
    const escalationNotifications = notifications.filter((n) => n["report_type"] === "schedule_escalation");
    expect(escalationNotifications).toHaveLength(0);
  });

  it("escalation respects minimum escalation interval (simplified max_per_hour check)", async () => {
    const notifications: Record<string, unknown>[] = [];
    const eng = new ScheduleEngine({
      baseDir: tempDir,
      notificationDispatcher: {
        dispatch: async (r) => { notifications.push(r); },
      },
    });

    const entry = await eng.addEntry({
      name: "rate-limited-entry",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      probe: {
        data_source_id: "missing-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: false,
      },
      escalation: {
        enabled: true,
        circuit_breaker_threshold: 100,
        cooldown_minutes: 0,
        max_per_hour: 1,  // Only 1 per hour
      },
    });

    // Set last_escalation_at to recent (within 1-hour rate window)
    const entries = eng.getEntries();
    const idx = entries.findIndex((e) => e.id === entry.id);
    entries[idx]!.last_escalation_at = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    entries[idx]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    // Should NOT escalate due to rate limit (max 1 per hour = 60 min interval, last was 5 min ago)
    expect(results[0]!.status).not.toBe("escalated");
  });

  it("escalation activates target entry", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });

    // Create a probe target entry
    const targetEntry = await eng.addEntry({
      name: "probe-target",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      enabled: false, // starts disabled
      probe: {
        data_source_id: "some-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: false,
      },
    });

    // Create escalating entry
    const escalatingEntry = await eng.addEntry({
      name: "escalating-entry",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      enabled: true,
      probe: {
        data_source_id: "missing-source",
        query_params: {},
        change_detector: { mode: "diff", baseline_window: 5 },
        llm_on_change: false,
      },
      escalation: {
        enabled: true,
        circuit_breaker_threshold: 100,
        cooldown_minutes: 0,
        max_per_hour: 100,
        target_entry_id: targetEntry.id,
        target_layer: "probe",
      },
    });

    const entries = eng.getEntries();
    const idx = entries.findIndex((e) => e.id === escalatingEntry.id);
    entries[idx]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    await eng.tick();

    const updatedTarget = eng.getEntries().find((e) => e.id === targetEntry.id)!;
    expect(updatedTarget.enabled).toBe(true);
  });
});

// ─── Additional Phase 2 tests ───

describe('ChangeDetector threshold mode edge cases', () => {
  it('threshold mode with undefined threshold_value returns changed true (surfaces misconfiguration)', () => {
    const result = detectChange('threshold', 50, [], undefined);
    expect(result.changed).toBe(true);
    expect(result.details).toContain('non-numeric result cannot be evaluated against threshold');
  });
});

describe('Probe execution edge cases', () => {
  it('executeProbe skips LLM when llmClient not injected even if llm_on_change is true', async () => {
    const adapter = makeMockAdapter({ count: 2 });
    const registry = new Map([['test-source', adapter]]);
    // No llmClient provided
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    const entry = await eng.addEntry(makeProbeEntry({
      probe: {
        data_source_id: 'test-source',
        query_params: {},
        change_detector: { mode: 'diff', baseline_window: 5 },
        llm_on_change: true, // true but no client
      },
    }));

    const entries = eng.getEntries();
    entries[0]!.baseline_results = [{ count: 1 }];
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.status).toBe('ok');
    expect(result!.change_detected).toBe(true);
    // tokens_used should be 0 since no llmClient was injected
    expect(result!.tokens_used).toBe(0);
  });

  it('executeProbe dispatches schedule_change notification on change', async () => {
    const notifications: Record<string, unknown>[] = [];
    const adapter = makeMockAdapter({ count: 2 });
    const registry = new Map([['test-source', adapter]]);
    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      notificationDispatcher: {
        dispatch: async (r) => { notifications.push(r); },
      },
    });

    const entry = await eng.addEntry(makeProbeEntry());

    const entries = eng.getEntries();
    entries[0]!.baseline_results = [{ count: 1 }];
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result!.change_detected).toBe(true);
    expect(notifications.some((n) => n['report_type'] === 'schedule_change')).toBe(true);
  });

  it('executeProbe returns error when entry has no probe config', async () => {
    const adapter = makeMockAdapter('value');
    const registry = new Map([['test-source', adapter]]);
    const eng = new ScheduleEngine({ baseDir: tempDir, dataSourceRegistry: registry });

    // Add entry without probe config (use heartbeat layer to get a raw entry then override)
    const entry = await eng.addEntry({
      name: 'no-probe-config',
      layer: 'probe',
      trigger: { type: 'interval', seconds: 60 },
      enabled: true,
      // probe field intentionally omitted
    });

    // Call executeProbe directly with an entry that has no probe config
    const result = await (eng as any).executeProbe({ ...entry, probe: undefined });
    expect(result.status).toBe('error');
    expect(result.error_message).toContain('No probe config');
  });

  it('escalation sets target entry next_fire_at for immediate firing', async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });

    const targetEntry = await eng.addEntry({
      name: 'target-probe',
      layer: 'probe',
      trigger: { type: 'interval', seconds: 3600 },
      enabled: false,
      probe: {
        data_source_id: 'some-source',
        query_params: {},
        change_detector: { mode: 'diff', baseline_window: 5 },
        llm_on_change: false,
      },
    });

    const escalatingEntry = await eng.addEntry({
      name: 'escalating-entry',
      layer: 'probe',
      trigger: { type: 'interval', seconds: 60 },
      enabled: true,
      probe: {
        data_source_id: 'missing-source',
        query_params: {},
        change_detector: { mode: 'diff', baseline_window: 5 },
        llm_on_change: false,
      },
      escalation: {
        enabled: true,
        circuit_breaker_threshold: 100,
        cooldown_minutes: 0,
        max_per_hour: 100,
        target_entry_id: targetEntry.id,
        target_layer: 'probe',
      },
    });

    const entries = eng.getEntries();
    const idx = entries.findIndex((e) => e.id === escalatingEntry.id);
    entries[idx]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const beforeTick = Date.now();
    await eng.tick();

    const updatedTarget = eng.getEntries().find((e) => e.id === targetEntry.id)!;
    expect(updatedTarget.enabled).toBe(true);
    // next_fire_at should have been set to a time <= now (i.e., immediate firing)
    expect(new Date(updatedTarget.next_fire_at).getTime()).toBeLessThanOrEqual(beforeTick + 5000);
  });
});

// ─── Phase 3: Cron execution ───

function makeCronEntry(overrides: Partial<ScheduleEntry> = {}): Omit<
  ScheduleEntry,
  "id" | "created_at" | "updated_at" | "last_fired_at" | "next_fire_at" |
  "consecutive_failures" | "last_escalation_at" | "baseline_results" |
  "total_executions" | "total_tokens_used" | "max_tokens_per_day" | "tokens_used_today" | "budget_reset_at"
> {
  return {
    name: "test-cron",
    layer: "cron",
    trigger: { type: "interval", seconds: 3600 },
    enabled: true,
    cron: {
      prompt_template: "Summarize current status: {{test-source}}",
      context_sources: ["test-source"],
      output_format: "notification",
      max_tokens: 1000,
    },
    ...overrides,
  };
}

function makeGoalTriggerEntry(overrides: Partial<ScheduleEntry> = {}): Omit<
  ScheduleEntry,
  "id" | "created_at" | "updated_at" | "last_fired_at" | "next_fire_at" |
  "consecutive_failures" | "last_escalation_at" | "baseline_results" |
  "total_executions" | "total_tokens_used" | "max_tokens_per_day" | "tokens_used_today" | "budget_reset_at"
> {
  return {
    name: "test-goal-trigger",
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 3600 },
    enabled: true,
    goal_trigger: {
      goal_id: "test-goal-id",
      max_iterations: 5,
      skip_if_active: true,
    },
    ...overrides,
  };
}

describe("Cron execution (Phase 3)", () => {
  it("executeCron gathers context and calls LLM", async () => {
    const adapter = makeMockAdapter("status: ok");
    const registry = new Map([["test-source", adapter]]);
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "All systems operational.",
        usage: { input_tokens: 50, output_tokens: 30 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeCronEntry());
    const result = await (eng as any).executeCron(entry);

    expect(result.status).toBe("ok");
    expect(mockLlm.sendMessage).toHaveBeenCalledOnce();
    expect(result.tokens_used).toBeGreaterThan(0);
  });

  it("executeCron interpolates prompt template with context", async () => {
    const adapter = makeMockAdapter("my-data");
    const registry = new Map([["test-source", adapter]]);
    let capturedPrompt = "";
    const mockLlm = {
      sendMessage: vi.fn().mockImplementation(async (messages: any[]) => {
        capturedPrompt = messages[0].content;
        return { content: "done", usage: { input_tokens: 10, output_tokens: 5 } };
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeCronEntry());
    await (eng as any).executeCron(entry);

    expect(capturedPrompt).toContain("my-data");
    expect(capturedPrompt).not.toContain("{{test-source}}");
  });

  it("executeCron skips when daily budget exceeded", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });

    const entry = await eng.addEntry(makeCronEntry());

    // Set tokens_used_today to exceed budget
    const entries = eng.getEntries();
    entries[0]!.tokens_used_today = 100001;
    entries[0]!.max_tokens_per_day = 100000;

    const result = await (eng as any).executeCron(eng.getEntries()[0]);
    expect(result.status).toBe("skipped");
    expect(result.error_message).toContain("daily budget exceeded");
  });

  it("executeCron dispatches notification on output_format notification", async () => {
    const adapter = makeMockAdapter("data");
    const registry = new Map([["test-source", adapter]]);
    const notifications: Record<string, unknown>[] = [];
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "summary",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
      notificationDispatcher: { dispatch: async (r) => { notifications.push(r); } },
    });

    const entry = await eng.addEntry(makeCronEntry());
    await (eng as any).executeCron(entry);

    expect(notifications.some((n) => n["report_type"] === "schedule_report_ready")).toBe(true);
  });

  it("executeCron returns output_summary", async () => {
    const adapter = makeMockAdapter("val");
    const registry = new Map([["test-source", adapter]]);
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "The summary text.",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeCronEntry());
    const result = await (eng as any).executeCron(entry);

    expect(result.output_summary).toBe("The summary text.");
  });

  it("executeCron handles missing context source gracefully", async () => {
    // No registry — source will not be found
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "summary without context",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeCronEntry());
    const result = await (eng as any).executeCron(entry);

    // Should still complete — missing source just results in empty string interpolation
    expect(result.status).toBe("ok");
    expect(mockLlm.sendMessage).toHaveBeenCalledOnce();
  });

  it("executeCron returns error when no cron config", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });
    const entry = await eng.addEntry(makeCronEntry());
    const result = await (eng as any).executeCron({ ...entry, cron: undefined });
    expect(result.status).toBe("error");
    expect(result.error_message).toContain("No cron config");
  });
});

// ─── Phase 3: GoalTrigger execution ───

describe("GoalTrigger execution (Phase 3)", () => {
  it("executeGoalTrigger calls coreLoop.run with correct args", async () => {
    const mockCoreLoop = {
      run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 3 }),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      coreLoop: mockCoreLoop,
    });

    const entry = await eng.addEntry(makeGoalTriggerEntry());
    const result = await (eng as any).executeGoalTrigger(entry);

    expect(result.status).toBe("ok");
    expect(mockCoreLoop.run).toHaveBeenCalledWith("test-goal-id", { maxIterations: 5 });
  });

  it("executeGoalTrigger skips when goal is active and skip_if_active is true", async () => {
    const mockCoreLoop = {
      run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 1 }),
    };
    const mockStateManager = {
      loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      coreLoop: mockCoreLoop,
      stateManager: mockStateManager,
    });

    const entry = await eng.addEntry(makeGoalTriggerEntry());
    const result = await (eng as any).executeGoalTrigger(entry);

    expect(result.status).toBe("skipped");
    expect(result.error_message).toContain("already active");
    expect(mockCoreLoop.run).not.toHaveBeenCalled();
  });

  it("executeGoalTrigger runs when skip_if_active is false even if goal is active", async () => {
    const mockCoreLoop = {
      run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 1 }),
    };
    const mockStateManager = {
      loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      coreLoop: mockCoreLoop,
      stateManager: mockStateManager,
    });

    const entry = await eng.addEntry(makeGoalTriggerEntry({
      goal_trigger: { goal_id: "test-goal-id", max_iterations: 5, skip_if_active: false },
    }));
    const result = await (eng as any).executeGoalTrigger(entry);

    expect(result.status).toBe("ok");
    expect(mockCoreLoop.run).toHaveBeenCalledOnce();
  });

  it("executeGoalTrigger skips when daily budget exceeded", async () => {
    const mockCoreLoop = {
      run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 1 }),
    };

    const eng = new ScheduleEngine({ baseDir: tempDir, coreLoop: mockCoreLoop });
    const entry = await eng.addEntry(makeGoalTriggerEntry());

    const entries = eng.getEntries();
    entries[0]!.tokens_used_today = 100001;
    entries[0]!.max_tokens_per_day = 100000;

    const result = await (eng as any).executeGoalTrigger(eng.getEntries()[0]);
    expect(result.status).toBe("skipped");
    expect(mockCoreLoop.run).not.toHaveBeenCalled();
  });

  it("executeGoalTrigger handles coreLoop error gracefully", async () => {
    const mockCoreLoop = {
      run: vi.fn().mockRejectedValue(new Error("loop failed")),
    };

    const eng = new ScheduleEngine({ baseDir: tempDir, coreLoop: mockCoreLoop });
    const entry = await eng.addEntry(makeGoalTriggerEntry());
    const result = await (eng as any).executeGoalTrigger(entry);

    expect(result.status).toBe("error");
    expect(result.error_message).toContain("loop failed");
  });

  it("executeGoalTrigger returns error when no coreLoop provided", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });
    const entry = await eng.addEntry(makeGoalTriggerEntry());
    const result = await (eng as any).executeGoalTrigger(entry);
    expect(result.status).toBe("error");
    expect(result.error_message).toContain("No coreLoop");
  });
});

// ─── Phase 3: tick() routing ───

describe("tick() routing (Phase 3)", () => {
  it("tick routes cron entries to executeCron", async () => {
    const adapter = makeMockAdapter("data");
    const registry = new Map([["test-source", adapter]]);
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "done",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeCronEntry());
    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    // executeCron calls LLM, so this won't be "skipped"
    expect(result!.status).toBe("ok");
    expect(mockLlm.sendMessage).toHaveBeenCalledOnce();
  });

  it("tick routes goal_trigger entries to executeGoalTrigger", async () => {
    const mockCoreLoop = {
      run: vi.fn().mockResolvedValue({ finalStatus: "completed", totalIterations: 1 }),
    };

    const eng = new ScheduleEngine({ baseDir: tempDir, coreLoop: mockCoreLoop });

    const entry = await eng.addEntry(makeGoalTriggerEntry({
      goal_trigger: { goal_id: "test-goal-id", max_iterations: 5, skip_if_active: false },
    }));
    const entries = eng.getEntries();
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    const results = await eng.tick();
    const result = results.find((r) => r.entry_id === entry.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("ok");
    expect(mockCoreLoop.run).toHaveBeenCalledOnce();
  });
});

// ─── Phase 3: Budget management ───

describe("Budget management (Phase 3)", () => {
  it("budget resets after 24 hours", async () => {
    const eng = new ScheduleEngine({ baseDir: tempDir });

    const entry = await eng.addEntry(makeCronEntry());

    // Set budget_reset_at to the past and tokens_used_today to a high value
    const entries = eng.getEntries();
    entries[0]!.tokens_used_today = 50000;
    entries[0]!.budget_reset_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    entries[0]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
    await eng.saveEntries();
    await eng.loadEntries();

    // tick() should reset the budget first
    // We don't need it to fully execute — just check budget was reset
    // Set up a minimal scenario that passes (no llmClient, so cron won't call LLM)
    await eng.tick();

    // After tick, tokens_used_today should have been reset (then incremented by 0 since no LLM)
    const updated = eng.getEntries().find((e) => e.id === entry.id)!;
    // Budget was reset to 0 then possibly incremented by 0 tokens
    expect(updated.tokens_used_today).toBe(0);
  });

  it("budget accumulated across multiple ticks", async () => {
    const adapter = makeMockAdapter("data");
    const registry = new Map([["test-source", adapter]]);
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "summary",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
    });

    const entry = await eng.addEntry(makeCronEntry());

    // Set budget_reset_at to far future so it doesn't reset
    const entries = eng.getEntries();
    entries[0]!.budget_reset_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const setDue = async () => {
      const es = eng.getEntries();
      const idx = es.findIndex((e) => e.id === entry.id);
      if (idx !== -1) es[idx]!.next_fire_at = new Date(Date.now() - 1000).toISOString();
      await eng.saveEntries();
      await eng.loadEntries();
    };

    await setDue();
    await eng.tick();

    const after1 = eng.getEntries().find((e) => e.id === entry.id)!;
    expect(after1.tokens_used_today).toBe(150); // 100 + 50

    await setDue();
    await eng.tick();

    const after2 = eng.getEntries().find((e) => e.id === entry.id)!;
    expect(after2.tokens_used_today).toBe(300); // 150 + 150
  });
});

// ─── Phase 3: Additional reviewer-required tests ───

describe("Cron execution — output_format both and report (Phase 3)", () => {
  it("executeCron with output_format 'both' dispatches notification and includes output_summary", async () => {
    const adapter = makeMockAdapter("data-both");
    const registry = new Map([["test-source", adapter]]);
    const notifications: Record<string, unknown>[] = [];
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "summary for both",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      parseJSON: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
      notificationDispatcher: { dispatch: async (r) => { notifications.push(r); } },
    });

    const entry = await eng.addEntry(makeCronEntry({
      cron: {
        prompt_template: "Summarize: {{test-source}}",
        context_sources: ["test-source"],
        output_format: "both",
        max_tokens: 1000,
      },
    }));
    const result = await (eng as any).executeCron(entry);

    expect(result.status).toBe("ok");
    expect(result.output_summary).toBe("summary for both");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!["report_type"]).toBe("schedule_report_ready");
    expect(notifications[0]!["output_summary"]).toBe("summary for both");
  });

  it("executeCron with output_format 'report' logs warning about unimplemented report path", async () => {
    const adapter = makeMockAdapter("data-report");
    const registry = new Map([["test-source", adapter]]);
    const warnMessages: string[] = [];
    const mockLlm = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "report summary",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      parseJSON: vi.fn(),
    };
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn().mockImplementation((msg: string) => { warnMessages.push(msg); }),
      error: vi.fn(),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      dataSourceRegistry: registry,
      llmClient: mockLlm as unknown as import("../../base/llm/llm-client.js").ILLMClient,
      logger: mockLogger,
    });

    const entry = await eng.addEntry(makeCronEntry({
      cron: {
        prompt_template: "Summarize: {{test-source}}",
        context_sources: ["test-source"],
        output_format: "report",
        max_tokens: 1000,
      },
    }));
    await (eng as any).executeCron(entry);

    const reportWarn = warnMessages.find((m) => m.includes("not yet implemented"));
    expect(reportWarn).toBeDefined();
    expect(reportWarn).toContain("Phase 4");
  });
});

describe("GoalTrigger execution — token accumulation (Phase 3)", () => {
  it("executeGoalTrigger accumulates tokens from coreLoop result — defaults to 0 (TODO Phase 4)", async () => {
    // LoopResult does not currently expose token usage. tokensUsed defaults to 0.
    // When CoreLoop adds a tokensUsed field this test should be updated.
    const mockCoreLoop = {
      run: vi.fn().mockResolvedValue({
        finalStatus: "completed",
        totalIterations: 3,
        goalId: "test-goal-id",
        iterations: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    };

    const eng = new ScheduleEngine({
      baseDir: tempDir,
      coreLoop: mockCoreLoop,
    });

    const entry = await eng.addEntry(makeGoalTriggerEntry({
      goal_trigger: { goal_id: "test-goal-id", max_iterations: 3, skip_if_active: false },
    }));
    const result = await (eng as any).executeGoalTrigger(entry);

    expect(result.status).toBe("ok");
    // tokens_used is 0 until LoopResult exposes token usage (Phase 4 TODO)
    expect(result.tokens_used).toBe(0);
    expect(mockCoreLoop.run).toHaveBeenCalledWith("test-goal-id", { maxIterations: 3 });
  });
});
