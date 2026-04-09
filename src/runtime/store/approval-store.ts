import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileWithSchema, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { getRuntimePendingApprovalsDir, getRuntimeResolvedApprovalsDir } from "./runtime-paths.js";
import { ApprovalRecordSchema, type ApprovalRecord } from "./runtime-schemas.js";

export class ApprovalStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async savePending(record: ApprovalRecord): Promise<void> {
    await writeJsonFileAtomic(this.getPendingPath(record.approval_id), record);
  }

  async getPending(approvalId: string): Promise<ApprovalRecord | null> {
    return readJsonFileWithSchema(this.getPendingPath(approvalId), ApprovalRecordSchema);
  }

  async listPending(): Promise<ApprovalRecord[]> {
    const dir = getRuntimePendingApprovalsDir(this.baseDir);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const pending = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) =>
            readJsonFileWithSchema(path.join(dir, entry.name), ApprovalRecordSchema)
          )
      );
      return pending
        .filter((record): record is ApprovalRecord => record !== null && record.state === "pending")
        .sort((a, b) => a.created_at - b.created_at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async resolvePending(
    approvalId: string,
    resolution: {
      state: "approved" | "denied" | "expired" | "cancelled";
      resolved_at: number;
      response_channel?: string;
    }
  ): Promise<ApprovalRecord | null> {
    const current = await this.getPending(approvalId);
    if (current === null || current.state !== "pending") {
      return null;
    }

    const resolved: ApprovalRecord = {
      ...current,
      state: resolution.state,
      resolved_at: resolution.resolved_at,
      response_channel: resolution.response_channel,
    };

    await writeJsonFileAtomic(this.getResolvedPath(approvalId), resolved);
    await fsp.unlink(this.getPendingPath(approvalId)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        throw err;
      }
    });

    return resolved;
  }

  private getPendingPath(approvalId: string): string {
    return path.join(getRuntimePendingApprovalsDir(this.baseDir), `${approvalId}.json`);
  }

  private getResolvedPath(approvalId: string): string {
    return path.join(getRuntimeResolvedApprovalsDir(this.baseDir), `${approvalId}.json`);
  }
}
