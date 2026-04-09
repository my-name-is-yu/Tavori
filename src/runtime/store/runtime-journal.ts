import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readJsonFileOrNull, readJsonFileWithSchema, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { EnvelopeSchema, type Envelope, type EnvelopeType } from "../types/envelope.js";
import {
  getRuntimeInboxDateDir,
  getRuntimeQueueDedupeDir,
  getRuntimeQueueRecordsDir,
} from "./runtime-paths.js";
import { QueueRecordSchema, type QueueRecord } from "./runtime-schemas.js";

export interface JournalAcceptResult {
  accepted: boolean;
  duplicateOf?: string;
}

export class RuntimeJournal {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async accept(envelope: Envelope): Promise<JournalAcceptResult> {
    if (envelope.dedupe_key) {
      const existingId = await this.lookupDedupe(envelope.dedupe_key);
      if (existingId) {
        const existing = await this.getQueueRecord(existingId);
        if (existing?.state === "queued") {
          return { accepted: false, duplicateOf: existingId };
        }
      }
    }

    await writeJsonFileAtomic(this.getInboxPath(envelope), envelope);
    await writeJsonFileAtomic(this.getQueueRecordPath(envelope.id), {
      message_id: envelope.id,
      envelope_type: envelope.type,
      priority: envelope.priority,
      state: "queued",
      dedupe_key: envelope.dedupe_key,
      available_at: envelope.created_at,
      attempt: 0,
      updated_at: Date.now(),
    } satisfies QueueRecord);

    if (envelope.dedupe_key) {
      await writeJsonFileAtomic(this.getDedupePath(envelope.dedupe_key), {
        dedupe_key: envelope.dedupe_key,
        message_id: envelope.id,
      });
    }

    return { accepted: true };
  }

  async markHandled(messageId: string): Promise<void> {
    const record = await this.getQueueRecord(messageId);
    if (!record || record.state !== "queued") {
      return;
    }

    await writeJsonFileAtomic(this.getQueueRecordPath(messageId), {
      ...record,
      state: "completed",
      updated_at: Date.now(),
    } satisfies QueueRecord);

    if (record.dedupe_key) {
      await fsp.unlink(this.getDedupePath(record.dedupe_key)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") {
          throw err;
        }
      });
    }
  }

  async replayPending(type?: EnvelopeType): Promise<Envelope[]> {
    const records = await this.listQueueRecords();
    const pending = records.filter((record) => {
      if (record.state !== "queued") {
        return false;
      }
      return type ? record.envelope_type === type : true;
    });

    const envelopes = await Promise.all(
      pending.map((record) => this.getEnvelope(record.message_id))
    );

    return envelopes
      .filter((envelope): envelope is Envelope => envelope !== null)
      .sort((a, b) => a.created_at - b.created_at);
  }

  async clearReceipts(): Promise<void> {
    const records = await this.listQueueRecords();
    for (const record of records) {
      if (record.dedupe_key) {
        await fsp.unlink(this.getDedupePath(record.dedupe_key)).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") {
            throw err;
          }
        });
      }
      await fsp.unlink(this.getQueueRecordPath(record.message_id)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") {
          throw err;
        }
      });
    }
  }

  private async listQueueRecords(): Promise<QueueRecord[]> {
    const dir = getRuntimeQueueRecordsDir(this.baseDir);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const records = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) =>
            readJsonFileWithSchema(path.join(dir, entry.name), QueueRecordSchema)
          )
      );

      return records.filter((record): record is QueueRecord => record !== null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  private async lookupDedupe(dedupeKey: string): Promise<string | null> {
    const data = await readJsonFileOrNull<{ message_id?: string }>(this.getDedupePath(dedupeKey));
    return typeof data?.message_id === "string" ? data.message_id : null;
  }

  private async getQueueRecord(messageId: string): Promise<QueueRecord | null> {
    return readJsonFileWithSchema(this.getQueueRecordPath(messageId), QueueRecordSchema);
  }

  private async getEnvelope(messageId: string): Promise<Envelope | null> {
    const inboxDir = path.join(this.baseDir, "runtime", "inbox");
    try {
      const days = await fsp.readdir(inboxDir, { withFileTypes: true });
      for (const day of days) {
        if (!day.isDirectory()) {
          continue;
        }
        const filePath = path.join(inboxDir, day.name, `${messageId}.json`);
        const envelope = await readJsonFileWithSchema(filePath, EnvelopeSchema);
        if (envelope) {
          return envelope;
        }
      }
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  private getInboxPath(envelope: Envelope): string {
    const dateKey = new Date(envelope.created_at).toISOString().slice(0, 10);
    return path.join(getRuntimeInboxDateDir(this.baseDir, dateKey), `${envelope.id}.json`);
  }

  private getQueueRecordPath(messageId: string): string {
    return path.join(getRuntimeQueueRecordsDir(this.baseDir), `${messageId}.json`);
  }

  private getDedupePath(dedupeKey: string): string {
    const digest = createHash("sha256").update(dedupeKey).digest("hex");
    return path.join(getRuntimeQueueDedupeDir(this.baseDir), `${digest}.json`);
  }
}
