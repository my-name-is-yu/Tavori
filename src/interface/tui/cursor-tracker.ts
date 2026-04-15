/**
 * Scans rendered terminal output to find the input prompt row.
 * Used for IME candidate window positioning — avoids fragile arithmetic.
 */

// Unique invisible marker — won't appear in message history or the visible prompt.
export const INPUT_MARKER = "\u200B\u2060";
const ZERO_WIDTH_SPACE = "\u200B";
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

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
