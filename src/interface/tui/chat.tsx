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
import { CARET_MARKER, INPUT_MARKER, positionCursorInFrame, buildCursorEscape } from "./cursor-tracker.js";
import { HIDE_CURSOR, SHOW_CURSOR } from "./flicker/dec.js";
import { isBashModeInput } from "./bash-mode.js";
import { isRenderableFrameChunk } from "./render-output.js";
import { estimateWrappedLineCount } from "./markdown-renderer.js";
import { buildChatViewport } from "./chat/viewport.js";
import { getScrollRequest, stripMouseEscapeSequences } from "./chat/scroll.js";
import { getMatchingSuggestions, type Suggestion } from "./chat/suggestions.js";
import type { ChatMessage } from "./chat/types.js";
import { getTrustedTuiControlStream } from "./terminal-output.js";
import { measureCharWidth, measureTextWidth } from "./text-width.js";

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
  availableRows?: number;
  availableCols?: number;
  controlStream?: Pick<NodeJS.WriteStream, "write">;
}

const SCROLL_LINE_STEP = 1;
const DEFAULT_PROMPT = "◉";
const BASH_PROMPT = "!";
const CHAT_CHROME_RESERVED_ROWS = 4;
const SCROLL_INDICATOR_ROWS = 2;
const INPUT_BOX_HORIZONTAL_CHROME = 4;
const SUGGESTION_HINT = " arrows to navigate, tab/enter to select, esc to dismiss";
export { buildChatViewport } from "./chat/viewport.js";
export { getScrollRequest, parseMouseEvent, stripMouseEscapeSequences } from "./chat/scroll.js";
export { getMatchingSuggestions } from "./chat/suggestions.js";

export function getInputPromptLabel(bashMode: boolean): string {
  return bashMode ? BASH_PROMPT : DEFAULT_PROMPT;
}

function getInputPlaceholder(bashMode: boolean): string {
  return bashMode ? "! for bash mode" : "/ for commands";
}

export function formatSuggestionLabel(suggestion: Suggestion): string {
  return suggestion.type === "goal"
    ? `  ${suggestion.name} ${suggestion.description.padEnd(20)}  [goal]`
    : `  ${suggestion.name.padEnd(20)}${suggestion.description}`;
}

type InputCell = {
  text: string;
  width: number;
};

type InputRow = {
  cells: InputCell[];
};

function charWidth(ch: string): number {
  return measureCharWidth(ch);
}

function stringWidth(text: string): number {
  return measureTextWidth(text);
}

function trimToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const next = charWidth(ch);
    if (used + next > width) break;
    out += ch;
    used += next;
  }
  return out;
}

function pushInputRow(rows: InputRow[], cells: InputCell[]): void {
  rows.push({ cells: [...cells] });
}

function buildInputRows(
  input: string,
  cursorOffset: number,
  contentWidth: number,
  placeholder: string,
): InputRow[] {
  if (contentWidth <= 0) {
    return [{ cells: [{ text: CARET_MARKER, width: 0 }] }];
  }

  if (input.length === 0) {
    return [{
      cells: [
        { text: CARET_MARKER, width: 0 },
        { text: " ", width: 1 },
        ...Array.from(trimToWidth(placeholder, Math.max(0, contentWidth - 1))).map((ch) => ({
          text: ch,
          width: charWidth(ch),
        })),
      ],
    }];
  }

  const rows: InputRow[] = [];
  let currentCells: InputCell[] = [];
  let currentWidth = 0;
  let offset = 0;

  while (offset <= input.length) {
    if (offset === cursorOffset) {
      currentCells.push({ text: CARET_MARKER, width: 0 });
    }

    if (offset === input.length) {
      break;
    }

    const codePoint = input.codePointAt(offset) ?? 0;
    const ch = String.fromCodePoint(codePoint);
    const nextOffset = offset + ch.length;

    if (ch === "\n") {
      currentCells.push({ text: " ", width: 1 });
      pushInputRow(rows, currentCells);
      currentCells = [];
      currentWidth = 0;
      offset = nextOffset;
      continue;
    }

    const width = charWidth(ch);
    if (currentWidth + width > contentWidth && currentCells.length > 0) {
      pushInputRow(rows, currentCells);
      currentCells = [];
      currentWidth = 0;
    }

    currentCells.push({ text: ch, width });
    currentWidth += width;
    offset = nextOffset;
  }

  pushInputRow(rows, currentCells);
  return rows;
}

function getInputBoxContentWidth(termCols: number, bashMode: boolean): number {
  const innerWidth = Math.max(1, termCols - INPUT_BOX_HORIZONTAL_CHROME);
  const promptWidth = getInputPromptLabel(bashMode).length + 1;
  return Math.max(1, innerWidth - promptWidth);
}

function estimateInputBoxHeight(
  input: string,
  termCols: number,
  bashMode: boolean,
): number {
  const contentWidth = getInputBoxContentWidth(termCols, bashMode);
  const displayText =
    input.length > 0 ? `${input}x` : getInputPlaceholder(bashMode);
  return estimateWrappedLineCount(displayText, contentWidth) + 2;
}

export function estimateComposerHeight({
  termCols,
  input,
  bashMode,
  emptyHint,
  matches,
}: {
  termCols: number;
  input: string;
  bashMode: boolean;
  emptyHint: boolean;
  matches: Suggestion[];
}): number {
  let height = 1 + estimateInputBoxHeight(input, termCols, bashMode);

  if (bashMode) {
    height += estimateWrappedLineCount("! for bash mode", termCols);
  }

  if (emptyHint) {
    height += estimateWrappedLineCount(" Type a message or /help for commands", termCols);
  }

  if (matches.length > 0) {
    height += matches.reduce(
      (total, suggestion) => total + estimateWrappedLineCount(formatSuggestionLabel(suggestion), termCols),
      0,
    );
    height += estimateWrappedLineCount(SUGGESTION_HINT, termCols);
  }

  return height;
}

export function Chat({
  messages,
  onSubmit,
  onClear,
  isProcessing,
  goalNames = [],
  noFlicker,
  availableRows,
  availableCols,
  controlStream = getTrustedTuiControlStream(),
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
  const termRows = availableRows ?? stdout?.rows ?? 24;
  const termCols = availableCols ?? stdout?.columns ?? 80;
  const composerHeight = estimateComposerHeight({
    termCols,
    input,
    bashMode,
    emptyHint,
    matches,
  });
  const processingRows = isProcessing ? 1 : 0;
  const messageRows = Math.max(
    1,
    termRows -
      CHAT_CHROME_RESERVED_ROWS -
      composerHeight -
      processingRows -
      SCROLL_INDICATOR_ROWS,
  );
  const viewport = buildChatViewport(
    messages,
    termCols,
    messageRows,
    scrollOffset,
  );
  const logPaneHeight = viewport.maxVisibleRows + processingRows + SCROLL_INDICATOR_ROWS;

  const applyScroll = useCallback((direction: "up" | "down", kind: "page" | "line") => {
    setScrollOffset((prev) => {
      const maxOffset = Math.max(0, viewport.totalRows - viewport.maxVisibleRows);
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
    if (!stdout) return;
    const original = stdout.write.bind(stdout);
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
        positionCursorInFrame(chunk, inputRef.current, (cursor: string) => controlStream.write(cursor));
        return result;
      }
      return (original as any)(chunk, ...args);
    } as typeof stdout.write;
    stdout.write = patched;
    return () => {
      stdout.write = original;
    };
  }, [controlStream, noFlicker, stdout]);

  // Keep the terminal's real cursor hidden in standard mode.
  React.useEffect(() => {
    if (noFlicker) return;
    controlStream.write(HIDE_CURSOR);
    return () => {
      controlStream.write(SHOW_CURSOR);
    };
  }, [controlStream, noFlicker]);

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
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        height={logPaneHeight}
        overflow="hidden"
      >
        {/* Scroll indicator for older messages */}
        <Box height={1} overflow="hidden">
          {viewport.hiddenAboveRows > 0 ? (
            <Text dimColor>
              {"↑"} {viewport.hiddenAboveRows} earlier lines
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>

        {/* All visible messages rendered with memoized rows to prevent flicker */}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          height={viewport.maxVisibleRows}
          justifyContent="flex-end"
          overflow="hidden"
        >
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
            <Box height={1} overflow="hidden">
              <CheckerboardSpinner />
              <Text> </Text>
              <ShimmerText>{`${spinnerVerb}...`}</ShimmerText>
            </Box>
          )}
        </Box>

        {/* Scroll-down indicator */}
        <Box height={1} overflow="hidden">
          {viewport.hiddenBelowRows > 0 ? (
            <Text dimColor>
              {"↓"} {viewport.hiddenBelowRows} newer lines
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" flexShrink={0} height={composerHeight}>
        {/* Copy toast — always reserve 1 row to prevent layout shift */}
        <Box justifyContent="flex-end" height={1}>
          {copyToast && <Text color="cyan">{copyToast}</Text>}
        </Box>

        {/* Input area with borders — always at bottom */}
        <Box flexDirection="column" flexShrink={0}>
          <Box
            borderStyle="single"
            borderColor={bashMode ? theme.command : theme.border}
            paddingX={1}
          >
            <Text color={bashMode ? theme.command : theme.userPrompt} bold>
              {getInputPromptLabel(bashMode)}{" "}
            </Text>
            <Text>{INPUT_MARKER}</Text>
            <TextInput
              value={input}
              onChange={(val) => {
                justSelected.current = false;
                setInput(stripMouseEscapeSequences(val));
              }}
              onSubmit={handleSubmit}
              placeholder={getInputPlaceholder(bashMode)}
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
                const label = formatSuggestionLabel(suggestion);
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
              <Text dimColor>{SUGGESTION_HINT}</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
