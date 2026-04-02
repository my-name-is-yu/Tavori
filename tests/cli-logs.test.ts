import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

// ─── cmdLogs tests ───

vi.mock("../src/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/paths.js")>();
  return {
    ...actual,
    getLogsDir: vi.fn(() => "/tmp/pulseed-logs-placeholder"),
  };
});

import { getLogsDir } from "../src/utils/paths.js";
import { cmdLogs } from "../src/cli/commands/logs.js";

// Helper to build a sample log line
function logLine(level: string, msg: string): string {
  const padded = level.padEnd(5);
  return `[2026-04-01T00:00:00.000Z] [${padded}] ${msg} {}`;
}

describe("cmdLogs", () => {
  let tmpDir: string;
  let logFile: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-logs-test-");
    logFile = path.join(tmpDir, "pulseed.log");
    vi.mocked(getLogsDir).mockReturnValue(tmpDir);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    cleanupTempDir(tmpDir);
  });

  // ── Missing file ──────────────────────────────────────────────

  it("returns 1 and prints message when log file does not exist", async () => {
    const code = await cmdLogs([]);
    expect(code).toBe(1);
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No log file found at");
    expect(output).toContain("pulseed.log");
  });

  // ── Last N lines ──────────────────────────────────────────────

  it("shows last 50 lines by default", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(logLine("INFO", `message ${i}`));
    }
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs([]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // Should contain line 51-100 (last 50)
    expect(output).toContain("message 51");
    expect(output).toContain("message 100");
    expect(output).not.toContain("message 50\n");
  });

  it("respects --lines flag", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(logLine("INFO", `msg ${i}`));
    }
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs(["--lines", "5"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("msg 16");
    expect(output).toContain("msg 20");
    expect(output).not.toContain("msg 15\n");
  });

  it("respects -n short flag", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(logLine("DEBUG", `dbg ${i}`));
    }
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs(["-n", "3"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("dbg 8");
    expect(output).toContain("dbg 10");
    expect(output).not.toContain("dbg 7\n");
  });

  it("handles empty log file without error", async () => {
    fs.writeFileSync(logFile, "");

    const code = await cmdLogs([]);
    expect(code).toBe(0);
    // No lines printed — stdout should have no calls or empty calls
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toBe("");
  });

  it("shows all lines when file has fewer lines than requested", async () => {
    const content = [logLine("INFO", "only line")].join("\n") + "\n";
    fs.writeFileSync(logFile, content);

    const code = await cmdLogs(["--lines", "100"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("only line");
  });

  // ── Level filtering ───────────────────────────────────────────

  it("filters to ERROR level and above", async () => {
    const lines = [
      logLine("DEBUG", "debug msg"),
      logLine("INFO", "info msg"),
      logLine("WARN", "warn msg"),
      logLine("ERROR", "error msg"),
    ];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs(["--level", "ERROR"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("error msg");
    expect(output).not.toContain("warn msg");
    expect(output).not.toContain("info msg");
    expect(output).not.toContain("debug msg");
  });

  it("filters to WARN level and above", async () => {
    const lines = [
      logLine("DEBUG", "debug msg"),
      logLine("INFO", "info msg"),
      logLine("WARN", "warn msg"),
      logLine("ERROR", "error msg"),
    ];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs(["--level", "WARN"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("warn msg");
    expect(output).toContain("error msg");
    expect(output).not.toContain("info msg");
    expect(output).not.toContain("debug msg");
  });

  it("filters to INFO level and above", async () => {
    const lines = [
      logLine("DEBUG", "debug msg"),
      logLine("INFO", "info msg"),
      logLine("WARN", "warn msg"),
    ];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs(["--level", "INFO"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("info msg");
    expect(output).toContain("warn msg");
    expect(output).not.toContain("debug msg");
  });

  it("accepts lowercase level flag", async () => {
    const lines = [logLine("ERROR", "err"), logLine("DEBUG", "dbg")];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const code = await cmdLogs(["--level", "error"]);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("err");
    expect(output).not.toContain("dbg");
  });

  it("returns 1 for unknown level", async () => {
    fs.writeFileSync(logFile, logLine("INFO", "x") + "\n");

    const code = await cmdLogs(["--level", "VERBOSE"]);
    expect(code).toBe(1);

    const errOutput = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(errOutput).toContain("Unknown log level");
    expect(errOutput).toContain("VERBOSE");
  });

  // ── Follow mode ───────────────────────────────────────────────

  it("follow mode starts, prints existing tail, and can be cancelled via SIGINT", async () => {
    const existingLines = [
      logLine("INFO", "existing line 1"),
      logLine("INFO", "existing line 2"),
    ];
    fs.writeFileSync(logFile, existingLines.join("\n") + "\n");

    // Schedule SIGINT after a short delay
    const timer = setTimeout(() => process.emit("SIGINT", "SIGINT"), 80);

    const code = await cmdLogs(["-f"]);
    clearTimeout(timer);

    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("existing line 1");
    expect(output).toContain("existing line 2");
  });

  it("follow mode with --level filters existing lines", async () => {
    const lines = [
      logLine("DEBUG", "debug existing"),
      logLine("ERROR", "error existing"),
    ];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const timer = setTimeout(() => process.emit("SIGINT", "SIGINT"), 80);

    const code = await cmdLogs(["-f", "--level", "ERROR"]);
    clearTimeout(timer);

    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("error existing");
    expect(output).not.toContain("debug existing");
  });

  it("follow mode handles missing file gracefully and can be cancelled", async () => {
    // logFile does not exist — follow mode should not throw
    const timer = setTimeout(() => process.emit("SIGINT", "SIGINT"), 80);
    const code = await cmdLogs(["-f"]);
    clearTimeout(timer);
    expect(code).toBe(0);
  });
});
