import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { PulSeedEventSchema, GoalScheduleSchema } from "../types/drive.js";
import type { PulSeedEvent, GoalSchedule } from "../types/drive.js";
import type { StateManager } from "../state/state-manager.js";
import type { Logger } from "../runtime/logger.js";
import { writeJsonFileAtomic } from "../utils/json-io.js";

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
  private watcher: FSWatcher | null = null;
  private inMemoryQueue: PulSeedEvent[] = [];
  private onEventCallback: ((event: PulSeedEvent) => void) | null = null;
  private readonly initPromise: Promise<void>;

  constructor(stateManager: StateManager, options?: { baseDir?: string; logger?: Logger }) {
    this.stateManager = stateManager;
    this.baseDir = options?.baseDir ?? stateManager.getBaseDir();
    this.logger = options?.logger;
    this.watcher = null;
    this.inMemoryQueue = [];
    this.onEventCallback = null;
    this.initPromise = this.ensureDirectories().catch((err) => {
      this.logger?.warn?.(`DriveSystem: failed to create directories: ${err}`);
    });
  }

  // ─── Directory Management ───

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      path.join(this.baseDir, "events"),
      path.join(this.baseDir, "events", "archive"),
      path.join(this.baseDir, "schedule"),
    ];
    for (const dir of dirs) {
      await fsp.mkdir(dir, { recursive: true });
    }
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
        goal.status === "archived" ||
        goal.status === "abandoned"
      ) {
        return false;
      }
    }

    // Check event queue for events targeting this goal
    const events = await this.readEventQueue();
    if (events.length > 0) {
      const hasGoalEvent = events.some(
        (e) => e.data["goal_id"] === goalId || e.data["target_goal_id"] === goalId
      );
      if (hasGoalEvent) {
        return true;
      }
    }

    // Check if schedule is due
    if (await this.isScheduleDue(goalId)) {
      return true;
    }

    return false;
  }

  // ─── Event Queue ───

  /**
   * Read all JSON files from {baseDir}/events/ directory.
   * Parse each as PulSeedEvent. Return sorted by timestamp (oldest first).
   * Skips files that fail to parse (logs a warning).
   */
  async readEventQueue(): Promise<PulSeedEvent[]> {
    await this.initPromise;
    const eventsDir = path.join(this.baseDir, "events");

    let fileNames: string[];
    try {
      fileNames = (await fsp.readdir(eventsDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const events: PulSeedEvent[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(eventsDir, fileName);

      // Skip directories (e.g., the archive subdirectory)
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = await fsp.readFile(filePath, "utf-8");
        const raw = JSON.parse(content) as unknown;
        const event = PulSeedEventSchema.parse(raw);
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
  async archiveEvent(eventFileName: string): Promise<void> {
    const srcPath = path.join(this.baseDir, "events", eventFileName);
    const archiveDir = path.join(this.baseDir, "events", "archive");
    await fsp.mkdir(archiveDir, { recursive: true });
    const dstPath = path.join(archiveDir, eventFileName);
    await fsp.rename(srcPath, dstPath);
  }

  /**
   * Read queue, archive each processed event, return the events.
   */
  async processEvents(): Promise<PulSeedEvent[]> {
    await this.initPromise;
    const eventsDir = path.join(this.baseDir, "events");

    let fileNames: string[];
    try {
      fileNames = (await fsp.readdir(eventsDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }

    const events: PulSeedEvent[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(eventsDir, fileName);

      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = await fsp.readFile(filePath, "utf-8");
        const raw = JSON.parse(content) as unknown;
        const event = PulSeedEventSchema.parse(raw);
        await this.archiveEvent(fileName);
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
  async getSchedule(goalId: string): Promise<GoalSchedule | null> {
    await this.initPromise;
    const filePath = path.join(this.baseDir, "schedule", `${goalId}.json`);
    try {
      const content = await fsp.readFile(filePath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      return GoalScheduleSchema.parse(raw);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      // Corrupted or invalid schedule file — return a fallback schedule that is immediately due
      this.logger?.warn(`DriveSystem: failed to load schedule for goal "${goalId}", using fallback: ${err}`);
      return GoalScheduleSchema.parse({
        goal_id: goalId,
        next_check_at: new Date(0).toISOString(),
        check_interval_hours: 1,
        last_triggered_at: null,
        consecutive_actions: 0,
        cooldown_until: null,
        current_interval_hours: 1,
      });
    }
  }

  /**
   * Save schedule atomically to {baseDir}/schedule/{goalId}.json.
   */
  async updateSchedule(goalId: string, schedule: GoalSchedule): Promise<void> {
    await this.initPromise;
    const scheduleDir = path.join(this.baseDir, "schedule");
    await fsp.mkdir(scheduleDir, { recursive: true });
    const validated = GoalScheduleSchema.parse(schedule);
    const filePath = path.join(scheduleDir, `${goalId}.json`);
    await writeJsonFileAtomic(filePath, validated);
  }

  /**
   * Check if the schedule for a goal is due (next_check_at <= now).
   * If no schedule exists, returns true (needs initial check).
   */
  async isScheduleDue(goalId: string): Promise<boolean> {
    const schedule = await this.getSchedule(goalId);
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
  async writeEvent(event: PulSeedEvent): Promise<void> {
    await this.initPromise;
    const eventsDir = path.join(this.baseDir, "events");
    await fsp.mkdir(eventsDir, { recursive: true });
    const filename = `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(eventsDir, filename);
    await writeJsonFileAtomic(filePath, event);
  }

  /**
   * Start watching the events directory for new event files.
   * When a new .json file appears, parse it and push it to the in-memory queue.
   * Optionally calls onEvent callback immediately on each new event.
   */
  startWatcher(onEvent?: (event: PulSeedEvent) => void): void {
    this.onEventCallback = onEvent ?? null;
    const eventsDir = path.join(this.baseDir, "events");

    // initPromise ensures the directory exists; if not yet resolved,
    // the watcher will be started after it completes.
    void this.initPromise.then(() => {
      // Guard: if stopWatcher was called before initPromise resolved
      if (this.onEventCallback === null && onEvent !== undefined) return;

      this.watcher = watch(eventsDir, (eventType, filename) => {
        if (eventType !== "rename" || !filename?.endsWith(".json")) return;
        if (filename.endsWith(".tmp")) return;

        const filePath = path.join(eventsDir, filename);
        void this.handleWatchEvent(filePath).catch((err) => {
          this.logger?.warn(`[DriveSystem] watcher async error: ${String(err)}`);
        });
      });
    });
  }

  /**
   * Handle a file event from the watcher asynchronously.
   */
  private async handleWatchEvent(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // file deleted — expected
      this.logger?.warn(`[DriveSystem] watcher read error: ${String(err)}`);
      return;
    }
    try {
      const event = PulSeedEventSchema.parse(JSON.parse(content) as unknown);
      this.inMemoryQueue.push(event);
      if (this.onEventCallback) {
        this.onEventCallback(event);
      }
    } catch (err) {
      this.logger?.warn(`[DriveSystem] watcher parse error in ${path.basename(filePath)}: ${String(err)}`);
    }
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
  drainInMemoryQueue(): PulSeedEvent[] {
    const events = [...this.inMemoryQueue];
    this.inMemoryQueue = [];
    return events;
  }
}
