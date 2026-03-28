import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../src/runtime/logger.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

async function readLogFile(logger: Logger, dir: string, filename = "pulseed.log"): Promise<string> {
  await logger.close();
  const filePath = path.join(dir, filename);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function logFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(async () => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// Constructor
// ═══════════════════════════════════════════════════════

describe("constructor", () => {
  it("creates the log directory if it does not exist", () => {
    const newDir = path.join(tmpDir, "nested", "logs");
    expect(fs.existsSync(newDir)).toBe(false);

    new Logger({ dir: newDir, consoleOutput: false });

    expect(fs.existsSync(newDir)).toBe(true);
  });

  it("does not throw when the log directory already exists", () => {
    expect(() => new Logger({ dir: tmpDir, consoleOutput: false })).not.toThrow();
    // Create a second instance to ensure idempotency
    expect(() => new Logger({ dir: tmpDir, consoleOutput: false })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════
// Log Levels — file output
// ═══════════════════════════════════════════════════════

describe("log levels — file output", () => {
  it("writes info messages to pulseed.log", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("hello from info");

    const content = await readLogFile(logger, tmpDir);
    expect(content).toContain("hello from info");
    expect(content).toContain("[INFO ]");
  });

  it("writes warn messages with [WARN ] label", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.warn("something is off");

    const content = await readLogFile(logger, tmpDir);
    expect(content).toContain("[WARN ]");
    expect(content).toContain("something is off");
  });

  it("writes error messages with [ERROR] label", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.error("critical failure");

    const content = await readLogFile(logger, tmpDir);
    expect(content).toContain("[ERROR]");
    expect(content).toContain("critical failure");
  });

  it("writes debug messages with [DEBUG] label when level is debug", async () => {
    const logger = new Logger({ dir: tmpDir, level: "debug", consoleOutput: false });
    logger.debug("debug trace");

    const content = await readLogFile(logger, tmpDir);
    expect(content).toContain("[DEBUG]");
    expect(content).toContain("debug trace");
  });

  it("includes an ISO-8601 timestamp in each log line", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("check timestamp");

    const content = await readLogFile(logger, tmpDir);
    // ISO-8601: 2026-03-14T... pattern
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\]/);
  });

  it("serializes context object as JSON appended to the line", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("with context", { goalId: "g-1", loop: 5 });

    const content = await readLogFile(logger, tmpDir);
    expect(content).toContain('"goalId":"g-1"');
    expect(content).toContain('"loop":5');
  });

  it("does not include context JSON when context is not provided", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("no context here");

    const content = await readLogFile(logger, tmpDir);
    // Should not end line with a JSON object — just message and newline
    const line = content.trim();
    expect(line.endsWith("}")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// Level filtering
// ═══════════════════════════════════════════════════════

describe("level filtering", () => {
  it("filters out debug and info when level is warn", async () => {
    const logger = new Logger({ dir: tmpDir, level: "warn", consoleOutput: false });

    logger.debug("this is debug");
    logger.info("this is info");
    logger.warn("this is warn");
    logger.error("this is error");

    const content = await readLogFile(logger, tmpDir);
    expect(content).not.toContain("this is debug");
    expect(content).not.toContain("this is info");
    expect(content).toContain("this is warn");
    expect(content).toContain("this is error");
  });

  it("filters out debug when level is info (default)", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false }); // default level=info
    logger.debug("hidden debug");
    logger.info("visible info");

    const content = await readLogFile(logger, tmpDir);
    expect(content).not.toContain("hidden debug");
    expect(content).toContain("visible info");
  });

  it("filters out everything below error when level is error", async () => {
    const logger = new Logger({ dir: tmpDir, level: "error", consoleOutput: false });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const content = await readLogFile(logger, tmpDir);
    expect(content).not.toContain("[DEBUG]");
    expect(content).not.toContain("[INFO ]");
    expect(content).not.toContain("[WARN ]");
    expect(content).toContain("[ERROR]");
  });

  it("writes all levels when level is debug", async () => {
    const logger = new Logger({ dir: tmpDir, level: "debug", consoleOutput: false });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const content = await readLogFile(logger, tmpDir);
    expect(content).toContain("[DEBUG]");
    expect(content).toContain("[INFO ]");
    expect(content).toContain("[WARN ]");
    expect(content).toContain("[ERROR]");
  });
});

// ═══════════════════════════════════════════════════════
// Console output
// ═══════════════════════════════════════════════════════

describe("console output", () => {
  it("calls console.log when consoleOutput is true for info messages", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = new Logger({ dir: tmpDir, consoleOutput: true });
    logger.info("should appear in console");
    await logger.close();

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]![0]).toContain("should appear in console");
  });

  it("calls console.warn for warn messages", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = new Logger({ dir: tmpDir, consoleOutput: true });
    logger.warn("warn to console");
    await logger.close();

    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("calls console.error for error messages", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = new Logger({ dir: tmpDir, consoleOutput: true });
    logger.error("error to console");
    await logger.close();

    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("does not call any console method when consoleOutput is false", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("no console");
    logger.warn("no console");
    logger.error("no console");
    await logger.close();

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// Log Rotation
// ═══════════════════════════════════════════════════════

describe("log rotation", () => {
  it("rotates when file exceeds maxSizeMB — creates pulseed.1.log", async () => {
    const logger = new Logger({
      dir: tmpDir,
      maxSizeMB: 0.001, // ~1 KB
      maxFiles: 3,
      consoleOutput: false,
    });

    // Write enough to exceed 1 KB
    for (let i = 0; i < 100; i++) {
      logger.info("A".repeat(100));
    }

    await logger.close();
    const files = logFiles(tmpDir);
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain("pulseed.1.log");
  });

  it("keeps writing to pulseed.log after rotation", async () => {
    const logger = new Logger({
      dir: tmpDir,
      maxSizeMB: 0.001,
      maxFiles: 3,
      consoleOutput: false,
    });

    for (let i = 0; i < 100; i++) {
      logger.info("B".repeat(100));
    }

    await logger.close();
    // pulseed.log should still exist with new data after rotation
    expect(fs.existsSync(path.join(tmpDir, "pulseed.log"))).toBe(true);
  });

  it("does not exceed maxFiles rotated files", async () => {
    const maxFiles = 3;
    const logger = new Logger({
      dir: tmpDir,
      maxSizeMB: 0.0005, // ~0.5 KB — very small to force many rotations
      maxFiles,
      consoleOutput: false,
    });

    // Write enough to trigger multiple rotations
    for (let i = 0; i < 500; i++) {
      logger.info("C".repeat(100));
    }

    await logger.close();
    const rotatedFiles = logFiles(tmpDir).filter((f) => f !== "pulseed.log");
    // Rotation shifts up to pulseed.maxFiles.log, then deletes it on the next cycle.
    // Total rotated files can be at most maxFiles (pulseed.1.log … pulseed.maxFiles.log).
    expect(rotatedFiles.length).toBeLessThanOrEqual(maxFiles);
  });

  it("deletes the oldest rotated file when rotation limit is reached", async () => {
    const maxFiles = 3;
    const logger = new Logger({
      dir: tmpDir,
      maxSizeMB: 0.0005,
      maxFiles,
      consoleOutput: false,
    });

    // Fill to trigger multiple rotations
    for (let i = 0; i < 300; i++) {
      logger.info("D".repeat(200));
    }

    await logger.close();
    // Files beyond maxFiles should not exist — pulseed.(maxFiles+1).log must be absent
    const tooOld = path.join(tmpDir, `pulseed.${maxFiles + 1}.log`);
    expect(fs.existsSync(tooOld)).toBe(false);
  });

  it("single log file does not rotate when under limit", async () => {
    const logger = new Logger({
      dir: tmpDir,
      maxSizeMB: 100, // Very large limit
      maxFiles: 5,
      consoleOutput: false,
    });

    logger.info("small entry");
    logger.warn("another small entry");

    await logger.close();
    const files = logFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("pulseed.log");
  });
});

// ═══════════════════════════════════════════════════════
// Date-based Rotation
// ═══════════════════════════════════════════════════════

describe("date-based rotation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should not rotate on first write (just record date)", async () => {
    vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });

    logger.info("first write");

    await logger.close();
    // Only pulseed.log should exist; no date-suffixed file
    const files = logFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("pulseed.log");
  });

  it("should rotate log file when date changes", async () => {
    vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });

    logger.info("day one message");

    // Advance to the next day
    vi.setSystemTime(new Date("2026-03-17T02:00:00Z"));
    logger.info("day two message");

    await logger.close();
    const files = logFiles(tmpDir);
    // Both pulseed.log (new day) and a rotated file should exist
    expect(files).toContain("pulseed.log");
    // At least one rotated file
    expect(files.length).toBeGreaterThan(1);
  });

  it("should name rotated file with date suffix (pulseed.YYYY-MM-DD.log)", async () => {
    vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });

    logger.info("day one message");

    // Advance to the next day to trigger rotation
    vi.setSystemTime(new Date("2026-03-17T02:00:00Z"));
    logger.info("day two message");

    await logger.close();
    const files = logFiles(tmpDir);
    expect(files).toContain("pulseed.2026-03-16.log");
  });

  it("should work together with size-based rotation", async () => {
    vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
    const logger = new Logger({
      dir: tmpDir,
      maxSizeMB: 0.001, // ~1 KB — triggers size rotation too
      consoleOutput: false,
    });

    // Trigger size-based rotation on day one
    for (let i = 0; i < 100; i++) {
      logger.info("E".repeat(100));
    }

    // Advance to next day and write more — triggers date rotation
    vi.setSystemTime(new Date("2026-03-17T02:00:00Z"));
    logger.info("day two first message");

    await logger.close();
    const files = logFiles(tmpDir);
    // Size-based rotated files (pulseed.1.log, ...) and date-rotated file should all exist
    const hasDateRotated = files.some((f) => /pulseed\.\d{4}-\d{2}-\d{2}\.log/.test(f));
    const hasSizeRotated = files.some((f) => /pulseed\.\d+\.log/.test(f));
    expect(hasDateRotated).toBe(true);
    expect(hasSizeRotated).toBe(true);
  });

  it("should not rotate by date when rotateByDate is false", async () => {
    vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));
    const logger = new Logger({
      dir: tmpDir,
      rotateByDate: false,
      maxSizeMB: 100, // prevent size rotation too
      consoleOutput: false,
    });

    logger.info("day one message");

    // Advance to next day
    vi.setSystemTime(new Date("2026-03-17T02:00:00Z"));
    logger.info("day two message");

    await logger.close();
    const files = logFiles(tmpDir);
    // No date-suffixed file should exist
    const hasDateRotated = files.some((f) => /pulseed\.\d{4}-\d{2}-\d{2}\.log/.test(f));
    expect(hasDateRotated).toBe(false);
    // Only pulseed.log
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("pulseed.log");
  });
});

// ═══════════════════════════════════════════════════════
// Stream error handling
// ═══════════════════════════════════════════════════════

describe("stream error handling", () => {
  it("logs the first stream error via console.error and subsequent log calls are no-ops", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Create logger pointing at a non-writable path to force a stream error.
    // We make the log directory read-only after the logger is constructed
    // so mkdirSync succeeds but createWriteStream fails on first write.
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });

    // Make the log file unwritable so that writing triggers an error
    const logFile = path.join(tmpDir, "pulseed.log");
    // Write once to open + create the file
    logger.info("before error");
    // Flush and close to ensure file exists on disk
    await logger.close();

    // Now make the file read-only so the next open attempt fails
    fs.chmodSync(logFile, 0o444);

    // Create a fresh logger that will fail to open the read-only file
    const logger2 = new Logger({ dir: tmpDir, consoleOutput: false });
    logger2.info("write 1 — should trigger stream error");

    // Wait a tick for the stream error event to propagate
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]![0]).toContain("[Logger] stream error");

    // Reset spy call count to verify subsequent writes don't trigger more errors
    errorSpy.mockClear();
    logger2.info("write 2 — should be silent no-op");
    logger2.info("write 3 — should be silent no-op");
    await new Promise((r) => setTimeout(r, 50));

    // No additional console.error calls — infinite loop is prevented
    expect(errorSpy).not.toHaveBeenCalled();

    // Cleanup: restore permissions
    fs.chmodSync(logFile, 0o644);
    await logger2.close();
  });
});

// ═══════════════════════════════════════════════════════
// close() method
// ═══════════════════════════════════════════════════════

describe("close()", () => {
  it("flushes buffered data to disk", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("before close");
    await logger.close();

    const content = fs.readFileSync(path.join(tmpDir, "pulseed.log"), "utf-8");
    expect(content).toContain("before close");
  });

  it("resolves immediately when no stream is open", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    // No writes — stream never opened
    await expect(logger.close()).resolves.toBeUndefined();
  });

  it("can be called multiple times without error", async () => {
    const logger = new Logger({ dir: tmpDir, consoleOutput: false });
    logger.info("once");
    await logger.close();
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
