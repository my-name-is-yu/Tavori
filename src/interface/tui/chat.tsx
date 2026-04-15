// ─── Chat ───
//
// Chat area component with message log and text input.
// Renders visible messages based on terminal height, with scroll indicator,
// styled user/AI distinction, spinner, timestamps, and color-coded message types.

import React, { useCallback, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { CheckerboardSpinner } from "./checkerboard-spinner.js";
import { getClipboardContent } from "./clipboard.js";
import { theme } from "./theme.js";
import { pickSpinnerVerb } from "./spinner-verbs.js";
import { ShimmerText } from "./shimmer-text.js";
import { INPUT_MARKER, positionCursorInFrame, buildCursorEscape } from "./cursor-tracker.js";
import { isBashModeInput } from "./bash-mode.js";
import { isRenderableFrameChunk } from "./render-output.js";
import { buildChatViewport } from "./chat/viewport.js";
import { getScrollRequest, stripMouseEscapeSequences } from "./chat/scroll.js";
import { getMatchingSuggestions } from "./chat/suggestions.js";
import type { ChatMessage } from "./chat/types.js";

export type {
  ChatDisplayRow,
  ChatMessage,
  ChatViewport,
  ScrollRequest,
} from "./chat/types.js";

interface ChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  onClear?: () => void;
  isProcessing: boolean; // show "thinking..." indicator
  goalNames?: string[];
  noFlicker?: boolean;
}

const SCROLL_LINE_STEP = 3;

export { buildChatViewport } from "./chat/viewport.js";
export { getScrollRequest, stripMouseEscapeSequences } from "./chat/scroll.js";
export { getMatchingSuggestions } from "./chat/suggestions.js";

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
        isRenderableFrameChunk(chunk) &&
        !isProcessingRef.current
      ) {
        if (noFlicker) {
          const cursorEsc = buildCursorEscape(chunk, inputRef.current) ?? undefined;
          const result = (original as any)(
            chunk,
            cursorEsc ? { cursorEscape: cursorEsc } : undefined,
            ...args,
          );
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
            <CheckerboardSpinner />
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
            paddingX={1}
          >
            <Text color={bashMode ? theme.command : theme.userPrompt} bold>
              {`${INPUT_MARKER} `}
            </Text>
            <TextInput
              value={input}
              onChange={(val) => {
                justSelected.current = false;
                setInput(stripMouseEscapeSequences(val));
              }}
              onSubmit={handleSubmit}
              placeholder={bashMode ? "! for bash mode" : "/ for commands"}
            />
          </Box>
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
