import * as path from "node:path";

export function getRuntimeRootDir(baseDir: string): string {
  return path.join(baseDir, "runtime");
}

export function getRuntimeInboxDir(baseDir: string): string {
  return path.join(getRuntimeRootDir(baseDir), "inbox");
}

export function getRuntimeInboxDateDir(baseDir: string, dateKey: string): string {
  return path.join(getRuntimeInboxDir(baseDir), dateKey);
}

export function getRuntimeQueueDir(baseDir: string): string {
  return path.join(getRuntimeRootDir(baseDir), "queue");
}

export function getRuntimeQueueRecordsDir(baseDir: string): string {
  return path.join(getRuntimeQueueDir(baseDir), "records");
}

export function getRuntimeQueueDedupeDir(baseDir: string): string {
  return path.join(getRuntimeQueueDir(baseDir), "dedupe");
}

export function getRuntimeApprovalsDir(baseDir: string): string {
  return path.join(getRuntimeRootDir(baseDir), "approvals");
}

export function getRuntimePendingApprovalsDir(baseDir: string): string {
  return path.join(getRuntimeApprovalsDir(baseDir), "pending");
}

export function getRuntimeResolvedApprovalsDir(baseDir: string): string {
  return path.join(getRuntimeApprovalsDir(baseDir), "resolved");
}
