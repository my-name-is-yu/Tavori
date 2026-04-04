// ─── ApprovalOverlay ───
//
// Dismissible approval panel that asks the user to approve or reject a task.
// Displayed when CoreLoop calls approvalFn(task) during the task lifecycle.
// useInput listens for 'y' (approve) and 'n' / Escape (reject).

import React from "react";
import { Box, Text, useInput } from "ink";
import type { Task } from "../base/types/task.js";
import { theme } from "./theme.js";

interface ApprovalOverlayProps {
  task: Task;
  onDecision: (approved: boolean) => void;
}

export function ApprovalOverlay({ task, onDecision }: ApprovalOverlayProps) {
  useInput((_input, key) => {
    if (_input.toLowerCase() === "y") {
      onDecision(true);
    } else if (_input.toLowerCase() === "n" || key.escape) {
      onDecision(false);
    }
  });

  const cols = process.stdout.columns || 60;
  const separator = "─".repeat(Math.min(cols, 60) - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.overlayBorder}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="center">
        <Text bold color={theme.overlayHeader}>
          TASK APPROVAL REQUIRED
        </Text>
      </Box>
      <Text dimColor>{separator}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Box width={14}>
            <Text bold color={theme.label}>Task:</Text>
          </Box>
          <Text wrap="wrap">{task.work_description}</Text>
        </Box>

        <Box marginTop={1}>
          <Box width={14}>
            <Text bold color={theme.label}>Rationale:</Text>
          </Box>
          <Text wrap="wrap">{task.rationale}</Text>
        </Box>

        <Box marginTop={1}>
          <Box width={14}>
            <Text bold color={theme.label}>Reversibility:</Text>
          </Box>
          <Text
            color={
              task.reversibility === "irreversible"
                ? theme.error
                : task.reversibility === "reversible"
                ? theme.success
                : theme.warning
            }
          >
            {task.reversibility}
          </Text>
        </Box>
      </Box>

      <Text dimColor>{separator}</Text>

      <Box justifyContent="center" marginTop={1}>
        <Text bold>Approve this task? </Text>
        <Text bold color={theme.success}>[y]</Text>
        <Text bold> / </Text>
        <Text bold color={theme.error}>[N]</Text>
        <Text bold> / </Text>
        <Text dimColor>ESC to reject</Text>
      </Box>
    </Box>
  );
}
