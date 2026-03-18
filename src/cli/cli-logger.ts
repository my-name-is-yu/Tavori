import { Logger } from "../runtime/logger.js";
import * as path from "node:path";
import * as os from "node:os";

// Shared Logger instance for all CLI commands
// Logs to ~/.motiva/logs/ (same dir used by daemon/run commands)
let _cliLogger: Logger | null = null;

export function getCliLogger(): Logger {
  if (!_cliLogger) {
    const motivaDir = path.join(os.homedir(), ".motiva", "logs");
    _cliLogger = new Logger({ dir: motivaDir, level: "warn", consoleOutput: true });
  }
  return _cliLogger;
}
