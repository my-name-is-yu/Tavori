import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getClipboardContent } from "./clipboard.js";
import { logTuiDebug } from "./debug-log.js";
import { theme } from "./theme.js";
import { pickSpinnerVerb } from "./spinner-verbs.js";
import {
  buildHiddenCursorEscapeFromPosition,
  CARET_MARKER,
  PROTECTED_ROW_MARKER,
  setActiveCursorEscape,
} from "./cursor-tracker.js";
import { measureCharWidth, measureTextWidth } from "./text-width.js";
import { isBashModeInput } from "./bash-mode.js";
import { buildChatViewport } from "./chat/viewport.js";
import {
  getScrollRequest,
  parseMouseEvent,
  stripMouseEscapeSequences,
} from "./chat/scroll.js";
import { getMatchingSuggestions, type Suggestion } from "./chat/suggestions.js";
import type { ChatMessage, ChatDisplayRow } from "./chat/types.js";

interface FullscreenChatProps {
  messages: ChatMessage[];
  onSubmit: (input: string) => void;
  onClear?: () => void;
  isProcessing: boolean;
  goalNames?: string[];
  availableRows: number;
  availableCols: number;
  cursorOriginX?: number;
  cursorOriginY?: number;
}

const SCROLL_LINE_STEP = 1;
const SCROLL_ANIMATION_INTERVAL_MS = 16;
const DEFAULT_PROMPT = "◉";
const BASH_PROMPT = "!";
const SUGGESTION_HINT = " arrows to navigate, tab/enter to select, esc to dismiss";
const INPUT_MARGIN = 4;
const SELECTION_BACKGROUND = theme.text;
const SELECTION_FOREGROUND = "#1F2329";
const FAKE_CURSOR_GLYPH = "▌";

type RenderSegment = {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
};

type RenderLine = {
  key: string;
  text?: string;
  segments?: RenderSegment[];
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  protected?: boolean;
};

type SelectionState = {
  anchor: number;
  focus: number;
};

type SelectionRange = {
  start: number;
  end: number;
};

type InputCell = {
  text: string;
  width: number;
  offsetBefore: number;
  offsetAfter: number;
  selected?: boolean;
  placeholder?: boolean;
};

type InputRow = {
  cells: InputCell[];
  startOffset: number;
  endOffset: number;
};

type ComposerRender = {
  lines: RenderLine[];
  inputRows: InputRow[];
  inputRowStartIndex: number;
  contentStartCol: number;
};

type ComposerLayout = {
  startLine: number;
  contentStartCol: number;
  rows: InputRow[];
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

function padToWidth(text: string, width: number): string {
  const trimmed = trimToWidth(text, width);
  const padding = Math.max(0, width - stringWidth(trimmed));
  return trimmed + " ".repeat(padding);
}

function getPreviousOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = offset - 1;
  const previousCode = text.charCodeAt(previous);
  if (
    previous > 0 &&
    previousCode >= 0xdc00 &&
    previousCode <= 0xdfff
  ) {
    const lead = text.charCodeAt(previous - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) {
      return previous - 1;
    }
  }
  return previous;
}

function getNextOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const code = text.charCodeAt(offset);
  if (
    offset + 1 < text.length &&
    code >= 0xd800 &&
    code <= 0xdbff
  ) {
    const trail = text.charCodeAt(offset + 1);
    if (trail >= 0xdc00 && trail <= 0xdfff) {
      return offset + 2;
    }
  }
  return offset + 1;
}

function isBackspaceInput(
  inputChar: string,
  key: { backspace?: boolean; delete?: boolean; ctrl?: boolean },
): boolean {
  return (
    key.backspace === true ||
    inputChar === "\u007f" ||
    inputChar === "\b" ||
    (key.ctrl === true && inputChar === "h") ||
    (key.delete === true && inputChar === "")
  );
}

function isDeleteInput(inputChar: string, key: { delete?: boolean }): boolean {
  return inputChar === "[3~" || inputChar === "\u001b[3~";
}

function summarizeKey(key: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(key).filter(([, value]) => value === true),
  );
}

function getPromptLabel(bashMode: boolean): string {
  return bashMode ? BASH_PROMPT : DEFAULT_PROMPT;
}

function getPlaceholder(bashMode: boolean): string {
  return bashMode ? "! for bash mode" : "/ for commands";
}

function formatSuggestionLabel(suggestion: Suggestion): string {
  return suggestion.type === "goal"
    ? `  ${suggestion.name} ${suggestion.description.padEnd(20)}  [goal]`
    : `  ${suggestion.name.padEnd(20)}${suggestion.description}`;
}

function normalizeSelection(selection: SelectionState | null): SelectionRange | null {
  if (!selection || selection.anchor === selection.focus) {
    return null;
  }

  return {
    start: Math.min(selection.anchor, selection.focus),
    end: Math.max(selection.anchor, selection.focus),
  };
}

function pushSegment(
  segments: RenderSegment[],
  text: string,
  style: Omit<RenderSegment, "text"> = {},
): void {
  if (text.length === 0) return;

  const previous = segments[segments.length - 1];
  if (
    previous &&
    previous.color === style.color &&
    previous.backgroundColor === style.backgroundColor &&
    previous.bold === style.bold &&
    previous.dim === style.dim
  ) {
    previous.text += text;
    return;
  }

  segments.push({ text, ...style });
}

function buildInputRows(
  input: string,
  cursorOffset: number,
  contentWidth: number,
  placeholder: string,
  selection: SelectionRange | null,
): {
  rows: InputRow[];
} {
  if (contentWidth <= 0) {
    return {
      rows: [{
        cells: [{
          text: CARET_MARKER,
          width: 0,
          offsetBefore: cursorOffset,
          offsetAfter: cursorOffset,
        }],
        startOffset: cursorOffset,
        endOffset: cursorOffset,
      }],
    };
  }

  if (input.length === 0) {
    const cells: InputCell[] = [{
      text: CARET_MARKER,
      width: 0,
      offsetBefore: 0,
      offsetAfter: 0,
    }];

    for (const ch of trimToWidth(placeholder, Math.max(0, contentWidth - 1))) {
      cells.push({
        text: ch,
        width: charWidth(ch),
        offsetBefore: 0,
        offsetAfter: 0,
        placeholder: true,
      });
    }

    return {
      rows: [{
        cells,
        startOffset: 0,
        endOffset: 0,
      }],
    };
  }

  const rows: InputRow[] = [];
  let currentCells: InputCell[] = [];
  let currentWidth = 0;
  let rowStartOffset = 0;
  let rowEndOffset = 0;
  const pushRow = () => {
    rows.push({
      cells: currentCells,
      startOffset: rowStartOffset,
      endOffset: rowEndOffset,
    });
    currentCells = [];
    currentWidth = 0;
  };

  let offset = 0;
  while (offset <= input.length) {
    if (offset === cursorOffset) {
      if (currentWidth >= contentWidth && currentCells.length > 0) {
        pushRow();
        rowStartOffset = offset;
        rowEndOffset = offset;
      }
      currentCells.push({
        text: CARET_MARKER,
        width: 0,
        offsetBefore: offset,
        offsetAfter: offset,
      });
    }

    if (offset === input.length) {
      break;
    }

    const codePoint = input.codePointAt(offset) ?? 0;
    const ch = String.fromCodePoint(codePoint);
    const nextOffset = offset + ch.length;

    if (ch === "\n") {
      pushRow();
      rowStartOffset = nextOffset;
      rowEndOffset = nextOffset;
      offset = nextOffset;
      continue;
    }

    const width = charWidth(ch);
    if (currentWidth + width > contentWidth && currentCells.length > 0) {
      pushRow();
      rowStartOffset = offset;
      rowEndOffset = offset;
    }

    currentCells.push({
      text: ch,
      width,
      offsetBefore: offset,
      offsetAfter: nextOffset,
      selected:
        selection !== null &&
        offset < selection.end &&
        nextOffset > selection.start,
    });
    currentWidth += width;
    rowEndOffset = nextOffset;
    offset = nextOffset;
  }

  rows.push({
    cells: currentCells,
    startOffset: rowStartOffset,
    endOffset: rowEndOffset,
  });

  return { rows };
}

function buildInputContentSegments(
  row: InputRow,
  contentWidth: number,
  bashMode: boolean,
): RenderSegment[] {
  const segments: RenderSegment[] = [];
  const defaultColor = bashMode ? theme.command : undefined;
  let usedWidth = 0;

  for (const cell of row.cells) {
    if (cell.text === CARET_MARKER) {
      pushSegment(segments, FAKE_CURSOR_GLYPH, {
        color: theme.text,
        bold: true,
      });
      usedWidth += 1;
      continue;
    }

    usedWidth += cell.width;

    if (cell.selected) {
      pushSegment(segments, cell.text, {
        color: SELECTION_FOREGROUND,
        backgroundColor: SELECTION_BACKGROUND,
      });
      continue;
    }

    pushSegment(segments, cell.text, {
      color: defaultColor,
      dim: cell.placeholder,
    });
  }

  if (usedWidth < contentWidth) {
    pushSegment(segments, " ".repeat(contentWidth - usedWidth), {
      color: defaultColor,
    });
  }

  return segments;
}

function getCursorPositionFromComposerLayout(
  layout: ComposerLayout,
): { x: number; y: number } | null {
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    const row = layout.rows[rowIndex];
    if (!row) continue;

    let colOffset = 0;
    for (const cell of row.cells) {
      if (cell.text === CARET_MARKER) {
        return {
          x: layout.contentStartCol + colOffset - 1,
          y: layout.startLine + rowIndex - 1,
        };
      }
      colOffset += cell.width;
    }
  }

  return null;
}

function buildComposerLines(args: {
  cols: number;
  input: string;
  cursorOffset: number;
  bashMode: boolean;
  emptyHint: boolean;
  matches: Suggestion[];
  selectedIdx: number;
  copyToast: string | null;
  selection: SelectionRange | null;
}): ComposerRender {
  const {
    cols,
    input,
    cursorOffset,
    bashMode,
    emptyHint,
    matches,
    selectedIdx,
    copyToast,
    selection,
  } = args;

  const lines: RenderLine[] = [];
  lines.push({
    key: "copy-toast",
    text: padToWidth(copyToast ?? "", cols),
    color: copyToast ? "cyan" : undefined,
  });

  const innerWidth = Math.max(1, cols - 2);
  const promptLabel = getPromptLabel(bashMode);
  const prompt = `${promptLabel} `;
  const promptWidth = stringWidth(prompt);
  const contentWidth = Math.max(1, innerWidth - INPUT_MARGIN - promptWidth);
  const inputRender = buildInputRows(
    input,
    cursorOffset,
    contentWidth,
    getPlaceholder(bashMode),
    selection,
  );
  const inputRows = inputRender.rows;

  lines.push({
    key: "composer-top",
    text: padToWidth(`┌${"─".repeat(Math.max(0, cols - 2))}┐`, cols),
    color: bashMode ? theme.command : theme.border,
  });

  inputRows.forEach((row, index) => {
    const segments: RenderSegment[] = [];
    const borderColor = bashMode ? theme.command : undefined;
    const promptColor = bashMode ? theme.command : theme.userPrompt;

    pushSegment(segments, "│ ", { color: borderColor });
    if (index === 0) {
      pushSegment(segments, promptLabel, { color: promptColor, bold: true });
      pushSegment(segments, " ", { color: promptColor, bold: true });
    } else {
      pushSegment(segments, " ".repeat(promptWidth), { color: borderColor });
    }
    segments.push(...buildInputContentSegments(row, contentWidth, bashMode));
    pushSegment(segments, " │", { color: borderColor });

    lines.push({
      key: `composer-row-${index}`,
      segments,
      protected: true,
    });
  });

  lines.push({
    key: "composer-bottom",
    text: padToWidth(`└${"─".repeat(Math.max(0, cols - 2))}┘`, cols),
    color: bashMode ? theme.command : theme.border,
  });

  if (bashMode) {
    lines.push({
      key: "bash-hint",
      text: padToWidth("! for bash mode", cols),
      color: theme.command,
    });
  }

  if (emptyHint) {
    lines.push({
      key: "empty-hint",
      text: padToWidth(" Type a message or /help for commands", cols),
      dim: true,
    });
  }

  if (matches.length > 0) {
    matches.forEach((suggestion, index) => {
      lines.push({
        key: `suggestion-${index}`,
        text: padToWidth(formatSuggestionLabel(suggestion), cols),
        color: index === selectedIdx ? theme.selected : undefined,
        bold: index === selectedIdx,
        dim: index !== selectedIdx,
      });
    });
    lines.push({
      key: "suggestion-hint",
      text: padToWidth(SUGGESTION_HINT, cols),
      dim: true,
    });
  }

  return {
    lines,
    inputRows,
    inputRowStartIndex: 2,
    contentStartCol: 3 + promptWidth,
  };
}

function renderMessageRow(row: ChatDisplayRow, cols: number): RenderLine {
  if (row.kind === "spacer") {
    return { key: row.key, text: " ".repeat(cols) };
  }

  return {
    key: row.key,
    text: padToWidth(row.text, cols),
    color: row.color,
    backgroundColor: row.backgroundColor,
    bold: row.bold,
    dim: row.dim,
  };
}

function getMouseOffsetFromComposer(
  layout: ComposerLayout,
  x: number,
  y: number,
  clampOutside: boolean,
): number | null {
  if (layout.rows.length === 0) {
    return null;
  }

  let rowIndex = y - layout.startLine;
  if (rowIndex < 0) {
    if (!clampOutside) return null;
    rowIndex = 0;
  }
  if (rowIndex >= layout.rows.length) {
    if (!clampOutside) return null;
    rowIndex = layout.rows.length - 1;
  }

  const row = layout.rows[rowIndex];
  if (!row) {
    return null;
  }

  if (row.startOffset === row.endOffset) {
    return row.startOffset;
  }

  const localCol = x - layout.contentStartCol;
  if (localCol <= 0) {
    return row.startOffset;
  }

  let usedWidth = 0;
  for (const cell of row.cells) {
    if (cell.placeholder || cell.width <= 0) {
      continue;
    }

    const midpoint = usedWidth + cell.width / 2;
    if (localCol <= midpoint) {
      return cell.offsetBefore;
    }

    usedWidth += cell.width;
    if (localCol <= usedWidth) {
      return cell.offsetAfter;
    }
  }

  return row.endOffset;
}

export function FullscreenChat({
  messages,
  onSubmit,
  onClear,
  isProcessing,
  goalNames = [],
  availableRows,
  availableCols,
  cursorOriginX = 0,
  cursorOriginY = 0,
}: FullscreenChatProps) {
  const [input, setInput] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const selectionAnchor = React.useRef<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const justSelected = React.useRef(false);

  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = React.useState(-1);
  const [draft, setDraft] = React.useState("");

  const [emptyHint, setEmptyHint] = React.useState(false);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const emptyHintTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollOffset, setScrollOffset] = React.useState(0);
  const [targetScrollOffset, setTargetScrollOffset] = React.useState(0);
  const [spinnerVerb, setSpinnerVerb] = React.useState(() => pickSpinnerVerb());

  React.useEffect(() => {
    let lastClipboard = "";
    let mounted = true;

    getClipboardContent().then((content) => {
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

  React.useEffect(() => {
    if (!isProcessing) return;
    const interval = setInterval(() => {
      setSpinnerVerb(pickSpinnerVerb());
    }, 5000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  const clearSelection = useCallback(() => {
    selectionAnchor.current = null;
    setSelection(null);
  }, []);

  const replaceInputRange = useCallback((
    start: number,
    end: number,
    replacement: string,
  ) => {
    const next = input.slice(0, start) + replacement + input.slice(end);
    setInput(next);
    setCursorOffset(start + replacement.length);
    clearSelection();
  }, [clearSelection, input]);

  const insertText = useCallback((text: string) => {
    justSelected.current = false;
    const selectedRange = normalizeSelection(selection);
    if (selectedRange) {
      replaceInputRange(selectedRange.start, selectedRange.end, text);
      return;
    }

    const next = input.slice(0, cursorOffset) + text + input.slice(cursorOffset);
    setInput(next);
    setCursorOffset(cursorOffset + text.length);
    clearSelection();
  }, [clearSelection, cursorOffset, input, replaceInputRange, selection]);

  const deleteSelection = useCallback(() => {
    const selectedRange = normalizeSelection(selection);
    if (!selectedRange) {
      return false;
    }

    replaceInputRange(selectedRange.start, selectedRange.end, "");
    return true;
  }, [replaceInputRange, selection]);

  const matches = justSelected.current ? [] : getMatchingSuggestions(input, goalNames);
  const hasMatches = matches.length > 0;
  const bashMode = isBashModeInput(input);
  const normalizedSelection = normalizeSelection(selection);
  const composer = buildComposerLines({
    cols: availableCols,
    input,
    cursorOffset,
    bashMode,
    emptyHint,
    matches,
    selectedIdx,
    copyToast,
    selection: normalizedSelection,
  });

  const messageRows = Math.max(
    1,
    availableRows - composer.lines.length - 3,
  );
  const viewport = buildChatViewport(messages, availableCols, messageRows, scrollOffset);
  const maxScrollOffset = Math.max(
    0,
    viewport.totalRows - viewport.maxVisibleRows,
  );
  const composerLayout: ComposerLayout = {
    startLine: viewport.maxVisibleRows + 3 + composer.inputRowStartIndex + 1,
    contentStartCol: composer.contentStartCol,
    rows: composer.inputRows,
  };
  const cursorPosition = getCursorPositionFromComposerLayout(composerLayout);
  const absoluteCursorPosition = cursorPosition
    ? {
        x: cursorOriginX + cursorPosition.x,
        y: cursorOriginY + cursorPosition.y,
      }
    : null;

  React.useEffect(() => {
    setActiveCursorEscape(
      absoluteCursorPosition
        ? buildHiddenCursorEscapeFromPosition(absoluteCursorPosition)
        : null,
    );
    return () => {
      setActiveCursorEscape(null);
    };
  }, [absoluteCursorPosition]);

  React.useEffect(() => {
    setScrollOffset((prev) => Math.min(prev, maxScrollOffset));
    setTargetScrollOffset((prev) => Math.min(prev, maxScrollOffset));
  }, [maxScrollOffset]);

  React.useEffect(() => {
    if (scrollOffset === targetScrollOffset) {
      return;
    }

    const interval = setInterval(() => {
      setScrollOffset((prev) => {
        if (prev === targetScrollOffset) {
          return prev;
        }

        const delta = targetScrollOffset - prev;
        const step = Math.max(
          1,
          Math.min(Math.abs(delta), Math.ceil(Math.abs(delta) * 0.35)),
        );
        return prev + Math.sign(delta) * step;
      });
    }, SCROLL_ANIMATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [scrollOffset, targetScrollOffset]);

  const applyScroll = useCallback((direction: "up" | "down", kind: "page" | "line") => {
    setTargetScrollOffset((prev) => {
      const amount = kind === "page" ? viewport.maxVisibleRows : SCROLL_LINE_STEP;
      const delta = direction === "up" ? amount : -amount;
      return Math.max(0, Math.min(maxScrollOffset, prev + delta));
    });
  }, [maxScrollOffset, viewport.maxVisibleRows]);

  const handleSubmit = useCallback((value: string) => {
    logTuiDebug("fullscreen-chat", "submit-attempt", {
      value,
      hasMatches,
      isProcessing,
    });
    if (hasMatches || isProcessing) return;
    if (!value.trim()) {
      setEmptyHint(true);
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
      emptyHintTimer.current = setTimeout(() => setEmptyHint(false), 1500);
      return;
    }

    const trimmed = value.trim();
    if (trimmed === "/clear") {
      onClear?.();
      setInput("");
      setCursorOffset(0);
      clearSelection();
      setHistory((prev) => [...prev, trimmed]);
      setHistoryIdx(-1);
      setScrollOffset(0);
      setTargetScrollOffset(0);
      return;
    }

    onSubmit(trimmed);
    setInput("");
    setCursorOffset(0);
    clearSelection();
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setScrollOffset(0);
    setTargetScrollOffset(0);
  }, [clearSelection, hasMatches, isProcessing, onClear, onSubmit]);

  useInput((inputChar, key) => {
    logTuiDebug("fullscreen-chat", "input-event", {
      inputChar,
      key: summarizeKey(key as Record<string, unknown>),
      input,
      cursorOffset,
      selection: normalizedSelection,
      historyIdx,
    });
    const scrollRequest = getScrollRequest(inputChar, key);
    if (scrollRequest) {
      logTuiDebug("fullscreen-chat", "scroll-request", {
        direction: scrollRequest.direction,
        kind: scrollRequest.kind,
      });
      applyScroll(scrollRequest.direction, scrollRequest.kind);
      return;
    }

    const mouseEvent = parseMouseEvent(inputChar);
    if (mouseEvent && mouseEvent.kind !== "wheel" && mouseEvent.button === "left") {
      const offset = getMouseOffsetFromComposer(
        composerLayout,
        mouseEvent.x,
        mouseEvent.y,
        mouseEvent.kind !== "press" && selectionAnchor.current !== null,
      );

      if (mouseEvent.kind === "release" && offset === null) {
        selectionAnchor.current = null;
        return;
      }

      if (offset !== null) {
        justSelected.current = false;
        setCursorOffset(offset);

        if (mouseEvent.kind === "press") {
          selectionAnchor.current = offset;
          setSelection({ anchor: offset, focus: offset });
        } else if (mouseEvent.kind === "drag" && selectionAnchor.current !== null) {
          setSelection({ anchor: selectionAnchor.current, focus: offset });
        } else if (mouseEvent.kind === "release" && selectionAnchor.current !== null) {
          const nextSelection = { anchor: selectionAnchor.current, focus: offset };
          selectionAnchor.current = null;
          setSelection(nextSelection.anchor === nextSelection.focus ? null : nextSelection);
        }
        return;
      }
    }

    if (key.return && key.shift) {
      logTuiDebug("fullscreen-chat", "insert-newline", { cursorOffset });
      insertText("\n");
      return;
    }

    if (hasMatches) {
      if (key.upArrow) {
        setSelectedIdx((prev) => (prev <= 0 ? matches.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((prev) => (prev >= matches.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.tab || key.return) {
        const selected = matches[selectedIdx];
        if (selected) {
          const value =
            selected.type === "goal"
              ? `${selected.name} ${selected.description}`
              : selected.name;
          setInput(value);
          setCursorOffset(value.length);
          clearSelection();
          setSelectedIdx(0);
          justSelected.current = true;
        }
        return;
      }
      if (key.escape) {
        setSelectedIdx(0);
        setInput("");
        setCursorOffset(0);
        clearSelection();
        return;
      }
    }

    if (key.return) {
      handleSubmit(input);
      return;
    }

    if (key.leftArrow) {
      if (normalizedSelection) {
        setCursorOffset(normalizedSelection.start);
        clearSelection();
        return;
      }
      setCursorOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      if (normalizedSelection) {
        setCursorOffset(normalizedSelection.end);
        clearSelection();
        return;
      }
      setCursorOffset((prev) => Math.min(input.length, prev + 1));
      return;
    }
    if ((key.ctrl && inputChar === "a") || key.home) {
      setCursorOffset(0);
      clearSelection();
      return;
    }
    if ((key.ctrl && inputChar === "e") || key.end) {
      setCursorOffset(input.length);
      clearSelection();
      return;
    }
    if (isBackspaceInput(inputChar, key)) {
      logTuiDebug("fullscreen-chat", "backspace-detected", {
        inputChar,
        key: summarizeKey(key as Record<string, unknown>),
        cursorOffset,
        input,
        selection: normalizedSelection,
      });
      if (deleteSelection()) {
        logTuiDebug("fullscreen-chat", "backspace-delete-selection", {});
        return;
      }
      if (cursorOffset > 0) {
        const previousOffset = getPreviousOffset(input, cursorOffset);
        const next = input.slice(0, previousOffset) + input.slice(cursorOffset);
        setInput(next);
        setCursorOffset(previousOffset);
        logTuiDebug("fullscreen-chat", "backspace-applied", {
          previousOffset,
          next,
        });
      } else {
        logTuiDebug("fullscreen-chat", "backspace-at-start", {});
      }
      return;
    }
    if (isDeleteInput(inputChar, key)) {
      logTuiDebug("fullscreen-chat", "delete-detected", {
        inputChar,
        key: summarizeKey(key as Record<string, unknown>),
        cursorOffset,
        input,
        selection: normalizedSelection,
      });
      if (deleteSelection()) {
        logTuiDebug("fullscreen-chat", "delete-selection", {});
        return;
      }
      if (cursorOffset < input.length) {
        const nextOffset = getNextOffset(input, cursorOffset);
        const next = input.slice(0, cursorOffset) + input.slice(nextOffset);
        setInput(next);
        logTuiDebug("fullscreen-chat", "delete-applied", {
          nextOffset,
          next,
        });
      } else {
        logTuiDebug("fullscreen-chat", "delete-at-end", {});
      }
      return;
    }

    if (key.upArrow) {
      if (history.length > 0) {
        clearSelection();
        if (historyIdx === -1) {
          setDraft(input);
          const idx = history.length - 1;
          setHistoryIdx(idx);
          setInput(history[idx]!);
          setCursorOffset(history[idx]!.length);
        } else if (historyIdx > 0) {
          const idx = historyIdx - 1;
          setHistoryIdx(idx);
          setInput(history[idx]!);
          setCursorOffset(history[idx]!.length);
        }
      }
      return;
    }
    if (key.downArrow && historyIdx !== -1) {
      clearSelection();
      if (historyIdx < history.length - 1) {
        const idx = historyIdx + 1;
        setHistoryIdx(idx);
        setInput(history[idx]!);
        setCursorOffset(history[idx]!.length);
      } else {
        setHistoryIdx(-1);
        setInput(draft);
        setCursorOffset(draft.length);
      }
      return;
    }

    if (inputChar && !key.ctrl && !key.meta) {
      const clean = stripMouseEscapeSequences(inputChar);
      if (clean.length === 0) return;
      insertText(clean);
    }
  }, { isActive: !isProcessing });

  React.useEffect(() => {
    setSelectedIdx(0);
  }, [matches.map((match) => match.name).join(",")]);

  React.useEffect(() => {
    return () => {
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
    };
  }, []);

  const lines: RenderLine[] = [];
  lines.push({
    key: "indicator-top",
    text: padToWidth(
      viewport.hiddenAboveRows > 0 ? `↑ ${viewport.hiddenAboveRows} earlier lines` : "",
      availableCols,
    ),
    dim: true,
  });

  const renderedRows = viewport.rows.map((row) => renderMessageRow(row, availableCols));
  const fillerCount = Math.max(0, viewport.maxVisibleRows - renderedRows.length);
  for (let index = 0; index < fillerCount; index += 1) {
    lines.push({ key: `filler-${index}`, text: " ".repeat(availableCols) });
  }
  lines.push(...renderedRows);

  lines.push({
    key: "processing",
    text: padToWidth(isProcessing ? `⠋ ${spinnerVerb}...` : "", availableCols),
    dim: !isProcessing,
  });
  lines.push({
    key: "indicator-bottom",
    text: padToWidth(
      viewport.hiddenBelowRows > 0 ? `↓ ${viewport.hiddenBelowRows} newer lines` : "",
      availableCols,
    ),
    dim: true,
  });
  lines.push(...composer.lines);

  while (lines.length < availableRows) {
    lines.push({
      key: `tail-filler-${lines.length}`,
      text: " ".repeat(availableCols),
    });
  }

  const visibleLines = lines.slice(0, availableRows);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visibleLines.map((line) => (
        <Box key={line.key} height={1} overflow="hidden">
          {line.segments ? (
            line.segments.map((segment, index) => (
              <Text
                key={`${line.key}-${index}`}
                color={segment.color ?? line.color}
                backgroundColor={segment.backgroundColor ?? line.backgroundColor}
                bold={segment.bold ?? line.bold}
                dimColor={segment.dim ?? line.dim}
              >
                {index === 0 && line.protected
                  ? `${PROTECTED_ROW_MARKER}${segment.text}`
                  : segment.text}
              </Text>
            ))
          ) : (
            <Text
              color={line.color}
              backgroundColor={line.backgroundColor}
              bold={line.bold}
              dimColor={line.dim}
            >
              {line.protected
                ? `${PROTECTED_ROW_MARKER}${line.text ?? ""}`
                : (line.text ?? "")}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
