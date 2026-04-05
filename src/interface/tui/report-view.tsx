// ─── ReportView ───
//
// Renders a PulSeed Report object in a formatted, readable way inside the TUI.
// Handles all 3 primary report types (execution_summary, daily_summary,
// weekly_report) with type-specific headers, plus a generic fallback for
// notification types (urgent_alert, approval_request, stall_escalation, etc.).

import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { renderMarkdownLines } from "./markdown-renderer.js";
import type { Report } from "../../base/types/report.js";
import { reportColor } from "./theme.js";

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
  onDismiss: () => void;
}

export function ReportView({ report, onDismiss }: ReportViewProps) {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const [scrollOffset, setScrollOffset] = useState(0);

  const color = reportColor(report.report_type);
  const icon = reportIcon(report.report_type);
  const mdLines = renderMarkdownLines(report.content);

  const generatedAt = report.generated_at
    ? new Date(report.generated_at).toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

  // Reserve rows: 1 header box border top + 1 header row + 1 goal row + 1 separator + 2 border bottom/footer + 1 footer hint
  const reservedRows = 7;
  const visibleLines = Math.max(1, termRows - reservedRows);
  const maxScroll = Math.max(0, mdLines.length - visibleLines);
  const clampedOffset = Math.min(scrollOffset, maxScroll);
  const visibleMdLines = mdLines.slice(clampedOffset, clampedOffset + visibleLines);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onDismiss();
      return;
    }
    if (key.upArrow || input === "k") {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {icon} {report.title}
        </Text>
        {generatedAt !== "" && (
          <Text dimColor>{generatedAt}</Text>
        )}
      </Box>

      {report.goal_id !== null && (
        <Text dimColor>goal: {report.goal_id}</Text>
      )}

      <Text dimColor>{"─".repeat(40)}</Text>

      <Box flexDirection="column">
        {visibleMdLines.map((line, i) => {
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

      <Text dimColor>{"─".repeat(40)}</Text>
      <Text dimColor>↑↓ scroll • q/Esc to close</Text>
    </Box>
  );
}
