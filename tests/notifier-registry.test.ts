import { describe, it, expect, vi } from "vitest";
import { NotifierRegistry } from "../src/runtime/notifier-registry.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../src/types/plugin.js";

// ─── Helpers ───

function makeNotifier(
  name: string,
  supportedEvents: NotificationEventType[]
): INotifier {
  return {
    name,
    notify: vi.fn().mockResolvedValue(undefined),
    supports: (eventType: NotificationEventType) =>
      supportedEvents.includes(eventType),
  };
}

function makeEvent(type: NotificationEventType): NotificationEvent {
  return {
    type,
    goal_id: "goal-1",
    timestamp: new Date().toISOString(),
    summary: "test event",
    details: {},
    severity: "info",
  };
}

// ─── Tests ───

describe("NotifierRegistry", () => {
  describe("register and has", () => {
    it("registers a notifier and reports it as present", () => {
      const registry = new NotifierRegistry();
      const notifier = makeNotifier("slack", ["goal_complete"]);

      registry.register("slack", notifier);

      expect(registry.has("slack")).toBe(true);
      expect(registry.size).toBe(1);
    });

    it("replaces an existing notifier when the same name is registered again", () => {
      const registry = new NotifierRegistry();
      const first = makeNotifier("slack", ["goal_complete"]);
      const second = makeNotifier("slack", ["stall_detected"]);

      registry.register("slack", first);
      registry.register("slack", second);

      expect(registry.size).toBe(1);
      // The second one should be the active one
      const found = registry.findForEvent("stall_detected");
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(second);
    });

    it("tracks multiple different notifiers", () => {
      const registry = new NotifierRegistry();
      registry.register("slack", makeNotifier("slack", ["goal_complete"]));
      registry.register("email", makeNotifier("email", ["goal_complete"]));
      registry.register("discord", makeNotifier("discord", ["stall_detected"]));

      expect(registry.size).toBe(3);
      expect(registry.names().sort()).toEqual(["discord", "email", "slack"]);
    });
  });

  describe("findForEvent", () => {
    it("returns empty array when no notifiers are registered", () => {
      const registry = new NotifierRegistry();
      expect(registry.findForEvent("goal_complete")).toEqual([]);
    });

    it("returns empty array when no notifiers support the event type", () => {
      const registry = new NotifierRegistry();
      registry.register("slack", makeNotifier("slack", ["goal_progress"]));

      expect(registry.findForEvent("approval_needed")).toEqual([]);
    });

    it("returns the single matching notifier", () => {
      const registry = new NotifierRegistry();
      const slackNotifier = makeNotifier("slack", ["goal_complete", "approval_needed"]);
      registry.register("slack", slackNotifier);

      const found = registry.findForEvent("goal_complete");
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(slackNotifier);
    });

    it("returns multiple notifiers that all support the same event type", () => {
      const registry = new NotifierRegistry();
      const slack = makeNotifier("slack", ["goal_complete", "stall_detected"]);
      const email = makeNotifier("email", ["goal_complete"]);
      const discord = makeNotifier("discord", ["approval_needed"]);

      registry.register("slack", slack);
      registry.register("email", email);
      registry.register("discord", discord);

      const found = registry.findForEvent("goal_complete");
      expect(found).toHaveLength(2);
      expect(found).toContain(slack);
      expect(found).toContain(email);
    });

    it("returns notifiers for each supported event type independently", () => {
      const registry = new NotifierRegistry();
      const allEvents: INotifier = makeNotifier("all", [
        "goal_progress",
        "goal_complete",
        "task_blocked",
        "approval_needed",
        "stall_detected",
        "trust_change",
      ]);
      registry.register("all", allEvents);

      const eventTypes: NotificationEventType[] = [
        "goal_progress",
        "goal_complete",
        "task_blocked",
        "approval_needed",
        "stall_detected",
        "trust_change",
      ];
      for (const eventType of eventTypes) {
        expect(registry.findForEvent(eventType)).toHaveLength(1);
      }
    });

    it("found notifiers are callable (notify resolves)", async () => {
      const registry = new NotifierRegistry();
      const notifier = makeNotifier("slack", ["goal_complete"]);
      registry.register("slack", notifier);

      const event = makeEvent("goal_complete");
      const found = registry.findForEvent("goal_complete");
      await found[0].notify(event);

      expect(notifier.notify).toHaveBeenCalledWith(event);
    });
  });

  describe("names", () => {
    it("returns empty array when nothing is registered", () => {
      const registry = new NotifierRegistry();
      expect(registry.names()).toEqual([]);
    });

    it("returns all registered names", () => {
      const registry = new NotifierRegistry();
      registry.register("a", makeNotifier("a", []));
      registry.register("b", makeNotifier("b", []));

      expect(registry.names().sort()).toEqual(["a", "b"]);
    });
  });
});
