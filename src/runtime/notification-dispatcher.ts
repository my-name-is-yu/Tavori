import type { Logger } from "./logger.js";
import type { Report } from "../base/types/report.js";
import type {
  NotificationChannel,
  NotificationConfig,
  NotificationResult,
  SlackChannel,
  EmailChannel,
  WebhookChannel,
} from "../base/types/notification.js";
import { NotificationConfigSchema } from "../base/types/notification.js";
import type { NotificationEvent, NotificationEventType } from "../base/types/plugin.js";
import type { NotifierRegistry } from "./notifier-registry.js";
import { sendSlack } from "./channels/slack-channel.js";
import { sendEmail } from "./channels/email-channel.js";
import { sendWebhook } from "./channels/webhook-channel.js";
import { NotificationBatcher } from "./notification-batcher.js";

// ─── Interface ───

export interface INotificationDispatcher {
  dispatch(report: Report): Promise<NotificationResult[]>;
}

// ─── Report type → NotificationEventType mapping ───

/**
 * Map an internal report_type string to the closest NotificationEventType
 * for routing to INotifier plugins. Returns null when no mapping applies.
 */
function reportTypeToEventType(reportType: string): NotificationEventType | null {
  switch (reportType) {
    case "goal_completion":
      return "goal_complete";
    case "approval_request":
      return "approval_needed";
    case "urgent_alert":
      return "approval_needed";
    case "stall_escalation":
      return "stall_detected";
    case "strategy_change":
      return "goal_progress";
    case "capability_escalation":
      return "task_blocked";
    case "progress_update":
      return "goal_progress";
    case "daily_summary":
      return "goal_progress";
    case "weekly_report":
      return "goal_progress";
    case "execution_summary":
      return "goal_progress";
    case "schedule_change":
      return "schedule_change_detected";
    case "schedule_heartbeat_failure":
      return "schedule_heartbeat_failure";
    case "schedule_escalation":
      return "schedule_escalation";
    case "schedule_report":
      return "schedule_report_ready";
    default:
      return null;
  }
}

// ─── NotificationDispatcher ───

export class NotificationDispatcher implements INotificationDispatcher {
  private config: NotificationConfig;
  /** reportType -> timestamp of last successful send */
  private lastSent: Map<string, number> = new Map();
  private notifierRegistry?: NotifierRegistry;
  private readonly logger?: Logger;
  private batcher?: NotificationBatcher;
  private realtimeSink?: (report: Report) => void | Promise<void>;

  constructor(config?: Partial<NotificationConfig>, notifierRegistry?: NotifierRegistry, logger?: Logger) {
    this.config = NotificationConfigSchema.parse(config ?? {});
    this.notifierRegistry = notifierRegistry;
    this.logger = logger;

    if (this.config.batching.enabled) {
      this.batcher = new NotificationBatcher(
        {
          window_minutes: this.config.batching.window_minutes,
          digest_format: this.config.batching.digest_format,
        },
        async (digest) => { await this.sendReport(digest); }
      );
    }
  }

  /** Flush batcher and stop the timer. Call on shutdown. */
  async stop(): Promise<void> {
    await this.batcher?.stop();
  }

  setRealtimeSink(sink: ((report: Report) => void | Promise<void>) | undefined): void {
    this.realtimeSink = sink;
  }

  /** Dispatch report to all configured channels */
  async dispatch(report: Report): Promise<NotificationResult[]> {
    // If batching is enabled, non-immediate reports go to the batcher
    if (this.batcher) {
      const batched = this.batcher.add(report);
      if (batched) return [];
    }

    return this.sendReport(report);
  }

  /** Send a report directly to all channels (bypasses batching). */
  private async sendReport(report: Report): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];

    const channels = this.getChannelsForReport(report);

    for (const channel of channels) {
      // Check DND
      if (this.isDND(report.report_type)) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "dnd",
        });
        continue;
      }

      // Check cooldown
      if (this.isCooldown(report.report_type)) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "cooldown",
        });
        continue;
      }

      // Check if this channel accepts this report type
      if (!this.channelAcceptsReportType(channel, report.report_type)) {
        results.push({
          channel_type: channel.type,
          success: false,
          suppressed: true,
          suppression_reason: "filtered",
        });
        continue;
      }

      // Send
      const result = await this.sendToChannel(channel, report);
      results.push(result);

      if (result.success) {
        this.lastSent.set(report.report_type, Date.now());
      }
    }

    // Route to NotifierRegistry plugins (additive, failures don't affect core dispatch)
    await this.dispatchToPluginNotifiers(report);

    if (this.realtimeSink) {
      try {
        await this.realtimeSink(report);
      } catch (err) {
        this.logger?.warn?.(`[NotificationDispatcher] realtime sink failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return results;
  }

  /**
   * Route the report to all matching INotifier plugins registered in the
   * NotifierRegistry. Plugin failures are logged but never propagated.
   */
  private async dispatchToPluginNotifiers(report: Report): Promise<void> {
    if (!this.notifierRegistry) return;
    if (this.isDND(report.report_type) || this.isCooldown(report.report_type)) return;

    const eventType = reportTypeToEventType(report.report_type);
    if (eventType === null) return;

    const notifiers = this.notifierRegistry
      .findForEvent(eventType)
      .filter((notifier) => this.pluginNotifierAcceptsReportType(notifier.name, report.report_type));
    if (notifiers.length === 0) return;

    const event: NotificationEvent = {
      type: eventType,
      goal_id: report.goal_id ?? "",
      timestamp: report.generated_at,
      summary: report.title,
      details: {
        report_id: report.id,
        report_type: report.report_type,
        content: report.content,
        verbosity: report.verbosity,
      },
      severity: this.resolveSeverity(report.report_type),
    };

    const settlements = await Promise.allSettled(
      notifiers.map((n) => n.notify(event))
    );

    let delivered = false;
    for (let i = 0; i < settlements.length; i++) {
      const result = settlements[i];
      if (result.status === "rejected") {
        const notifierName = notifiers[i].name;
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger?.error(`[NotificationDispatcher] plugin notifier "${notifierName}" failed: ${reason}`);
      } else {
        delivered = true;
      }
    }
    if (delivered) {
      this.lastSent.set(report.report_type, Date.now());
    }
  }

  /** Derive a severity level from the report type. */
  private resolveSeverity(reportType: string): "info" | "warning" | "critical" {
    if (reportType === "urgent_alert") return "critical";
    if (reportType === "stall_escalation" || reportType === "capability_escalation") return "warning";
    return "info";
  }

  // ─── Private helpers ───

  /**
   * Return the channels applicable to this report. Per-goal overrides take
   * priority over the global channel list.
   */
  private getChannelsForReport(report: Report): NotificationChannel[] {
    if (report.goal_id) {
      const override = this.config.goal_overrides.find(
        (o) => o.goal_id === report.goal_id
      );
      if (override?.channels && override.channels.length > 0) {
        return override.channels;
      }
    }
    return this.config.channels;
  }

  private getCooldownMinutes(reportType: string): number {
    const cooldown = this.config.cooldown as Record<string, number>;
    return cooldown[reportType] ?? 0;
  }

  /** Check if currently in DND hours for the given report type. */
  private isDND(reportType: string): boolean {
    const dnd = this.config.do_not_disturb;
    if (!dnd.enabled) return false;

    // Exceptions bypass DND (urgent_alert, approval_request by default)
    if (dnd.exceptions.includes(reportType)) return false;

    const now = new Date();
    const hour = now.getHours();

    // Handle overnight DND (e.g., 22:00–07:00)
    if (dnd.start_hour > dnd.end_hour) {
      return hour >= dnd.start_hour || hour < dnd.end_hour;
    }
    return hour >= dnd.start_hour && hour < dnd.end_hour;
  }

  /** Check cooldown: true if we should suppress due to recent send. */
  private isCooldown(reportType: string): boolean {
    const cooldownMinutes = this.getCooldownMinutes(reportType);
    if (cooldownMinutes <= 0) return false;

    const lastSent = this.lastSent.get(reportType);
    if (lastSent === undefined) return false;

    const elapsedMs = Date.now() - lastSent;
    return elapsedMs < cooldownMinutes * 60 * 1000;
  }

  /**
   * Return true if the channel should receive this report type.
   * An empty report_types array means "accept all."
   */
  private channelAcceptsReportType(
    channel: NotificationChannel,
    reportType: string
  ): boolean {
    if (channel.report_types.length === 0) return true;
    return channel.report_types.includes(reportType);
  }

  /**
   * Decide whether a registered INotifier should receive this report.
   * mode=all keeps existing behavior unless a per-notifier route disables or narrows it.
   * mode=only sends only to explicitly listed enabled routes.
   * mode=none disables plugin notifier delivery while legacy channels still work.
   */
  private pluginNotifierAcceptsReportType(notifierName: string, reportType: string): boolean {
    const routing = this.config.plugin_notifiers;
    if (routing.mode === "none") {
      return false;
    }

    const route = routing.routes.find((candidate) => candidate.id === notifierName);
    if (routing.mode === "only" && route === undefined) {
      return false;
    }
    if (route?.enabled === false) {
      return false;
    }
    if (route && route.report_types.length > 0) {
      return route.report_types.includes(reportType);
    }
    return true;
  }

  /** Dispatch to the correct sender based on channel type. */
  private async sendToChannel(
    channel: NotificationChannel,
    report: Report
  ): Promise<NotificationResult> {
    switch (channel.type) {
      case "slack":
        return sendSlack(channel as SlackChannel, report);
      case "email":
        return sendEmail(channel as EmailChannel, report);
      case "webhook":
        return sendWebhook(channel as WebhookChannel, report);
    }
  }
}
