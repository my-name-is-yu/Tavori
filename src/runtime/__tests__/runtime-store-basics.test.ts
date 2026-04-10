import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import {
  createRuntimeStorePaths,
  ensureRuntimeStorePaths,
  encodeRuntimePathSegment,
  runtimeDateKey,
} from "../store/runtime-paths.js";
import {
  RuntimeJournal,
  listRuntimeJson,
  loadRuntimeJson,
  moveRuntimeJson,
  saveRuntimeJson,
} from "../store/runtime-journal.js";
import {
  RuntimeEnvelopeSchema,
  RuntimeQueueRecordSchema,
  compactRuntimeHealthKpi,
  evolveRuntimeHealthKpi,
  summarizeRuntimeHealthStatus,
  summarizeRuntimeHealthKpi,
} from "../store/runtime-schemas.js";

describe("runtime store basics", () => {
  let tmpDir: string;
  let paths = createRuntimeStorePaths();

  beforeEach(() => {
    tmpDir = makeTempDir();
    paths = createRuntimeStorePaths(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("resolves the runtime root and derived paths", () => {
    expect(paths.rootDir).toBe(path.resolve(tmpDir));
    expect(paths.approvalPendingPath("approval-1")).toBe(
      path.join(tmpDir, "approvals", "pending", "approval-1.json")
    );
    expect(paths.outboxRecordPath(12)).toBe(path.join(tmpDir, "outbox", "000000000012.json"));
    const goalId = "goal%/a";
    expect(paths.goalLeasePath(goalId)).toBe(
      path.join(tmpDir, "leases", "goal", `${encodeRuntimePathSegment(goalId)}.json`)
    );
    expect(paths.completedByIdempotencyPath("danger/with/slash")).toMatch(
      /completed\/by-idempotency\/[a-f0-9]{64}\.json$/
    );
  });

  it("creates the runtime directory layout", async () => {
    await ensureRuntimeStorePaths(paths);
    expect(fs.existsSync(paths.leaderDir)).toBe(true);
    expect(fs.existsSync(paths.approvalsPendingDir)).toBe(true);
    expect(fs.existsSync(paths.outboxDir)).toBe(true);
    expect(fs.existsSync(paths.healthDir)).toBe(true);
  });

  it("formats date buckets deterministically", () => {
    expect(runtimeDateKey(new Date("2026-04-09T12:34:56.000Z"))).toBe("2026-04-09");
  });

  it("writes, reads, lists, moves, and removes runtime JSON records", async () => {
    const journal = new RuntimeJournal(paths);
    await journal.ensureReady();

    const recordPath = paths.approvalPendingPath("a-1");
    const record = {
      approval_id: "a-1",
      request_envelope_id: "msg-1",
      correlation_id: "corr-1",
      state: "pending" as const,
      created_at: 1,
      expires_at: 2,
      payload: { note: "hello" },
    };

    await saveRuntimeJson(recordPath, RuntimeQueueRecordSchema, {
      message_id: "msg-1",
      state: "queued",
      available_at: 1,
      attempt: 0,
      updated_at: 1,
    });
    const queueRecord = await loadRuntimeJson(recordPath, RuntimeQueueRecordSchema);
    expect(queueRecord?.message_id).toBe("msg-1");

    const listDir = path.join(tmpDir, "custom");
    await fs.promises.mkdir(listDir, { recursive: true });
    await saveRuntimeJson(path.join(listDir, "b.json"), RuntimeEnvelopeSchema, {
      message_id: "m2",
      kind: "event",
      name: "beta",
      source: "test",
      priority: "normal",
      payload: {},
      created_at: 2,
      attempt: 0,
    });
    await saveRuntimeJson(path.join(listDir, "a.json"), RuntimeEnvelopeSchema, {
      message_id: "m1",
      kind: "event",
      name: "alpha",
      source: "test",
      priority: "normal",
      payload: {},
      created_at: 1,
      attempt: 0,
    });

    const listed = await listRuntimeJson(listDir, RuntimeEnvelopeSchema);
    expect(listed.map((r) => r.message_id)).toEqual(["m1", "m2"]);

    const moveSource = path.join(listDir, "move.json");
    const moveTarget = path.join(listDir, "nested", "moved.json");
    await saveRuntimeJson(moveSource, RuntimeEnvelopeSchema, {
      message_id: "m3",
      kind: "system",
      name: "move",
      source: "test",
      priority: "low",
      payload: {},
      created_at: 3,
      attempt: 0,
    });
    await moveRuntimeJson(moveSource, moveTarget);
    expect(fs.existsSync(moveSource)).toBe(false);
    expect(fs.existsSync(moveTarget)).toBe(true);

    await journal.remove(moveTarget);
    expect(fs.existsSync(moveTarget)).toBe(false);

    expect(record.approval_id).toBe("a-1");
  });

  it("summarizes component health correctly", () => {
    expect(summarizeRuntimeHealthStatus({ gateway: "ok", queue: "ok" })).toBe("ok");
    expect(summarizeRuntimeHealthStatus({ gateway: "ok", queue: "degraded" })).toBe("degraded");
    expect(summarizeRuntimeHealthStatus({ gateway: "ok", queue: "failed" })).toBe("failed");
  });

  it("tracks KPI degradation and recovery transitions", () => {
    const degraded = evolveRuntimeHealthKpi(null, {
      process_alive: "ok",
      command_acceptance: "degraded",
      task_execution: "ok",
    }, 100, {
      command_acceptance: "queue degraded",
    });
    expect(summarizeRuntimeHealthKpi(degraded)).toBe("degraded");
    expect(degraded.degraded_at).toBe(100);
    expect(degraded.command_acceptance.reason).toBe("queue degraded");

    const recovered = evolveRuntimeHealthKpi(degraded, {
      process_alive: "ok",
      command_acceptance: "ok",
      task_execution: "ok",
    }, 250);
    expect(summarizeRuntimeHealthKpi(recovered)).toBe("ok");
    expect(recovered.degraded_at).toBe(100);
    expect(recovered.recovered_at).toBe(250);
    expect(compactRuntimeHealthKpi(recovered)).toMatchObject({
      status: "ok",
      process_alive: true,
      can_accept_command: true,
      can_execute_task: true,
    });
  });
});
