import * as p from "@clack/prompts";
import type { NotificationConfig } from "../../../../base/types/notification.js";
import { guardCancel } from "./utils.js";

export function validateUrl(url: string | undefined): string | undefined {
  if (!url) return "URL is required.";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "URL must start with http:// or https://";
  }

  try {
    new URL(url);
    return undefined;
  } catch {
    return "Enter a valid URL.";
  }
}

export async function stepNotification(): Promise<NotificationConfig | null> {
  const enableNotifications = guardCancel(
    await p.confirm({
      message: "Configure notifications now?",
      initialValue: false,
    })
  );

  if (!enableNotifications) {
    return null;
  }

  const webhookUrl = guardCancel(
    await p.text({
      message: "Enter a notification webhook URL:",
      placeholder: "https://example.com/webhook",
      validate: validateUrl,
    })
  );

  return {
    channels: [
      {
        type: "webhook",
        url: webhookUrl,
        report_types: [],
        format: "json",
      },
    ],
    do_not_disturb: {
      enabled: false,
      start_hour: 22,
      end_hour: 7,
      exceptions: ["urgent_alert", "approval_request"],
    },
    cooldown: {
      urgent_alert: 0,
      approval_request: 0,
      stall_escalation: 60,
      strategy_change: 30,
      goal_completion: 0,
      capability_escalation: 60,
    },
    goal_overrides: [],
    batching: {
      enabled: false,
      window_minutes: 30,
      digest_format: "compact",
    },
  };
}
