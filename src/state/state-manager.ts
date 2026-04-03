import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getPulseedDirPath } from "../utils/paths.js";
import { StateError } from "../utils/errors.js";
import type { Logger } from "../runtime/logger.js";
import { GoalSchema, GoalTreeSchema } from "../types/goal.js";
import { ObservationLogSchema, ObservationLogEntrySchema } from "../types/state.js";
import { GapHistoryEntrySchema } from "../types/gap.js";
import type { Goal, GoalTree } from "../types/goal.js";
import type { ObservationLog, ObservationLogEntry } from "../types/state.js";
import type { GapHistoryEntry } from "../types/gap.js";
import type { PaceSnapshot } from "../types/goal.js";
import { LoopCheckpointSchema } from "../types/checkpoint.js";
import type { TrustManager } from "../traits/trust-manager.js";
import { initDirs, atomicWrite, atomicRead } from "./state-persistence.js";

export { initDirs, atomicWrite, atomicRead };

/**
 * StateManager handles persistence of goals, state vectors, observation logs,
 * and gap history under a base directory (default: ~/.pulseed/).
 *
 * File layout:
 *   <base>/goals/<goal_id>/goal.json
 *   <base>/goals/<goal_id>/observations.json
 *   <base>/goals/<goal_id>/gap-history.json
 *   <base>/goal-trees/<root_id>.json
 *   <base>/events/              (event queue directory)
 *   <base>/events/archive/      (processed events)
 *   <base>/reports/             (report output directory)
 *
 * All writes are atomic: write to .tmp file, then rename.
 */
export class StateManager {
  private readonly baseDir: string;
  private readonly logger?: Logger;

  constructor(baseDir?: string, logger?: Logger) {
    this.baseDir = baseDir ?? getPulseedDirPath();
    this.logger = logger;
  }

  /** Create required subdirectories. Must be called after construction before first use. */
  async init(): Promise<void> {
    await initDirs(this.baseDir);
  }

  /** Returns the base directory path */
  getBaseDir(): string {
    return this.baseDir;
  }

  private async goalDir(goalId: string): Promise<string> {
    const dir = path.join(this.baseDir, "goals", goalId);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return dir;
      throw err;
    }
    return dir;
  }

  // ─── Atomic Write / Read (delegated to state-persistence) ───

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    return atomicWrite(filePath, data);
  }

  private async atomicRead<T>(filePath: string): Promise<T | null> {
    return atomicRead<T>(filePath, this.logger);
  }

  // ─── Goal CRUD ───

  async saveGoal(goal: Goal): Promise<void> {
    const parsed = GoalSchema.parse(goal);
    const dir = await this.goalDir(parsed.id);
    await this.atomicWrite(path.join(dir, "goal.json"), parsed);
  }

  async loadGoal(goalId: string): Promise<Goal | null> {
    // Primary path: active goals
    const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
    const raw = await this.atomicRead<unknown>(filePath);
    if (raw !== null) return GoalSchema.parse(raw);

    // Fallback: archived goals (archiveGoal() copies goal dir to archive/<goalId>/goal/)
    const archivePath = path.join(this.baseDir, "archive", goalId, "goal", "goal.json");
    const archiveRaw = await this.atomicRead<unknown>(archivePath);
    if (archiveRaw === null) return null;
    return GoalSchema.parse(archiveRaw);
  }

  async deleteGoal(goalId: string, _visited = new Set<string>()): Promise<boolean> {
    if (_visited.has(goalId)) return false;
    _visited.add(goalId);

    const dir = path.join(this.baseDir, "goals", goalId);
    try {
      await fsp.access(dir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // After the active goals check fails, try archive directory
      const archiveDir = path.join(this.baseDir, "archive", goalId);
      try {
        await fsp.access(archiveDir);
        // Load archived goal to get children_ids before deleting
        const archiveGoalPath = path.join(archiveDir, "goal", "goal.json");
        let archivedGoal: Goal | null = null;
        try {
          const raw = await this.atomicRead<unknown>(archiveGoalPath);
          if (raw !== null) archivedGoal = GoalSchema.parse(raw);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          this.logger?.warn(`[StateManager] Skipping children of archived "${goalId}": goal.json unreadable`);
        }
        if (archivedGoal !== null) {
          for (const childId of archivedGoal.children_ids) {
            await this.deleteGoal(childId, _visited);
          }
        }
        await fsp.rm(archiveDir, { recursive: true, force: true });
        return true;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        return false;
      }
    }

    // Recursively delete children first (depth-first)
    let goal: Goal | null = null;
    try {
      goal = await this.loadGoal(goalId);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.logger?.warn(`[StateManager] Skipping children of "${goalId}": goal.json unreadable`);
    }
    if (goal !== null) {
      for (const childId of goal.children_ids) {
        await this.deleteGoal(childId, _visited);
      }
    }

    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * Archive a completed goal by moving its state files to
   * <base>/archive/<goalId>/.
   *
   * Moves:
   *   goals/<goalId>/         → archive/<goalId>/goal/
   *   tasks/<goalId>/         → archive/<goalId>/tasks/    (if exists)
   *   strategies/<goalId>/    → archive/<goalId>/strategies/ (if exists)
   *   stalls/<goalId>.json    → archive/<goalId>/stalls.json (if exists)
   *   reports/<goalId>/       → archive/<goalId>/reports/  (if exists)
   *
   * Returns true if the goal was archived, false if the goal was not found.
   */
  async archiveGoal(goalId: string, _visited = new Set<string>()): Promise<boolean> {
    if (_visited.has(goalId)) return false;
    _visited.add(goalId);

    const goalDir = path.join(this.baseDir, "goals", goalId);
    try {
      await fsp.access(goalDir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    }

    // Recursively archive children first (depth-first)
    let goal: Goal | null = null;
    try {
      goal = await this.loadGoal(goalId);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.logger?.warn(`[StateManager] Skipping children of "${goalId}": goal.json unreadable`);
    }
    if (goal !== null) {
      for (const childId of goal.children_ids) {
        await this.archiveGoal(childId, _visited);
      }
    }

    const archiveBase = path.join(this.baseDir, "archive", goalId);
    await fsp.mkdir(archiveBase, { recursive: true });

    // Move goals/<goalId>/ → archive/<goalId>/goal/
    const archiveGoalDir = path.join(archiveBase, "goal");
    await fsp.cp(goalDir, archiveGoalDir, { recursive: true });
    await fsp.rm(goalDir, { recursive: true, force: true });

    // Update status to "archived" in the archived goal.json (Bug 5)
    // Use direct JSON merge instead of GoalSchema.parse() to avoid silent failure
    // when unrelated fields fail Zod validation, which would leave status as "active".
    const archivedGoalJsonPath = path.join(archiveGoalDir, "goal.json");
    try {
      const archivedRaw = await this.atomicRead<unknown>(archivedGoalJsonPath);
      if (archivedRaw !== null && typeof archivedRaw === "object") {
        await this.atomicWrite(archivedGoalJsonPath, { ...(archivedRaw as Record<string, unknown>), status: "archived" });
      } else {
        this.logger?.warn(`[StateManager] Could not update status to "archived" for "${goalId}": goal.json missing or not an object`);
      }
    } catch (err) {
      this.logger?.warn(`[StateManager] Could not update status to "archived" for "${goalId}": ${String(err)}`);
    }

    // Move tasks/<goalId>/ → archive/<goalId>/tasks/ (if exists)
    const tasksDir = path.join(this.baseDir, "tasks", goalId);
    try {
      await fsp.access(tasksDir);
      const archiveTasksDir = path.join(archiveBase, "tasks");
      await fsp.cp(tasksDir, archiveTasksDir, { recursive: true });
      await fsp.rm(tasksDir, { recursive: true, force: true });
    } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

    // Move strategies/<goalId>/ → archive/<goalId>/strategies/ (if exists)
    const strategiesDir = path.join(this.baseDir, "strategies", goalId);
    try {
      await fsp.access(strategiesDir);
      const archiveStrategiesDir = path.join(archiveBase, "strategies");
      await fsp.cp(strategiesDir, archiveStrategiesDir, { recursive: true });
      await fsp.rm(strategiesDir, { recursive: true, force: true });
    } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

    // Move stalls/<goalId>.json → archive/<goalId>/stalls.json (if exists)
    const stallsFile = path.join(this.baseDir, "stalls", `${goalId}.json`);
    try {
      await fsp.access(stallsFile);
      const archiveStallsFile = path.join(archiveBase, "stalls.json");
      await fsp.cp(stallsFile, archiveStallsFile);
      await fsp.rm(stallsFile, { force: true });
    } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

    // Move reports/<goalId>/ → archive/<goalId>/reports/ (if exists)
    const reportsDir = path.join(this.baseDir, "reports", goalId);
    try {
      await fsp.access(reportsDir);
      const archiveReportsDir = path.join(archiveBase, "reports");
      await fsp.cp(reportsDir, archiveReportsDir, { recursive: true });
      await fsp.rm(reportsDir, { recursive: true, force: true });
    } catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }

    return true;
  }

  /**
   * Returns the goal IDs of all archived goals under <base>/archive/.
   */
  async listArchivedGoals(): Promise<string[]> {
    const archiveDir = path.join(this.baseDir, "archive");
    try {
      const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
      return entries.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return [];
    }
  }

  async listGoalIds(): Promise<string[]> {
    const goalsDir = path.join(this.baseDir, "goals");
    try {
      const entries = await fsp.readdir(goalsDir, { withFileTypes: true });
      return entries.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return [];
    }
  }

  // ─── Goal Tree ───

  async saveGoalTree(tree: GoalTree): Promise<void> {
    const parsed = GoalTreeSchema.parse(tree);
    const filePath = path.join(
      this.baseDir,
      "goal-trees",
      `${parsed.root_id}.json`
    );
    await this.atomicWrite(filePath, parsed);
  }

  async loadGoalTree(rootId: string): Promise<GoalTree | null> {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    const raw = await this.atomicRead<unknown>(filePath);
    if (raw === null) return null;
    return GoalTreeSchema.parse(raw);
  }

  async deleteGoalTree(rootId: string): Promise<boolean> {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    try {
      await fsp.unlink(filePath);
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    }
  }

  // ─── Observation Log ───

  async saveObservationLog(log: ObservationLog): Promise<void> {
    const parsed = ObservationLogSchema.parse(log);
    const dir = await this.goalDir(parsed.goal_id);
    await this.atomicWrite(path.join(dir, "observations.json"), parsed);
  }

  async loadObservationLog(goalId: string): Promise<ObservationLog | null> {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "observations.json"
    );
    const raw = await this.atomicRead<unknown>(filePath);
    if (raw === null) return null;
    return ObservationLogSchema.parse(raw);
  }

  async appendObservation(goalId: string, entry: ObservationLogEntry): Promise<void> {
    const parsed = ObservationLogEntrySchema.parse(entry);
    if (parsed.goal_id !== goalId) {
      throw new StateError(
        `appendObservation: entry.goal_id ("${parsed.goal_id}") does not match goalId ("${goalId}")`
      );
    }
    let log = await this.loadObservationLog(goalId);
    if (log === null) {
      log = { goal_id: goalId, entries: [] };
    }
    log.entries.push(parsed);
    log.entries = log.entries.slice(-500);
    await this.saveObservationLog(log);
  }

  // ─── Gap History ───

  async saveGapHistory(goalId: string, history: GapHistoryEntry[]): Promise<void> {
    const parsed = history.map((e) => GapHistoryEntrySchema.parse(e));
    const dir = await this.goalDir(goalId);
    await this.atomicWrite(path.join(dir, "gap-history.json"), parsed);
  }

  async loadGapHistory(goalId: string): Promise<GapHistoryEntry[]> {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "gap-history.json"
    );
    const raw = await this.atomicRead<unknown[]>(filePath);
    if (raw === null) return [];
    return raw.map((e) => GapHistoryEntrySchema.parse(e));
  }

  async appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry): Promise<void> {
    const parsed = GapHistoryEntrySchema.parse(entry);
    const history = await this.loadGapHistory(goalId);
    history.push(parsed);
    await this.saveGapHistory(goalId, history.slice(-500));
  }

  /**
   * Save a pace snapshot to a milestone goal (persists to disk).
   */
  async savePaceSnapshot(goalId: string, snapshot: PaceSnapshot): Promise<void> {
    const goal = await this.loadGoal(goalId);
    if (!goal) {
      throw new StateError(`savePaceSnapshot: goal "${goalId}" not found`);
    }
    const updated: Goal = { ...goal, pace_snapshot: snapshot };
    await this.saveGoal(updated);
  }

  // ─── Goal Tree Traversal ───

  /**
   * BFS traversal starting at rootId.
   * Returns null if rootId doesn't exist, otherwise returns goals in BFS order.
   */
  private async bfsCollect(rootId: string): Promise<Goal[] | null> {
    const root = await this.loadGoal(rootId);
    if (root === null) return null;

    const result: Goal[] = [];
    const queue: string[] = [rootId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const goal = await this.loadGoal(currentId);
      if (goal === null) continue;

      result.push(goal);

      for (const childId of goal.children_ids) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    return result;
  }

  /**
   * Get the full goal tree rooted at rootId.
   * Returns null if the root goal doesn't exist.
   * Returns goals in BFS order: root first, then children level by level.
   */
  async getGoalTree(rootId: string): Promise<Goal[] | null> {
    return this.bfsCollect(rootId);
  }

  /**
   * Get all goals in the subtree of goalId (including goalId itself).
   * Returns [] if goal not found.
   */
  async getSubtree(goalId: string): Promise<Goal[]> {
    return (await this.bfsCollect(goalId)) ?? [];
  }

  /**
   * Update a goal that belongs to a tree, handling both goal and tree consistency.
   * Merges updates into the existing goal, preserving its id.
   * If the goal has a parent_id, ensures the parent's children_ids still includes this goal.
   */
  async updateGoalInTree(goalId: string, updates: Partial<Goal>): Promise<void> {
    const existingGoal = await this.loadGoal(goalId);
    if (existingGoal === null) {
      throw new StateError(`updateGoalInTree: goal "${goalId}" not found`);
    }

    const updatedGoal: Goal = {
      ...existingGoal,
      ...updates,
      id: existingGoal.id,  // id is immutable
    };

    await this.saveGoal(updatedGoal);

    // Ensure parent's children_ids still includes this goal
    if (existingGoal.parent_id !== null) {
      const parent = await this.loadGoal(existingGoal.parent_id);
      if (parent !== null && !parent.children_ids.includes(goalId)) {
        await this.saveGoal({
          ...parent,
          children_ids: [...parent.children_ids, goalId],
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Utility ───

  /** Check whether a goal directory exists */
  async goalExists(goalId: string): Promise<boolean> {
    try {
      await fsp.access(path.join(this.baseDir, "goals", goalId, "goal.json"));
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    }
  }

  /**
   * Restore dimension values and trust balance from a loop crash-recovery checkpoint.
   * Uses Zod validation on both the checkpoint and the goal.
   * Returns the saved cycle_number so the caller can resume iteration counting,
   * or 0 if no checkpoint exists or restoration fails (non-fatal).
   */
  async restoreFromCheckpoint(
    goalId: string,
    adapterType: string,
    trustManager?: TrustManager
  ): Promise<number> {
    try {
      const raw = await this.atomicRead<unknown>(
        path.join(this.baseDir, "goals", goalId, "checkpoint.json")
      );
      if (raw === null) return 0;

      const parseResult = LoopCheckpointSchema.safeParse(raw);
      if (!parseResult.success) {
        this.logger?.warn(`[StateManager] Invalid checkpoint for "${goalId}": ${parseResult.error.message}`);
        return 0;
      }
      const cp = parseResult.data;

      // Restore dimension values from snapshot
      if (cp.dimension_snapshot) {
        const goal = await this.loadGoal(goalId);
        if (goal !== null) {
          const updatedDimensions = goal.dimensions.map((dim) => {
            const snapshotVal = cp.dimension_snapshot![dim.name];
            return typeof snapshotVal === "number"
              ? { ...dim, current_value: snapshotVal }
              : dim;
          });
          await this.saveGoal({ ...goal, dimensions: updatedDimensions });
        }
      }

      // Restore trust balance for the adapter domain
      if (typeof cp.trust_snapshot === "number" && trustManager) {
        try {
          await trustManager.setOverride(adapterType, cp.trust_snapshot, "checkpoint_restore");
        } catch (e: unknown) {
          // Non-fatal — trust restore failure should not abort the run
        }
      }

      return cp.cycle_number;
    } catch (e: unknown) {
      // Checkpoint restore failure is non-fatal — caller starts from beginning
      return 0;
    }
  }

  /** Read raw JSON from any path relative to base dir */
  async readRaw(relativePath: string): Promise<unknown | null> {
    const resolved = path.resolve(this.baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    return this.atomicRead<unknown>(resolved);
  }

  /** Write raw JSON to any path relative to base dir (atomic) */
  async writeRaw(relativePath: string, data: unknown): Promise<void> {
    const resolved = path.resolve(this.baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    const filePath = resolved;
    const dir = path.dirname(filePath);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await this.atomicWrite(filePath, data);
  }
}
