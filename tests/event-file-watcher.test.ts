/**
 * Tests for EventServer file watcher (Milestone 12.4).
 *
 * Tests cover:
 * - File watcher detects new JSON files in events directory
 * - Malformed JSON files are handled gracefully (logged, not crashed)
 * - Processed files are moved to events/processed/ after handling
 * - Events directory is created if it doesn't exist
 * - File watcher cleanup on stop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventServer } from "../src/runtime/event-server.js";
import type { PulSeedEvent } from "../src/types/drive.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ───

const validEvent: PulSeedEvent = {
  type: "external",
  source: "test-watcher",
  timestamp: new Date().toISOString(),
  data: { key: "value" },
};

const createMockDriveSystem = () => ({
  writeEvent: vi.fn().mockResolvedValue(undefined),
});

/**
 * Write a JSON file atomically (tmp → rename) to simulate how DriveSystem writes events.
 */
function writeEventFile(dir: string, filename: string, content: unknown): string {
  const filePath = path.join(dir, filename);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(content), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

/**
 * Wait up to `timeoutMs` for a condition to become true, polling every `intervalMs`.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

// ─── Test setup ───

let tmpDir: string;
let mockDriveSystem: ReturnType<typeof createMockDriveSystem>;
let server: EventServer;

beforeEach(() => {
  tmpDir = makeTempDir();
  mockDriveSystem = createMockDriveSystem();
  server = new EventServer(mockDriveSystem as never, {
    eventsDir: path.join(tmpDir, "events"),
  });
});

afterEach(() => {
  server.stopFileWatcher();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── isWatching() ───

describe("isWatching()", () => {
  it("returns false before startFileWatcher is called", () => {
    expect(server.isWatching()).toBe(false);
  });

  it("returns true after startFileWatcher is called", () => {
    server.startFileWatcher();
    expect(server.isWatching()).toBe(true);
  });

  it("returns false after stopFileWatcher is called", () => {
    server.startFileWatcher();
    server.stopFileWatcher();
    expect(server.isWatching()).toBe(false);
  });
});

// ─── Events directory creation ───

describe("events directory creation", () => {
  it("creates events directory if it does not exist", () => {
    const eventsDir = path.join(tmpDir, "events");
    expect(fs.existsSync(eventsDir)).toBe(false);
    server.startFileWatcher();
    expect(fs.existsSync(eventsDir)).toBe(true);
  });

  it("getEventsDir() returns the configured directory", () => {
    expect(server.getEventsDir()).toBe(path.join(tmpDir, "events"));
  });

  it("does not throw if events directory already exists", () => {
    const eventsDir = path.join(tmpDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    expect(() => server.startFileWatcher()).not.toThrow();
  });
});

// ─── File watcher detects new JSON files ───

describe("file watcher — detects new JSON files", () => {
  it("calls driveSystem.writeEvent when a valid JSON file appears", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    writeEventFile(eventsDir, "event_001.json", validEvent);

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0, 8000);

    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
    const called = mockDriveSystem.writeEvent.mock.calls[0][0] as PulSeedEvent;
    expect(called.type).toBe("external");
    expect(called.source).toBe("test-watcher");
  });

  it("processes multiple event files sequentially", { timeout: 15000 }, async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    for (let i = 0; i < 3; i++) {
      writeEventFile(eventsDir, `event_00${i}.json`, { ...validEvent, data: { index: i } });
      // Small delay to avoid rename collisions on some OSes
      await new Promise((r) => setTimeout(r, 30));
    }

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length >= 3, 8000);
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledTimes(3);
  });

  it("calls driveSystem.writeEvent with correctly parsed event fields", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    const event: PulSeedEvent = {
      type: "internal",
      source: "core-loop",
      timestamp: "2026-03-17T00:00:00.000Z",
      data: { reason: "stall" },
    };
    writeEventFile(eventsDir, "event_internal.json", event);

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0, 8000);

    const called = mockDriveSystem.writeEvent.mock.calls[0][0] as PulSeedEvent;
    expect(called.type).toBe("internal");
    expect(called.source).toBe("core-loop");
    expect(called.data).toEqual({ reason: "stall" });
  });
});

// ─── Processed files are moved ───

describe("file watcher — processed files are moved to processed/", () => {
  it("moves processed file to events/processed/ directory", { timeout: 15000 }, async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    const filename = "event_to_move.json";
    writeEventFile(eventsDir, filename, validEvent);

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0, 8000);

    const processedPath = path.join(eventsDir, "processed", filename);
    await waitFor(() => fs.existsSync(processedPath));

    expect(fs.existsSync(processedPath)).toBe(true);
  });

  it("original event file is removed from events/ after processing", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    const filename = "event_remove_original.json";
    const originalPath = writeEventFile(eventsDir, filename, validEvent);

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0, 8000);
    await waitFor(() => !fs.existsSync(originalPath));

    expect(fs.existsSync(originalPath)).toBe(false);
  });

  it("creates events/processed/ directory if missing", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    expect(fs.existsSync(path.join(eventsDir, "processed"))).toBe(false);

    writeEventFile(eventsDir, "event_make_processed_dir.json", validEvent);

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0, 8000);
    await waitFor(() => fs.existsSync(path.join(eventsDir, "processed")));

    expect(fs.existsSync(path.join(eventsDir, "processed"))).toBe(true);
  });
});

// ─── Malformed files — graceful handling ───

describe("file watcher — malformed files handled gracefully", () => {
  it("does not crash when a JSON file contains invalid JSON", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    // Write malformed JSON directly (not via writeEventFile which uses JSON.stringify)
    const filePath = path.join(eventsDir, "malformed.json");
    fs.writeFileSync(filePath, "{ not valid json {{{{", "utf-8");

    // Give the watcher time to process
    await new Promise((r) => setTimeout(r, 200));

    // Server is still watching
    expect(server.isWatching()).toBe(true);
    // writeEvent was never called
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });

  it("does not crash when event file fails Zod validation", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    // Valid JSON but missing required "type" field
    writeEventFile(eventsDir, "invalid_schema.json", {
      source: "test",
      timestamp: new Date().toISOString(),
      data: {},
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(server.isWatching()).toBe(true);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });

  it("continues processing valid files after encountering a malformed file", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    // Write malformed first
    fs.writeFileSync(path.join(eventsDir, "bad.json"), "INVALID", "utf-8");
    await new Promise((r) => setTimeout(r, 100));

    // Then write a valid file
    writeEventFile(eventsDir, "good.json", validEvent);

    await waitFor(() => mockDriveSystem.writeEvent.mock.calls.length > 0, 8000);
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
  });

  it("does not process .tmp files", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();

    // Write a .tmp file — should be ignored
    fs.writeFileSync(
      path.join(eventsDir, "event_001.json.tmp"),
      JSON.stringify(validEvent),
      "utf-8"
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

// ─── File watcher cleanup on stop ───

describe("file watcher cleanup on stop", () => {
  it("stopFileWatcher() sets isWatching() to false", () => {
    server.startFileWatcher();
    expect(server.isWatching()).toBe(true);
    server.stopFileWatcher();
    expect(server.isWatching()).toBe(false);
  });

  it("stopFileWatcher() is idempotent — can be called multiple times", () => {
    server.startFileWatcher();
    server.stopFileWatcher();
    expect(() => server.stopFileWatcher()).not.toThrow();
    expect(server.isWatching()).toBe(false);
  });

  it("startFileWatcher() is idempotent — calling twice does not create two watchers", () => {
    server.startFileWatcher();
    const firstWatcher = server.isWatching();
    server.startFileWatcher(); // second call should be a no-op
    expect(firstWatcher).toBe(true);
    expect(server.isWatching()).toBe(true);
  });

  it("stop() calls stopFileWatcher() automatically", async () => {
    server.startFileWatcher();
    expect(server.isWatching()).toBe(true);
    // stop() doesn't require HTTP server to be started
    await server.stop();
    expect(server.isWatching()).toBe(false);
  });

  it("does not process files written after stopFileWatcher is called", async () => {
    const eventsDir = path.join(tmpDir, "events");
    server.startFileWatcher();
    server.stopFileWatcher();

    writeEventFile(eventsDir, "after_stop.json", validEvent);

    await new Promise((r) => setTimeout(r, 200));
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});
