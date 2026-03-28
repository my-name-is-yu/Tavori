// ─── HelpOverlay ───
//
// Dismissible help panel with structured, visually polished layout.
// Organized into COMMANDS and KEYBOARD SHORTCUTS sections.
// Listens for the Escape key via Ink's useInput and calls onDismiss.

import React from "react";
import { Box, Text, useInput } from "ink";

interface HelpOverlayProps {
  onDismiss: () => void;
}

export function HelpOverlay({ onDismiss }: HelpOverlayProps) {
  useInput((_input, key) => {
    if (key.escape) onDismiss();
  });

  const cols = process.stdout.columns || 60;
  const separator = "─".repeat(Math.min(cols, 60) - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="center">
        <Text bold color="yellow">
          HELP
        </Text>
      </Box>
      <Text dimColor>{separator}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color="yellow">
          COMMANDS
        </Text>
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Box width={20}><Text color="green" bold>/run or /start</Text></Box>
            <Text>Start the goal loop</Text>
          </Box>
          <Box>
            <Box width={20}><Text color="green" bold>/stop or /quit</Text></Box>
            <Text>Stop the running loop</Text>
          </Box>
          <Box>
            <Box width={20}><Text color="green" bold>/status</Text></Box>
            <Text>Show current progress</Text>
          </Box>
          <Box>
            <Box width={20}><Text color="green" bold>/report</Text></Box>
            <Text>Generate a summary report</Text>
          </Box>
          <Box>
            <Box width={20}><Text color="green" bold>/goals</Text></Box>
            <Text>List all goals</Text>
          </Box>
          <Box>
            <Box width={20}><Text color="green" bold>/help or ?</Text></Box>
            <Text>Show this help</Text>
          </Box>
          <Box>
            <Box width={20}><Text dimColor>{"<anything else>"}</Text></Box>
            <Text>Chat with PulSeed</Text>
          </Box>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color="yellow">
          KEYBOARD SHORTCUTS
        </Text>
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Box width={20}><Text color="cyan" bold>ESC</Text></Box>
            <Text>Close this overlay</Text>
          </Box>
          <Box>
            <Box width={20}><Text color="cyan" bold>Ctrl-C</Text></Box>
            <Text>Quit PulSeed</Text>
          </Box>
        </Box>
      </Box>

      <Text dimColor>{separator}</Text>
      <Text dimColor>Type naturally to create goals or ask questions.</Text>
      <Text dimColor>Press ESC to close</Text>
    </Box>
  );
}
