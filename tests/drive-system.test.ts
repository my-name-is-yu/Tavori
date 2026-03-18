import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import { DriveSystem } from "../src/drive/drive-system.js";
import type { MotivaEvent, GoalSchedule } from "../src/types/drive.js";
import type { Goal } from "../src/types/goal.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal } from "./helpers/fixtures.js";

function makeEvent(overrides: Partial<MotivaEvent> = {}): MotivaEvent {
  return {
    type: "external",
    source: "test-source",
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

function writeEventFile(eventsDir: string, fileName: string, event: MotivaEvent): void {
  const filePath = path.join(eventsDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(event, null, 2), "utf-8");
}

// ─── Test Suite ───

describe("DriveSystem", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let driveSystem: DriveSystem;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    driveSystem = new DriveSystem(stateManager, { baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── directory creation ───

  describe("constructor", () => {
    it("creates required directories", () => {
      expect(fs.existsSync(path.join(tmpDir, "events"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "events", "archive"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "schedule"))).toBe(true);
    });

    it("uses stateManager baseDir when no baseDir option provided", () => {
      const ds = new DriveSystem(stateManager);
      expect(ds).toBeDefined();
    });
  });

  // ─── shouldActivate ───

  describe("shouldActivate", () => {
    it("returns true when schedule is due (no schedule stored => always due)", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "active" });
      await stateManager.saveGoal(goal);
      expect(await driveSystem.shouldActivate(goalId)).toBe(true);
    });

    it("returns false when schedule is not yet due and no events", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "active" });
      await stateManager.saveGoal(goal);

      const futureTime = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
      const schedule = driveSystem.createDefaultSchedule(goalId, 10);
      // Override next_check_at to future
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: futureTime });

      expect(await driveSystem.shouldActivate(goalId)).toBe(false);
    });

    it("returns true when schedule is overdue", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "active" });
      await stateManager.saveGoal(goal);

      const pastTime = new Date(Date.now() - 1000).toISOString();
      const schedule = driveSystem.createDefaultSchedule(goalId, 1);
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: pastTime });

      expect(await driveSystem.shouldActivate(goalId)).toBe(true);
    });

    it("returns false when goal status is completed", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "completed" });
      await stateManager.saveGoal(goal);

      // Even with no schedule (which defaults to due), should return false
      expect(await driveSystem.shouldActivate(goalId)).toBe(false);
    });

    it("returns false when goal status is cancelled", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "cancelled" });
      await stateManager.saveGoal(goal);
      expect(await driveSystem.shouldActivate(goalId)).toBe(false);
    });

    it("returns false when goal status is archived", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "archived" });
      await stateManager.saveGoal(goal);
      expect(await driveSystem.shouldActivate(goalId)).toBe(false);
    });

    it("returns true when event queue has an event targeting this goal (even if schedule not due)", async () => {
      const goalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "active" });
      await stateManager.saveGoal(goal);

      // Set schedule to future so schedule check would be false
      const futureTime = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
      const schedule = driveSystem.createDefaultSchedule(goalId, 10);
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: futureTime });

      // Write an event file that targets this specific goal
      const eventsDir = path.join(tmpDir, "events");
      writeEventFile(eventsDir, "evt-001.json", makeEvent({ data: { goal_id: goalId } }));

      expect(await driveSystem.shouldActivate(goalId)).toBe(true);
    });

    it("returns false when event queue has events for a different goal (schedule not due)", async () => {
      const goalId = crypto.randomUUID();
      const otherGoalId = crypto.randomUUID();
      const goal = makeGoal({ id: goalId, status: "active" });
      await stateManager.saveGoal(goal);

      // Set schedule to future so schedule check would be false
      const futureTime = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
      const schedule = driveSystem.createDefaultSchedule(goalId, 10);
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: futureTime });

      // Write an event file that targets a different goal
      const eventsDir = path.join(tmpDir, "events");
      writeEventFile(eventsDir, "evt-002.json", makeEvent({ data: { goal_id: otherGoalId } }));

      expect(await driveSystem.shouldActivate(goalId)).toBe(false);
    });

    it("returns true for unknown goal (no saved goal, no schedule)", async () => {
      const goalId = "nonexistent-goal";
      // No goal stored, no schedule => schedule is due => true
      expect(await driveSystem.shouldActivate(goalId)).toBe(true);
    });
  });

  // ─── readEventQueue ───

  describe("readEventQueue", () => {
    it("returns empty array when events directory is empty", () => {
      expect(driveSystem.readEventQueue()).toEqual([]);
    });

    it("reads and parses event files", () => {
      const eventsDir = path.join(tmpDir, "events");
      const event = makeEvent({ source: "test", timestamp: "2025-01-01T00:00:00.000Z" });
      writeEventFile(eventsDir, "evt-001.json", event);

      const result = driveSystem.readEventQueue();
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe("test");
    });

    it("sorts events by timestamp oldest first", () => {
      const eventsDir = path.join(tmpDir, "events");
      const older = makeEvent({ timestamp: "2025-01-01T00:00:00.000Z", source: "older" });
      const newer = makeEvent({ timestamp: "2025-06-01T00:00:00.000Z", source: "newer" });
      // Write newer first (file order should not affect result)
      writeEventFile(eventsDir, "evt-b.json", newer);
      writeEventFile(eventsDir, "evt-a.json", older);

      const result = driveSystem.readEventQueue();
      expect(result).toHaveLength(2);
      expect(result[0]?.source).toBe("older");
      expect(result[1]?.source).toBe("newer");
    });

    it("skips files that fail JSON parsing", () => {
      const eventsDir = path.join(tmpDir, "events");
      fs.writeFileSync(path.join(eventsDir, "corrupted.json"), "{ not valid json", "utf-8");
      const valid = makeEvent({ source: "valid" });
      writeEventFile(eventsDir, "valid.json", valid);

      const result = driveSystem.readEventQueue();
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe("valid");
    });

    it("skips files that fail Zod validation", () => {
      const eventsDir = path.join(tmpDir, "events");
      fs.writeFileSync(
        path.join(eventsDir, "invalid-schema.json"),
        JSON.stringify({ totally: "wrong" }),
        "utf-8"
      );
      const valid = makeEvent({ source: "valid" });
      writeEventFile(eventsDir, "valid.json", valid);

      const result = driveSystem.readEventQueue();
      expect(result).toHaveLength(1);
    });

    it("ignores archive subdirectory", () => {
      const eventsDir = path.join(tmpDir, "events");
      const archiveDir = path.join(eventsDir, "archive");
      fs.mkdirSync(archiveDir, { recursive: true });
      // Write an event in archive — should not be returned
      writeEventFile(archiveDir, "archived.json", makeEvent({ source: "archived" }));
      // Write a valid event in queue
      writeEventFile(eventsDir, "active.json", makeEvent({ source: "active" }));

      const result = driveSystem.readEventQueue();
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe("active");
    });

    it("returns empty array when events directory does not exist", () => {
      // Create DriveSystem pointing to a dir that has no events subdir
      const anotherTmp = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-noevents-"));
      try {
        const anotherSm = new StateManager(anotherTmp);
        const anotherDs = new DriveSystem(anotherSm, { baseDir: anotherTmp });
        // DriveSystem constructor creates the dirs, so remove to simulate absence
        fs.rmSync(path.join(anotherTmp, "events"), { recursive: true, force: true });
        const result = anotherDs.readEventQueue();
        expect(result).toEqual([]);
      } finally {
        fs.rmSync(anotherTmp, { recursive: true, force: true });
      }
    });
  });

  // ─── archiveEvent ───

  describe("archiveEvent", () => {
    it("moves event file to archive directory", () => {
      const eventsDir = path.join(tmpDir, "events");
      const archiveDir = path.join(eventsDir, "archive");
      const event = makeEvent();
      writeEventFile(eventsDir, "to-archive.json", event);

      expect(fs.existsSync(path.join(eventsDir, "to-archive.json"))).toBe(true);
      driveSystem.archiveEvent("to-archive.json");

      expect(fs.existsSync(path.join(eventsDir, "to-archive.json"))).toBe(false);
      expect(fs.existsSync(path.join(archiveDir, "to-archive.json"))).toBe(true);
    });

    it("creates archive directory if it does not exist", () => {
      const eventsDir = path.join(tmpDir, "events");
      const archiveDir = path.join(eventsDir, "archive");
      // Remove archive dir
      fs.rmSync(archiveDir, { recursive: true, force: true });

      writeEventFile(eventsDir, "evt.json", makeEvent());
      driveSystem.archiveEvent("evt.json");

      expect(fs.existsSync(archiveDir)).toBe(true);
      expect(fs.existsSync(path.join(archiveDir, "evt.json"))).toBe(true);
    });
  });

  // ─── processEvents ───

  describe("processEvents", () => {
    it("returns empty array when no events", () => {
      expect(driveSystem.processEvents()).toEqual([]);
    });

    it("reads and archives all events, returns sorted events", () => {
      const eventsDir = path.join(tmpDir, "events");
      const archiveDir = path.join(eventsDir, "archive");
      const older = makeEvent({ timestamp: "2025-01-01T00:00:00.000Z", source: "older" });
      const newer = makeEvent({ timestamp: "2025-06-01T00:00:00.000Z", source: "newer" });
      writeEventFile(eventsDir, "evt-b.json", newer);
      writeEventFile(eventsDir, "evt-a.json", older);

      const result = driveSystem.processEvents();

      expect(result).toHaveLength(2);
      expect(result[0]?.source).toBe("older");
      expect(result[1]?.source).toBe("newer");

      // Files should be archived
      expect(fs.existsSync(path.join(eventsDir, "evt-a.json"))).toBe(false);
      expect(fs.existsSync(path.join(eventsDir, "evt-b.json"))).toBe(false);
      expect(fs.existsSync(path.join(archiveDir, "evt-a.json"))).toBe(true);
      expect(fs.existsSync(path.join(archiveDir, "evt-b.json"))).toBe(true);
    });

    it("skips corrupted files during processEvents", () => {
      const eventsDir = path.join(tmpDir, "events");
      fs.writeFileSync(path.join(eventsDir, "corrupted.json"), "not json", "utf-8");
      writeEventFile(eventsDir, "valid.json", makeEvent({ source: "valid" }));

      const result = driveSystem.processEvents();
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe("valid");
    });
  });

  // ─── isScheduleDue ───

  describe("isScheduleDue", () => {
    it("returns true when no schedule exists (needs initial check)", () => {
      expect(driveSystem.isScheduleDue("unknown-goal")).toBe(true);
    });

    it("returns true when next_check_at is in the past", () => {
      const goalId = crypto.randomUUID();
      const schedule = driveSystem.createDefaultSchedule(goalId, 1);
      const pastTime = new Date(Date.now() - 5000).toISOString();
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: pastTime });

      expect(driveSystem.isScheduleDue(goalId)).toBe(true);
    });

    it("returns true when next_check_at equals now (boundary — due)", () => {
      const goalId = crypto.randomUUID();
      const schedule = driveSystem.createDefaultSchedule(goalId, 1);
      // Use a time slightly in the past to ensure <= comparison passes
      const justNow = new Date(Date.now() - 1).toISOString();
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: justNow });

      expect(driveSystem.isScheduleDue(goalId)).toBe(true);
    });

    it("returns false when next_check_at is in the future", () => {
      const goalId = crypto.randomUUID();
      const schedule = driveSystem.createDefaultSchedule(goalId, 1);
      const futureTime = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
      driveSystem.updateSchedule(goalId, { ...schedule, next_check_at: futureTime });

      expect(driveSystem.isScheduleDue(goalId)).toBe(false);
    });
  });

  // ─── getSchedule / updateSchedule ───

  describe("getSchedule / updateSchedule", () => {
    it("returns null when no schedule file exists", () => {
      expect(driveSystem.getSchedule("no-such-goal")).toBeNull();
    });

    it("round-trips schedule persistence correctly", () => {
      const goalId = crypto.randomUUID();
      const schedule: GoalSchedule = {
        goal_id: goalId,
        next_check_at: "2025-06-01T12:00:00.000Z",
        check_interval_hours: 4,
        last_triggered_at: "2025-06-01T08:00:00.000Z",
        consecutive_actions: 2,
        cooldown_until: null,
        current_interval_hours: 4,
      };

      driveSystem.updateSchedule(goalId, schedule);
      const loaded = driveSystem.getSchedule(goalId);

      expect(loaded).not.toBeNull();
      expect(loaded?.goal_id).toBe(goalId);
      expect(loaded?.next_check_at).toBe("2025-06-01T12:00:00.000Z");
      expect(loaded?.check_interval_hours).toBe(4);
      expect(loaded?.last_triggered_at).toBe("2025-06-01T08:00:00.000Z");
      expect(loaded?.consecutive_actions).toBe(2);
      expect(loaded?.current_interval_hours).toBe(4);
    });

    it("updates an existing schedule", () => {
      const goalId = crypto.randomUUID();
      const schedule = driveSystem.createDefaultSchedule(goalId, 2);
      driveSystem.updateSchedule(goalId, schedule);

      const updated = { ...schedule, check_interval_hours: 8, current_interval_hours: 8 };
      driveSystem.updateSchedule(goalId, updated);

      const loaded = driveSystem.getSchedule(goalId);
      expect(loaded?.check_interval_hours).toBe(8);
    });

    it("creates schedule directory if it does not exist", () => {
      const scheduleDir = path.join(tmpDir, "schedule");
      fs.rmSync(scheduleDir, { recursive: true, force: true });

      const goalId = crypto.randomUUID();
      const schedule = driveSystem.createDefaultSchedule(goalId, 1);
      driveSystem.updateSchedule(goalId, schedule);

      expect(fs.existsSync(scheduleDir)).toBe(true);
      expect(driveSystem.getSchedule(goalId)).not.toBeNull();
    });

    it("returns null for corrupted schedule file", () => {
      const goalId = "corrupted-goal";
      const scheduleDir = path.join(tmpDir, "schedule");
      fs.mkdirSync(scheduleDir, { recursive: true });
      fs.writeFileSync(path.join(scheduleDir, `${goalId}.json`), "not valid json", "utf-8");

      expect(driveSystem.getSchedule(goalId)).toBeNull();
    });
  });

  // ─── createDefaultSchedule ───

  describe("createDefaultSchedule", () => {
    it("creates schedule with correct goal_id", () => {
      const goalId = "goal-abc";
      const schedule = driveSystem.createDefaultSchedule(goalId, 6);
      expect(schedule.goal_id).toBe(goalId);
    });

    it("sets next_check_at approximately intervalHours from now", () => {
      const goalId = "goal-interval";
      const intervalHours = 3;
      const before = Date.now();
      const schedule = driveSystem.createDefaultSchedule(goalId, intervalHours);
      const after = Date.now();

      const nextCheckMs = new Date(schedule.next_check_at).getTime();
      const expectedMin = before + intervalHours * 60 * 60 * 1000;
      const expectedMax = after + intervalHours * 60 * 60 * 1000;

      expect(nextCheckMs).toBeGreaterThanOrEqual(expectedMin);
      expect(nextCheckMs).toBeLessThanOrEqual(expectedMax);
    });

    it("sets check_interval_hours and current_interval_hours to provided interval", () => {
      const schedule = driveSystem.createDefaultSchedule("goal-x", 12);
      expect(schedule.check_interval_hours).toBe(12);
      expect(schedule.current_interval_hours).toBe(12);
    });

    it("sets last_triggered_at to null", () => {
      const schedule = driveSystem.createDefaultSchedule("goal-x", 1);
      expect(schedule.last_triggered_at).toBeNull();
    });

    it("sets consecutive_actions to 0", () => {
      const schedule = driveSystem.createDefaultSchedule("goal-x", 1);
      expect(schedule.consecutive_actions).toBe(0);
    });

    it("sets cooldown_until to null", () => {
      const schedule = driveSystem.createDefaultSchedule("goal-x", 1);
      expect(schedule.cooldown_until).toBeNull();
    });
  });

  // ─── prioritizeGoals ───

  describe("prioritizeGoals", () => {
    it("returns empty array for empty input", () => {
      expect(driveSystem.prioritizeGoals([], new Map())).toEqual([]);
    });

    it("sorts goals by score highest first", () => {
      const scores = new Map([
        ["goal-a", 0.3],
        ["goal-b", 0.9],
        ["goal-c", 0.6],
      ]);
      const result = driveSystem.prioritizeGoals(["goal-a", "goal-b", "goal-c"], scores);
      expect(result).toEqual(["goal-b", "goal-c", "goal-a"]);
    });

    it("places goals without scores at the end", () => {
      const scores = new Map([
        ["goal-a", 0.5],
        ["goal-c", 0.8],
        // goal-b has no score
      ]);
      const result = driveSystem.prioritizeGoals(["goal-a", "goal-b", "goal-c"], scores);
      expect(result[0]).toBe("goal-c");
      expect(result[1]).toBe("goal-a");
      expect(result[2]).toBe("goal-b");
    });

    it("preserves relative order of unscored goals", () => {
      const scores = new Map([["goal-a", 1.0]]);
      const result = driveSystem.prioritizeGoals(
        ["goal-a", "goal-x", "goal-y", "goal-z"],
        scores
      );
      expect(result[0]).toBe("goal-a");
      expect(result.slice(1)).toEqual(["goal-x", "goal-y", "goal-z"]);
    });

    it("handles all goals having no scores — preserves original order", () => {
      const result = driveSystem.prioritizeGoals(
        ["goal-1", "goal-2", "goal-3"],
        new Map()
      );
      expect(result).toEqual(["goal-1", "goal-2", "goal-3"]);
    });

    it("handles goals with equal scores", () => {
      const scores = new Map([
        ["goal-a", 0.5],
        ["goal-b", 0.5],
        ["goal-c", 0.5],
      ]);
      const result = driveSystem.prioritizeGoals(["goal-a", "goal-b", "goal-c"], scores);
      // All have same score — all present, none missing
      expect(result).toHaveLength(3);
      expect(result).toContain("goal-a");
      expect(result).toContain("goal-b");
      expect(result).toContain("goal-c");
    });
  });

  // ─── Edge cases: missing directories ───

  describe("edge cases", () => {
    it("processEvents returns empty array when events dir is missing", () => {
      fs.rmSync(path.join(tmpDir, "events"), { recursive: true, force: true });
      expect(driveSystem.processEvents()).toEqual([]);
    });

    it("readEventQueue handles non-.json files gracefully", () => {
      const eventsDir = path.join(tmpDir, "events");
      fs.writeFileSync(path.join(eventsDir, "readme.txt"), "ignore me", "utf-8");
      writeEventFile(eventsDir, "valid.json", makeEvent({ source: "valid" }));

      const result = driveSystem.readEventQueue();
      expect(result).toHaveLength(1);
    });

    it("getSchedule handles schedule dir missing gracefully", () => {
      fs.rmSync(path.join(tmpDir, "schedule"), { recursive: true, force: true });
      expect(driveSystem.getSchedule("any-goal")).toBeNull();
    });

    it("atomic write creates .tmp then renames (file is not corrupt after write)", () => {
      const goalId = crypto.randomUUID();
      const schedule = driveSystem.createDefaultSchedule(goalId, 1);
      driveSystem.updateSchedule(goalId, schedule);

      const scheduleFile = path.join(tmpDir, "schedule", `${goalId}.json`);
      const tmpFile = scheduleFile + ".tmp";

      expect(fs.existsSync(scheduleFile)).toBe(true);
      expect(fs.existsSync(tmpFile)).toBe(false); // tmp file should be cleaned up
    });
  });
});
