import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PagerDutyNotifier } from "../examples/plugins/pagerduty-notifier/src/index.js";
import type { NotificationEvent } from "../src/types/plugin.js";

// ─── Helpers ───

function makeEvent(
  overrides: Partial<NotificationEvent> = {}
): NotificationEvent {
  return {
    type: "task_blocked",
    goal_id: "goal-test-1",
    timestamp: "2026-03-20T00:00:00.000Z",
    summary: "Task is blocked waiting for input",
    details: { task_id: "task-42" },
    severity: "warning",
    ...overrides,
  };
}

// ─── Tests ───

describe("PagerDutyNotifier — INotifier interface compliance", () => {
  it("has a name property equal to 'pagerduty-notifier'", () => {
    const notifier = new PagerDutyNotifier({ routing_key: "r-key-test" });
    expect(notifier.name).toBe("pagerduty-notifier");
  });

  it("exposes a notify() method", () => {
    const notifier = new PagerDutyNotifier({ routing_key: "r-key-test" });
    expect(typeof notifier.notify).toBe("function");
  });

  it("exposes a supports() method", () => {
    const notifier = new PagerDutyNotifier({ routing_key: "r-key-test" });
    expect(typeof notifier.supports).toBe("function");
  });

  it("throws when routing_key is missing", () => {
    expect(() => new PagerDutyNotifier({ routing_key: "" })).toThrow(
      "routing_key is required"
    );
  });
});

describe("PagerDutyNotifier — supports()", () => {
  let notifier: PagerDutyNotifier;

  beforeEach(() => {
    notifier = new PagerDutyNotifier({ routing_key: "test-routing-key" });
  });

  it("returns true for task_blocked", () => {
    expect(notifier.supports("task_blocked")).toBe(true);
  });

  it("returns true for approval_needed", () => {
    expect(notifier.supports("approval_needed")).toBe(true);
  });

  it("returns true for stall_detected", () => {
    expect(notifier.supports("stall_detected")).toBe(true);
  });

  it("returns true for goal_complete", () => {
    expect(notifier.supports("goal_complete")).toBe(true);
  });

  it("returns true for trust_change", () => {
    expect(notifier.supports("trust_change")).toBe(true);
  });

  it("returns false for goal_progress", () => {
    expect(notifier.supports("goal_progress")).toBe(false);
  });
});

describe("PagerDutyNotifier — notify() request content", () => {
  let notifier: PagerDutyNotifier;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"status":"success","message":"Event processed","dedup_key":"srv01of5a8hq"}',
    });
    vi.stubGlobal("fetch", fetchMock);

    notifier = new PagerDutyNotifier({ routing_key: "test-routing-key-abc" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the PagerDuty Events API v2 endpoint", async () => {
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
  });

  it("uses POST method", async () => {
    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("sends JSON content-type header", async () => {
    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("includes the routing_key in the payload", async () => {
    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload["routing_key"]).toBe("test-routing-key-abc");
  });

  it("sets event_action to 'trigger'", async () => {
    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload["event_action"]).toBe("trigger");
  });

  it("includes event summary in payload.summary", async () => {
    await notifier.notify(makeEvent({ summary: "Critical issue escalated" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { summary: string };
    };
    expect(payload.payload.summary).toBe("Critical issue escalated");
  });

  it("maps info severity correctly", async () => {
    await notifier.notify(makeEvent({ severity: "info" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { severity: string };
    };
    expect(payload.payload.severity).toBe("info");
  });

  it("maps warning severity correctly", async () => {
    await notifier.notify(makeEvent({ severity: "warning" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { severity: string };
    };
    expect(payload.payload.severity).toBe("warning");
  });

  it("maps critical severity correctly", async () => {
    await notifier.notify(makeEvent({ severity: "critical" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { severity: string };
    };
    expect(payload.payload.severity).toBe("critical");
  });

  it("includes goal_id in custom_details", async () => {
    await notifier.notify(makeEvent({ goal_id: "goal-xyz-99" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { custom_details: Record<string, unknown> };
    };
    expect(payload.payload.custom_details["goal_id"]).toBe("goal-xyz-99");
  });

  it("includes event type in custom_details", async () => {
    await notifier.notify(makeEvent({ type: "stall_detected" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { custom_details: Record<string, unknown> };
    };
    expect(payload.payload.custom_details["event_type"]).toBe("stall_detected");
  });

  it("defaults source to 'pulseed' when not configured", async () => {
    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { source: string };
    };
    expect(payload.payload.source).toBe("pulseed");
  });

  it("uses configured source when provided", async () => {
    const notifierWithSource = new PagerDutyNotifier({
      routing_key: "test-key",
      source: "pulseed-production",
    });

    await notifierWithSource.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      payload: { source: string };
    };
    expect(payload.payload.source).toBe("pulseed-production");
  });

  it("throws when API returns a non-OK status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid routing key",
    });

    await expect(notifier.notify(makeEvent())).rejects.toThrow("400");
  });
});
