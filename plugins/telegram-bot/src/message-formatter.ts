// ─── Local compatible interface (mirrors pulseed NotificationEvent) ───

export interface NotificationEvent {
  type: string;
  goal_id: string;
  timestamp: string;
  summary: string;
  details: Record<string, unknown>;
  severity: "info" | "warning" | "critical" | "success";
}

// ─── Severity emoji mapping ───

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  warning: "🚨",
  info: "ℹ️",
  success: "✅",
};

// ─── formatNotification ───

export function formatNotification(event: NotificationEvent): string {
  const emoji = SEVERITY_EMOJI[event.severity] ?? "ℹ️";
  const lines: string[] = [
    `${emoji} *${event.type}*`,
    `Goal: ${event.goal_id}`,
    event.summary,
  ];

  const hasDetails =
    event.details !== undefined &&
    event.details !== null &&
    Object.keys(event.details).length > 0;

  if (hasDetails) {
    const detailLines = Object.entries(event.details)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n");
    lines.push(detailLines);
  }

  return lines.join("\n");
}
