// ─── pulseed approval commands (read-only) ───

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { parseArgs } from "node:util";

import { StateManager } from "../../../base/state/state-manager.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { ApprovalRecordSchema, type ApprovalRecord } from "../../../runtime/store/runtime-schemas.js";
import { createRuntimeStorePaths, type RuntimeStorePaths } from "../../../runtime/store/runtime-paths.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

function createApprovalContext(stateManager: StateManager): {
  approvalStore: ApprovalStore;
  paths: RuntimeStorePaths;
} {
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  const paths = createRuntimeStorePaths(runtimeRoot);
  return { approvalStore: new ApprovalStore(paths), paths };
}

const ID_WIDTH = 14;
const GOAL_WIDTH = 14;
const STATE_WIDTH = 12;
const DATE_WIDTH = 24;
const CHANNEL_WIDTH = 24;

function formatCell(value: string | undefined, maxLen: number): string {
  const normalized = (value ?? "-").replace(/\s+/g, " ").trim() || "-";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function dateLabel(value?: number): string {
  return value === undefined ? "-" : new Date(value).toISOString();
}

async function countInvalidApprovalFiles(dirPath: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let invalid = 0;
  for (const fileName of entries.filter((entry) => entry.endsWith(".json"))) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dirPath, fileName), "utf-8")) as unknown;
      if (!ApprovalRecordSchema.safeParse(raw).success) {
        invalid += 1;
      }
    } catch {
      invalid += 1;
    }
  }
  return invalid;
}

function printApprovalRows(records: ApprovalRecord[], showResolved: boolean): void {
  if (showResolved) {
    console.log(
      `${"ID".padEnd(ID_WIDTH)} ${"GOAL".padEnd(GOAL_WIDTH)} ${"STATE".padEnd(STATE_WIDTH)} ${"CREATED".padEnd(DATE_WIDTH)} ${"RESOLVED".padEnd(DATE_WIDTH)} CHANNEL`
    );
    console.log("-".repeat(100));
    for (const record of records) {
      console.log(
        `${formatCell(record.approval_id, ID_WIDTH).padEnd(ID_WIDTH)} ${formatCell(record.goal_id, GOAL_WIDTH).padEnd(GOAL_WIDTH)} ${record.state.padEnd(STATE_WIDTH)} ${dateLabel(record.created_at).padEnd(DATE_WIDTH)} ${dateLabel(record.resolved_at).padEnd(DATE_WIDTH)} ${formatCell(record.response_channel, CHANNEL_WIDTH)}`
      );
    }
    return;
  }

  console.log(
    `${"ID".padEnd(ID_WIDTH)} ${"GOAL".padEnd(GOAL_WIDTH)} ${"STATE".padEnd(STATE_WIDTH)} ${"CREATED".padEnd(DATE_WIDTH)} ${"EXPIRES".padEnd(DATE_WIDTH)} CHANNEL`
  );
  console.log("-".repeat(100));
  for (const record of records) {
    console.log(
      `${formatCell(record.approval_id, ID_WIDTH).padEnd(ID_WIDTH)} ${formatCell(record.goal_id, GOAL_WIDTH).padEnd(GOAL_WIDTH)} ${record.state.padEnd(STATE_WIDTH)} ${dateLabel(record.created_at).padEnd(DATE_WIDTH)} ${dateLabel(record.expires_at).padEnd(DATE_WIDTH)} ${formatCell(record.response_channel, CHANNEL_WIDTH)}`
    );
  }
}

export async function cmdApprovalList(stateManager: StateManager, args: string[]): Promise<number> {
  const logger = getCliLogger();
  let values: { resolved?: boolean };

  try {
    ({ values } = parseArgs({
      args,
      options: {
        resolved: { type: "boolean" },
      },
      strict: false,
    }) as { values: { resolved?: boolean } });
  } catch (err) {
    logger.error(formatOperationError("parse approval list arguments", err));
    values = {};
  }

  const showResolved = values.resolved === true;
  const { approvalStore, paths } = createApprovalContext(stateManager);

  let approvals: ApprovalRecord[];
  let invalidCount = 0;
  try {
    approvals = showResolved ? await approvalStore.listResolved() : await approvalStore.listPending();
    invalidCount = await countInvalidApprovalFiles(
      showResolved ? paths.approvalsResolvedDir : paths.approvalsPendingDir
    );
  } catch (err) {
    logger.error(formatOperationError("load approval records", err));
    return 1;
  }

  if (invalidCount > 0) {
    logger.warn(`Skipped ${invalidCount} invalid ${showResolved ? "resolved" : "pending"} approval record(s).`);
  }

  const label = showResolved ? "resolved" : "pending";
  if (approvals.length === 0) {
    console.log(`No ${label} approvals found.`);
    return 0;
  }

  const sorted = [...approvals].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.approval_id.localeCompare(b.approval_id);
  });

  console.log(`${showResolved ? "Resolved" : "Pending"} approvals:\n`);
  printApprovalRows(sorted, showResolved);
  console.log(`\nTotal: ${sorted.length} approval(s)`);

  return 0;
}
