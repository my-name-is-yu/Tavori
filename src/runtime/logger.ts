import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerConfig {
  dir: string;                    // Log directory path
  maxSizeMB?: number;            // Max size per log file (default: 10)
  maxFiles?: number;             // Max number of rotated files (default: 5)
  level?: LogLevel;              // Minimum log level (default: "info")
  consoleOutput?: boolean;       // Also log to console (default: true)
  rotateByDate?: boolean;        // Rotate log file when date changes (default: true)
}

export class Logger {
  private dir: string;
  private maxSizeBytes: number;
  private maxFiles: number;
  private level: number;
  private consoleOutput: boolean;
  private rotateByDate: boolean;
  private currentFile: string;
  private lastWriteDate: string | null = null;
  private stream: fs.WriteStream | null = null;
  // Bytes written to the current stream (in-memory + on-disk combined)
  private streamSize = 0;
  // True if we have written at least one byte since the last rotation (or since startup)
  private hasCurrentData = false;
  // True if any data was written under lastWriteDate (survives size rotations within the same day)
  private hadDataOnLastDate = false;
  // Queue of lines buffered while rotation flush is in progress
  private rotationQueue: string[] = [];
  // Promise that resolves once the current rotation + queue drain is complete
  private rotationDone: Promise<void> | null = null;
  // True once a stream error has occurred — stops reopening to prevent infinite loop
  private streamErrored = false;

  constructor(config: LoggerConfig) {
    this.dir = config.dir;
    this.maxSizeBytes = (config.maxSizeMB ?? 10) * 1024 * 1024;
    this.maxFiles = config.maxFiles ?? 5;
    this.level = LOG_LEVELS[config.level ?? "info"];
    this.consoleOutput = config.consoleOutput ?? true;
    this.rotateByDate = config.rotateByDate ?? true;
    this.currentFile = path.join(this.dir, "pulseed.log");

    // Ensure log directory exists (one-time init, sync is acceptable here)
    fs.mkdirSync(this.dir, { recursive: true });

    // Seed streamSize from existing file to avoid immediate re-rotation
    // Done asynchronously to avoid blocking the constructor; streamSize stays 0 until resolved
    fsp.stat(this.currentFile).then((stat) => {
      this.streamSize = stat.size;
      this.hasCurrentData = this.streamSize > 0;
      this.hadDataOnLastDate = this.hasCurrentData;
    }).catch(() => {
      // File doesn't exist yet — streamSize stays 0, which is correct
    });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  private setLevel(level: LogLevel): void {
    this.level = LOG_LEVELS[level];
  }

  /**
   * Flush and close the underlying write stream.
   * Waits for any in-flight rotation to complete first.
   * Call during clean shutdown to ensure all buffered data is written to disk.
   */
  async close(): Promise<void> {
    // Loop: wait for rotations that may chain (rotation → queue drain → another rotation)
    while (this.rotationDone) {
      await this.rotationDone;
    }

    // Now close the current stream
    if (!this.stream) return;
    const stream = this.stream;
    return new Promise((resolve) => {
      stream.end(() => {
        this.stream = null;
        resolve();
      });
    });
  }

  private openStream(): fs.WriteStream {
    const stream = fs.createWriteStream(this.currentFile, { flags: "a" });
    stream.on("error", (err) => {
      if (!this.streamErrored) {
        // Log first error via console.error so it's visible; suppress subsequent ones
        console.error("[Logger] stream error — file logging disabled:", err.message);
        this.streamErrored = true;
      }
      this.stream = null;
    });
    return stream;
  }

  private getStream(): fs.WriteStream | null {
    if (this.streamErrored) return null;
    if (!this.stream) {
      this.stream = this.openStream();
    }
    return this.stream;
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.level) return;

    const timestamp = new Date().toISOString();
    const contextStr = context ? " " + JSON.stringify(context) : "";
    const line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${contextStr}\n`;

    // Console output
    if (this.consoleOutput) {
      const consoleFn = level === "error" ? console.error
        : level === "warn" ? console.warn
        : console.log;
      consoleFn(line.trimEnd());
    }

    // File output
    this.writeToFile(line);
  }

  private writeToFile(line: string): void {
    try {
      // If rotation is in progress, queue the line and return
      if (this.rotationDone) {
        this.rotationQueue.push(line);
        return;
      }

      // Check if rotation is needed before writing
      const rotation = this.checkRotation();

      if (rotation) {
        // Queue this line; it will be written after rotation completes
        this.rotationQueue.push(line);
        this.rotationDone = this.flushAndRotate(rotation).then(() => {
          this.rotationDone = null;
          // Drain the queue (may trigger further rotations, which set rotationDone again)
          const queued = this.rotationQueue.splice(0);
          for (const qLine of queued) {
            this.writeToFile(qLine);
          }
        });
        return;
      }

      // Normal write — non-blocking via stream buffer
      const stream = this.getStream();
      if (!stream) return; // stream errored previously — silently drop
      stream.write(line, "utf-8");
      const bytes = Buffer.byteLength(line, "utf-8");
      this.streamSize += bytes;
      this.hasCurrentData = true;
      this.hadDataOnLastDate = true;
    } catch {
      // Silently fail file writes (don't crash daemon for logging issues)
    }
  }

  // Returns the current date as YYYY-MM-DD
  private getCurrentDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Check if rotation is needed. Returns a descriptor of what rotation to perform,
   * or null if no rotation is needed. Does NOT perform the rotation.
   *
   * Uses streamSize (bytes accounted by this Logger instance) rather than existsSync,
   * because the stream buffer may not have been flushed to disk yet.
   */
  private checkRotation(): { type: "date"; date: string } | { type: "size" } | null {
    // ── Date-based rotation ──────────────────────────────────────────────
    if (this.rotateByDate) {
      const today = this.getCurrentDate();
      if (this.lastWriteDate === null) {
        // First write: just record the date, no rotation
        this.lastWriteDate = today;
      } else if (this.lastWriteDate !== today) {
        const prevDate = this.lastWriteDate;
        // Capture whether we had data on the previous date before resetting
        const shouldRotate = this.hadDataOnLastDate;
        this.lastWriteDate = today;
        this.hadDataOnLastDate = false;
        // Rotate only if data was written under the previous date
        if (shouldRotate) {
          return { type: "date", date: prevDate };
        }
        return null;
      }
    }

    // ── Size-based rotation ──────────────────────────────────────────────
    // streamSize tracks both on-disk and in-buffer bytes, so no existsSync needed
    if (this.streamSize >= this.maxSizeBytes) {
      return { type: "size" };
    }

    return null;
  }

  /**
   * Flush the current stream to disk, perform the file rename, then resolve.
   * Opens a fresh stream after rotation. Called only on rotation events (rare).
   */
  private flushAndRotate(rotation: { type: "date"; date: string } | { type: "size" }): Promise<void> {
    const doRotate = async (): Promise<void> => {
      try {
        if (rotation.type === "date") {
          const dest = path.join(this.dir, `pulseed.${rotation.date}.log`);
          await fsp.rename(this.currentFile, dest).catch(() => {
            // File may not exist — ignore
          });
        } else {
          // Size-based: shift existing rotated files up, then rename current
          for (let i = this.maxFiles - 1; i >= 1; i--) {
            const older = path.join(this.dir, `pulseed.${i + 1}.log`);
            const newer = path.join(this.dir, `pulseed.${i}.log`);
            if (i === this.maxFiles - 1) {
              await fsp.unlink(older).catch(() => {
                // File may not exist — ignore
              });
            }
            await fsp.rename(newer, older).catch(() => {
              // File may not exist — ignore
            });
          }
          await fsp.rename(this.currentFile, path.join(this.dir, "pulseed.1.log")).catch(() => {
            // File may not exist — ignore
          });
        }
      } catch (err) {
        console.error("[Logger] rotation error:", err instanceof Error ? err.message : err);
      }

      this.streamSize = 0;
      this.hasCurrentData = false;
      // Open fresh stream for the new log file
      this.stream = this.openStream();
    };

    if (this.stream) {
      // Flush buffered data to disk before renaming
      const oldStream = this.stream;
      this.stream = null;
      return new Promise<void>((resolve) => {
        oldStream.end(() => {
          doRotate().then(resolve).catch(resolve);
        });
      });
    } else {
      return doRotate();
    }
  }
}
