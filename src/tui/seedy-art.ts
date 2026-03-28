/**
 * Seedy — PulSeed mascot pixel art
 *
 * A cute round cream/white seed with a green sprout on top and two black oval eyes.
 * Uses Unicode box-drawing / block characters and ANSI 24-bit color escape codes.
 *
 * Sizes:
 *   small  — ~7 terminal lines, suitable for status bars and inline use
 *   medium — ~12 terminal lines, suitable for splash screens and help views
 *
 * States (small size only; medium falls back to default):
 *   default  — neutral ● eyes, small ▾ mouth
 *   thinking — upward-tilted ◝◞ eyes, dot trail
 *   success  — closed ^ ^ eyes, ‿ smile
 *   error    — > < stressed eyes, ︵ frown
 *   active   — ★ sparkle eyes, tilted stem
 */

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const R = "\x1b[0m"; // reset all attributes

const CREAM = "\x1b[38;2;245;240;232m"; // #F5F0E8 — body
const GREEN = "\x1b[38;2;76;175;80m"; // #4CAF50 — leaves
const STEM = "\x1b[38;2;102;187;106m"; // #66BB6A — stem
const BLACK = "\x1b[38;2;30;30;30m"; // near-black — eyes
const BLUSH = "\x1b[38;2;255;182;193m"; // pink — cheek blush

// Colorizer shortcuts
const c = (s: string) => CREAM + s + R;
const g = (s: string) => GREEN + s + R;
const s = (s: string) => STEM + s + R;
const e = (s: string) => BLACK + s + R;
const b = (s: string) => BLUSH + s + R;

// ---------------------------------------------------------------------------
// SEEDY_SMALL  (~7 lines)
// ---------------------------------------------------------------------------

export const SEEDY_SMALL: string =
  `    ${s("│")}    \n` +
  `  ${g("╭╩╮")}   \n` +
  ` ${c("╭─────╮")}  \n` +
  ` ${c("│")} ${e("●")} ${c("●")} ${c("│")}  \n` +
  ` ${c("│  ▾  │")}  \n` +
  ` ${c("╰─────╯")}  \n` +
  `  ${c("╰───╯")}   `;

// ---------------------------------------------------------------------------
// SEEDY_MEDIUM  (~12 lines)
// ---------------------------------------------------------------------------

export const SEEDY_MEDIUM: string =
  `      ${s("│")}      \n` +
  `    ${g("╭╩─╮")}    \n` +
  `  ${g("╭─╯")}  ${g("╰─╮")}  \n` +
  `   ${g("╰──┬──╯")}   \n` +
  `  ${c("╭───────╮")}  \n` +
  ` ${c("╭─────────╮")} \n` +
  ` ${c("│")} ${e("◉")} ${c("   ")} ${e("◉")} ${c("│")} \n` +
  ` ${c("│  ")}${b("·")}${c("     ")}${b("·")}${c("  │")} \n` +
  ` ${c("│    ‿    │")} \n` +
  ` ${c("╰─────────╯")} \n` +
  `  ${c("╰───────╯")}  `;

// ---------------------------------------------------------------------------
// State variants  (SMALL size)
// ---------------------------------------------------------------------------

/** Eyes tilted up-right — Seedy is thinking */
export const SEEDY_THINKING: string =
  `    ${s("│")}    \n` +
  `  ${g("╭╩╮")}   \n` +
  ` ${c("╭─────╮")}  \n` +
  ` ${c("│")} ${e("◝")} ${c("◞")} ${c("│")}  \n` +
  ` ${c("│  ···│")}  \n` +
  ` ${c("╰─────╯")}  \n` +
  `  ${c("╰───╯")}   `;

/** Closed ^ ^ eyes with ‿ smile — success */
export const SEEDY_SUCCESS: string =
  `    ${s("│")}    \n` +
  `  ${g("╭╩╮")}   \n` +
  ` ${c("╭─────╮")}  \n` +
  ` ${c("│")} ${e("^")} ${c("^")} ${c("│")}  \n` +
  ` ${c("│")}  ${c("‿")}  ${c("│")}  \n` +
  ` ${c("╰─────╯")}  \n` +
  `  ${c("╰───╯")}   `;

/** Stressed > < eyes with ︵ frown — error */
export const SEEDY_ERROR: string =
  `    ${s("│")}    \n` +
  `  ${g("╭╩╮")}   \n` +
  ` ${c("╭─────╮")}  \n` +
  ` ${c("│")} ${e(">")} ${c("<")} ${c("│")}  \n` +
  ` ${c("│")}  ${c("︵")}  ${c("│")}  \n` +
  ` ${c("╰─────╯")}  \n` +
  `  ${c("╰───╯")}   `;

/** Tilted stem, ★ sparkle eyes — actively running */
export const SEEDY_ACTIVE: string =
  `   ${s("╱")}${g("❧")}    \n` +
  `  ${g("╭╩╮")}   \n` +
  ` ${c("╭─────╮")}  \n` +
  ` ${c("│")} ${e("★")} ${c("★")} ${c("│")}  \n` +
  ` ${c("│  ‿  │")}  \n` +
  ` ${c("╰─────╯")}  \n` +
  `  ${c("╰───╯")}   `;

// ---------------------------------------------------------------------------
// Plain ASCII  (no ANSI — for logs, markdown, non-color terminals)
// ---------------------------------------------------------------------------

/** Full ASCII Seedy, 8 lines, no color codes */
export const SEEDY_ASCII: string = [
  "    |    ",
  "  (╚╦╗)  ",
  " /       \\",
  "|  o   o  |",
  "|    ‿    |",
  " \\       /",
  "  \\_____/ ",
].join("\n");

/** Compact 5-line ASCII Seedy */
export const SEEDY_ASCII_COMPACT: string = [
  "  |  ",
  "(╚╗) ",
  "(o o)",
  "( ‿ )",
  "\\___/",
].join("\n");

// ---------------------------------------------------------------------------
// getSeedyArt — convenience accessor
// ---------------------------------------------------------------------------

export type SeedyState = "default" | "thinking" | "success" | "error" | "active";
export type SeedySize = "small" | "medium";

/**
 * Returns the ANSI-colored Seedy art string for a given state and size.
 *
 * @param state  - Emotional/activity state of Seedy (default: 'default')
 * @param size   - 'small' (~7 lines) or 'medium' (~12 lines) (default: 'small')
 * @returns Multi-line string with embedded ANSI escape codes
 *
 * @example
 * console.log(getSeedyArt('success', 'small'));
 * console.log(getSeedyArt('default', 'medium'));
 */
export function getSeedyArt(state: SeedyState = "default", size: SeedySize = "small"): string {
  if (size === "medium") {
    return SEEDY_MEDIUM; // medium only has a default variant
  }

  switch (state) {
    case "thinking":
      return SEEDY_THINKING;
    case "success":
      return SEEDY_SUCCESS;
    case "error":
      return SEEDY_ERROR;
    case "active":
      return SEEDY_ACTIVE;
    default:
      return SEEDY_SMALL;
  }
}
