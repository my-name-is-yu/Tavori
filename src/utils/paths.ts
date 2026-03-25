// ─── SeedPulse Path Utilities ───
//
// Centralizes ~/.seedpulse path construction.
// SEEDPULSE_HOME env var overrides the default ~/.seedpulse location.
// TAVORI_HOME is accepted as a deprecated fallback for SEEDPULSE_HOME.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Migrate data from the legacy ~/.tavori/ directory to ~/.seedpulse/.
 * Safe to call multiple times (idempotent).
 */
export function migrateFromLegacyDir(): void {
  const newDir = path.join(os.homedir(), ".seedpulse");
  const oldDir = path.join(os.homedir(), ".tavori");
  if (fs.existsSync(newDir)) return; // already migrated
  if (!fs.existsSync(oldDir)) return; // nothing to migrate
  fs.cpSync(oldDir, newDir, { recursive: true });
  process.stdout.write("Migrated data from ~/.tavori/ to ~/.seedpulse/\n");
}

/**
 * Returns the SeedPulse base directory.
 * Defaults to ~/.seedpulse; can be overridden via SEEDPULSE_HOME (or deprecated TAVORI_HOME) env var.
 */
export function getTavoriDirPath(): string {
  if (process.env["TAVORI_HOME"]) {
    process.stderr.write(
      "Deprecation warning: TAVORI_HOME is deprecated. Use SEEDPULSE_HOME instead.\n"
    );
    return process.env["TAVORI_HOME"];
  }
  migrateFromLegacyDir();
  return process.env["SEEDPULSE_HOME"] ?? path.join(os.homedir(), ".seedpulse");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getTavoriDirPath(), "reports");
}
