// ─── PulSeed Path Utilities ───
//
// Centralizes ~/.pulseed path construction.
// PULSEED_HOME env var overrides the default ~/.pulseed location.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the PulSeed base directory.
 * Defaults to ~/.pulseed; can be overridden via PULSEED_HOME env var.
 */
export function getPulseedDirPath(): string {
  return process.env["PULSEED_HOME"] ?? path.join(os.homedir(), ".pulseed");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getPulseedDirPath(), "reports");
}
