// ─── Conatus Path Utilities ───
//
// Centralizes ~/.conatus path construction.
// CONATUS_HOME env var overrides the default ~/.conatus location.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the Conatus base directory.
 * Defaults to ~/.conatus; can be overridden via CONATUS_HOME env var.
 */
export function getMotivaDirPath(): string {
  return process.env["CONATUS_HOME"] ?? path.join(os.homedir(), ".conatus");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getMotivaDirPath(), "reports");
}
