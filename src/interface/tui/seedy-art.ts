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

// ---------------------------------------------------------------------------
// SEEDY_PIXEL  — half-block pixel art (9 cols × 5 terminal lines)
//
// Source: assets/seedy.piskel (32×32 sprite, 9×9 non-transparent bounding box)
// Rendering: each pair of pixel rows (top, bottom) maps to one terminal line
// using ▀ (upper half-block) with ANSI 24-bit foreground/background colors.
// Row pairs: (0,1), (2,3), (4,5), (6,7), (8,∅) → 5 terminal lines.
//
// Colors:
//   1 = green  (#4CAF50)  → fg 76;175;80
//   2 = cream  (#F5F0E8)  → fg 245;240;232  (matches CREAM above)
//   3 = black  (near-blk) → fg 30;30;30     (matches BLACK above)
//   0 = transparent       → space or omitted from fg/bg
// ---------------------------------------------------------------------------

// Pixel grid (9 columns × 9 rows):
// 0=transparent, 1=green, 2=cream, 3=black
const _PIXEL_GRID: readonly (readonly number[])[] = [
  [0, 1, 1, 1, 0, 1, 1, 1, 0], // row 0
  [1, 1, 1, 1, 1, 1, 1, 1, 1], // row 1
  [0, 0, 0, 0, 1, 0, 0, 0, 0], // row 2
  [0, 0, 2, 2, 2, 2, 2, 0, 0], // row 3
  [0, 2, 2, 2, 2, 2, 2, 2, 0], // row 4
  [2, 2, 2, 3, 2, 2, 3, 2, 2], // row 5
  [2, 2, 2, 2, 2, 2, 2, 2, 2], // row 6
  [0, 2, 2, 2, 2, 2, 2, 2, 0], // row 7
  [0, 0, 2, 2, 2, 2, 2, 0, 0], // row 8
] as const;

const _PIXEL_COLORS: Record<number, [number, number, number]> = {
  1: [76, 175, 80],    // green  #4CAF50
  2: [245, 240, 232],  // cream  #F5F0E8
  3: [30, 30, 30],     // black  near-black
};

function _buildPixelArt(): string {
  const _R = "\x1b[0m";
  const _fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
  const _bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

  const rowPairs: [number, number | null][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], [8, null],
  ];

  const lines: string[] = [];

  for (const [topIdx, botIdx] of rowPairs) {
    const topRow = _PIXEL_GRID[topIdx];
    const botRow = botIdx !== null ? _PIXEL_GRID[botIdx] : Array(9).fill(0);
    let line = "";

    for (let col = 0; col < 9; col++) {
      const tp = topRow[col];
      const bp = botRow[col];

      if (tp === 0 && bp === 0) {
        line += " ";
      } else if (tp !== 0 && bp === 0) {
        const [r, g, b] = _PIXEL_COLORS[tp];
        line += _fg(r, g, b) + "▀" + _R;
      } else if (tp === 0 && bp !== 0) {
        const [r, g, b] = _PIXEL_COLORS[bp];
        line += _fg(r, g, b) + "▄" + _R;
      } else {
        const [tr, tg, tb] = _PIXEL_COLORS[tp];
        const [br, bg_, bb] = _PIXEL_COLORS[bp];
        line += _fg(tr, tg, tb) + _bg(br, bg_, bb) + "▀" + _R;
      }
    }
    lines.push(line);
  }

  return lines.join("\n");
}

/** Pre-built ANSI pixel art of Seedy — 9 cols wide × 5 terminal lines tall */
export const SEEDY_PIXEL: string = _buildPixelArt();

// ---------------------------------------------------------------------------
// getSeedyArt — updated to support "pixel" size
// ---------------------------------------------------------------------------

export type SeedySize = "small" | "medium" | "pixel";

/**
 * Returns the ANSI-colored Seedy art string for a given state and size.
 *
 * @param state  - Emotional/activity state of Seedy (default: 'default')
 * @param size   - 'small' (~7 lines), 'medium' (~12 lines), or 'pixel' (9×5 half-block art)
 * @returns Multi-line string with embedded ANSI escape codes
 */
export function getSeedyArt(state: SeedyState = "default", size: SeedySize = "small"): string {
  if (size === "pixel") {
    return SEEDY_PIXEL;
  }
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

