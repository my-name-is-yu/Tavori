import { loadGlobalConfig } from "../../../base/config/global-config.js";

export { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, BSU, ESU, CURSOR_HOME, ERASE_SCREEN, HIDE_CURSOR, SHOW_CURSOR, ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, parkCursor } from "./dec.js";
export { isSynchronizedOutputSupported, isTmuxCC } from "./terminal-detect.js";
export { createFrameWriter, type FrameWriter } from "./frame-writer.js";
export { AlternateScreen } from "./AlternateScreen.js";
export { MouseTracking, attachMouseTracking } from "./MouseTracking.js";

/**
 * Check if no-flicker mode is enabled.
 * Priority: PULSEED_NO_FLICKER env var > ~/.pulseed/config.json no_flicker field.
 */
export async function isNoFlickerEnabled(): Promise<boolean> {
  // Env var takes priority (explicit override)
  const envVal = process.env.PULSEED_NO_FLICKER;
  if (envVal) {
    return envVal === "1" || envVal.toLowerCase() === "true";
  }
  // Fall back to config file
  const config = await loadGlobalConfig();
  return config.no_flicker;
}
