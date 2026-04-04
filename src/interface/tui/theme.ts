// ─── Theme ───
//
// Centralized brand color palette and semantic theme for all TUI components.
// Based on docs/design/personality/brand.md hex values.
// seedy-art.ts already uses hex directly and is excluded from this system.

import type { Report } from "../base/types/report.js";

// ─── Semantic theme object ───

export const theme = {
  // Brand
  brand: "#4CAF50",
  brandLight: "#A5D6A7",
  header: "#4CAF50",

  // Text
  text: "#E6EDF3",
  textDim: "#30363D",
  border: "#30363D",

  // Status colors
  success: "#4CAF50",
  warning: "#FFB74D",
  error: "#EF5350",
  info: "#42A5F5",

  // Chat / input
  userPrompt: "#4CAF50",
  userPrefix: "#A5D6A7",
  command: "#4CAF50",

  // Labels and navigation
  shortcut: "#A5D6A7",
  label: "#A5D6A7",
  selected: "#42A5F5",

  // Overlays
  overlayBorder: "#FFB74D",
  overlayHeader: "#FFB74D",

  // Code syntax highlighting
  codeInline: "#A5D6A7",
  codeKeyword: "#42A5F5",
  codeString: "#4CAF50",
  codeNumber: "#FFB74D",
  codeComment: "#30363D",
} as const;

// ─── Color helper functions (moved from TUI components) ───

/**
 * Returns the hex color for a given loop status string.
 * Previously: statusColor() in dashboard.tsx
 */
export function statusColor(status: string): string {
  switch (status) {
    case "running":
      return theme.success;
    case "completed":
      return theme.label;
    case "stalled":
    case "error":
      return theme.error;
    case "stopped":
      return theme.warning;
    default:
      return theme.text;
  }
}

/**
 * Returns the hex color for a progress percentage value.
 * Previously: progressColor() in dashboard.tsx
 */
export function progressColor(progress: number): string {
  if (progress >= 80) return theme.success;
  if (progress >= 40) return theme.warning;
  return theme.error;
}

/**
 * Returns the hex color for a given report type.
 * Previously: reportColor() in report-view.tsx
 */
export function reportColor(reportType: Report["report_type"]): string {
  switch (reportType) {
    case "execution_summary":
      return theme.label;
    case "daily_summary":
      return theme.info;
    case "weekly_report":
      return theme.brand;
    case "urgent_alert":
      return theme.error;
    case "approval_request":
      return theme.warning;
    case "stall_escalation":
      return theme.error;
    case "goal_completion":
      return theme.success;
    case "capability_escalation":
      return theme.warning;
    case "strategy_change":
      return theme.label;
    default:
      return theme.text;
  }
}

/**
 * Returns the hex color for a chat message type.
 * Previously: getMessageTypeColor() in chat.tsx
 */
export function getMessageTypeColor(
  messageType: "info" | "error" | "warning" | "success" | undefined
): string | undefined {
  switch (messageType) {
    case "error":
      return theme.error;
    case "warning":
      return theme.warning;
    case "success":
      return theme.success;
    case "info":
      return theme.info;
    default:
      return undefined;
  }
}
