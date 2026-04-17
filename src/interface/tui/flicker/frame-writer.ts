import {
  BSU,
  ESU,
  CURSOR_HOME,
  ERASE_LINE,
  ERASE_SCREEN,
  cursorTo,
  parkCursor,
} from "./dec.js";
import { PROTECTED_ROW_MARKER } from "../cursor-tracker.js";
import { logTuiDebug } from "../debug-log.js";
import { isSynchronizedOutputSupported } from "./terminal-detect.js";

export interface FrameWriter {
  /** Write a frame to the terminal, wrapped in BSU/ESU with cursor-home */
  write(frame: string, cursorEscape?: string): void;
  /** Request an erase-screen on the next write (deferred into BSU/ESU block) */
  requestErase(): void;
  /** Clean up resources */
  destroy(): void;
}

interface ParsedLine {
  protected: boolean;
  text: string;
}

/**
 * Create a FrameWriter that wraps Ink's stdout output with the
 * BSU/ESU + cursor-home + deferred-erase sequence.
 *
 * Reference: Claude Code src/ink/ink.tsx render loop
 */
export function createFrameWriter(stream: NodeJS.WriteStream): FrameWriter {
  const syncSupported = isSynchronizedOutputSupported();
  // Capture raw write before the session controller patches stdout/stderr:
  // renderStdout.write -> frameWriter.write -> raw stream.write
  // If stream.write is wrapped, it would recurse or swallow frames.
  const rawWrite = stream.write.bind(stream) as (s: string) => boolean;
  let needsErase = false;
  let destroyed = false;
  let lastLines: ParsedLine[] | null = null;
  let lastCursorEscape: string | null = null;

  function getTermRows(): number {
    return stream.rows ?? 24;
  }

  function joinFrame(lines: ParsedLine[]): string {
    return lines.map((line) => line.text).join("\n");
  }

  function buildFullFrame(lines: ParsedLine[], finalCursor: string): string {
    const prefix = syncSupported ? BSU : "";
    const suffix = syncSupported ? ESU : "";
    const erase = needsErase ? ERASE_SCREEN : "";
    const trailingCursor = syncSupported ? finalCursor : "";
    return prefix + erase + CURSOR_HOME + joinFrame(lines) + finalCursor + suffix + trailingCursor;
  }

  function splitFrame(frame: string): ParsedLine[] {
    return frame.split("\n").map((line) => ({
      protected: line.startsWith(PROTECTED_ROW_MARKER),
      text: line.startsWith(PROTECTED_ROW_MARKER)
        ? line.slice(PROTECTED_ROW_MARKER.length)
        : line,
    }));
  }

  function buildDiffFrame(nextLines: ParsedLine[], finalCursor: string): string {
    const prefix = syncSupported ? BSU : "";
    const suffix = syncSupported ? ESU : "";
    const trailingCursor = syncSupported ? finalCursor : "";
    const previousLines = lastLines ?? [];
    const maxLines = Math.max(previousLines.length, nextLines.length);
    let output = "";

    for (let index = 0; index < maxLines; index += 1) {
      const row = index + 1;
      const previousLine = previousLines[index];
      const nextLine = nextLines[index];
      const previousText = previousLine?.text ?? "";
      const nextText = nextLine?.text ?? "";

      if (previousText === nextText) {
        continue;
      }

      output += cursorTo(row);
      if (nextLine?.protected) {
        if (nextText.length > 0) {
          output += nextText;
        }
        continue;
      }

      output += ERASE_LINE;
      if (nextText.length > 0) {
        output += nextText;
      }
    }

    if (output.length === 0 && lastCursorEscape === finalCursor) {
      return "";
    }

    return prefix + output + finalCursor + suffix + trailingCursor;
  }

  return {
    write(frame: string, cursorEscape?: string): void {
      if (destroyed) return;

      const rows = getTermRows();
      const finalCursor = cursorEscape ?? parkCursor(rows);
      const nextLines = splitFrame(frame);
      const shouldRenderFullFrame = needsErase || lastLines === null;
      const output = shouldRenderFullFrame
        ? buildFullFrame(nextLines, finalCursor)
        : buildDiffFrame(nextLines, finalCursor);

      logTuiDebug("frame-writer", "write", {
        mode: shouldRenderFullFrame ? "full" : "diff",
        rows,
        nextLineCount: nextLines.length,
        outputLength: output.length,
        hasCursorEscape: cursorEscape !== undefined,
      });

      if (output.length > 0) {
        // Single rawWrite() call for atomicity — bypasses any stdout patches
        rawWrite(output);
      }

      needsErase = false;
      lastLines = nextLines;
      lastCursorEscape = finalCursor;
    },

    requestErase(): void {
      needsErase = true;
      lastLines = null;
      lastCursorEscape = null;
    },

    destroy(): void {
      destroyed = true;
      lastLines = null;
      lastCursorEscape = null;
    },
  };
}
