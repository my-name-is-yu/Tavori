import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state/state-manager.js";
import {
  getMilestones,
  getOverdueMilestones,
  evaluatePace,
  generateRescheduleOptions,
} from "../src/goal/milestone-evaluator.js";
import type { Goal, GoalTree } from "../src/types/goal.js";
import type { ObservationLogEntry } from "../src/types/state.js";
import type { GapHistoryEntry } from "../src/types/gap.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";

describe("StateManager", async () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    manager = new StateManager(tmpDir);
    await manager.init();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("directory structure", () => {
    it("creates base directories on init()", () => {
      expect(fs.existsSync(path.join(tmpDir, "goals"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "goal-trees"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "events"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "events", "archive"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "reports"))).toBe(true);
    });

    it("returns the base directory path", () => {
      expect(manager.getBaseDir()).toBe(tmpDir);
    });
  });

  describe("Goal CRUD", async () => {
    it("saves and loads a goal", async () => {
      const goal = makeGoal({ id: "goal-1", title: "My Goal", dimensions: [makeDimension({ name: "test_dim" })] });
      await manager.saveGoal(goal);
      const loaded = await manager.loadGoal("goal-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe("goal-1");
      expect(loaded!.title).toBe("My Goal");
      expect(loaded!.dimensions).toHaveLength(1);
      expect(loaded!.dimensions[0].name).toBe("test_dim");
    });

    it("returns null for non-existent goal", async () => {
      const loaded = await manager.loadGoal("nonexistent");
      expect(loaded).toBeNull();
    });

    it("overwrites existing goal on save", async () => {
      const goal = makeGoal({ id: "goal-1", title: "Original" });
      await manager.saveGoal(goal);

      const updated = makeGoal({ id: "goal-1", title: "Updated" });
      await manager.saveGoal(updated);

      const loaded = await manager.loadGoal("goal-1");
      expect(loaded!.title).toBe("Updated");
    });

    it("deletes a goal", async () => {
      const goal = makeGoal({ id: "goal-del" });
      await manager.saveGoal(goal);
      expect(await manager.goalExists("goal-del")).toBe(true);

      const result = await manager.deleteGoal("goal-del");
      expect(result).toBe(true);
      expect(await manager.goalExists("goal-del")).toBe(false);
      expect(await manager.loadGoal("goal-del")).toBeNull();
    });

    it("returns false when deleting non-existent goal", async () => {
      expect(await manager.deleteGoal("nope")).toBe(false);
    });

    it("lists goal IDs", async () => {
      await manager.saveGoal(makeGoal({ id: "g1" }));
      await manager.saveGoal(makeGoal({ id: "g2" }));
      await manager.saveGoal(makeGoal({ id: "g3" }));

      const ids = await manager.listGoalIds();
      expect(ids.sort()).toEqual(["g1", "g2", "g3"]);
    });

    it("goalExists returns correct values", async () => {
      expect(await manager.goalExists("nope")).toBe(false);
      await manager.saveGoal(makeGoal({ id: "exists" }));
      expect(await manager.goalExists("exists")).toBe(true);
    });
  });

  describe("atomic writes", async () => {
    it("does not leave .tmp files after successful write", async () => {
      const goal = makeGoal({ id: "atomic-test" });
      await manager.saveGoal(goal);

      const goalDir = path.join(tmpDir, "goals", "atomic-test");
      const files = fs.readdirSync(goalDir);
      expect(files).toContain("goal.json");
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });

    it("writes valid JSON that can be parsed", async () => {
      const goal = makeGoal({ id: "json-test" });
      await manager.saveGoal(goal);

      const filePath = path.join(tmpDir, "goals", "json-test", "goal.json");
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.id).toBe("json-test");
    });
  });

  describe("Issue #429: non-ENOENT errors are re-thrown", async () => {
    it("listGoalIds re-throws non-ENOENT errors", async () => {
      // Remove the goals dir and replace it with a file to cause ENOTDIR
      const goalsDir = path.join(tmpDir, "goals");
      fs.rmSync(goalsDir, { recursive: true, force: true });
      fs.writeFileSync(goalsDir, "not a directory");

      await expect(manager.listGoalIds()).rejects.toThrow();

      // Restore for afterEach cleanup
      fs.rmSync(goalsDir);
      fs.mkdirSync(goalsDir);
    });

    it("listArchivedGoals re-throws non-ENOENT errors", async () => {
      // Create archive as a file instead of directory to cause ENOTDIR on readdir
      const archiveDir = path.join(tmpDir, "archive");
      fs.writeFileSync(archiveDir, "not a directory");

      await expect(manager.listArchivedGoals()).rejects.toThrow();

      // Restore for afterEach cleanup
      fs.rmSync(archiveDir);
    });

    it("deleteGoalTree re-throws non-ENOENT errors", async () => {
      // Create a directory where the file should be so unlink gets EISDIR
      const treeDir = path.join(tmpDir, "goal-trees", "bad-id.json");
      fs.mkdirSync(treeDir, { recursive: true });

      await expect(manager.deleteGoalTree("bad-id")).rejects.toThrow();

      // Restore for afterEach cleanup
      fs.rmSync(treeDir, { recursive: true, force: true });
    });

    it("goalExists re-throws non-ENOENT errors (ENOTDIR via file as dir)", async () => {
      // Make goals/<goalId> a regular file — then fsp.access(goals/<goalId>/goal.json)
      // fails with ENOTDIR because it tries to traverse into a non-directory
      const goalEntry = path.join(tmpDir, "goals", "badgoal-exists");
      fs.rmSync(goalEntry, { recursive: true, force: true });
      fs.writeFileSync(goalEntry, "not a dir");

      await expect(manager.goalExists("badgoal-exists")).rejects.toThrow();

      // Restore for afterEach cleanup
      fs.rmSync(goalEntry);
    });

    it("deleteGoal re-throws non-ENOENT errors on goal dir access", async () => {
      // Remove execute permission from goals dir so fsp.access fails with EACCES
      const goalsDir = path.join(tmpDir, "goals");
      fs.chmodSync(goalsDir, 0o000);

      try {
        await expect(manager.deleteGoal("any-goal")).rejects.toThrow();
      } finally {
        fs.chmodSync(goalsDir, 0o755);
      }
    });

    it("archiveGoal re-throws non-ENOENT errors on goal dir access", async () => {
      // Remove execute permission from goals dir so fsp.access fails with EACCES
      const goalsDir = path.join(tmpDir, "goals");
      fs.chmodSync(goalsDir, 0o000);

      try {
        await expect(manager.archiveGoal("any-goal")).rejects.toThrow();
      } finally {
        fs.chmodSync(goalsDir, 0o755);
      }
    });
  });

  describe("Issue #430: corrupt JSON returns null instead of throwing", async () => {
    it("loadGoal returns null for corrupt goal.json", async () => {
      const goal = makeGoal({ id: "corrupt-goal" });
      await manager.saveGoal(goal);

      const goalPath = path.join(tmpDir, "goals", "corrupt-goal", "goal.json");
      fs.writeFileSync(goalPath, "{ not valid json ~~~");

      const result = await manager.loadGoal("corrupt-goal");
      expect(result).toBeNull();
    });

    it("loadObservationLog returns null for corrupt observations.json", async () => {
      await manager.saveGoal(makeGoal({ id: "corrupt-obs" }));
      const obsPath = path.join(tmpDir, "goals", "corrupt-obs", "observations.json");
      fs.mkdirSync(path.dirname(obsPath), { recursive: true });
      fs.writeFileSync(obsPath, "{ bad json");

      const result = await manager.loadObservationLog("corrupt-obs");
      expect(result).toBeNull();
    });

    it("loadGapHistory returns empty array for corrupt gap-history.json", async () => {
      await manager.saveGoal(makeGoal({ id: "corrupt-gap" }));
      const gapPath = path.join(tmpDir, "goals", "corrupt-gap", "gap-history.json");
      fs.mkdirSync(path.dirname(gapPath), { recursive: true });
      fs.writeFileSync(gapPath, "not json at all");

      const result = await manager.loadGapHistory("corrupt-gap");
      // atomicRead returns null -> loadGapHistory returns []
      expect(result).toEqual([]);
    });
  });

  describe("Issue #431: history capping at 500 entries", async () => {
    it("appendObservation caps entries at 500", async () => {
      await manager.saveGoal(makeGoal({ id: "cap-obs" }));

      const baseEntry: ObservationLogEntry = {
        observation_id: "obs-0",
        timestamp: new Date().toISOString(),
        trigger: "periodic",
        goal_id: "cap-obs",
        dimension_name: "dim1",
        layer: "mechanical",
        method: {
          type: "api_query",
          source: "api",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        raw_result: 1,
        extracted_value: 1,
        confidence: 0.9,
        notes: null,
      };

      // Append 510 entries
      for (let i = 0; i < 510; i++) {
        await manager.appendObservation("cap-obs", { ...baseEntry, observation_id: `obs-${i}` });
      }

      const loaded = await manager.loadObservationLog("cap-obs");
      expect(loaded!.entries).toHaveLength(500);
      // Should keep the last 500 (obs-10 through obs-509)
      expect(loaded!.entries[0].observation_id).toBe("obs-10");
      expect(loaded!.entries[499].observation_id).toBe("obs-509");
    });

    it("appendGapHistoryEntry caps entries at 500", async () => {
      await manager.saveGoal(makeGoal({ id: "cap-gap" }));

      const baseEntry: GapHistoryEntry = {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "d", normalized_weighted_gap: 0.5 }],
        confidence_vector: [{ dimension_name: "d", confidence: 0.9 }],
      };

      // Append 510 entries
      for (let i = 0; i < 510; i++) {
        await manager.appendGapHistoryEntry("cap-gap", { ...baseEntry, iteration: i });
      }

      const loaded = await manager.loadGapHistory("cap-gap");
      expect(loaded).toHaveLength(500);
      // Should keep the last 500 (iteration 10 through 509)
      expect(loaded[0].iteration).toBe(10);
      expect(loaded[499].iteration).toBe(509);
    });
  });

  describe("Goal Tree", async () => {
    it("saves and loads a goal tree", async () => {
      const goal1 = makeGoal({ id: "root", children_ids: ["child1"] });
      const goal2 = makeGoal({ id: "child1", parent_id: "root", node_type: "subgoal" });

      const tree: GoalTree = {
        root_id: "root",
        goals: {
          root: goal1,
          child1: goal2,
        },
      };

      await manager.saveGoalTree(tree);
      const loaded = await manager.loadGoalTree("root");
      expect(loaded).not.toBeNull();
      expect(loaded!.root_id).toBe("root");
      expect(Object.keys(loaded!.goals)).toHaveLength(2);
    });

    it("returns null for non-existent tree", async () => {
      expect(await manager.loadGoalTree("nonexistent")).toBeNull();
    });

    it("deletes a goal tree", async () => {
      const tree: GoalTree = {
        root_id: "del-tree",
        goals: {
          "del-tree": makeGoal({ id: "del-tree" }),
        },
      };
      await manager.saveGoalTree(tree);
      expect(await manager.deleteGoalTree("del-tree")).toBe(true);
      expect(await manager.loadGoalTree("del-tree")).toBeNull();
    });
  });

  describe("Observation Log", async () => {
    it("saves and loads observation log", async () => {
      const log = {
        goal_id: "obs-goal",
        entries: [
          {
            observation_id: "obs-1",
            timestamp: new Date().toISOString(),
            trigger: "post_task" as const,
            goal_id: "obs-goal",
            dimension_name: "test_dim",
            layer: "mechanical" as const,
            method: {
              type: "mechanical" as const,
              source: "test",
              schedule: null,
              endpoint: null,
              confidence_tier: "mechanical" as const,
            },
            raw_result: { value: 42 },
            extracted_value: 42,
            confidence: 0.95,
            notes: null,
          },
        ],
      };

      // Save the goal first so the directory exists
      await manager.saveGoal(makeGoal({ id: "obs-goal" }));
      await manager.saveObservationLog(log);

      const loaded = await manager.loadObservationLog("obs-goal");
      expect(loaded).not.toBeNull();
      expect(loaded!.entries).toHaveLength(1);
      expect(loaded!.entries[0].observation_id).toBe("obs-1");
    });

    it("appends observations", async () => {
      await manager.saveGoal(makeGoal({ id: "append-obs" }));

      const entry1: ObservationLogEntry = {
        observation_id: "obs-a",
        timestamp: new Date().toISOString(),
        trigger: "periodic",
        goal_id: "append-obs",
        dimension_name: "dim1",
        layer: "mechanical",
        method: {
          type: "api_query",
          source: "api",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        raw_result: 10,
        extracted_value: 10,
        confidence: 0.9,
        notes: null,
      };

      const entry2: ObservationLogEntry = {
        ...entry1,
        observation_id: "obs-b",
        extracted_value: 20,
      };

      await manager.appendObservation("append-obs", entry1);
      await manager.appendObservation("append-obs", entry2);

      const loaded = await manager.loadObservationLog("append-obs");
      expect(loaded!.entries).toHaveLength(2);
      expect(loaded!.entries[0].observation_id).toBe("obs-a");
      expect(loaded!.entries[1].observation_id).toBe("obs-b");
    });

    it("returns null for non-existent observation log", async () => {
      expect(await manager.loadObservationLog("nope")).toBeNull();
    });
  });

  describe("Gap History", async () => {
    it("saves and loads gap history", async () => {
      await manager.saveGoal(makeGoal({ id: "gap-goal" }));

      const history: GapHistoryEntry[] = [
        {
          iteration: 1,
          timestamp: new Date().toISOString(),
          gap_vector: [
            { dimension_name: "dim1", normalized_weighted_gap: 0.5 },
          ],
          confidence_vector: [{ dimension_name: "dim1", confidence: 0.9 }],
        },
      ];

      await manager.saveGapHistory("gap-goal", history);
      const loaded = await manager.loadGapHistory("gap-goal");
      expect(loaded).toHaveLength(1);
      expect(loaded[0].iteration).toBe(1);
    });

    it("appends gap history entries", async () => {
      await manager.saveGoal(makeGoal({ id: "gap-append" }));

      const entry1: GapHistoryEntry = {
        iteration: 1,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "d", normalized_weighted_gap: 0.8 }],
        confidence_vector: [{ dimension_name: "d", confidence: 0.5 }],
      };

      const entry2: GapHistoryEntry = {
        iteration: 2,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "d", normalized_weighted_gap: 0.6 }],
        confidence_vector: [{ dimension_name: "d", confidence: 0.7 }],
      };

      await manager.appendGapHistoryEntry("gap-append", entry1);
      await manager.appendGapHistoryEntry("gap-append", entry2);

      const loaded = await manager.loadGapHistory("gap-append");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].gap_vector[0].normalized_weighted_gap).toBe(0.8);
      expect(loaded[1].gap_vector[0].normalized_weighted_gap).toBe(0.6);
    });

    it("returns empty array for non-existent gap history", async () => {
      expect(await manager.loadGapHistory("nonexistent")).toEqual([]);
    });
  });

  describe("milestone tracking", async () => {
    function makeMilestone(overrides: Partial<Goal> = {}): Goal {
      return makeGoal({
        node_type: "milestone",
        ...overrides,
      });
    }

    describe("getMilestones", () => {
      it("returns only goals with node_type === milestone", () => {
        const g1 = makeGoal({ id: "g1", node_type: "goal" });
        const g2 = makeMilestone({ id: "m1" });
        const g3 = makeGoal({ id: "g3", node_type: "subgoal" });
        const g4 = makeMilestone({ id: "m2" });

        const milestones = getMilestones([g1, g2, g3, g4]);
        expect(milestones).toHaveLength(2);
        expect(milestones.map((m) => m.id)).toEqual(["m1", "m2"]);
      });

      it("returns empty array when no milestones", () => {
        const goals = [makeGoal({ id: "g1" }), makeGoal({ id: "g2", node_type: "subgoal" })];
        expect(getMilestones(goals)).toHaveLength(0);
      });

      it("returns empty array for empty input", () => {
        expect(getMilestones([])).toHaveLength(0);
      });
    });

    describe("getOverdueMilestones", () => {
      it("returns milestones past their target_date", () => {
        const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // yesterday
        const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // tomorrow

        const overdue = makeMilestone({ id: "m-overdue", target_date: pastDate });
        const upcoming = makeMilestone({ id: "m-upcoming", target_date: futureDate });
        const noDate = makeMilestone({ id: "m-nodate", target_date: null });

        const result = getOverdueMilestones([overdue, upcoming, noDate]);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("m-overdue");
      });

      it("excludes milestones without a target_date", () => {
        const noDate = makeMilestone({ id: "m-nodate", target_date: null });
        expect(getOverdueMilestones([noDate])).toHaveLength(0);
      });

      it("returns empty array when no milestones are overdue", () => {
        const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const m = makeMilestone({ id: "m-future", target_date: futureDate });
        expect(getOverdueMilestones([m])).toHaveLength(0);
      });
    });

    describe("evaluatePace", () => {
      it("returns on_track when pace_ratio >= 0.8", () => {
        // 20% elapsed, 20% achievement → pace_ratio = 1.0 → on_track
        const now = Date.now();
        const createdAt = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days ago
        const targetDate = new Date(now + 80 * 24 * 60 * 60 * 1000).toISOString(); // 80 days from now
        const milestone = makeMilestone({ id: "m-ontrack", created_at: createdAt, target_date: targetDate });

        const snapshot = evaluatePace(milestone, 0.2);
        expect(snapshot.status).toBe("on_track");
        expect(snapshot.achievement_ratio).toBe(0.2);
        expect(snapshot.pace_ratio).toBeGreaterThanOrEqual(0.8);
      });

      it("returns at_risk when pace_ratio >= 0.5 and < 0.8", () => {
        // 50% elapsed, 30% achievement → pace_ratio = 0.6 → at_risk
        const now = Date.now();
        const createdAt = new Date(now - 50 * 24 * 60 * 60 * 1000).toISOString(); // 50 days ago
        const targetDate = new Date(now + 50 * 24 * 60 * 60 * 1000).toISOString(); // 50 days from now
        const milestone = makeMilestone({ id: "m-atrisk", created_at: createdAt, target_date: targetDate });

        const snapshot = evaluatePace(milestone, 0.3);
        expect(snapshot.status).toBe("at_risk");
        expect(snapshot.pace_ratio).toBeGreaterThanOrEqual(0.5);
        expect(snapshot.pace_ratio).toBeLessThan(0.8);
      });

      it("returns behind when pace_ratio < 0.5", () => {
        // 80% elapsed, 20% achievement → pace_ratio = 0.25 → behind
        const now = Date.now();
        const createdAt = new Date(now - 80 * 24 * 60 * 60 * 1000).toISOString(); // 80 days ago
        const targetDate = new Date(now + 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days from now
        const milestone = makeMilestone({ id: "m-behind", created_at: createdAt, target_date: targetDate });

        const snapshot = evaluatePace(milestone, 0.2);
        expect(snapshot.status).toBe("behind");
        expect(snapshot.pace_ratio).toBeLessThan(0.5);
      });

      it("returns on_track when no target_date is set", () => {
        const milestone = makeMilestone({ id: "m-nodate", target_date: null });
        const snapshot = evaluatePace(milestone, 0.5);
        expect(snapshot.status).toBe("on_track");
        expect(snapshot.pace_ratio).toBe(1);
        expect(snapshot.elapsed_ratio).toBe(0);
      });

      it("handles 0 elapsed time without divide-by-zero", () => {
        // Freeze time so created_at === Date.now() → elapsed_ratio is exactly 0
        const frozenNow = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(frozenNow);
        try {
          const now = new Date(frozenNow);
          const futureDate = new Date(frozenNow + 100 * 24 * 60 * 60 * 1000).toISOString();
          const milestone = makeMilestone({
            id: "m-zero-elapsed",
            created_at: now.toISOString(),
            target_date: futureDate,
          });

          const snapshot = evaluatePace(milestone, 0.0);
          // Should not throw; pace_ratio = 1 when elapsed_ratio === 0
          expect(snapshot.status).toBe("on_track");
          expect(snapshot.pace_ratio).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("includes evaluated_at timestamp", () => {
        const now = Date.now();
        const createdAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
        const targetDate = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
        const milestone = makeMilestone({ id: "m-ts", created_at: createdAt, target_date: targetDate });

        const snapshot = evaluatePace(milestone, 0.1);
        expect(snapshot.evaluated_at).toBeTruthy();
        expect(() => new Date(snapshot.evaluated_at)).not.toThrow();
      });
    });

    describe("savePaceSnapshot", async () => {
      it("persists pace snapshot to goal file", async () => {
        const milestone = makeMilestone({ id: "m-save" });
        await manager.saveGoal(milestone);

        const snapshot = evaluatePace(milestone, 0.5);
        await manager.savePaceSnapshot("m-save", snapshot);

        const loaded = await manager.loadGoal("m-save");
        expect(loaded).not.toBeNull();
        expect(loaded!.pace_snapshot).not.toBeNull();
        expect(loaded!.pace_snapshot!.achievement_ratio).toBe(0.5);
      });

      it("throws when goal does not exist", async () => {
        const snapshot = {
          elapsed_ratio: 0.5,
          achievement_ratio: 0.5,
          pace_ratio: 1,
          status: "on_track" as const,
          evaluated_at: new Date().toISOString(),
        };
        await expect(manager.savePaceSnapshot("nonexistent", snapshot)).rejects.toThrow();
      });
    });

    describe("generateRescheduleOptions", () => {
      it("generates 3 option types for a behind milestone", () => {
        const now = Date.now();
        const createdAt = new Date(now - 80 * 24 * 60 * 60 * 1000).toISOString();
        const targetDate = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();
        const milestone = makeMilestone({
          id: "m-behind-opts",
          created_at: createdAt,
          target_date: targetDate,
        });

        const opts = generateRescheduleOptions(milestone, 0.1);

        expect(opts.milestone_id).toBe("m-behind-opts");
        expect(opts.options).toHaveLength(3);
        expect(opts.options.map((o) => o.option_type).sort()).toEqual([
          "extend_deadline",
          "reduce_target",
          "renegotiate",
        ]);
      });

      it("sets new_target_date for extend_deadline option", () => {
        const now = Date.now();
        const createdAt = new Date(now - 50 * 24 * 60 * 60 * 1000).toISOString();
        const targetDate = new Date(now + 50 * 24 * 60 * 60 * 1000).toISOString();
        const milestone = makeMilestone({
          id: "m-extend",
          created_at: createdAt,
          target_date: targetDate,
        });

        const opts = generateRescheduleOptions(milestone, 0.2);
        const extendOpt = opts.options.find((o) => o.option_type === "extend_deadline")!;

        expect(extendOpt.new_target_date).not.toBeNull();
        // Extended date should be after original target_date
        expect(new Date(extendOpt.new_target_date!).getTime()).toBeGreaterThan(
          new Date(targetDate).getTime()
        );
      });

      it("sets renegotiate option with no new values", () => {
        const milestone = makeMilestone({ id: "m-renegotiate" });
        const opts = generateRescheduleOptions(milestone, 0.1);
        const renegotiateOpt = opts.options.find((o) => o.option_type === "renegotiate")!;

        expect(renegotiateOpt.new_target_date).toBeNull();
        expect(renegotiateOpt.new_target_value).toBeNull();
      });

      it("uses parent_id as goal_id when set", () => {
        const milestone = makeMilestone({ id: "m-child", parent_id: "parent-goal" });
        const opts = generateRescheduleOptions(milestone, 0.5);
        expect(opts.goal_id).toBe("parent-goal");
      });

      it("falls back to milestone id as goal_id when no parent_id", () => {
        const milestone = makeMilestone({ id: "m-root", parent_id: null });
        const opts = generateRescheduleOptions(milestone, 0.5);
        expect(opts.goal_id).toBe("m-root");
      });

      it("includes generated_at timestamp", () => {
        const milestone = makeMilestone({ id: "m-ts-opts" });
        const opts = generateRescheduleOptions(milestone, 0.5);
        expect(opts.generated_at).toBeTruthy();
        expect(() => new Date(opts.generated_at)).not.toThrow();
      });
    });
  });

  describe("raw read/write", async () => {
    it("writes and reads arbitrary JSON", async () => {
      await manager.writeRaw("custom/data.json", { hello: "world" });
      const loaded = await manager.readRaw("custom/data.json");
      expect(loaded).toEqual({ hello: "world" });
    });

    it("returns null for non-existent raw path", async () => {
      expect(await manager.readRaw("does/not/exist.json")).toBeNull();
    });

    it("throws on path traversal in readRaw", async () => {
      await expect(manager.readRaw("../outside.json")).rejects.toThrow(
        "Path traversal detected"
      );
    });

    it("throws on path traversal in writeRaw", async () => {
      await expect(
        manager.writeRaw("../../outside.json", { evil: true })
      ).rejects.toThrow("Path traversal detected");
    });
  });

  describe("archiveGoal", async () => {
    it("archives a completed goal — moves all state files", async () => {
      const goalId = "archive-full";
      const goal = makeGoal({ id: goalId });
      await manager.saveGoal(goal);

      // Create tasks/<goalId>/ directory with a file
      const tasksDir = path.join(tmpDir, "tasks", goalId);
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, "task.json"), JSON.stringify({ id: "t1" }));

      // Create strategies/<goalId>/ directory with a file
      const strategiesDir = path.join(tmpDir, "strategies", goalId);
      fs.mkdirSync(strategiesDir, { recursive: true });
      fs.writeFileSync(path.join(strategiesDir, "strategy.json"), JSON.stringify({ id: "s1" }));

      // Create stalls/<goalId>.json
      const stallsDir = path.join(tmpDir, "stalls");
      fs.mkdirSync(stallsDir, { recursive: true });
      fs.writeFileSync(path.join(stallsDir, `${goalId}.json`), JSON.stringify({ stall: true }));

      // Create reports/<goalId>/ directory with a file
      const reportsDir = path.join(tmpDir, "reports", goalId);
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(reportsDir, "report.json"), JSON.stringify({ report: 1 }));

      const result = await manager.archiveGoal(goalId);
      expect(result).toBe(true);

      const archiveBase = path.join(tmpDir, "archive", goalId);

      // Goal files moved to archive/<goalId>/goal/
      expect(fs.existsSync(path.join(archiveBase, "goal", "goal.json"))).toBe(true);
      // Original goal dir removed
      expect(fs.existsSync(path.join(tmpDir, "goals", goalId))).toBe(false);

      // Tasks moved
      expect(fs.existsSync(path.join(archiveBase, "tasks", "task.json"))).toBe(true);
      expect(fs.existsSync(tasksDir)).toBe(false);

      // Strategies moved
      expect(fs.existsSync(path.join(archiveBase, "strategies", "strategy.json"))).toBe(true);
      expect(fs.existsSync(strategiesDir)).toBe(false);

      // Stalls moved
      expect(fs.existsSync(path.join(archiveBase, "stalls.json"))).toBe(true);
      expect(fs.existsSync(path.join(stallsDir, `${goalId}.json`))).toBe(false);

      // Reports moved
      expect(fs.existsSync(path.join(archiveBase, "reports", "report.json"))).toBe(true);
      expect(fs.existsSync(reportsDir)).toBe(false);
    });

    it("returns false for non-existent goal", async () => {
      const result = await manager.archiveGoal("does-not-exist");
      expect(result).toBe(false);
    });

    it("handles partial state (only goal dir, no tasks/strategies)", async () => {
      const goalId = "archive-partial";
      const goal = makeGoal({ id: goalId });
      await manager.saveGoal(goal);

      const result = await manager.archiveGoal(goalId);
      expect(result).toBe(true);

      const archiveBase = path.join(tmpDir, "archive", goalId);

      // Goal files moved
      expect(fs.existsSync(path.join(archiveBase, "goal", "goal.json"))).toBe(true);
      // Optional dirs not created in archive (they didn't exist)
      expect(fs.existsSync(path.join(archiveBase, "tasks"))).toBe(false);
      expect(fs.existsSync(path.join(archiveBase, "strategies"))).toBe(false);
      expect(fs.existsSync(path.join(archiveBase, "stalls.json"))).toBe(false);
    });

    it("listArchivedGoals returns archived goal IDs", async () => {
      // No archives yet
      expect(await manager.listArchivedGoals()).toEqual([]);

      // Archive two goals
      await manager.saveGoal(makeGoal({ id: "arc-1" }));
      await manager.saveGoal(makeGoal({ id: "arc-2" }));
      await manager.archiveGoal("arc-1");
      await manager.archiveGoal("arc-2");

      const archived = (await manager.listArchivedGoals()).sort();
      expect(archived).toEqual(["arc-1", "arc-2"]);
    });

    it("loadGoal falls back to archive after archiveGoal()", async () => {
      // Create and save a goal
      const goal = makeGoal({ id: "fallback-test", title: "Archived Goal" });
      await manager.saveGoal(goal);

      // Verify it's loadable from active path
      expect(await manager.loadGoal("fallback-test")).not.toBeNull();

      // Archive it — this removes the active-path directory
      await manager.archiveGoal("fallback-test");

      // Active path should no longer exist
      const activePath = path.join(tmpDir, "goals", "fallback-test");
      expect(fs.existsSync(activePath)).toBe(false);

      // loadGoal should still return the goal via archive fallback
      const loaded = await manager.loadGoal("fallback-test");
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe("fallback-test");
      expect(loaded!.title).toBe("Archived Goal");
    });

    it("loadGoal returns null for a goal that was never saved nor archived", async () => {
      expect(await manager.loadGoal("never-existed")).toBeNull();
    });

    it("archiveGoal cascades to children — both parent and child appear in archive", async () => {
      const child = makeGoal({ id: "arc-child", parent_id: "arc-parent" });
      const parent = makeGoal({ id: "arc-parent", children_ids: ["arc-child"] });
      await manager.saveGoal(child);
      await manager.saveGoal(parent);

      const result = await manager.archiveGoal("arc-parent");
      expect(result).toBe(true);

      // Both parent and child directories should be in the archive
      expect(fs.existsSync(path.join(tmpDir, "archive", "arc-parent", "goal", "goal.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "archive", "arc-child", "goal", "goal.json"))).toBe(true);

      // Both should have status "archived"
      const parentArchived = await manager.loadGoal("arc-parent");
      expect(parentArchived?.status).toBe("archived");
      const childArchived = await manager.loadGoal("arc-child");
      expect(childArchived?.status).toBe("archived");
    });

    it("archiveGoal tolerates corrupt child — succeeds without throwing", async () => {
      const child = makeGoal({ id: "arc-corrupt-child", parent_id: "arc-corrupt-parent" });
      const parent = makeGoal({ id: "arc-corrupt-parent", children_ids: ["arc-corrupt-child"] });
      await manager.saveGoal(child);
      await manager.saveGoal(parent);

      // Corrupt the child's goal.json with invalid JSON
      const childGoalPath = path.join(tmpDir, "goals", "arc-corrupt-child", "goal.json");
      fs.writeFileSync(childGoalPath, "{ not valid json ~~~");

      // archiveGoal on the parent should succeed despite the corrupt child
      await expect(manager.archiveGoal("arc-corrupt-parent")).resolves.toBe(true);

      // Parent archive should exist
      expect(fs.existsSync(path.join(tmpDir, "archive", "arc-corrupt-parent", "goal", "goal.json"))).toBe(true);
    });
  });

  describe("deleteGoal cascade", async () => {
    it("deleteGoal cascades to children — both parent and child directories removed", async () => {
      const child = makeGoal({ id: "del-child", parent_id: "del-parent" });
      const parent = makeGoal({ id: "del-parent", children_ids: ["del-child"] });
      await manager.saveGoal(child);
      await manager.saveGoal(parent);

      const result = await manager.deleteGoal("del-parent");
      expect(result).toBe(true);

      expect(await manager.goalExists("del-parent")).toBe(false);
      expect(await manager.goalExists("del-child")).toBe(false);
    });

    it("deleteGoal tolerates corrupt child — succeeds without throwing", async () => {
      const child = makeGoal({ id: "del-corrupt-child", parent_id: "del-corrupt-parent" });
      const parent = makeGoal({ id: "del-corrupt-parent", children_ids: ["del-corrupt-child"] });
      await manager.saveGoal(child);
      await manager.saveGoal(parent);

      // Corrupt the child's goal.json with invalid JSON
      const childGoalPath = path.join(tmpDir, "goals", "del-corrupt-child", "goal.json");
      fs.writeFileSync(childGoalPath, "{ not valid json ~~~");

      // deleteGoal on the parent should succeed despite the corrupt child
      await expect(manager.deleteGoal("del-corrupt-parent")).resolves.toBe(true);

      expect(await manager.goalExists("del-corrupt-parent")).toBe(false);
    });
  });

  describe("atomicRead / history cap / error propagation", async () => {
    it("atomicRead returns null on corrupt JSON instead of throwing", async () => {
      // Write a valid goal first to create the directory, then corrupt its JSON
      const goal = makeGoal({ id: "corrupt-read" });
      await manager.saveGoal(goal);

      const goalPath = path.join(tmpDir, "goals", "corrupt-read", "goal.json");
      fs.writeFileSync(goalPath, "{ this is not valid json ~~~");

      // loadGoal calls atomicRead which should return null on corrupt JSON
      const loaded = await manager.loadGoal("corrupt-read");
      expect(loaded).toBeNull();
    });

    it("appendObservation caps entries at 500", async () => {
      await manager.saveGoal(makeGoal({ id: "cap-test" }));

      const baseEntry: ObservationLogEntry = {
        observation_id: "obs-cap",
        timestamp: new Date().toISOString(),
        trigger: "periodic",
        goal_id: "cap-test",
        dimension_name: "dim1",
        layer: "mechanical",
        method: {
          type: "api_query",
          source: "api",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        raw_result: 1,
        extracted_value: 1,
        confidence: 0.9,
        notes: null,
      };

      // Append 510 entries
      for (let i = 0; i < 510; i++) {
        await manager.appendObservation("cap-test", {
          ...baseEntry,
          observation_id: `obs-${i}`,
          extracted_value: i,
        });
      }

      const loaded = await manager.loadObservationLog("cap-test");
      expect(loaded).not.toBeNull();
      expect(loaded!.entries.length).toBe(500);
      // Should have the last 500 entries (obs-10 through obs-509)
      expect(loaded!.entries[0].observation_id).toBe("obs-10");
      expect(loaded!.entries[499].observation_id).toBe("obs-509");
    });

    it("listGoalIds propagates non-ENOENT errors", async () => {
      // Remove the goals directory then replace it with a file — readdir will fail with ENOTDIR
      const goalsDir = path.join(tmpDir, "goals");
      fs.rmSync(goalsDir, { recursive: true, force: true });
      fs.writeFileSync(goalsDir, "not-a-directory");

      await expect(manager.listGoalIds()).rejects.toThrow();
    });
  });
});
