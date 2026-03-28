// ─── PagerDutyNotifier ───
//
// A PulSeed notifier plugin that sends events to PagerDuty via Events API v2.
// Uses native fetch — no external dependencies required.

import type {
  INotifier,
  NotificationEvent,
  NotificationEventType,
} from "../../../../src/types/plugin.js";

// ─── Supported events (must match plugin.yaml) ───

const SUPPORTED_EVENTS: NotificationEventType[] = [
  "goal_complete",
  "task_blocked",
  "approval_needed",
  "stall_detected",
  "trust_change",
];

// ─── PagerDuty severity mapping ───

const SEVERITY_MAP: Record<NotificationEvent["severity"], string> = {
  info: "info",
  warning: "warning",
  critical: "critical",
};

// ─── Config ───

export interface PagerDutyNotifierConfig {
  routing_key: string;
  source?: string;
  component?: string;
}

// ─── PagerDutyNotifier implementation ───

export class PagerDutyNotifier implements INotifier {
  readonly name = "pagerduty-notifier";

  private config: PagerDutyNotifierConfig;

  constructor(config: PagerDutyNotifierConfig) {
    if (!config.routing_key) {
      throw new Error("pagerduty-notifier: routing_key is required");
    }
    this.config = config;
  }

  supports(eventType: NotificationEventType): boolean {
    return SUPPORTED_EVENTS.includes(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    const payload = {
      routing_key: this.config.routing_key,
      event_action: "trigger",
      payload: {
        summary: event.summary,
        source: this.config.source ?? "pulseed",
        severity: SEVERITY_MAP[event.severity],
        timestamp: event.timestamp,
        component: this.config.component,
        custom_details: {
          goal_id: event.goal_id,
          event_type: event.type,
          ...event.details,
        },
      },
    };

    const response = await fetch(
      "https://events.pagerduty.com/v2/enqueue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `pagerduty-notifier: API returned ${response.status}: ${body}`
      );
    }
  }
}

// ─── Default export (required by PluginLoader) ───

const _routingKey = process.env["PAGERDUTY_ROUTING_KEY"];

export default _routingKey
  ? new PagerDutyNotifier({
      routing_key: _routingKey,
      source: process.env["PAGERDUTY_SOURCE"],
      component: process.env["PAGERDUTY_COMPONENT"],
    })
  : null;
