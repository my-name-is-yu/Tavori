import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { CoreLoop } from "../core-loop.js";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../utils/json-io.js";
import type { LoopResult } from "../core-loop.js";
import { DriveSystem } from "../drive/drive-system.js";
import { StateManager } from "../state-manager.js";
import { PIDManager } from "./pid-manager.js";
import { Logger } from "./logger.js";
import type { EventServer } from "./event-server.js";
import type { PulSeedEvent } from "../types/drive.js";
import type { DaemonConfig, DaemonState } from "../types/daemon.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../types/daemon.js";

// ─── ShutdownMarker ───
//
// Written to {baseDir}/shutdown-state.json to track daemon lifecycle.
// state: "running"        — daemon is active; if found on startup, previous instance crashed
// state: "clean_shutdown" — daemon exited gracefully via SIGTERM/SIGINT or stop()

interface ShutdownMarker {
  goal_ids: string[];
  loop_index: number;
  timestamp: string;   // ISO 8601
  reason: "signal" | "stop" | "max_retries" | "startup";
  state: "running" | "clean_shutdown";
}

// ─── DaemonRunner ───
//
// Runs the PulSeed CoreLoop continuously as a long-lived daemon process.
// Responsibilities:
//   - PID file management (prevent duplicate daemons)
//   - Signal handling (SIGINT/SIGTERM → graceful stop)
//   - Multi-goal scheduling (DriveSystem.shouldActivate per goal)
//   - Crash recovery (configurable max_retries before hard stop)
//   - Daemon state persistence (~/.pulseed/daemon-state.json)
//
// The daemon loop:
//   1. Determine which goals need activation (shouldActivate)
//   2. Run CoreLoop.run(goalId) for each active goal
//   3. Save state and sleep until next check interval

export interface DaemonDeps {
  coreLoop: CoreLoop;
  driveSystem: DriveSystem;
  stateManager: StateManager;
  pidManager: PIDManager;
  logger: Logger;
  config?: Partial<DaemonConfig>;
  eventServer?: EventServer;
}

export class DaemonRunner {
  private coreLoop: CoreLoop;
  private driveSystem: DriveSystem;
  private stateManager: StateManager;
  private pidManager: PIDManager;
  private logger: Logger;
  private config: DaemonConfig;
  private running = false;
  private shuttingDown = false;
  private state: DaemonState;
  private baseDir: string;
  private shutdownHandler: (() => void) | null = null;
  private eventServer: EventServer | undefined;
  private sleepAbortController: AbortController | null = null;
  private currentGoalIds: string[] = [];
  private currentLoopIndex = 0;

  constructor(deps: DaemonDeps) {
    this.coreLoop = deps.coreLoop;
    this.driveSystem = deps.driveSystem;
    this.stateManager = deps.stateManager;
    this.pidManager = deps.pidManager;
    this.logger = deps.logger;
    this.eventServer = deps.eventServer;

    // Parse config with defaults via DaemonConfigSchema.parse()
    this.config = DaemonConfigSchema.parse(deps.config ?? {});

    // Resolve base directory from stateManager
    this.baseDir = this.stateManager.getBaseDir();

    // Initialize daemon state
    this.state = DaemonStateSchema.parse({
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    });
  }

  // ─── Public API ───

  /**
   * Start daemon loop for given goals.
   * Throws if daemon is already running.
   */
  async start(goalIds: string[]): Promise<void> {
    // 1. Check if already running
    if (await this.pidManager.isRunning()) {
      const info = await this.pidManager.readPID();
      throw new Error(
        `Daemon is already running (PID ${info?.pid ?? "unknown"}). ` +
          `Stop it first or remove the PID file at: ${this.pidManager.getPath()}`
      );
    }

    // 2. Write PID file
    await this.pidManager.writePID();

    // 2b. Rotate log if needed, then check for crash recovery marker
    await this.rotateLog();
    await this.checkCrashRecovery();

    // 2c. Start EventServer (if provided) and file watcher
    if (this.eventServer) {
      await this.eventServer.start();
      this.eventServer.startFileWatcher();
      this.logger.info("EventServer started", {
        host: this.eventServer.getHost(),
        port: this.eventServer.getPort(),
      });
    }
    this.driveSystem.startWatcher((event) => this.onEventReceived(event));

    // 3. Set up signal handlers for graceful shutdown
    this.shuttingDown = false;
    const shutdownTimeout = this.config.crash_recovery.graceful_shutdown_timeout_ms ?? 30_000;
    let forceStopTimer: ReturnType<typeof setTimeout> | null = null;

    const shutdown = (): void => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.logger.info("Shutting down gracefully...");
      // Abort current sleep so the loop exits promptly
      this.sleepAbortController?.abort();
      // Start a timeout to force-stop if graceful shutdown takes too long
      forceStopTimer = setTimeout(() => {
        this.logger.warn(
          `Graceful shutdown timeout (${shutdownTimeout}ms) exceeded, forcing stop`
        );
        this.running = false;
      }, shutdownTimeout);
    };
    this.shutdownHandler = shutdown;
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // 4. Restore state from previous interrupted run
    const mergedGoalIds = await this.restoreState(goalIds);

    // 5. Save initial daemon state
    this.running = true;
    this.currentGoalIds = mergedGoalIds;
    this.currentLoopIndex = 0;
    this.state = DaemonStateSchema.parse({
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: mergedGoalIds,
      status: "running",
      crash_count: 0,
      last_error: null,
    });
    await this.saveDaemonState();

    // 5b. Write "running" shutdown marker (crash detection on next startup)
    await this.writeShutdownMarker({
      goal_ids: mergedGoalIds,
      loop_index: 0,
      timestamp: new Date().toISOString(),
      reason: "startup",
      state: "running",
    });

    // 6. Log start
    this.logger.info("Daemon started", {
      pid: process.pid,
      goals: mergedGoalIds,
      check_interval_ms: this.config.check_interval_ms,
    });

    // 7. Run main loop
    try {
      await this.runLoop(mergedGoalIds);
    } finally {
      // Cancel the force-stop timer if it's still pending
      if (forceStopTimer !== null) {
        clearTimeout(forceStopTimer);
        forceStopTimer = null;
      }
      // Remove signal handlers
      if (this.shutdownHandler) {
        process.removeListener("SIGTERM", this.shutdownHandler);
        process.removeListener("SIGINT", this.shutdownHandler);
        this.shutdownHandler = null;
      }
      // Stop file watcher and EventServer
      this.driveSystem.stopWatcher();
      if (this.eventServer) {
        this.eventServer.stopFileWatcher();
        await this.eventServer.stop();
        this.logger.info("EventServer stopped");
      }
    }
  }

  /**
   * Signal daemon to stop after current iteration completes.
   * Saves interrupted_goals so they can be restored on next start.
   */
  stop(): void {
    this.running = false;
    this.sleepAbortController?.abort();
    this.state.status = "stopping";
    // Save current active_goals as interrupted_goals for state restoration
    this.state.interrupted_goals = [...this.state.active_goals];
    // Do NOT persist here — cleanup() will save the final state after the loop exits.
    // Calling saveDaemonState() here would race with cleanup()'s save and corrupt the file.
    this.logger.info("Stop requested — daemon will stop after current iteration");
  }

  // ─── Private: Main Loop ───

  /**
   * Main daemon loop. Runs until this.running is false or a critical error occurs.
   */
  private async runLoop(goalIds: string[]): Promise<void> {
    while (this.running && !this.shuttingDown) {
      try {
        // 1. Determine which goals need activation
        const activeGoals = await this.determineActiveGoals(goalIds);

        if (activeGoals.length === 0) {
          this.logger.info("No goals need activation this cycle", {
            checked: goalIds.length,
          });
        }

        // 2. Execute loop for each active goal
        for (const goalId of activeGoals) {
          if (!this.running) break;

          this.logger.info(`Running loop for goal: ${goalId}`);

          try {
            const result: LoopResult = await this.coreLoop.run(goalId);
            this.state.loop_count++;
            this.currentLoopIndex = this.state.loop_count;
            this.state.last_loop_at = new Date().toISOString();
            this.logger.info(`Loop completed for goal: ${goalId}`, {
              status: result.finalStatus,
              iterations: result.totalIterations,
            });
          } catch (err) {
            this.handleLoopError(goalId, err);
          }

          // Bail out of goal iteration if crash limit exceeded
          if (!this.running) break;
        }

        // 3. Save state
        await this.saveDaemonState();

        // 4. Wait for next check interval
        if (this.running) {
          const intervalMs = this.getNextInterval(goalIds);
          this.logger.debug(`Sleeping for ${intervalMs}ms until next check`);
          await this.sleep(intervalMs);
        }
      } catch (err) {
        await this.handleCriticalError(err);
      }
    }

    // Cleanup after loop exits
    await this.cleanup();
  }

  // ─── Private: Goal Activation ───

  /**
   * Determine which goals should be activated this cycle.
   * Uses DriveSystem.shouldActivate() for each goal, then sorts by priority.
   */
  private async determineActiveGoals(goalIds: string[]): Promise<string[]> {
    const eligibleIds: string[] = [];
    const scores = new Map<string, number>();

    for (const goalId of goalIds) {
      if (await this.driveSystem.shouldActivate(goalId)) {
        eligibleIds.push(goalId);
        // Load goal to get a rough priority signal (gap or drive score not available here)
        // Use schedule consecutive_actions as a tiebreaker — more urgent goals first
        const schedule = await this.driveSystem.getSchedule(goalId);
        // Higher consecutive_actions = more urgent (stalled goal). Use inverse of next_check_at
        // as a proxy: goals that are most overdue rank highest.
        const nextCheckAt = schedule
          ? new Date(schedule.next_check_at).getTime()
          : 0;
        // Earlier next_check_at means more overdue → assign higher (inverted) score
        scores.set(goalId, -nextCheckAt);
      }
    }

    // Sort by priority: most overdue first
    return this.driveSystem.prioritizeGoals(eligibleIds, scores);
  }

  // ─── Private: Interval Calculation ───

  /**
   * Calculate the next check interval in milliseconds.
   * Uses per-goal override from config.goal_intervals if configured,
   * otherwise falls back to config.check_interval_ms.
   * Returns the minimum interval across all goals (so the daemon checks
   * as soon as the earliest goal is due).
   */
  private getNextInterval(goalIds: string[]): number {
    const goalIntervals = this.config.goal_intervals;

    if (!goalIntervals || goalIds.length === 0) {
      return this.config.check_interval_ms;
    }

    let minInterval = this.config.check_interval_ms;

    for (const goalId of goalIds) {
      const override = goalIntervals[goalId];
      if (override !== undefined && override < minInterval) {
        minInterval = override;
      }
    }

    return minInterval;
  }

  // ─── Private: Error Handling ───

  /**
   * Handle a non-critical loop error for a single goal.
   * Increments crash_count and stops daemon if max_retries exceeded.
   */
  private handleLoopError(goalId: string, err: unknown): void {
    this.state.last_error = err instanceof Error ? err.message : String(err);
    this.state.crash_count++;
    this.logger.error(`Loop error for goal ${goalId}`, {
      error: this.state.last_error,
      crash_count: this.state.crash_count,
      max_retries: this.config.crash_recovery.max_retries,
    });

    // If crash count exceeds max_retries, stop daemon
    if (this.state.crash_count >= this.config.crash_recovery.max_retries) {
      this.logger.error(
        `Max crash retries (${this.config.crash_recovery.max_retries}) exceeded, stopping daemon`
      );
      this.running = false;
    }
  }

  /**
   * Handle a critical daemon-level error (outer loop catch).
   * Marks state as crashed and stops the loop.
   */
  private async handleCriticalError(err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error("Critical daemon error", { error: msg });
    this.state.status = "crashed";
    this.state.last_error = msg;
    await this.saveDaemonState();
    this.running = false;
  }

  // ─── Private: State Persistence ───

  /**
   * Save daemon state to {baseDir}/daemon-state.json atomically.
   */
  private async saveDaemonState(): Promise<void> {
    const statePath = path.join(this.baseDir, "daemon-state.json");
    try {
      await writeJsonFileAtomic(statePath, this.state);
    } catch (err) {
      // Non-fatal — log but don't crash the daemon
      this.logger.warn("Failed to save daemon state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load daemon state from {baseDir}/daemon-state.json.
   * Returns null if the file doesn't exist or fails to parse.
   */
  private async loadDaemonState(): Promise<DaemonState | null> {
    const statePath = path.join(this.baseDir, "daemon-state.json");
    const data = await readJsonFileOrNull(statePath);
    if (data === null) return null;
    try {
      return DaemonStateSchema.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Restore state from a previous interrupted run.
   * Merges interrupted_goals from daemon-state.json with the given goalIds (deduped).
   * Returns the merged goal ID array.
   */
  private async restoreState(goalIds: string[]): Promise<string[]> {
    const saved = await this.loadDaemonState();
    if (!saved || !saved.interrupted_goals || saved.interrupted_goals.length === 0) {
      return goalIds;
    }

    const merged = Array.from(new Set([...goalIds, ...saved.interrupted_goals]));
    if (merged.length > goalIds.length) {
      this.logger.info("Restored interrupted goals from previous run", {
        interrupted: saved.interrupted_goals,
        merged,
      });
    }
    return merged;
  }

  // ─── Private: Cleanup ───

  /**
   * Perform cleanup after the loop exits: update state, remove PID file, log.
   * Also writes "clean_shutdown" marker to enable crash-vs-clean detection on next startup.
   */
  private async cleanup(): Promise<void> {
    // Only set to "stopped" if not already "crashed"
    const wasCrashed = this.state.status === "crashed";
    if (!wasCrashed) {
      this.state.status = "stopped";
    }
    await this.saveDaemonState();
    await this.pidManager.cleanup();

    // Write clean shutdown marker (async, atomic)
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    const marker: ShutdownMarker = {
      goal_ids: this.currentGoalIds,
      loop_index: this.currentLoopIndex,
      timestamp: new Date().toISOString(),
      reason: wasCrashed ? "max_retries" : "stop",
      state: wasCrashed ? "running" : "clean_shutdown",
    };
    try {
      await writeJsonFileAtomic(markerPath, marker);
    } catch {
      // Non-fatal
    }

    this.logger.info("Daemon stopped", {
      loop_count: this.state.loop_count,
      crash_count: this.state.crash_count,
    });
  }

  // ─── Private: Sleep ───

  /**
   * Sleep for the given number of milliseconds.
   * Can be aborted early via sleepAbortController (e.g. when an event arrives).
   */
  private sleep(ms: number): Promise<void> {
    this.sleepAbortController = new AbortController();
    const abortController = this.sleepAbortController;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abortController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }).finally(() => {
      this.sleepAbortController = null;
    });
  }

  // ─── Private: Event Handling ───

  /**
   * Called when a file-watcher event arrives from DriveSystem.
   * Aborts the current sleep so the loop runs immediately.
   */
  private onEventReceived(event: PulSeedEvent): void {
    this.logger.info("Event received, triggering immediate loop", {
      event_type: event.type,
    });
    this.sleepAbortController?.abort();
  }

  // ─── Private: Shutdown Marker ───

  /**
   * Write shutdown-state.json to baseDir (async, atomic).
   */
  private async writeShutdownMarker(marker: ShutdownMarker): Promise<void> {
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    try {
      await writeJsonFileAtomic(markerPath, marker);
    } catch {
      // Non-fatal — log but don't crash
    }
  }

  /**
   * Read shutdown-state.json from baseDir.
   * Returns null if file doesn't exist or fails to parse.
   */
  async readShutdownMarker(): Promise<ShutdownMarker | null> {
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    return readJsonFileOrNull<ShutdownMarker>(markerPath);
  }

  /**
   * Delete shutdown-state.json (after successful resume).
   */
  async deleteShutdownMarker(): Promise<void> {
    const markerPath = path.join(this.baseDir, "shutdown-state.json");
    try {
      await fsp.unlink(markerPath);
    } catch {
      // File may not exist — ignore
    }
  }

  /**
   * Check for a previous shutdown marker and log recovery information.
   * Called at startup before the main loop begins.
   */
  private async checkCrashRecovery(): Promise<void> {
    const marker = await this.readShutdownMarker();
    if (!marker) return;

    if (marker.state === "clean_shutdown") {
      this.logger.info("Resuming from clean shutdown", {
        previous_loop_index: marker.loop_index,
        previous_goals: marker.goal_ids,
        shutdown_at: marker.timestamp,
      });
    } else {
      // state === "running" — previous instance did not shut down cleanly
      this.logger.warn(
        "Recovering from crash — previous instance did not shut down cleanly",
        {
          previous_loop_index: marker.loop_index,
          previous_goals: marker.goal_ids,
          last_seen_at: marker.timestamp,
        }
      );
    }

    // Delete the marker; we'll write a fresh "running" marker in start()
    await this.deleteShutdownMarker();
  }

  // ─── Private: Log Rotation ───

  /**
   * Rotate the main log file if it exceeds the configured size limit.
   * Renames pulseed.log to pulseed.<timestamp>.log and keeps at most maxFiles rotated files.
   * Called at daemon startup.
   */
  async rotateLog(): Promise<void> {
    const logDir = path.join(this.baseDir, this.config.log_dir);
    const logPath = path.join(logDir, "pulseed.log");
    const maxSizeBytes = this.config.log_rotation.max_size_mb * 1024 * 1024;
    const maxFiles = this.config.log_rotation.max_files;

    try {
      // Check if log file exists and exceeds size limit
      let stat: Stats;
      try {
        stat = await fsp.stat(logPath);
      } catch {
        // File doesn't exist — nothing to rotate
        return;
      }

      if (stat.size < maxSizeBytes) return;

      // Rotate: rename current log with timestamp suffix
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedName = `pulseed.${timestamp}.log`;
      const rotatedPath = path.join(logDir, rotatedName);
      await fsp.rename(logPath, rotatedPath);

      this.logger.info("Log file rotated", {
        rotated_to: rotatedName,
        size_bytes: stat.size,
      });

      // Prune old rotated files: keep only the most recent maxFiles
      await this.pruneRotatedLogs(logDir, maxFiles);
    } catch {
      // Non-fatal — rotation failures should not prevent daemon startup
    }
  }

  /**
   * Remove oldest rotated log files, keeping at most maxFiles.
   */
  private async pruneRotatedLogs(logDir: string, maxFiles: number): Promise<void> {
    try {
      const entries = await fsp.readdir(logDir);
      // Rotated files match: pulseed.<timestamp>.log (not pulseed.log itself)
      const rotated = entries
        .filter((f) => /^pulseed\..+\.log$/.test(f) && f !== "pulseed.log")
        .sort(); // ISO timestamps sort lexicographically = chronologically

      // Remove oldest files beyond maxFiles
      const excess = rotated.length - maxFiles;
      if (excess <= 0) return;

      for (let i = 0; i < excess; i++) {
        await fsp.unlink(path.join(logDir, rotated[i]!));
      }
    } catch {
      // Non-fatal
    }
  }

  // ─── Static Utilities ───

  /**
   * Generate a crontab entry that runs `pulseed run --goal <goalId>` on a schedule.
   *
   * Rules:
   *   intervalMinutes <= 0 → treated as 60
   *   intervalMinutes < 60 → every N minutes:   *\/N * * * *
   *   intervalMinutes < 1440 (1 day) → every N hours: 0 *\/N * * *
   *   intervalMinutes >= 1440 → once per day:   0 0 * * *
   */
  static generateCronEntry(goalId: string, intervalMinutes: number = 60): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(goalId)) {
      throw new Error(`Invalid goalId for cron entry: "${goalId}" (only alphanumeric, underscore, hyphen allowed)`);
    }
    if (intervalMinutes <= 0) intervalMinutes = 60;

    if (intervalMinutes < 60) {
      return `*/${intervalMinutes} * * * * /usr/bin/env pulseed run --goal ${goalId}`;
    }

    const hours = Math.floor(intervalMinutes / 60);
    if (hours < 24) {
      return `0 */${hours} * * * /usr/bin/env pulseed run --goal ${goalId}`;
    }

    return `0 0 * * * /usr/bin/env pulseed run --goal ${goalId}`;
  }
}
