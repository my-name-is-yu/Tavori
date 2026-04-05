import React, { useInsertionEffect } from "react";
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  ERASE_SCREEN,
  CURSOR_HOME,
} from "./dec.js";

interface AlternateScreenProps {
  children: React.ReactNode;
  /** When false, renders children without alt-screen (pass-through) */
  enabled?: boolean;
}

/**
 * React component that enters the alternate screen buffer on mount
 * and exits on unmount. Uses useInsertionEffect to ensure alt-screen
 * entry happens BEFORE Ink's first render frame.
 *
 * Reference: Claude Code src/ink/components/AlternateScreen.tsx
 *
 * Why useInsertionEffect?
 * - Ink's reconciler calls resetAfterCommit between mutation and layout phases
 * - resetAfterCommit triggers onRender, which writes the first frame
 * - useLayoutEffect fires AFTER resetAfterCommit -> first frame hits main buffer
 * - useInsertionEffect fires during mutation phase -> alt-screen is ready before first frame
 */
export function AlternateScreen({
  children,
  enabled = true,
}: AlternateScreenProps): React.ReactNode {
  useInsertionEffect(() => {
    if (!enabled) return;

    // Enter alt-screen, clear it, hide cursor
    process.stdout.write(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME + HIDE_CURSOR);

    return () => {
      // Show cursor, exit alt-screen (restores main buffer)
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    };
  }, [enabled]);

  return React.createElement(React.Fragment, null, children);
}
