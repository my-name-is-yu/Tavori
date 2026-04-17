/**
 * Scans rendered terminal output to find the input prompt row.
 * Used for IME candidate window positioning — avoids fragile arithmetic.
 */
import { measureTextWidth } from "./text-width.js";

// Unique invisible marker — won't appear in message history or the visible prompt.
export const INPUT_MARKER = "\u200B\u2060";
export const CARET_MARKER = "\u200B\u2061";
export const PROTECTED_ROW_MARKER = "\u2062\u2063";
let activeCursorEscape: string | null = null;
let activePromptCursorAnchor: PromptCursorAnchor | null = null;
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface PromptCursorAnchor {
  promptLabel: string;
  caretRowOffset: number;
  caretColumnOffset: number;
}

function displayWidth(text: string): number {
  const normalized = text
    .replace(ESCAPE_SEQUENCE, "")
    .replaceAll(INPUT_MARKER, "")
    .replaceAll(CARET_MARKER, "")
    .replaceAll(PROTECTED_ROW_MARKER, "");
  return measureTextWidth(normalized);
}

function findInputMarkerPosition(frame: string): { row: number; col: number } | null {
  return findMarkerPosition(frame, INPUT_MARKER);
}

function findMarkerPosition(
  frame: string,
  marker: string,
): { row: number; col: number } | null {
  const lines = frame.split("\n");
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const markerIndex = line.indexOf(marker);
    if (markerIndex >= 0) {
      return {
        row,
        col: displayWidth(line.slice(0, markerIndex)),
      };
    }
  }
  return null;
}

function findPromptPosition(frame: string, promptLabel: string): { row: number; col: number } | null {
  const lines = frame.split("\n");
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    const line = lines[row] ?? "";
    if (!line.includes("│")) continue;

    const markerIndex = line.indexOf(promptLabel);
    if (markerIndex >= 0) {
      return {
        row,
        col: displayWidth(line.slice(0, markerIndex)),
      };
    }
  }

  return null;
}

/**
 * Find the row index of the input prompt in a rendered frame.
 * Returns null if the marker is not found (e.g., overlay is showing).
 */
export function findCursorRow(frame: string): number | null {
  return findInputMarkerPosition(frame)?.row ?? null;
}

/**
 * Compute the cursor x-position from the marker column and input text.
 * The marker is rendered at the input start column. CJK chars = 2 columns each.
 */
export function computeCursorX(frame: string, input: string): number | null {
  const position = findInputMarkerPosition(frame);
  if (!position) return null;

  let width = position.col;
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    width += cp > 0x2E7F ? 2 : 1;
  }
  return width;
}

/**
 * Write ANSI escape to position the terminal cursor at the input caret.
 * Called directly from the stdout intercept — no React state involved.
 */
export function positionCursorInFrame(
  frame: string,
  inputText: string,
  write: (s: string) => boolean,
): void {
  const row = findCursorRow(frame);
  const x = computeCursorX(frame, inputText);
  if (row === null || x === null) return;
  // ANSI CSI: move to row;col (1-indexed)
  write(`\x1b[${row + 1};${x + 1}H`);
}

/**
 * Build the cursor-positioning escape sequence as a string.
 * Used by chat.tsx in no-flicker mode to concatenate cursor positioning
 * into the frame before the frame writer processes it (inside BSU/ESU block).
 */
export function buildCursorEscape(
  frame: string,
  inputText: string,
): string | null {
  const row = findCursorRow(frame);
  const x = computeCursorX(frame, inputText);
  if (row === null || x === null) return null;
  return `\x1b[${row + 1};${x + 1}H`;
}

export function buildCursorEscapeFromInputMarker(
  frame: string,
  cursorColumns: number,
): string | null {
  const position = findMarkerPosition(frame, INPUT_MARKER);
  if (!position) return null;
  return `\x1b[${position.row + 1};${position.col + cursorColumns + 1}H\x1b[?25h`;
}

export function buildCursorEscapeFromCaretMarker(frame: string): string | null {
  const position = findMarkerPosition(frame, CARET_MARKER);
  if (!position) return null;
  return `\x1b[${position.row + 1};${position.col + 1}H\x1b[?25h`;
}

export function buildHiddenCursorEscapeFromCaretMarker(frame: string): string | null {
  const position = findMarkerPosition(frame, CARET_MARKER);
  if (!position) return null;
  return `\x1b[${position.row + 1};${position.col + 1}H\x1b[?25l`;
}

export function buildHiddenCursorEscapeFromPosition(position: { x: number; y: number }): string {
  return `\x1b[${position.y + 1};${position.x + 1}H\x1b[?25l`;
}

export function setActiveCursorEscape(cursorEscape: string | null): void {
  activeCursorEscape = cursorEscape;
}

export function getActiveCursorEscape(): string | null {
  return activeCursorEscape;
}

export function setActivePromptCursorAnchor(anchor: PromptCursorAnchor | null): void {
  activePromptCursorAnchor = anchor;
}

export function buildCursorEscapeFromPromptAnchor(frame: string): string | null {
  if (!activePromptCursorAnchor) return null;

  const promptPosition = findPromptPosition(
    frame,
    activePromptCursorAnchor.promptLabel,
  );
  if (!promptPosition) return null;

  const promptWidth = displayWidth(`${activePromptCursorAnchor.promptLabel} `);
  const row = promptPosition.row + activePromptCursorAnchor.caretRowOffset + 1;
  const col = promptPosition.col + promptWidth + activePromptCursorAnchor.caretColumnOffset + 1;
  return `\x1b[${row};${col}H\x1b[?25l`;
}
