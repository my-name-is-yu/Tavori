// ─── Chat ───
//
// Chat area component with message log and text input.
// Renders visible messages based on terminal height, with scroll indicator,
// styled user/AI distinction, spinner, timestamps, and color-coded message types.

import React, { useCallback, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  renderMarkdownLines,
  splitMarkdownLineToRows,
  wrapTextToRows,
} from "./markdown-renderer.js";
import { fuzzyMatch, fuzzyFilter } from "./fuzzy.js";
import { getClipboardContent } from "./clipboard.js";
import { theme, getMessageTypeColor } from "./theme.js";
import { pickSpinnerVerb } from "./spinner-verbs.js";
import { ShimmerText } from "./shimmer-text.js";
import { positionCursorInFrame, buildCursorEscape } from "./cursor-tracker.js";
import { isBashModeInput } from "./bash-mode.js";

export interface ChatMessage {
  id: string;
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
}

interface ChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  onClear?: () => void;
  isProcessing: boolean; // show "thinking..." indicator
  goalNames?: string[];
  noFlicker?: boolean;
}

const CHAT_UI_RESERVED_ROWS = 8;
const DEFAULT_MESSAGE_WIDTH_PADDING = 4;
const MESSAGE_INNER_PADDING = 2;
const MIN_MESSAGE_WIDTH = 10;
const SCROLL_LINE_STEP = 3;

interface ChatDisplayRow {
  key: string;
  kind: "user" | "pulseed" | "spacer";
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  marginLeft?: number;
  paddingX?: number;
}

export interface ChatViewport {
  rows: ChatDisplayRow[];
  hiddenAboveRows: number;
  hiddenBelowRows: number;
  totalRows: number;
  maxVisibleRows: number;
}

export interface ScrollRequest {
  direction: "up" | "down";
  kind: "page" | "line";
}

function getRowWidth(termCols: number): number {
  return Math.max(MIN_MESSAGE_WIDTH, termCols - DEFAULT_MESSAGE_WIDTH_PADDING - MESSAGE_INNER_PADDING);
}

function wrapUserMessageRows(text: string, width: number): string[] {
  const wrapped = wrapTextToRows(text, width);
  return wrapped.map((line, index) => (index === 0 ? `◉ ${line}` : `  ${line}`));
}

function buildMessageRows(msg: ChatMessage, width: number): ChatDisplayRow[] {
  if (msg.role === "user") {
    const rows = wrapUserMessageRows(msg.text, width);
    return rows.map((text, index) => ({
      key: `${msg.id}:user:${index}`,
      kind: "user",
      text,
      backgroundColor: "#D9D9D9",
      color: "#1A1A1A",
      paddingX: 1,
    }));
  }

  const typeColor = getMessageTypeColor(msg.messageType);
  const rendered = renderMarkdownLines(msg.text);
  const rows: ChatDisplayRow[] = [];

  rendered.forEach((line, lineIndex) => {
    const wrappedLines = splitMarkdownLineToRows(line, width);
      wrappedLines.forEach((wrappedLine, rowIndex) => {
        rows.push({
          key: `${msg.id}:pulseed:${lineIndex}:${rowIndex}`,
          kind: "pulseed",
          text: wrappedLine.text,
        color: typeColor,
          bold: wrappedLine.bold,
          dim: wrappedLine.dim,
          italic: wrappedLine.italic,
          marginLeft: 2,
        });
    });
  });

  if (rows.length === 0) {
    rows.push({
      key: `${msg.id}:pulseed:empty`,
      kind: "pulseed",
      text: "",
      color: typeColor,
      marginLeft: 2,
    });
  }

  return rows;
}

export function buildChatViewport(
  messages: ChatMessage[],
  termCols: number,
  termRows: number,
  scrollOffsetRows: number,
): ChatViewport {
  const maxVisibleRows = Math.max(1, termRows - CHAT_UI_RESERVED_ROWS);
  const rowWidth = getRowWidth(termCols);
  const flatRows: ChatDisplayRow[] = [];

  for (const msg of messages) {
    flatRows.push(...buildMessageRows(msg, rowWidth));
    flatRows.push({
      key: `${msg.id}:spacer`,
      kind: "spacer",
      text: "",
    });
  }

  const totalRows = flatRows.length;
  const visibleEndIdx = Math.max(0, totalRows - scrollOffsetRows);
  const visibleStartIdx = Math.max(0, visibleEndIdx - maxVisibleRows);

  return {
    rows: flatRows.slice(visibleStartIdx, visibleEndIdx),
    hiddenAboveRows: visibleStartIdx,
    hiddenBelowRows: totalRows - visibleEndIdx,
    totalRows,
    maxVisibleRows,
  };
}

export function getScrollRequest(
  inputChar: string,
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    shift?: boolean;
    meta?: boolean;
    ctrl?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
  }
): ScrollRequest | null {
  if (key.pageUp || inputChar === "[5~") {
    return { direction: "up", kind: "page" };
  }
  if (key.pageDown || inputChar === "[6~") {
    return { direction: "down", kind: "page" };
  }
  if (key.ctrl && (inputChar === "u" || inputChar === "U")) {
    return { direction: "up", kind: "page" };
  }
  if (key.ctrl && (inputChar === "d" || inputChar === "D")) {
    return { direction: "down", kind: "page" };
  }
  if (key.meta && key.upArrow) {
    return { direction: "up", kind: "line" };
  }
  if (key.meta && key.downArrow) {
    return { direction: "down", kind: "line" };
  }
  if (key.shift && key.upArrow) {
    return { direction: "up", kind: "line" };
  }
  if (key.shift && key.downArrow) {
    return { direction: "down", kind: "line" };
  }
  return null;
}

type Suggestion = {
  name: string;
  description: string;
  aliases: string[];
  type: "command" | "goal";
};

const COMMANDS: Suggestion[] = [
  {
    name: "/run",
    aliases: ["/start"],
    description: "Start the goal loop",
    type: "command",
  },
  {
    name: "/stop",
    aliases: ["/quit"],
    description: "Stop the running loop",
    type: "command",
  },
  {
    name: "/status",
    aliases: [],
    description: "Show current progress",
    type: "command",
  },
  {
    name: "/report",
    aliases: [],
    description: "Generate a summary report",
    type: "command",
  },
  {
    name: "/goals",
    aliases: [],
    description: "List all goals",
    type: "command",
  },
  {
    name: "/help",
    aliases: ["?"],
    description: "Show help overlay",
    type: "command",
  },
  {
    name: "/dashboard",
    aliases: [],
    description: "Toggle dashboard sidebar",
    type: "command" as const,
  },
  {
    name: "/settings",
    aliases: ["/config"],
    description: "View and toggle config",
    type: "command",
  },
  {
    name: "/flicker",
    aliases: [],
    description: "Toggle no-flicker mode (next launch)",
    type: "command",
  },
];

/** Commands that accept a goal name as argument */
const GOAL_ARG_COMMANDS = ["/run ", "/start "];

function isExactCommandMatch(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return COMMANDS.some((cmd) => {
    if (cmd.name.toLowerCase() === normalized) return true;
    return cmd.aliases.some((alias) => {
      const normalizedAlias = alias.startsWith("/") ? alias : `/${alias}`;
      return normalizedAlias.toLowerCase() === normalized;
    });
  });
}

export function getMatchingSuggestions(
  input: string,
  goalNames: string[],
): Suggestion[] {
  if (!input.startsWith("/")) return [];
  if (isExactCommandMatch(input)) return [];

  // Check if user typed a command that expects a goal name argument
  for (const prefix of GOAL_ARG_COMMANDS) {
    if (input.startsWith(prefix)) {
      const goalQuery = input.slice(prefix.length);
      if (goalNames.some((goal) => goal.toLowerCase() === goalQuery.toLowerCase())) {
        return [];
      }
      const matchedGoals = fuzzyFilter(goalQuery, goalNames, (g) => g, 6);
      return matchedGoals.map((g) => ({
        name: prefix.trimEnd(),
        description: g,
        aliases: [],
        type: "goal" as const,
      }));
    }
  }

  // Fuzzy match against command names and aliases
  const query = input.slice(1); // strip leading "/"

  // Show all commands when query is empty (just "/")
  if (!query) {
    return COMMANDS.map((cmd) => ({ ...cmd }));
  }

  const scored: Array<{ cmd: Suggestion; score: number }> = [];

  for (const cmd of COMMANDS) {
    // Try matching against name (without leading "/")
    const nameScore = fuzzyMatch(query, cmd.name.slice(1));
    // Try matching against aliases
    const aliasScores = cmd.aliases.map((a) =>
      a.startsWith("/") ? fuzzyMatch(query, a.slice(1)) : fuzzyMatch(query, a),
    );
    const bestAlias = aliasScores.reduce<number | null>(
      (best, s) => (s !== null && (best === null || s > best) ? s : best),
      null,
    );
    const best =
      nameScore !== null && (bestAlias === null || nameScore >= bestAlias)
        ? nameScore
        : bestAlias;

    if (best !== null) {
      scored.push({ cmd, score: best });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map((s) => s.cmd);
}

export function Chat({
  messages,
  onSubmit,
  onClear,
  isProcessing,
  goalNames = [],
  noFlicker,
}: ChatProps) {
  const [input, setInput] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  // Tracks whether a suggestion was just selected so getMatchingSuggestions
  // returns [] for one render cycle, allowing Enter to submit unblocked.
  const justSelected = React.useRef(false);

  // ── Input history (shell-like ↑↓ recall) ──
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [draft, setDraft] = React.useState("");

  // ── Empty-enter hint ──
  const [emptyHint, setEmptyHint] = React.useState(false);

  // ── Copy toast (shown when clipboard changes) ──
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const emptyHintTimer = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // ── Scroll offset for chat scroll ──
  const [scrollOffset, setScrollOffset] = React.useState(0);

  // ── Clipboard change detection — poll every 500ms ──
  React.useEffect(() => {
    let lastClipboard = "";
    let mounted = true;

    // Get initial clipboard content (don't toast on startup)
    getClipboardContent().then(content => {
      if (mounted) lastClipboard = content;
    });

    const interval = setInterval(async () => {
      if (!mounted) return;
      const current = await getClipboardContent();
      if (current !== lastClipboard && current.length > 0) {
        lastClipboard = current;
        setCopyToast(`copied ${current.length} chars to clipboard`);
        setTimeout(() => {
          if (mounted) setCopyToast(null);
        }, 2000);
      }
    }, 500);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const [spinnerVerb, setSpinnerVerb] = React.useState(() => pickSpinnerVerb());

  React.useEffect(() => {
    if (!isProcessing) return;
    const interval = setInterval(() => {
      setSpinnerVerb(pickSpinnerVerb());
    }, 5000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  const matches = justSelected.current
    ? []
    : getMatchingSuggestions(input, goalNames);
  const hasMatches = matches.length > 0;
  const bashMode = isBashModeInput(input);

  // Scroll-slicing: clip messages to visible terminal height
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const termCols = stdout?.columns ?? 80;
  const viewport = buildChatViewport(messages, termCols, termRows, scrollOffset);

  const applyScroll = useCallback((direction: "up" | "down", kind: "page" | "line") => {
    setScrollOffset((prev) => {
      const maxOffset = Math.max(0, viewport.totalRows - 1);
      const amount = kind === "page" ? viewport.maxVisibleRows : SCROLL_LINE_STEP;
      const delta = direction === "up" ? amount : -amount;
      return Math.max(0, Math.min(maxOffset, prev + delta));
    });
  }, [viewport.maxVisibleRows, viewport.totalRows]);

  useInput(
    (inputChar, key) => {
      const scrollRequest = getScrollRequest(inputChar, key);
      if (scrollRequest) {
        applyScroll(scrollRequest.direction, scrollRequest.kind);
        return;
      }

      if (hasMatches) {
        if (key.upArrow) {
          setSelectedIdx((prev) => (prev <= 0 ? matches.length - 1 : prev - 1));
        } else if (key.downArrow) {
          setSelectedIdx((prev) => (prev >= matches.length - 1 ? 0 : prev + 1));
        } else if (key.tab || key.return) {
          const selected = matches[selectedIdx];
          if (selected) {
            // Insert suggestion into input (don't submit)
            const value =
              selected.type === "goal"
                ? `${selected.name} ${selected.description}`
                : selected.name;
            setInput(value);
            setSelectedIdx(0);
            justSelected.current = true;
          }
        } else if (key.escape) {
          setSelectedIdx(0);
          setInput("");
        }
      } else {
        // ── Input history: ↑↓ when no suggestions ──
        if (key.upArrow) {
          if (history.length > 0) {
            if (historyIdx === -1) {
              setDraft(input);
              const idx = history.length - 1;
              setHistoryIdx(idx);
              setInput(history[idx]);
            } else if (historyIdx > 0) {
              const idx = historyIdx - 1;
              setHistoryIdx(idx);
              setInput(history[idx]);
            }
          }
        } else if (key.downArrow && historyIdx !== -1) {
          if (historyIdx < history.length - 1) {
            const idx = historyIdx + 1;
            setHistoryIdx(idx);
            setInput(history[idx]);
          } else {
            setHistoryIdx(-1);
            setInput(draft);
          }
        }
      }
    },
    { isActive: !isProcessing },
  );

  // Reset selected index when matches change
  const matchKey = matches.map((m) => m.name).join(",");
  React.useEffect(() => {
    setSelectedIdx(0);
  }, [matchKey]);

  // Cleanup emptyHint timer on unmount
  React.useEffect(() => {
    return () => {
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
    };
  }, []);

  // Refs for stdout intercept to access current state without re-renders
  const inputRef = React.useRef(input);
  const isProcessingRef = React.useRef(isProcessing);
  React.useEffect(() => {
    inputRef.current = input;
  }, [input]);
  React.useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // Stdout intercept: capture frame AND position cursor via direct ANSI injection
  React.useEffect(() => {
    const original = process.stdout.write.bind(process.stdout);
    const patched = function (chunk: any, ...args: any[]) {
      // Only process full Ink frames (not small escape sequences)
      if (
        typeof chunk === "string" &&
        chunk.length > 50 &&
        !isProcessingRef.current
      ) {
        if (noFlicker) {
          // No-flicker mode: write frame first (goes through frame-writer BSU/ESU),
          // then write cursor escape AFTER — parkCursor in frame-writer would
          // overwrite cursor position if we concatenated it into the frame.
          const result = (original as any)(chunk, ...args);
          const cursorEsc = buildCursorEscape(chunk, inputRef.current);
          if (cursorEsc) {
            (original as any)(cursorEsc);
          }
          return result;
        }
        // Standard mode: write frame, then position cursor separately
        const result = (original as any)(chunk, ...args);
        positionCursorInFrame(chunk, inputRef.current, original);
        return result;
      }
      return (original as any)(chunk, ...args);
    } as typeof process.stdout.write;
    process.stdout.write = patched;
    return () => {
      process.stdout.write = original;
    };
  }, []);

  // Hide cursor during AI processing
  React.useEffect(() => {
    if (isProcessing) {
      const original = process.stdout.write.bind(process.stdout);
      original("\x1b[?25l");
    }
  }, [isProcessing]);

  const handleSubmit = (value: string) => {
    if (hasMatches) return; // let useInput handle enter when suggestions are shown
    if (isProcessing) return;
    if (!value.trim()) {
      // Show empty-enter hint
      setEmptyHint(true);
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
      emptyHintTimer.current = setTimeout(() => setEmptyHint(false), 1500);
      return;
    }
    const trimmed = value.trim();
    // /clear command
    if (trimmed === "/clear") {
      onClear?.();
      setInput("");
      setHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
      setScrollOffset(0);
      return;
    }
    onSubmit(trimmed);
    setInput("");
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setScrollOffset(0);
  };

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Scroll indicator for older messages */}
      {viewport.hiddenAboveRows > 0 && (
        <Text dimColor>
          {"↑"} {viewport.hiddenAboveRows} earlier lines
        </Text>
      )}

      {/* All visible messages rendered with memoized rows to prevent flicker */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {viewport.rows.map((row) => {
          if (row.kind === "spacer") {
            return (
              <Box key={row.key} height={1}>
                <Text> </Text>
              </Box>
            );
          }

          const text = row.text;
          const textProps: Record<string, unknown> = {};
          if (row.color) textProps.color = row.color;
          if (row.bold) textProps.bold = true;
          if (row.dim) textProps.dimColor = true;
          if (row.italic) textProps.italic = true;

          if (row.kind === "user") {
            return (
              <Box key={row.key} paddingX={row.paddingX ?? 0}>
                <Text {...textProps} backgroundColor={row.backgroundColor}>
                  {text}
                </Text>
              </Box>
            );
          }

          return (
            <Box key={row.key} marginLeft={row.marginLeft ?? 0}>
              <Text {...textProps}>{text}</Text>
            </Box>
          );
        })}

        {isProcessing && (
          <Box>
            <Spinner type="dots" />
            <Text> </Text>
            <ShimmerText>{`${spinnerVerb}...`}</ShimmerText>
          </Box>
        )}

        {/* Scroll-down indicator */}
        {viewport.hiddenBelowRows > 0 && (
          <Text dimColor>
            {"↓"} {viewport.hiddenBelowRows} newer lines
          </Text>
        )}

        {/* Copy toast — always reserve 1 row to prevent layout shift */}
        <Box justifyContent="flex-end" height={1}>
          {copyToast && <Text color="cyan">{copyToast}</Text>}
        </Box>

        {/* Input area with borders — always at bottom */}
        <Box flexDirection="column">
          <Box
            borderStyle="single"
            borderColor={bashMode ? theme.command : theme.border}
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
          />
          <Box>
            <Text color={bashMode ? theme.command : theme.userPrompt} bold>
              {"​◉ "}
            </Text>
            <TextInput
              value={input}
              onChange={(val) => {
                justSelected.current = false;
                setInput(val);
              }}
              onSubmit={handleSubmit}
              placeholder={bashMode ? "! for bash mode" : "/ for commands"}
            />
          </Box>
          <Box
            borderStyle="single"
            borderColor={bashMode ? theme.command : theme.border}
            borderTop={false}
            borderLeft={false}
            borderRight={false}
          />
          {bashMode && <Text color={theme.command}>! for bash mode</Text>}
          {emptyHint && (
            <Text dimColor> Type a message or /help for commands</Text>
          )}
          {hasMatches && (
            <Box flexDirection="column">
              {matches.map((suggestion, idx) => {
                const isSelected = idx === selectedIdx;
                const label =
                  suggestion.type === "goal"
                    ? `  ${suggestion.name} ${suggestion.description.padEnd(20)}  [goal]`
                    : `  ${suggestion.name.padEnd(20)}${suggestion.description}`;
                const key = `${suggestion.type}-${suggestion.name}-${suggestion.description}`;
                return isSelected ? (
                  <Text key={key} bold color={theme.selected}>
                    {label}
                  </Text>
                ) : (
                  <Text key={key} dimColor>
                    {label}
                  </Text>
                );
              })}
              <Text dimColor>
                {" "}
                arrows to navigate, tab/enter to select, esc to dismiss
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
