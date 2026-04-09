import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope } from "../types/envelope.js";
import { RuntimeJournal } from "../store/runtime-journal.js";
import { getRuntimeQueueRecordsDir } from "../store/runtime-paths.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

describe("RuntimeJournal", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  it("accepts and replays queued envelopes", async () => {
    tmpDir = makeTempDir();
    const journal = new RuntimeJournal(tmpDir);
    const envelope = createEnvelope({
      type: "event",
      name: "external",
      source: "http",
      payload: { hello: "world" },
    });

    const accepted = await journal.accept(envelope);
    expect(accepted).toEqual({ accepted: true });

    const pending = await journal.replayPending("event");
    expect(pending).toEqual([envelope]);

    await journal.markHandled(envelope.id);
    await expect(journal.replayPending("event")).resolves.toEqual([]);
  });

  it("suppresses duplicate queued receipts by dedupe_key", async () => {
    tmpDir = makeTempDir();
    const journal = new RuntimeJournal(tmpDir);
    const first = createEnvelope({
      type: "event",
      name: "schedule_activated",
      source: "schedule-engine",
      goal_id: "goal-1",
      dedupe_key: "schedule:entry-1",
      payload: { entry_id: "entry-1" },
    });
    const second = createEnvelope({
      type: "event",
      name: "schedule_activated",
      source: "schedule-engine",
      goal_id: "goal-1",
      dedupe_key: "schedule:entry-1",
      payload: { entry_id: "entry-1" },
    });

    await journal.accept(first);
    const duplicate = await journal.accept(second);
    expect(duplicate).toEqual({ accepted: false, duplicateOf: first.id });

    const recordsDir = getRuntimeQueueRecordsDir(tmpDir);
    expect(fs.readdirSync(recordsDir)).toEqual([`${first.id}.json`]);
  });

  it("clears queue receipts on clean shutdown cleanup", async () => {
    tmpDir = makeTempDir();
    const journal = new RuntimeJournal(tmpDir);
    const envelope = createEnvelope({
      type: "event",
      name: "cron_task_due",
      source: "cron-scheduler",
      dedupe_key: "cron:task-1",
      payload: { id: "task-1" },
    });

    await journal.accept(envelope);
    const recordsDir = getRuntimeQueueRecordsDir(tmpDir);
    expect(fs.existsSync(path.join(recordsDir, `${envelope.id}.json`))).toBe(true);

    await journal.clearReceipts();
    expect(fs.readdirSync(recordsDir)).toHaveLength(0);
    await expect(journal.replayPending("event")).resolves.toEqual([]);
  });
});
