import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StateManager } from "../../src/state/state-manager.js";
import { DriveSystem } from "../../src/drive/drive-system.js";
import type { Logger } from "../../src/runtime/logger.js";
import type { PulSeedEvent } from "../../src/types/drive.js";
import { makeTempDir } from "../helpers/temp-dir.js";
import { makeGoal } from "../helpers/fixtures.js";

function makeEvent(overrides: Partial<PulSeedEvent> = {}): PulSeedEvent {
  return {
    type: "external",
    source: "test-source",
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

function writeEventFile(eventsDir: string, fileName: string, event: PulSeedEvent): void {
  fs.writeFileSync(path.join(eventsDir, fileName), JSON.stringify(event, null, 2), "utf-8");
}

describe("DriveSystem malformed JSON regression", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let driveSystem: DriveSystem;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    driveSystem = new DriveSystem(stateManager, { baseDir: tmpDir });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("skips malformed event files, logs a warning, and continues processing later valid events", async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const watchedSystem = new DriveSystem(stateManager, { baseDir: tmpDir, logger });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const goalId = randomUUID();
    await stateManager.saveGoal(makeGoal({ id: goalId, status: "active" }));

    const eventsDir = path.join(tmpDir, "events");
    fs.writeFileSync(path.join(eventsDir, "bad.json"), "{ not valid json", "utf-8");
    writeEventFile(eventsDir, "good.json", makeEvent({ source: "valid-after-bad", data: { goal_id: goalId } }));

    const processed = await watchedSystem.processEvents();
    expect(processed).toHaveLength(1);
    expect(processed[0]?.source).toBe("valid-after-bad");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipping invalid event file "bad.json"'));
  });
});
