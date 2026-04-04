import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { LoopState, DimensionProgress } from "./use-loop.js";
import { theme, statusColor, progressColor } from "./theme.js";

interface DashboardProps {
  state: LoopState;
  maxIterations?: number;
}

const BAR_WIDTH = 20;

function renderBar(progress: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, progress)) / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function statusLabel(status: string): string {
  switch (status) {
    case "idle":          return "Idle";
    case "running":       return "Running";
    case "completed":     return "Completed";
    case "stalled":       return "Stalled";
    case "max_iterations": return "Max iterations reached";
    case "error":         return "Error";
    case "stopped":       return "Stopped";
    default:              return status;
  }
}


function formatElapsed(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function DimensionRow({ dim }: { dim: DimensionProgress }) {
  const bar = renderBar(dim.progress);
  const pct = String(dim.progress).padStart(3, " ") + "%";
  // bar(20) + "  "(2) + "  "(2) + pct(4) + border/padding(4) = 32 fixed chars
  const termWidth = process.stdout.columns || 80;
  const labelWidth = Math.max(8, Math.min(32, termWidth - 32));
  const rawLabel = dim.displayName || dim.name;
  const truncated = rawLabel.length > labelWidth;
  const label = (truncated ? rawLabel.slice(0, labelWidth - 1) + "…" : rawLabel).padEnd(labelWidth, " ");
  const color = progressColor(dim.progress);
  return (
    <Box>
      <Text>{label}  </Text>
      <Text color={color}>{bar}</Text>
      <Text>  {pct}</Text>
    </Box>
  );
}

export function Dashboard({ state }: DashboardProps) {
  if (state.status === "idle") {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        overflow="hidden"
      >
        <Text bold color={theme.brand}>
          🎯 PULSEED
        </Text>
        <Text> </Text>
        <Text color={theme.warning}>No active goals.</Text>
        <Text> </Text>
        <Text dimColor>Get started:</Text>
        <Text>
          {"  1. Type a goal: "}
          <Text color={theme.userPrefix}>"improve test coverage to 90%"</Text>
        </Text>
        <Text>
          {"  2. Then type: "}
          <Text color={theme.command}>/run</Text>
        </Text>
        <Text>{"  3. PulSeed will decompose and execute automatically."}</Text>
        <Text> </Text>
        <Text dimColor>
          {"Type "}
          <Text color={theme.text}>/help</Text>
          {" for all commands."}
        </Text>
      </Box>
    );
  }

  const goalLabel = state.goalId ?? "(unknown)";

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      {/* Header */}
      <Box>
        <Text bold color={theme.brand}>
          PULSEED
        </Text>
        <Text>{"  goal: "}</Text>
        <Text bold>{goalLabel}</Text>
        <Text>{"  "}</Text>
        {state.status === "running" ? (
          <Text color={theme.success}>
            <Spinner type="dots" />
            {" " + statusLabel("running")}
          </Text>
        ) : (
          <Text color={statusColor(state.status)}>{statusLabel(state.status)}</Text>
        )}
      </Box>

      {/* Separator */}
      <Box borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} />

      {/* Stats row: iter, elapsed, last result */}
      {(state.running || state.iteration > 0) && (
        <Box>
          <Text dimColor>{"Iter: "}</Text>
          <Text>{state.iteration}</Text>
          {state.startedAt && (
            <>
              <Text dimColor>{" │ Elapsed: "}</Text>
              <Text>{formatElapsed(state.startedAt)}</Text>
            </>
          )}
          {state.lastResult && (
            <>
              <Text dimColor>{" │ Last: "}</Text>
              <Text>{statusLabel(state.lastResult.finalStatus)}</Text>
            </>
          )}
        </Box>
      )}

      {/* Dimension progress bars */}
      {state.dimensions.length === 0 ? (
        <Text color={theme.border}>Loading dimensions...</Text>
      ) : (
        state.dimensions.map((dim) => (
          <DimensionRow key={dim.name} dim={dim} />
        ))
      )}

      {/* Error message */}
      {state.status === "error" && state.lastError && (
        <Text color={theme.error}>Error: {state.lastError}</Text>
      )}
    </Box>
  );
}
