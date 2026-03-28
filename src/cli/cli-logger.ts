import { Logger } from "../runtime/logger.js";
import { getLogsDir } from "../utils/paths.js";

// Shared Logger instance for all CLI commands
// Logs to ~/.pulseed/logs/ (same dir used by daemon/run commands)
let _cliLogger: Logger | null = null;

export function getCliLogger(): Logger {
  if (!_cliLogger) {
    _cliLogger = new Logger({ dir: getLogsDir(), level: "warn", consoleOutput: true });
  }
  return _cliLogger;
}
