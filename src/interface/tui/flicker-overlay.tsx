// ─── FlickerOverlay ───
//
// Interactive rendering mode selector, shown by /flicker command.
// Inspired by Claude Code's /theme selector.

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { loadGlobalConfig, updateGlobalConfig } from "../../base/config/global-config.js";
import { theme } from "./theme.js";

interface FlickerOverlayProps {
  onClose: () => void;
}

interface FlickerOption {
  label: string;
  description: string;
  value: boolean; // no_flicker config value
}

const OPTIONS: FlickerOption[] = [
  {
    label: "Off",
    description: "Standard Ink rendering",
    value: false,
  },
  {
    label: "On",
    description: "Alt-screen + synchronized output (DEC 2026)",
    value: true,
  },
];

export function FlickerOverlay({ onClose }: FlickerOverlayProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeValue, setActiveValue] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);

  // Load current config on mount
  useEffect(() => {
    loadGlobalConfig().then((config) => {
      setActiveValue(config.no_flicker);
      // Pre-select current value
      const idx = OPTIONS.findIndex((o) => o.value === config.no_flicker);
      if (idx >= 0) setSelectedIndex(idx);
    });
  }, []);

  const handleSelect = useCallback(async () => {
    const option = OPTIONS[selectedIndex];
    await updateGlobalConfig({ no_flicker: option.value });
    setActiveValue(option.value);
    setSaved(true);
    setTimeout(() => onClose(), 800);
  }, [selectedIndex, onClose]);

  useInput((input, key) => {
    if (saved) return; // ignore input during save animation

    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      handleSelect();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => Math.min(OPTIONS.length - 1, prev + 1));
    }
    // Number keys for direct jump
    const num = parseInt(input, 10);
    if (num >= 1 && num <= OPTIONS.length) {
      setSelectedIndex(num - 1);
    }
  });

  const cols = process.stdout.columns || 60;
  const separator = "─".repeat(Math.min(cols, 50) - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.overlayBorder}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={theme.brand}>
        No-Flicker Mode
      </Text>
      <Box marginTop={1}>
        <Text bold>Choose your rendering mode</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((option, i) => {
          const isSelected = i === selectedIndex;
          const isActive = option.value === activeValue;
          return (
            <Box key={i}>
              <Text color={isSelected ? theme.brand : undefined}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text color={isSelected ? theme.brand : undefined}>
                {i + 1}. {option.label}
              </Text>
              <Text dimColor> — {option.description}</Text>
              {isActive && <Text color={theme.success}> ✓</Text>}
            </Box>
          );
        })}
      </Box>

      <Text dimColor>{separator}</Text>

      {saved ? (
        <Box marginTop={1}>
          <Text color={theme.success} bold>Saved! Takes effect on next launch.</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>Enter to select · Esc to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
