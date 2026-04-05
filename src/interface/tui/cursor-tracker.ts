/**
 * Scans rendered terminal output to find the input prompt row.
 * Used for IME candidate window positioning — avoids fragile arithmetic.
 */

// Unique marker: zero-width space + ◉ — won't appear in message history
const INPUT_MARKER = "\u200B\u25C9";

/**
 * Find the row index of the input prompt in a rendered frame.
 * Returns null if the marker is not found (e.g., overlay is showing).
 */
export function findCursorRow(frame: string): number | null {
  const lines = frame.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(INPUT_MARKER)) {
      return i;
    }
  }
  return null;
}

/**
 * Compute the cursor x-position from input text.
 * Prompt "◉ " = 2 columns. CJK chars = 2 columns each.
 */
export function computeCursorX(input: string): number {
  let width = 2; // "◉ " prefix
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
  if (row === null) return;
  const x = computeCursorX(inputText);
  // ANSI CSI: move to row;col (1-indexed) and show cursor
  write(`\x1b[${row + 1};${x + 1}H\x1b[?25h`);
}
