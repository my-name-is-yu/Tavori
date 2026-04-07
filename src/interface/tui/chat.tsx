// ─── Chat ───
//
// Chat area component with message log and text input.
// Renders visible messages based on terminal height, with scroll indicator,
// styled user/AI distinction, spinner, timestamps, and color-coded message types.

import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  renderMarkdownLines,
  type MarkdownLine,
  type MarkdownSegment,
} from "./markdown-renderer.js";
import { fuzzyMatch, fuzzyFilter } from "./fuzzy.js";
import { getClipboardContent } from "./clipboard.js";
import { theme, getMessageTypeColor } from "./theme.js";
import { pickSpinnerVerb } from "./spinner-verbs.js";
import { ShimmerText } from "./shimmer-text.js";
import { positionCursorInFrame, buildCursorEscape } from "./cursor-tracker.js";

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

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Render a single inline segment with its formatting */
function SegmentComponent({
  seg,
  baseColor,
}: {
  seg: MarkdownSegment;
  baseColor?: string;
}) {
  if (seg.bold && seg.italic) {
    return (
      <Text bold italic color={seg.color ?? baseColor}>
        {seg.text}
      </Text>
    );
  }
  if (seg.bold) {
    return (
      <Text bold color={seg.color ?? baseColor}>
        {seg.text}
      </Text>
    );
  }
  if (seg.italic) {
    return (
      <Text italic color={seg.color ?? baseColor}>
        {seg.text}
      </Text>
    );
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

/** Memoized message row — prevents spinner re-renders from flickering messages */
const MessageRow = React.memo(function MessageRow({
  msg,
}: {
  msg: ChatMessage;
}) {
  if (msg.role === "user") {
    return (
      <Box marginBottom={1}>
        <Box paddingX={1}>
          <Text color="#1A1A1A" backgroundColor="#D9D9D9">
            ◉ {msg.text}
          </Text>
        </Box>
      </Box>
    );
  }
  const typeColor = getMessageTypeColor(msg.messageType);
  const mdLines = renderMarkdownLines(msg.text);
  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={2}>
      <Box flexDirection="column">
        {mdLines.map((line, j) => (
          <MarkdownLineComponent key={j} line={line} color={typeColor} />
        ))}
      </Box>
    </Box>
  );
});

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
  const prevMsgCount = React.useRef(messages.length);

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

  // Scroll-slicing: clip messages to visible terminal height
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const termCols = stdout?.columns ?? 80;
  const maxVisible = Math.max(1, termRows - 8); // reserve rows for header, input, status bar

  // Auto-scroll to bottom when new messages arrive and we're at the bottom
  React.useEffect(() => {
    if (messages.length > prevMsgCount.current && scrollOffset === 0) {
      // Already at bottom — nothing to do
    } else if (messages.length > prevMsgCount.current && scrollOffset > 0) {
      // New message arrived while scrolled up — keep position but user can see indicator
    }
    prevMsgCount.current = messages.length;
  }, [messages.length, scrollOffset]);

  const endIdx = messages.length - scrollOffset;
  const startIdx = Math.max(0, endIdx - maxVisible);
  const visibleMessages = messages.slice(
    startIdx,
    endIdx > 0 ? endIdx : undefined,
  );
  const hiddenAbove = startIdx;
  const hiddenBelow = scrollOffset;

  useInput(
    (inputChar, key) => {
      // ── Scroll: Shift+↑/↓ or PageUp/PageDown ──
      if (key.upArrow && key.shift) {
        setScrollOffset((prev) =>
          Math.min(prev + 3, Math.max(0, messages.length - 1)),
        );
        return;
      }
      if (key.downArrow && key.shift) {
        setScrollOffset((prev) => Math.max(0, prev - 3));
        return;
      }
      // PageUp/PageDown via escape sequences
      if (inputChar === "[5~") {
        setScrollOffset((prev) =>
          Math.min(prev + 5, Math.max(0, messages.length - 1)),
        );
        return;
      }
      if (inputChar === "[6~") {
        setScrollOffset((prev) => Math.max(0, prev - 5));
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
      {hiddenAbove > 0 && (
        <Text dimColor>
          {"↑"} {hiddenAbove} earlier messages
        </Text>
      )}

      {/* All visible messages rendered with memoized rows to prevent flicker */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {visibleMessages.map((msg) => {
          return (
            <React.Fragment key={msg.id}>
              <MessageRow msg={msg} />
            </React.Fragment>
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
        {hiddenBelow > 0 && (
          <Text dimColor>
            {"↓"} {hiddenBelow} newer messages
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
            borderColor={theme.border}
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
          />
          <Box>
            <Text color={theme.userPrompt} bold>
              {"​◉ "}
            </Text>
            <TextInput
              value={input}
              onChange={(val) => {
                justSelected.current = false;
                setInput(val);
              }}
              onSubmit={handleSubmit}
              placeholder="/ for commands"
            />
          </Box>
          <Box
            borderStyle="single"
            borderColor={theme.border}
            borderTop={false}
            borderLeft={false}
            borderRight={false}
          />
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
