import type { INotifier, NotificationEvent, NotificationEventType } from "./types.js";
import { loadConfig, type WhatsAppWebhookConfig } from "./config.js";
import { WhatsAppCloudClient } from "./whatsapp-client.js";
import { WhatsAppWebhookServer } from "./webhook-server.js";

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

export class WhatsAppWebhookPlugin implements INotifier {
  readonly name = "whatsapp-webhook";

  private config: WhatsAppWebhookConfig | null = null;
  private client: WhatsAppCloudClient | null = null;
  private server: WhatsAppWebhookServer | null = null;

  constructor(private readonly pluginDir: string) {}

  async init(): Promise<void> {
    this.config = loadConfig(this.pluginDir);
    this.client = new WhatsAppCloudClient(this.config.phone_number_id, this.config.access_token);
    this.server = new WhatsAppWebhookServer(this.config, this.client);
    await this.server.start();
  }

  supports(eventType: NotificationEventType): boolean {
    return SUPPORTED_EVENTS.includes(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (this.config === null || this.client === null) {
      throw new Error("whatsapp-webhook: plugin not initialized");
    }

    await this.client.sendTextMessage({
      to: this.config.recipient_id,
      body: formatNotification(event),
    });
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }
}

export default WhatsAppWebhookPlugin;
