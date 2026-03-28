// ─── ReportView ───
//
// Renders a PulSeed Report object in a formatted, readable way inside the TUI.
// Handles all 3 primary report types (execution_summary, daily_summary,
// weekly_report) with type-specific headers, plus a generic fallback for
// notification types (urgent_alert, approval_request, stall_escalation, etc.).

import React from "react";
import { Box, Text } from "ink";
import { renderMarkdownLines } from "./markdown-renderer.js";
import type { Report } from "../types/report.js";

// ─── Per-type header color ───

function reportColor(reportType: Report["report_type"]): string {
  switch (reportType) {
    case "execution_summary":
      return "cyan";
    case "daily_summary":
      return "blue";
    case "weekly_report":
      return "magenta";
    case "urgent_alert":
      return "red";
    case "approval_request":
      return "yellow";
    case "stall_escalation":
      return "red";
    case "goal_completion":
      return "green";
    case "capability_escalation":
      return "yellow";
    case "strategy_change":
      return "cyan";
    default:
      return "white";
  }
}

function reportIcon(reportType: Report["report_type"]): string {
  switch (reportType) {
    case "execution_summary":
      return "[ LOOP ]";
    case "daily_summary":
      return "[ DAILY ]";
    case "weekly_report":
      return "[ WEEKLY ]";
    case "urgent_alert":
      return "[ URGENT ]";
    case "approval_request":
      return "[ APPROVAL ]";
    case "stall_escalation":
      return "[ STALL ]";
    case "goal_completion":
      return "[ DONE ]";
    case "capability_escalation":
      return "[ CAPABILITY ]";
    case "strategy_change":
      return "[ STRATEGY ]";
    default:
      return "[ REPORT ]";
  }
}

// ─── ReportView ───

export interface ReportViewProps {
  report: Report;
}

export function ReportView({ report }: ReportViewProps) {
  const color = reportColor(report.report_type);
  const icon = reportIcon(report.report_type);
  const mdLines = renderMarkdownLines(report.content);

  // Format generated_at as a readable timestamp
  const generatedAt = report.generated_at
    ? new Date(report.generated_at).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      {/* Header row */}
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {icon} {report.title}
        </Text>
        {generatedAt !== "" && (
          <Text dimColor>{generatedAt}</Text>
        )}
      </Box>

      {/* Goal ID row (when present) */}
      {report.goal_id !== null && (
        <Text dimColor>goal: {report.goal_id}</Text>
      )}

      {/* Separator */}
      <Text dimColor>{"─".repeat(40)}</Text>

      {/* Report content rendered as markdown */}
      <Box flexDirection="column">
        {mdLines.map((line, i) => {
          if (line.text === "") {
            return <Text key={i}> </Text>;
          }
          const props: Record<string, unknown> = {};
          if (line.bold) props.bold = true;
          if (line.dim) props.dimColor = true;
          return (
            <Text key={i} {...props}>
              {line.text}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
