// ─── pulseed logs command ───
//
// Shows daemon log lines from ~/.pulseed/logs/pulseed.log
// Supports: --lines N, --level <level>, --follow/-f

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir } from "../../utils/paths.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const READ_CHUNK_SIZE = 64 * 1024; // 64KB

function parseLevel(raw: string): LogLevel | null {
  const upper = raw.toUpperCase() as LogLevel;
  return upper in LEVEL_ORDER ? upper : null;
}

function lineMatchesLevel(line: string, minLevel: LogLevel): boolean {
  // Log format: [<ISO timestamp>] [<LEVEL padded 5>] ...
  // e.g. [2026-04-01T00:00:00.000Z] [ERROR] message
  const match = line.match(/\[([A-Z ]{4,5})\]/);
  if (!match || !match[1]) return false;
  const found = match[1].trim() as LogLevel;
  if (!(found in LEVEL_ORDER)) return false;
  return LEVEL_ORDER[found] >= LEVEL_ORDER[minLevel];
}

/**
 * Read the last N lines from a file efficiently by reading a chunk from the end.
 */
function readLastLines(filePath: string, n: number): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  if (stat.size === 0) return [];

  const readSize = Math.min(READ_CHUNK_SIZE, stat.size);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
  } finally {
    fs.closeSync(fd);
  }

  const content = buffer.toString("utf8");
  const lines = content.split("\n");

  // Remove trailing empty entry from trailing newline
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.slice(-n);
}

/**
 * Follow a log file, printing new lines as they are appended.
 * Handles file rotation by re-opening when the file is replaced.
 */
async function followLog(filePath: string, minLevel: LogLevel | null): Promise<void> {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    // File may not exist yet; start at 0
  }

  let watcher: fs.FSWatcher | null = null;
  let stopped = false;

  const checkForNewLines = () => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < fileSize) {
        // File was rotated/truncated — reset position
        fileSize = 0;
      }
      if (stat.size === fileSize) return;

      const toRead = stat.size - fileSize;
      const buf = Buffer.alloc(toRead);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buf, 0, toRead, fileSize);
      } finally {
        fs.closeSync(fd);
      }
      fileSize = stat.size;

      const chunk = buf.toString("utf8");
      const lines = chunk.split("\n");
      // The last element may be an incomplete line if the write was partial;
      // for simplicity, print complete lines only (those followed by \n)
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        if (minLevel === null || lineMatchesLevel(line, minLevel)) {
          process.stdout.write(line + "\n");
        }
      }
    } catch {
      // File disappeared (rotation in progress) — will retry on next event
    }
  };

  // Initial drain in case file already has content
  checkForNewLines();

  const setupWatcher = () => {
    try {
      watcher = fs.watch(filePath, () => {
        checkForNewLines();
      });
      watcher.on("error", () => {
        // Watch target gone; re-try after a short delay
        watcher = null;
        if (!stopped) setTimeout(setupWatcher, 500);
      });
    } catch {
      // File may not exist yet; retry
      if (!stopped) setTimeout(setupWatcher, 500);
    }
  };

  setupWatcher();

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      stopped = true;
      watcher?.close();
      resolve();
    });
  });
}

export async function cmdLogs(args: string[]): Promise<number> {
  let values: { follow?: boolean; lines?: string; level?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        follow: { type: "boolean", short: "f" },
        lines: { type: "string", short: "n", default: "50" },
        level: { type: "string" },
      },
      strict: false,
    }) as { values: { follow?: boolean; lines?: string; level?: string } });
  } catch {
    values = { lines: "50" };
  }

  const logPath = path.join(getLogsDir(), "pulseed.log");

  const lineCount = parseInt(values.lines ?? "50", 10);
  const n = isNaN(lineCount) || lineCount <= 0 ? 50 : lineCount;

  let minLevel: LogLevel | null = null;
  if (values.level) {
    minLevel = parseLevel(values.level);
    if (minLevel === null) {
      process.stderr.write(
        `Unknown log level: "${values.level}". Valid levels: DEBUG, INFO, WARN, ERROR\n`
      );
      return 1;
    }
  }

  // Check file existence for non-follow mode
  if (!values.follow) {
    try {
      fs.accessSync(logPath, fs.constants.R_OK);
    } catch {
      process.stdout.write(`No log file found at ${logPath}\n`);
      return 1;
    }
  }

  if (values.follow) {
    // For follow mode, print existing tail first, then watch
    let existingLines: string[] = [];
    try {
      fs.accessSync(logPath, fs.constants.R_OK);
      existingLines = readLastLines(logPath, n);
    } catch {
      // File not yet present; that's fine for follow mode
    }

    for (const line of existingLines) {
      if (minLevel === null || lineMatchesLevel(line, minLevel)) {
        process.stdout.write(line + "\n");
      }
    }

    await followLog(logPath, minLevel);
    return 0;
  }

  // Non-follow: read last N lines and print
  const lines = readLastLines(logPath, n);
  for (const line of lines) {
    if (minLevel === null || lineMatchesLevel(line, minLevel)) {
      process.stdout.write(line + "\n");
    }
  }

  return 0;
}
