// ─── Chat ───
//
// Chat area component with message log and text input.
// Renders visible messages based on terminal height, with scroll indicator,
// styled user/AI distinction, spinner, timestamps, and color-coded message types.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { renderMarkdownLines, type MarkdownLine, type MarkdownSegment } from "./markdown-renderer.js";
import { fuzzyMatch, fuzzyFilter } from "./fuzzy.js";
import { theme, getMessageTypeColor } from "./theme.js";

export interface ChatMessage {
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
}

interface ChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  isProcessing: boolean; // show "thinking..." indicator
  goalNames?: string[];
}


function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Render a single inline segment with its formatting */
function SegmentComponent({ seg, baseColor }: { seg: MarkdownSegment; baseColor?: string }) {
  if (seg.bold && seg.italic) {
    return <Text bold italic color={seg.color ?? baseColor}>{seg.text}</Text>;
  }
  if (seg.bold) {
    return <Text bold color={seg.color ?? baseColor}>{seg.text}</Text>;
  }
  if (seg.italic) {
    return <Text italic color={seg.color ?? baseColor}>{seg.text}</Text>;
  }
  if (seg.code) {
    return <Text color={theme.codeInline}>{seg.text}</Text>;
  }
  if (seg.color) {
    return <Text color={seg.color}>{seg.text}</Text>;
  }
  return <Text color={baseColor}>{seg.text}</Text>;
}

/** Render a single MarkdownLine with appropriate styling */
function MarkdownLineComponent({
  line,
  color,
}: {
  line: MarkdownLine;
  color?: string;
}) {
  // Empty line -> render as blank space
  if (line.text === "") {
    return <Text> </Text>;
  }

  // Lines with inline segments (formatted text or syntax-highlighted code)
  if (line.segments && line.segments.length > 0) {
    return (
      <Box flexDirection="row" flexWrap="wrap">
        {line.segments.map((seg, i) => (
          <SegmentComponent key={i} seg={seg} baseColor={color} />
        ))}
      </Box>
    );
  }

  const props: Record<string, unknown> = {};
  if (line.bold) props.bold = true;
  if (line.dim) props.dimColor = true;
  if (color) props.color = color;

  return <Text {...props}>{line.text}</Text>;
}

type Suggestion = {
  name: string;
  description: string;
  aliases: string[];
  type: 'command' | 'goal';
};

const COMMANDS: Suggestion[] = [
  { name: '/run', aliases: ['/start'], description: 'Start the goal loop', type: 'command' },
  { name: '/stop', aliases: ['/quit'], description: 'Stop the running loop', type: 'command' },
  { name: '/status', aliases: [], description: 'Show current progress', type: 'command' },
  { name: '/report', aliases: [], description: 'Generate a summary report', type: 'command' },
  { name: '/goals', aliases: [], description: 'List all goals', type: 'command' },
  { name: '/help', aliases: ['?'], description: 'Show help overlay', type: 'command' },
  { name: '/dashboard', aliases: [], description: 'Toggle dashboard sidebar', type: 'command' as const },
];

/** Commands that accept a goal name as argument */
const GOAL_ARG_COMMANDS = ['/run ', '/start '];

function getMatchingSuggestions(input: string, goalNames: string[]): Suggestion[] {
  if (!input.startsWith('/')) return [];

  // Check if user typed a command that expects a goal name argument
  for (const prefix of GOAL_ARG_COMMANDS) {
    if (input.startsWith(prefix)) {
      const goalQuery = input.slice(prefix.length);
      const matchedGoals = fuzzyFilter(goalQuery, goalNames, (g) => g, 6);
      return matchedGoals.map((g) => ({
        name: prefix.trimEnd(),
        description: g,
        aliases: [],
        type: 'goal' as const,
      }));
    }
  }

  // Fuzzy match against command names and aliases
  const query = input.slice(1); // strip leading '/'

  // Show all commands when query is empty (just "/")
  if (!query) {
    return COMMANDS.map(cmd => ({ ...cmd }));
  }

  const scored: Array<{ cmd: Suggestion; score: number }> = [];

  for (const cmd of COMMANDS) {
    // Try matching against name (without leading '/')
    const nameScore = fuzzyMatch(query, cmd.name.slice(1));
    // Try matching against aliases
    const aliasScores = cmd.aliases.map((a) =>
      a.startsWith('/') ? fuzzyMatch(query, a.slice(1)) : fuzzyMatch(query, a)
    );
    const bestAlias = aliasScores.reduce<number | null>(
      (best, s) => (s !== null && (best === null || s > best) ? s : best),
      null
    );
    const best = nameScore !== null && (bestAlias === null || nameScore >= bestAlias)
      ? nameScore
      : bestAlias;

    if (best !== null) {
      scored.push({ cmd, score: best });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map((s) => s.cmd);
}

export function Chat({ messages, onSubmit, isProcessing, goalNames = [] }: ChatProps) {
  const [input, setInput] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  // Tracks whether a suggestion was just selected so getMatchingSuggestions
  // returns [] for one render cycle, allowing Enter to submit unblocked.
  const justSelected = React.useRef(false);

  const matches = justSelected.current ? [] : getMatchingSuggestions(input, goalNames);
  const hasMatches = matches.length > 0;

  useInput((_, key) => {
    if (!hasMatches) return;

    if (key.upArrow) {
      setSelectedIdx((prev) => (prev <= 0 ? matches.length - 1 : prev - 1));
    } else if (key.downArrow) {
      setSelectedIdx((prev) => (prev >= matches.length - 1 ? 0 : prev + 1));
    } else if (key.tab || key.return) {
      const selected = matches[selectedIdx];
      if (selected) {
        // Auto-submit on selection (no extra Enter needed)
        const value = selected.type === 'goal'
          ? `${selected.name} ${selected.description}`
          : selected.name;
        setInput("");
        setSelectedIdx(0);
        onSubmit(value.trim());
      }
    } else if (key.escape) {
      setSelectedIdx(0);
      setInput("");
    }
  });

  // Reset selected index when matches change
  React.useEffect(() => {
    setSelectedIdx(0);
  }, [matches.map(m => m.name).join(',')]);

  const handleSubmit = (value: string) => {
    if (hasMatches) return; // let useInput handle enter when suggestions are shown
    if (!value.trim() || isProcessing) return;
    onSubmit(value.trim());
    setInput("");
  };

  // Cap visible messages based on terminal height
  const termRows = process.stdout.rows || 40;
  const visibleCount = Math.max(termRows - 12, 8);
  const startIdx = Math.max(messages.length - visibleCount, 0);
  const visibleMessages = messages.slice(startIdx);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Scroll indicator */}
      {startIdx > 0 && (
        <Text dimColor>{"\u2191"} {startIdx} earlier messages</Text>
      )}

      {/* Message log */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg, i) => {
          const timeStr = formatTime(msg.timestamp ?? new Date());
          const absoluteIdx = startIdx + i;

          if (msg.role === "user") {
            return (
              <Box key={absoluteIdx} flexDirection="column" marginBottom={2}>
                <Box>
                  <Text color={theme.userPrefix} bold>
                    {"\u276F "}
                  </Text>
                  <Text>{msg.text}</Text>
                  <Text dimColor> {timeStr}</Text>
                </Box>
              </Box>
            );
          }

          // PulSeed message — render markdown lines individually
          const typeColor = getMessageTypeColor(msg.messageType);
          const mdLines = renderMarkdownLines(msg.text);

          return (
            <Box key={absoluteIdx} flexDirection="column" marginBottom={1} marginLeft={2}>
              <Box justifyContent="space-between">
                <Text color={theme.brand} bold>
                  PulSeed
                </Text>
                <Text dimColor>{timeStr}</Text>
              </Box>
              <Box flexDirection="column">
                {mdLines.map((line, j) => (
                  <MarkdownLineComponent
                    key={j}
                    line={line}
                    color={typeColor}
                  />
                ))}
              </Box>
            </Box>
          );
        })}

        {/* Thinking spinner */}
        {isProcessing && (
          <Box>
            <Text color={theme.warning}>
              <Spinner type="dots" />
            </Text>
            <Text color={theme.warning}> Thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Input area with borders */}
      <Box flexDirection="column">
        <Box borderStyle="single" borderColor={theme.border} borderBottom={false} borderLeft={false} borderRight={false} />
        <Box>
          <Text color={theme.userPrompt} bold>
            {"\u276F "}
          </Text>
          <TextInput
            value={input}
            onChange={(val) => { justSelected.current = false; setInput(val); }}
            onSubmit={handleSubmit}
            placeholder="/ for commands"
          />
        </Box>
        <Box borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} />
        {hasMatches && (
          <Box flexDirection="column">
            {matches.map((suggestion, idx) => {
              const isSelected = idx === selectedIdx;
              const label = suggestion.type === 'goal'
                ? `  ${suggestion.name} ${suggestion.description.padEnd(20)}  [goal]`
                : `  ${suggestion.name.padEnd(20)}${suggestion.description}`;
              const key = `${suggestion.type}-${suggestion.name}-${suggestion.description}`;
              return isSelected ? (
                <Text key={key} bold color={theme.selected}>{label}</Text>
              ) : (
                <Text key={key} dimColor>{label}</Text>
              );
            })}
            <Text dimColor>  arrows to navigate, tab/enter to select, esc to dismiss</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
