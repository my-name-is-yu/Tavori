import type { INotifier, NotificationEvent, NotificationEventType } from "./types.js";
import { loadConfig, type SignalBridgeConfig } from "./config.js";
import { SignalBridgeClient } from "./signal-client.js";
import { SignalBridgePoller } from "./poller.js";

const SUPPORTED_EVENTS: NotificationEventType[] = [
  "goal_progress",
  "goal_complete",
  "task_blocked",
  "approval_needed",
  "stall_detected",
  "trust_change",
  "schedule_change_detected",
  "schedule_heartbeat_failure",
  "schedule_escalation",
  "schedule_report_ready",
];

function formatNotification(event: NotificationEvent): string {
  const detailKeys = Object.keys(event.details);
  const detailSuffix = detailKeys.length > 0 ? ` | details: ${detailKeys.join(",")}` : "";
  const content = typeof event.details["content"] === "string" ? `\n\n${event.details["content"]}` : "";
  return `[${event.severity}] ${event.summary} (goal ${event.goal_id})${detailSuffix}${content}`;
}

export class SignalBridgePlugin implements INotifier {
  readonly name = "signal-bridge";

  private config: SignalBridgeConfig | null = null;
  private client: SignalBridgeClient | null = null;
  private poller: SignalBridgePoller | null = null;

  constructor(private readonly pluginDir: string) {}

  async init(): Promise<void> {
    this.config = loadConfig(this.pluginDir);
    this.client = new SignalBridgeClient(this.config.bridge_url, this.config.account);
    this.poller = new SignalBridgePoller(this.config, this.client);
    this.poller.start();
  }

  supports(eventType: NotificationEventType): boolean {
    return SUPPORTED_EVENTS.includes(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (this.config === null || this.client === null) {
      throw new Error("signal-bridge: plugin not initialized");
    }

    await this.client.sendTextMessage({
      recipient: this.config.recipient_id,
      body: formatNotification(event),
    });
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
  }
}

export default SignalBridgePlugin;
