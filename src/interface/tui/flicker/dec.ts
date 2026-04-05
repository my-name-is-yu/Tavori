// DEC Private Mode escape sequences for no-flicker rendering
// Reference: Claude Code src/ink/termio/dec.ts

/** Enter alternate screen buffer (DEC 1049 set) */
export const ENTER_ALT_SCREEN = "[?1049h";

/** Exit alternate screen buffer (DEC 1049 reset) */
export const EXIT_ALT_SCREEN = "[?1049l";

/** Begin Synchronized Update (DEC 2026 set) — terminal holds display */
export const BSU = "[?2026h";

/** End Synchronized Update (DEC 2026 reset) — terminal flushes display */
export const ESU = "[?2026l";

/** Move cursor to home position (0,0) */
export const CURSOR_HOME = "[H";

/** Erase entire screen */
export const ERASE_SCREEN = "[2J";

/** Hide cursor */
export const HIDE_CURSOR = "[?25l";

/** Show cursor */
export const SHOW_CURSOR = "[?25h";

/** Build a cursor-park sequence for the given terminal row */
export function parkCursor(rows: number): string {
  return `[${rows};1H`;
}
