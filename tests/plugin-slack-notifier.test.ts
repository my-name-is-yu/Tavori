import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackNotifier } from "../plugins/slack-notifier/src/index.js";
import type { NotificationEvent } from "../src/types/plugin.js";

// ─── Helpers ───

function makeEvent(
  overrides: Partial<NotificationEvent> = {}
): NotificationEvent {
  return {
    type: "goal_complete",
    goal_id: "goal-test-1",
    timestamp: "2026-03-17T00:00:00.000Z",
    summary: "Goal reached satisficing threshold",
    details: {},
    severity: "info",
    ...overrides,
  };
}

// ─── Tests ───

describe("SlackNotifier — INotifier interface compliance", () => {
  it("has a name property equal to 'slack-notifier'", () => {
    const notifier = new SlackNotifier({ webhook_url: "https://example.com/hook" });
    expect(notifier.name).toBe("slack-notifier");
  });

  it("exposes a notify() method", () => {
    const notifier = new SlackNotifier({ webhook_url: "https://example.com/hook" });
    expect(typeof notifier.notify).toBe("function");
  });

  it("exposes a supports() method", () => {
    const notifier = new SlackNotifier({ webhook_url: "https://example.com/hook" });
    expect(typeof notifier.supports).toBe("function");
  });

  it("throws when webhook_url is missing", () => {
    expect(() => new SlackNotifier({ webhook_url: "" })).toThrow(
      "webhook_url is required"
    );
  });
});

describe("SlackNotifier — supports()", () => {
  let notifier: SlackNotifier;

  beforeEach(() => {
    notifier = new SlackNotifier({ webhook_url: "https://hooks.slack.com/test" });
  });

  it("returns true for goal_complete", () => {
    expect(notifier.supports("goal_complete")).toBe(true);
  });

  it("returns true for approval_needed", () => {
    expect(notifier.supports("approval_needed")).toBe(true);
  });

  it("returns true for stall_detected", () => {
    expect(notifier.supports("stall_detected")).toBe(true);
  });

  it("returns true for task_blocked", () => {
    expect(notifier.supports("task_blocked")).toBe(true);
  });

  it("returns false for goal_progress", () => {
    expect(notifier.supports("goal_progress")).toBe(false);
  });

  it("returns false for trust_change", () => {
    expect(notifier.supports("trust_change")).toBe(false);
  });
});

describe("SlackNotifier — notify() message formatting", () => {
  let notifier: SlackNotifier;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", fetchMock);

    notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/services/T000/B000/test",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the configured webhook URL", async () => {
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/T000/B000/test");
    expect(init.method).toBe("POST");
  });

  it("sends JSON content-type header", async () => {
    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });

  it("includes the event summary in the message text", async () => {
    await notifier.notify(makeEvent({ summary: "All tests passed" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload["text"]).toContain("All tests passed");
  });

  it("includes the goal_id in the blocks context", async () => {
    await notifier.notify(makeEvent({ goal_id: "my-special-goal" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as {
      blocks: Array<{ elements?: Array<{ text: string }> }>;
    };
    const contextBlock = payload.blocks.find((b) => b.elements);
    expect(contextBlock?.elements?.[0]?.text).toContain("my-special-goal");
  });

  it("uses green_circle emoji for info severity", async () => {
    await notifier.notify(makeEvent({ severity: "info" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).toContain(":green_circle:");
  });

  it("uses yellow_circle emoji for warning severity", async () => {
    await notifier.notify(makeEvent({ severity: "warning" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).toContain(":yellow_circle:");
  });

  it("uses red_circle emoji for critical severity", async () => {
    await notifier.notify(makeEvent({ severity: "critical" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).toContain(":red_circle:");
  });

  it("throws when webhook returns a non-OK status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_payload",
    });

    await expect(notifier.notify(makeEvent())).rejects.toThrow("400");
  });
});

describe("SlackNotifier — mention_on_critical", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds @channel mention for critical events when mention_on_critical is true", async () => {
    const notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/test",
      mention_on_critical: true,
    });

    await notifier.notify(makeEvent({ severity: "critical" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).toContain("<!channel>");
  });

  it("does not add @channel mention when mention_on_critical is false", async () => {
    const notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/test",
      mention_on_critical: false,
    });

    await notifier.notify(makeEvent({ severity: "critical" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).not.toContain("<!channel>");
  });

  it("does not add @channel mention for non-critical events even when mention_on_critical is true", async () => {
    const notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/test",
      mention_on_critical: true,
    });

    await notifier.notify(makeEvent({ severity: "warning" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).not.toContain("<!channel>");
  });

  it("defaults to adding @channel mention when mention_on_critical is omitted", async () => {
    const notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/test",
      // mention_on_critical not set — defaults to true
    });

    await notifier.notify(makeEvent({ severity: "critical" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { text: string };
    expect(payload.text).toContain("<!channel>");
  });
});

describe("SlackNotifier — channel override", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the channel field when channel is configured", async () => {
    const notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/test",
      channel: "#pulseed-alerts",
    });

    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { channel?: string };
    expect(payload.channel).toBe("#pulseed-alerts");
  });

  it("omits the channel field when no channel override is configured", async () => {
    const notifier = new SlackNotifier({
      webhook_url: "https://hooks.slack.com/test",
    });

    await notifier.notify(makeEvent());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "channel")).toBe(false);
  });
});
