import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../state-manager.js";
import { readWAL } from "../state-wal.js";
import { appendWALRecord } from "../state-wal.js";
import { listSnapshots } from "../state-snapshot.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

describe("StateManager WAL integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-sm-wal-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("saveGoal with WAL enabled creates WAL records", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();
    const goal = makeGoal({ id: "g1" });
    await sm.saveGoal(goal);

    const records = await readWAL("g1", tmpDir);
    expect(records.length).toBe(2); // intent + commit
    expect(records[0].op).toBe("save_goal");
    expect(records[1].op).toBe("commit");
  });

  it("saveGoal with WAL disabled creates no WAL records", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: false });
    await sm.init();
    const goal = makeGoal({ id: "g2" });
    await sm.saveGoal(goal);

    const records = await readWAL("g2", tmpDir);
    expect(records.length).toBe(0);

    // Data should still be persisted
    const loaded = await sm.loadGoal("g2");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("g2");
  });

  it("crash recovery replays uncommitted WAL intent", async () => {
    // Step 1: create goal dir and write an intent without commit
    const goalId = "g-crash";
    const goalDir = path.join(tmpDir, "goals", goalId);
    fs.mkdirSync(goalDir, { recursive: true });

    const goal = makeGoal({ id: goalId });
    await appendWALRecord(goalId, tmpDir, {
      op: "save_goal",
      data: goal,
      ts: new Date().toISOString(),
    });

    // No goal.json exists yet
    expect(fs.existsSync(path.join(goalDir, "goal.json"))).toBe(false);

    // Step 2: init triggers recovery
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    // Goal should now be recovered
    const loaded = await sm.loadGoal(goalId);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(goalId);
  });

  it("snapshot is created every 50 writes", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    for (let i = 0; i < 50; i++) {
      await sm.saveGoal(makeGoal({ id: "g-snap", description: `v${i}` }));
    }

    const snaps = await listSnapshots("g-snap", tmpDir);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
  });

  it("WAL compaction is triggered every 100 writes", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    for (let i = 0; i < 100; i++) {
      await sm.saveGoal(makeGoal({ id: "g-compact", description: `v${i}` }));
    }

    // After compaction, committed records should be removed
    const records = await readWAL("g-compact", tmpDir);
    // Compaction leaves only uncommitted intents (none here) + compaction markers
    const intents = records.filter((r) => r.op !== "commit" && r.op !== "compaction_start" && r.op !== "compaction_complete");
    expect(intents.length).toBe(0);
  });

  it("concurrent saveGoal for same goal both succeed", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    const g1 = makeGoal({ id: "g-concurrent", description: "first" });
    const g2 = makeGoal({ id: "g-concurrent", description: "second" });

    await Promise.all([sm.saveGoal(g1), sm.saveGoal(g2)]);

    const loaded = await sm.loadGoal("g-concurrent");
    expect(loaded).not.toBeNull();
    // One of the two should have won
    expect(["first", "second"]).toContain(loaded!.description);
  });

  it("concurrent saveGoal for different goals both succeed", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    const gA = makeGoal({ id: "g-a" });
    const gB = makeGoal({ id: "g-b" });

    await Promise.all([sm.saveGoal(gA), sm.saveGoal(gB)]);

    const loadedA = await sm.loadGoal("g-a");
    const loadedB = await sm.loadGoal("g-b");
    expect(loadedA).not.toBeNull();
    expect(loadedB).not.toBeNull();
  });

  it("backward compatible constructor without options", async () => {
    const sm = new StateManager(tmpDir);
    await sm.init();
    const goal = makeGoal({ id: "g-compat" });
    await sm.saveGoal(goal);

    const loaded = await sm.loadGoal("g-compat");
    expect(loaded).not.toBeNull();
  });

  it("replay is idempotent on second init", async () => {
    // Step 1: create goal dir and write an intent without commit
    const goalId = "g-idempotent";
    const goalDir = path.join(tmpDir, "goals", goalId);
    fs.mkdirSync(goalDir, { recursive: true });

    const goal = makeGoal({ id: goalId, description: "original" });
    await appendWALRecord(goalId, tmpDir, {
      op: "save_goal",
      data: goal,
      ts: "2026-01-01T00:00:00.000Z",
    });

    // Step 2: first init replays the uncommitted intent
    const sm1 = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm1.init();

    const loaded1 = await sm1.loadGoal(goalId);
    expect(loaded1).not.toBeNull();
    expect(loaded1!.id).toBe(goalId);

    // WAL should now contain a commit record (H2 fix)
    const recordsAfterFirst = await readWAL(goalId, tmpDir);
    const commits = recordsAfterFirst.filter((r) => r.op === "commit");
    expect(commits.length).toBeGreaterThanOrEqual(1);

    // Step 3: second init should NOT replay (commit record exists)
    const sm2 = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm2.init();

    const loaded2 = await sm2.loadGoal(goalId);
    expect(loaded2).not.toBeNull();
    expect(loaded2!.id).toBe(goalId);
    expect(loaded2!.description).toBe("original");

    // WAL should still have same number of commits (no extra replay)
    const recordsAfterSecond = await readWAL(goalId, tmpDir);
    const commitsAfterSecond = recordsAfterSecond.filter((r) => r.op === "commit");
    expect(commitsAfterSecond.length).toBe(commits.length);
  });
});
