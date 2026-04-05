// ─── Settings Overlay ───
//
// Interactive settings panel for configuring PulSeed from within TUI.
// Changes are saved to ~/.pulseed/config.json and take effect on next restart.

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { loadGlobalConfig, updateGlobalConfig } from "../../base/config/global-config.js";
import type { GlobalConfig } from "../../base/config/global-config.js";

interface SettingsOverlayProps {
  onClose: () => void;
}

interface SettingItem {
  key: keyof GlobalConfig;
  label: string;
  description: string;
  type: "boolean";
}

const SETTINGS: SettingItem[] = [
  {
    key: "daemon_mode",
    label: "Daemon Mode",
    description: "Run CoreLoop as background daemon. TUI becomes a client that can disconnect without stopping the loop.",
    type: "boolean",
  },
  {
    key: "no_flicker",
    label: "No-Flicker Mode",
    description: "Use alt-screen + synchronized output for flicker-free TUI. Takes effect on next launch.",
    type: "boolean",
  },
];

export function SettingsOverlay({ onClose }: SettingsOverlayProps): React.ReactElement {
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadGlobalConfig().then(setConfig);
  }, []);

  const toggleSetting = useCallback(async () => {
    if (!config) return;
    const setting = SETTINGS[selectedIndex];
    if (setting.type === "boolean") {
      const newValue = !config[setting.key];
      const updated = await updateGlobalConfig({ [setting.key]: newValue });
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, [config, selectedIndex]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (key.downArrow && selectedIndex < SETTINGS.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }
    if (key.return || input === " ") {
      toggleSetting();
    }
  });

  if (!config) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading settings...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="green">Settings</Text>
        <Text color="gray">  (up/down navigate, Enter/Space toggle, Esc close)</Text>
      </Box>

      {SETTINGS.map((setting, i) => {
        const isSelected = i === selectedIndex;
        const value = config[setting.key];
        const displayValue = typeof value === "boolean"
          ? (value ? "ON" : "OFF")
          : String(value);
        const valueColor = typeof value === "boolean"
          ? (value ? "green" : "gray")
          : "yellow";

        return (
          <Box key={setting.key} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={isSelected ? "cyan" : "white"}>
                {isSelected ? "> " : "  "}
              </Text>
              <Text bold={isSelected}>{setting.label}</Text>
              <Text>  </Text>
              <Text color={valueColor} bold>[{displayValue}]</Text>
            </Box>
            {isSelected && (
              <Box marginLeft={4}>
                <Text color="gray" dimColor>{setting.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {saved && (
        <Box marginTop={1}>
          <Text color="green">Saved. Changes take effect on next restart.</Text>
        </Box>
      )}

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray" dimColor>Config file: ~/.pulseed/config.json</Text>
      </Box>
    </Box>
  );
}
