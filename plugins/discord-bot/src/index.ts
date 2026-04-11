import type { INotifier, NotificationEvent, NotificationEventType } from "./types.js";
import { loadConfig, type DiscordBotConfig } from "./config.js";
import { DiscordAPI } from "./discord-api.js";
import { DiscordWebhookServer } from "./webhook-server.js";

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

export class DiscordBotPlugin implements INotifier {
  readonly name = "discord-bot";

  private config: DiscordBotConfig | null = null;
  private api: DiscordAPI | null = null;
  private server: DiscordWebhookServer | null = null;

  constructor(private readonly pluginDir: string) {}

  async init(): Promise<void> {
    this.config = loadConfig(this.pluginDir);
    this.api = new DiscordAPI(this.config.bot_token);
    this.server = new DiscordWebhookServer(this.config, this.api);
    await this.server.start();
  }

  supports(eventType: NotificationEventType): boolean {
    return SUPPORTED_EVENTS.includes(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (this.config === null || this.api === null) {
      throw new Error("discord-bot: plugin not initialized");
    }
    await this.api.sendChannelMessage(this.config.channel_id, formatNotification(event));
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
  }
}

export default DiscordBotPlugin;
