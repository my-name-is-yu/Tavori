import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotificationBatcher } from "../src/runtime/notification-batcher.js";
import type { Report } from "../src/types/report.js";

// ─── Helpers ───

const makeReport = (overrides?: Partial<Report>): Report => ({
  id: "r-1",
  report_type: "execution_summary",
  goal_id: "goal-1",
  title: "Test Report",
  content: "Test content",
  verbosity: "standard",
  generated_at: new Date().toISOString(),
  delivered_at: null,
  read: false,
  ...overrides,
});

const makeConfig = (overrides?: Partial<{ window_minutes: number; digest_format: "compact" | "detailed" }>) => ({
  window_minutes: 30,
  digest_format: "compact" as const,
  ...overrides,
});

// ─── getPriority ───

describe("NotificationBatcher.getPriority", () => {
  it("classifies goal_completion as immediate", () => {
    expect(NotificationBatcher.getPriority("goal_completion")).toBe("immediate");
  });

  it("classifies urgent_alert as immediate", () => {
    expect(NotificationBatcher.getPriority("urgent_alert")).toBe("immediate");
  });

  it("classifies approval_request as immediate", () => {
    expect(NotificationBatcher.getPriority("approval_request")).toBe("immediate");
  });

  it("classifies daily_summary as batchable", () => {
    expect(NotificationBatcher.getPriority("daily_summary")).toBe("batchable");
  });

  it("classifies strategy_change as batchable", () => {
    expect(NotificationBatcher.getPriority("strategy_change")).toBe("batchable");
  });

  it("classifies execution_summary as batchable", () => {
    expect(NotificationBatcher.getPriority("execution_summary")).toBe("batchable");
  });

  it("classifies stall_escalation as digest_only", () => {
    expect(NotificationBatcher.getPriority("stall_escalation")).toBe("digest_only");
  });

  it("classifies capability_escalation as digest_only", () => {
    expect(NotificationBatcher.getPriority("capability_escalation")).toBe("digest_only");
  });

  it("classifies weekly_report as digest_only", () => {
    expect(NotificationBatcher.getPriority("weekly_report")).toBe("digest_only");
  });

  it("classifies unknown type as digest_only", () => {
    expect(NotificationBatcher.getPriority("unknown_type")).toBe("digest_only");
  });
});

// ─── add() ───

describe("NotificationBatcher.add()", () => {
  let flushCb: ReturnType<typeof vi.fn>;
  let batcher: NotificationBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCb = vi.fn().mockResolvedValue(undefined);
    batcher = new NotificationBatcher(makeConfig(), flushCb);
  });

  afterEach(async () => {
    await batcher.stop();
    vi.useRealTimers();
  });

  it("returns false for immediate reports", () => {
    const result = batcher.add(makeReport({ report_type: "urgent_alert" }));
    expect(result).toBe(false);
  });

  it("returns false for goal_completion", () => {
    expect(batcher.add(makeReport({ report_type: "goal_completion" }))).toBe(false);
  });

  it("returns false for approval_request", () => {
    expect(batcher.add(makeReport({ report_type: "approval_request" }))).toBe(false);
  });

  it("returns true for batchable reports", () => {
    const result = batcher.add(makeReport({ report_type: "execution_summary" }));
    expect(result).toBe(true);
  });

  it("returns true for strategy_change", () => {
    expect(batcher.add(makeReport({ report_type: "strategy_change" }))).toBe(true);
  });

  it("returns true for digest_only reports", () => {
    expect(batcher.add(makeReport({ report_type: "stall_escalation" }))).toBe(true);
  });

  it("immediate reports do not increase queue length", () => {
    batcher.add(makeReport({ report_type: "urgent_alert" }));
    expect(batcher.getQueueLength()).toBe(0);
  });

  it("batchable reports increase queue length", () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    expect(batcher.getQueueLength()).toBe(1);

    batcher.add(makeReport({ report_type: "strategy_change" }));
    expect(batcher.getQueueLength()).toBe(2);
  });
});

// ─── flush() ───

describe("NotificationBatcher.flush()", () => {
  let flushCb: ReturnType<typeof vi.fn>;
  let batcher: NotificationBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCb = vi.fn().mockResolvedValue(undefined);
    batcher = new NotificationBatcher(makeConfig(), flushCb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("empty queue flush is a no-op", async () => {
    await batcher.flush();
    expect(flushCb).not.toHaveBeenCalled();
  });

  it("flush() calls the callback once with a digest report", async () => {
    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "goal-1" }));
    batcher.add(makeReport({ report_type: "strategy_change", goal_id: "goal-1" }));

    await batcher.flush();

    expect(flushCb).toHaveBeenCalledTimes(1);
    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.report_type).toBe("daily_summary");
  });

  it("flush() groups reports by goal_id in digest content", async () => {
    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "goal-A", title: "A1" }));
    batcher.add(makeReport({ report_type: "strategy_change", goal_id: "goal-B", title: "B1" }));
    batcher.add(makeReport({ report_type: "execution_summary", goal_id: "goal-A", title: "A2" }));

    await batcher.flush();

    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.content).toContain("goal-A");
    expect(digest.content).toContain("goal-B");
  });

  it("flush() creates digest with correct title reflecting count", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    batcher.add(makeReport({ report_type: "strategy_change" }));
    batcher.add(makeReport({ report_type: "stall_escalation" }));

    await batcher.flush();

    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.title).toContain("3");
  });

  it("flush() clears the queue", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    await batcher.flush();
    expect(batcher.getQueueLength()).toBe(0);
  });

  it("flush() uses detailed format when configured", async () => {
    const detailedBatcher = new NotificationBatcher(
      makeConfig({ digest_format: "detailed" }),
      flushCb
    );
    detailedBatcher.add(
      makeReport({ report_type: "execution_summary", goal_id: "goal-1", title: "My Title", content: "My Content" })
    );

    await detailedBatcher.flush();

    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.content).toContain("My Title");
    expect(digest.content).toContain("My Content");
  });
});

// ─── timer ───

describe("NotificationBatcher — timer", () => {
  let flushCb: ReturnType<typeof vi.fn>;
  let batcher: NotificationBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCb = vi.fn().mockResolvedValue(undefined);
    batcher = new NotificationBatcher(makeConfig({ window_minutes: 1 }), flushCb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("timer fires after window_minutes and flushes", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    expect(flushCb).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(flushCb).toHaveBeenCalledTimes(1);
  });

  it("timer does not fire before window_minutes elapses", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));

    await vi.advanceTimersByTimeAsync(59 * 1000);

    expect(flushCb).not.toHaveBeenCalled();
  });
});

// ─── stop() ───

describe("NotificationBatcher.stop()", () => {
  let flushCb: ReturnType<typeof vi.fn>;
  let batcher: NotificationBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCb = vi.fn().mockResolvedValue(undefined);
    batcher = new NotificationBatcher(makeConfig(), flushCb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop() flushes remaining queue items", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));
    batcher.add(makeReport({ report_type: "strategy_change" }));

    await batcher.stop();

    expect(flushCb).toHaveBeenCalledTimes(1);
    const digest: Report = flushCb.mock.calls[0][0];
    expect(digest.report_type).toBe("daily_summary");
  });

  it("stop() on empty queue is a no-op", async () => {
    await batcher.stop();
    expect(flushCb).not.toHaveBeenCalled();
  });

  it("stop() cancels the pending timer", async () => {
    batcher.add(makeReport({ report_type: "execution_summary" }));

    await batcher.stop();
    vi.clearAllMocks();

    // After stop, timer should not fire
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(flushCb).not.toHaveBeenCalled();
  });
});
