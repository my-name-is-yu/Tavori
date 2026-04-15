/**
 * Scans rendered terminal output to find the input prompt row.
 * Used for IME candidate window positioning — avoids fragile arithmetic.
 */

// Unique marker: zero-width space + ◉ — won't appear in message history
export const INPUT_MARKER = "\u200B\u25C9";
const ZERO_WIDTH_SPACE = "\u200B";
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const PROMPT_WIDTH = 2; // "◉ " prefix

function displayWidth(text: string): number {
  let width = 0;
  for (const segment of text
    .replace(ESCAPE_SEQUENCE, "")
    .split(ZERO_WIDTH_SPACE)
    .join("")) {
    const cp = segment.codePointAt(0) ?? 0;
    width += cp > 0x2E7F ? 2 : 1;
  }
  return width;
}

function findInputMarkerPosition(frame: string): { row: number; col: number } | null {
  const lines = frame.split("\n");
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const markerIndex = line.indexOf(INPUT_MARKER);
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
 * Prompt "◉ " = 2 columns. CJK chars = 2 columns each.
 */
export function computeCursorX(frame: string, input: string): number | null {
  const position = findInputMarkerPosition(frame);
  if (!position) return null;

  let width = position.col + PROMPT_WIDTH;
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
  // ANSI CSI: move to row;col (1-indexed) and show cursor
  write(`\x1b[${row + 1};${x + 1}H\x1b[?25h`);
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
  return `[${row + 1};${x + 1}H[?25h`;
}
