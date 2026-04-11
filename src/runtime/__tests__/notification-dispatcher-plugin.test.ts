import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import { NotifierRegistry } from "../notifier-registry.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";
import type { Report } from "../../base/types/report.js";

// ─── Helpers ───

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "r1",
    report_type: "goal_completion",
    goal_id: "goal-1",
    title: "Goal achieved",
    content: "All targets met.",
    verbosity: "standard",
    generated_at: new Date().toISOString(),
    ...overrides,
  } as Report;
}

function makeNotifier(
  name: string,
  supportedEvents: NotificationEventType[],
  notifyImpl?: (event: NotificationEvent) => Promise<void>
): INotifier {
  return {
    name,
    notify: notifyImpl ?? vi.fn().mockResolvedValue(undefined),
    supports: (eventType: NotificationEventType) => supportedEvents.includes(eventType),
  };
}

// ─── Tests ───

describe("NotificationDispatcher — NotifierRegistry integration", () => {
  let registry: NotifierRegistry;
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    registry = new NotifierRegistry();
    // No channels configured — we only test plugin routing here
    dispatcher = new NotificationDispatcher({}, registry);
  });

  it("routes a mapped report type to a matching notifier", async () => {
    const notifier = makeNotifier("my-notifier", ["goal_complete"]);
    registry.register("my-notifier", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));

    expect(notifier.notify).toHaveBeenCalledOnce();
    const event = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as NotificationEvent;
    expect(event.type).toBe("goal_complete");
    expect(event.goal_id).toBe("goal-1");
    expect(event.summary).toBe("Goal achieved");
  });

  it("does not crash when a plugin notifier throws", async () => {
    const failing = makeNotifier("failing-notifier", ["goal_complete"], async () => {
      throw new Error("network failure");
    });
    registry.register("failing-notifier", failing);

    // Should resolve without throwing
    await expect(
      dispatcher.dispatch(makeReport({ report_type: "goal_completion" }))
    ).resolves.toBeDefined();
  });

  it("delivers the event to all matching notifiers", async () => {
    const n1 = makeNotifier("n1", ["goal_complete"]);
    const n2 = makeNotifier("n2", ["goal_complete"]);
    registry.register("n1", n1);
    registry.register("n2", n2);

    await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));

    expect(n1.notify).toHaveBeenCalledOnce();
    expect(n2.notify).toHaveBeenCalledOnce();
  });

  it("skips notifiers that do not support the event type", async () => {
    const matching = makeNotifier("matching", ["goal_complete"]);
    const nonMatching = makeNotifier("non-matching", ["stall_detected"]);
    registry.register("matching", matching);
    registry.register("non-matching", nonMatching);

    await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));

    expect(matching.notify).toHaveBeenCalledOnce();
    expect(nonMatching.notify).not.toHaveBeenCalled();
  });

  it("does not route when no NotifierRegistry is set", async () => {
    const dispatcherNoRegistry = new NotificationDispatcher({});
    // Just ensure it completes without error
    await expect(
      dispatcherNoRegistry.dispatch(makeReport({ report_type: "goal_completion" }))
    ).resolves.toBeDefined();
  });

  it("maps stall_escalation report type to stall_detected event", async () => {
    const notifier = makeNotifier("stall-watcher", ["stall_detected"]);
    registry.register("stall-watcher", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "stall_escalation" }));

    expect(notifier.notify).toHaveBeenCalledOnce();
    const event = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as NotificationEvent;
    expect(event.type).toBe("stall_detected");
    expect(event.severity).toBe("warning");
  });

  it("maps urgent_alert report type to approval_needed with critical severity", async () => {
    const notifier = makeNotifier("approval-handler", ["approval_needed"]);
    registry.register("approval-handler", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "urgent_alert" }));

    expect(notifier.notify).toHaveBeenCalledOnce();
    const event = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as NotificationEvent;
    expect(event.type).toBe("approval_needed");
    expect(event.severity).toBe("critical");
  });

  it("does not route unmapped report types to any notifier", async () => {
    const notifier = makeNotifier("catch-all", ["goal_complete", "stall_detected", "approval_needed"]);
    registry.register("catch-all", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "unknown_custom_type" as any }));

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("delivers event details including report metadata", async () => {
    const notifier = makeNotifier("detail-checker", ["goal_complete"]);
    registry.register("detail-checker", notifier);

    const report = makeReport({
      report_type: "goal_completion",
      id: "rep-42",
      content: "All done",
    });
    await dispatcher.dispatch(report);

    const event = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as NotificationEvent;
    expect(event.details).toMatchObject({
      report_id: "rep-42",
      report_type: "goal_completion",
      content: "All done",
    });
  });

  it("routes daily and weekly reports through plugin notifiers", async () => {
    const notifier = makeNotifier("report-target", ["goal_progress"]);
    registry.register("report-target", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "weekly_report" }));

    expect(notifier.notify).toHaveBeenCalledOnce();
    const event = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as NotificationEvent;
    expect(event.type).toBe("goal_progress");
    expect(event.details.report_type).toBe("weekly_report");
  });

  it("filters plugin notifier delivery through notification config", async () => {
    dispatcher = new NotificationDispatcher(
      {
        plugin_notifiers: {
          mode: "only",
          routes: [{ id: "discord-bot", enabled: true, report_types: ["weekly_report"] }],
        },
      },
      registry
    );
    const discord = makeNotifier("discord-bot", ["goal_progress"]);
    const whatsapp = makeNotifier("whatsapp-webhook", ["goal_progress"]);
    registry.register("discord-bot", discord);
    registry.register("whatsapp-webhook", whatsapp);

    await dispatcher.dispatch(makeReport({ report_type: "weekly_report" }));

    expect(discord.notify).toHaveBeenCalledOnce();
    expect(whatsapp.notify).not.toHaveBeenCalled();
  });

  it("applies DND suppression to plugin notifiers", async () => {
    dispatcher = new NotificationDispatcher(
      {
        do_not_disturb: {
          enabled: true,
          start_hour: 0,
          end_hour: 23,
          exceptions: [],
        },
      },
      registry
    );
    const notifier = makeNotifier("discord-bot", ["goal_complete"]);
    registry.register("discord-bot", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("applies cooldown suppression to plugin notifiers after a plugin delivery", async () => {
    dispatcher = new NotificationDispatcher(
      {
        cooldown: {
          goal_completion: 60,
          urgent_alert: 0,
          approval_request: 0,
          stall_escalation: 60,
          strategy_change: 30,
          capability_escalation: 60,
        },
      },
      registry
    );
    const notifier = makeNotifier("discord-bot", ["goal_complete"]);
    registry.register("discord-bot", notifier);

    await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));
    await dispatcher.dispatch(makeReport({ report_type: "goal_completion", id: "r2" }));

    expect(notifier.notify).toHaveBeenCalledOnce();
  });

  it("one failing notifier does not prevent other notifiers from receiving event", async () => {
    const failing = makeNotifier("failing", ["goal_complete"], async () => {
      throw new Error("boom");
    });
    const healthy = makeNotifier("healthy", ["goal_complete"]);
    registry.register("failing", failing);
    registry.register("healthy", healthy);

    await dispatcher.dispatch(makeReport({ report_type: "goal_completion" }));

    expect(healthy.notify).toHaveBeenCalledOnce();
  });
});
