import * as fs from "node:fs";
import * as path from "node:path";
import { MotivaEventSchema, GoalScheduleSchema } from "../types/drive.js";
import type { MotivaEvent, GoalSchedule } from "../types/drive.js";
import type { StateManager } from "../state-manager.js";
import type { Logger } from "../runtime/logger.js";

/**
 * DriveSystem handles lightweight activation checks (no LLM calls), event queue
 * processing, and goal schedule management.
 *
 * File layout:
 *   <baseDir>/events/*.json          — event queue
 *   <baseDir>/events/archive/*.json  — processed events
 *   <baseDir>/schedule/<goalId>.json — goal schedules
 *
 * Inactive goal statuses: "completed", "cancelled", "archived"
 * All writes are atomic: write to .tmp file, then rename.
 */
export class DriveSystem {
  private readonly baseDir: string;
  private readonly stateManager: StateManager;
  private readonly logger?: Logger;
  private watcher: fs.FSWatcher | null = null;
  private inMemoryQueue: MotivaEvent[] = [];
  private onEventCallback: ((event: MotivaEvent) => void) | null = null;

  constructor(stateManager: StateManager, options?: { baseDir?: string; logger?: Logger }) {
    this.stateManager = stateManager;
    this.baseDir = options?.baseDir ?? stateManager.getBaseDir();
    this.logger = options?.logger;
    this.watcher = null;
    this.inMemoryQueue = [];
    this.onEventCallback = null;
    this.ensureDirectories();
  }

  // ─── Directory Management ───

  private ensureDirectories(): void {
    const dirs = [
      path.join(this.baseDir, "events"),
      path.join(this.baseDir, "events", "archive"),
      path.join(this.baseDir, "schedule"),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ─── Atomic Write ───

  private atomicWrite(filePath: string, data: unknown): void {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  // ─── Activation Check ───

  /**
   * Lightweight check (no LLM). Returns true if any condition is met:
   * 1. Event queue has unprocessed events for this goal
   * 2. Schedule is due (next_check_at <= now)
   * 3. Goal is not in a terminal status ("completed", "cancelled", "archived")
   */
  async shouldActivate(goalId: string): Promise<boolean> {
    // Check goal status — terminal statuses suppress activation
    const goal = await this.stateManager.loadGoal(goalId);
    if (goal !== null) {
      if (
        goal.status === "completed" ||
        goal.status === "cancelled" ||
        goal.status === "archived"
      ) {
        return false;
      }
    }

    // Check event queue for events targeting this goal
    const events = this.readEventQueue();
    if (events.length > 0) {
      const hasGoalEvent = events.some(
        (e) => e.data["goal_id"] === goalId || e.data["target_goal_id"] === goalId
      );
      if (hasGoalEvent) {
        return true;
      }
    }

    // Check if schedule is due
    if (this.isScheduleDue(goalId)) {
      return true;
    }

    return false;
  }

  // ─── Event Queue ───

  /**
   * Read all JSON files from {baseDir}/events/ directory.
   * Parse each as MotivaEvent. Return sorted by timestamp (oldest first).
   * Skips files that fail to parse (logs a warning).
   */
  readEventQueue(): MotivaEvent[] {
    const eventsDir = path.join(this.baseDir, "events");
    if (!fs.existsSync(eventsDir)) {
      return [];
    }

    let fileNames: string[];
    try {
      fileNames = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const events: MotivaEvent[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(eventsDir, fileName);

      // Skip directories (e.g., the archive subdirectory)
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const raw = JSON.parse(content) as unknown;
        const event = MotivaEventSchema.parse(raw);
        events.push(event);
      } catch (err) {
        this.logger?.warn(`DriveSystem: skipping invalid event file "${fileName}": ${err}`);
      }
    }

    // Sort oldest first by timestamp
    events.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    return events;
  }

  /**
   * Move an event file from {baseDir}/events/{fileName} to
   * {baseDir}/events/archive/{fileName}. Creates the archive dir if needed.
   */
  archiveEvent(eventFileName: string): void {
    const srcPath = path.join(this.baseDir, "events", eventFileName);
    const archiveDir = path.join(this.baseDir, "events", "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const dstPath = path.join(archiveDir, eventFileName);
    fs.renameSync(srcPath, dstPath);
  }

  /**
   * Read queue, archive each processed event, return the events.
   */
  processEvents(): MotivaEvent[] {
    const eventsDir = path.join(this.baseDir, "events");
    if (!fs.existsSync(eventsDir)) {
      return [];
    }

    let fileNames: string[];
    try {
      fileNames = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const events: MotivaEvent[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(eventsDir, fileName);

      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const raw = JSON.parse(content) as unknown;
        const event = MotivaEventSchema.parse(raw);
        this.archiveEvent(fileName);
        events.push(event);
      } catch (err) {
        this.logger?.warn(`DriveSystem: skipping invalid event file "${fileName}" during processEvents: ${err}`);
      }
    }

    // Sort oldest first by timestamp
    events.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    return events;
  }

  // ─── Schedule Management ───

  /**
   * Load schedule from {baseDir}/schedule/{goalId}.json.
   * Returns null if no schedule exists or parsing fails.
   */
  getSchedule(goalId: string): GoalSchedule | null {
    const filePath = path.join(this.baseDir, "schedule", `${goalId}.json`);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      return GoalScheduleSchema.parse(raw);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.logger?.warn(`DriveSystem: failed to load schedule for goal "${goalId}": ${err}`);
      return null;
    }
  }

  /**
   * Save schedule atomically to {baseDir}/schedule/{goalId}.json.
   */
  updateSchedule(goalId: string, schedule: GoalSchedule): void {
    const scheduleDir = path.join(this.baseDir, "schedule");
    fs.mkdirSync(scheduleDir, { recursive: true });
    const validated = GoalScheduleSchema.parse(schedule);
    const filePath = path.join(scheduleDir, `${goalId}.json`);
    this.atomicWrite(filePath, validated);
  }

  /**
   * Check if the schedule for a goal is due (next_check_at <= now).
   * If no schedule exists, returns true (needs initial check).
   */
  isScheduleDue(goalId: string): boolean {
    const schedule = this.getSchedule(goalId);
    if (schedule === null) {
      return true;
    }
    const nextCheckAt = new Date(schedule.next_check_at).getTime();
    return nextCheckAt <= Date.now();
  }

  /**
   * Create a new schedule with next_check_at = now + intervalHours.
   */
  createDefaultSchedule(goalId: string, intervalHours: number): GoalSchedule {
    const now = new Date();
    const nextCheckAt = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
    return GoalScheduleSchema.parse({
      goal_id: goalId,
      next_check_at: nextCheckAt.toISOString(),
      check_interval_hours: intervalHours,
      last_triggered_at: null,
      consecutive_actions: 0,
      cooldown_until: null,
      current_interval_hours: intervalHours,
    });
  }

  // ─── Multi-Goal Prioritization ───

  /**
   * Sort goals by drive score (highest first).
   * Goals without scores go last (in their original relative order).
   */
  prioritizeGoals(goalIds: string[], scores: Map<string, number>): string[] {
    const withScore: Array<{ id: string; score: number }> = [];
    const withoutScore: string[] = [];

    for (const id of goalIds) {
      const score = scores.get(id);
      if (score !== undefined) {
        withScore.push({ id, score });
      } else {
        withoutScore.push(id);
      }
    }

    // Sort descending by score (stable sort preserves original order for ties)
    withScore.sort((a, b) => b.score - a.score);

    return [...withScore.map((g) => g.id), ...withoutScore];
  }

  // ─── Event Writing & Real-Time Watching ───

  /**
   * Write an event file to the events directory.
   * Public method used by EventServer to enqueue events via HTTP.
   */
  writeEvent(event: MotivaEvent): void {
    const eventsDir = path.join(this.baseDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const filename = `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(eventsDir, filename);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(event, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Start watching the events directory for new event files.
   * When a new .json file appears, parse it and push it to the in-memory queue.
   * Optionally calls onEvent callback immediately on each new event.
   */
  startWatcher(onEvent?: (event: MotivaEvent) => void): void {
    this.onEventCallback = onEvent ?? null;
    const eventsDir = path.join(this.baseDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });

    this.watcher = fs.watch(eventsDir, (eventType, filename) => {
      if (eventType !== "rename" || !filename?.endsWith(".json")) return;
      if (filename.endsWith(".tmp")) return;

      const filePath = path.join(eventsDir, filename);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // file deleted — expected
        this.logger?.warn(`[DriveSystem] watcher read error: ${String(err)}`);
        return;
      }
      try {
        const event = MotivaEventSchema.parse(JSON.parse(content) as unknown);
        this.inMemoryQueue.push(event);
        if (this.onEventCallback) {
          this.onEventCallback(event);
        }
      } catch (err) {
        this.logger?.warn(`[DriveSystem] watcher parse error in ${filename}: ${String(err)}`);
      }
    });
  }

  /**
   * Stop watching the events directory and clear the callback.
   */
  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.onEventCallback = null;
  }

  /**
   * Return all events accumulated in the in-memory queue since the last drain,
   * and clear the queue.
   */
  drainInMemoryQueue(): MotivaEvent[] {
    const events = [...this.inMemoryQueue];
    this.inMemoryQueue = [];
    return events;
  }
}
