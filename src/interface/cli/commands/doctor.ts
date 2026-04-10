// ─── pulseed doctor — installation health check ───

import * as fs from "node:fs";
import * as path from "node:path";
import { getPulseedDirPath, getLogsDir, getGoalsDir } from "../../../base/utils/paths.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { getCliRunnerBuildPath } from "../../../base/utils/pulseed-meta.js";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { DaemonConfigSchema } from "../../../base/types/daemon.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import {
  ApprovalStore,
  OutboxStore,
  RuntimeHealthStore,
  compactRuntimeHealthKpi,
  createRuntimeStorePaths,
  type RuntimeHealthKpi,
} from "../../../runtime/store/index.js";
import { runRuntimeStoreMaintenanceCycle, type RuntimeMaintenanceLogger } from "../../../runtime/daemon/maintenance.js";
import { DaemonStateSchema } from "../../../runtime/types/daemon.js";
import { summarizeTaskOutcomeLedgers } from "../../../orchestrator/execution/task/task-outcome-ledger.js";

// ─── Types ───

type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function resolveDaemonRuntimeRoot(baseDir: string, configuredRoot?: string): string {
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

async function loadDaemonConfig(baseDir: string) {
  const configPath = path.join(baseDir, "daemon.json");
  const legacyConfigPath = path.join(baseDir, "daemon-config.json");
  const configRaw =
    (await readJsonFileOrNull(configPath)) ??
    (await readJsonFileOrNull(legacyConfigPath));
  const parsed = configRaw !== null ? DaemonConfigSchema.safeParse(configRaw) : null;
  return parsed?.success ? parsed.data : DaemonConfigSchema.parse({});
}

function formatRelativeTimestamp(timestamp: number): string {
  const ms = Date.now() - timestamp;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function formatCompactKpiDetail(kpi: RuntimeHealthKpi): string {
  const compact = compactRuntimeHealthKpi(kpi);
  if (!compact) {
    return "KPI unavailable";
  }
  return `KPI process=${compact.process_alive ? "up" : "down"} accept=${compact.can_accept_command ? "up" : "down"} execute=${compact.can_execute_task ? "up" : "down"} (${compact.status})`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

// ─── Individual checks ───

export function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    return { name: "Node.js version", status: "pass", detail: `v${version} (>= 20 required)` };
  }
  return { name: "Node.js version", status: "fail", detail: `v${version} (>= 20 required)` };
}

export function checkPulseedDir(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const displayDir = dir.replace(process.env["HOME"] ?? "", "~");
  if (fs.existsSync(dir)) {
    return { name: "PulSeed directory", status: "pass", detail: `${displayDir} exists` };
  }
  return { name: "PulSeed directory", status: "fail", detail: `${displayDir} not found` };
}

export function checkProviderConfig(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const configPath = path.join(dir, "provider.json");
  const displayPath = configPath.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(configPath)) {
    return { name: "Provider config", status: "fail", detail: `${displayPath} not found` };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    JSON.parse(content);
    return { name: "Provider config", status: "pass", detail: `${displayPath} found` };
  } catch {
    return { name: "Provider config", status: "fail", detail: `${displayPath} is invalid JSON` };
  }
}

export function checkApiKey(baseDir?: string): CheckResult {
  // Check environment variables first
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const openaiKey = process.env["OPENAI_API_KEY"];

  if (anthropicKey || openaiKey) {
    const which = anthropicKey ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return { name: "API key", status: "pass", detail: `${which} found in environment` };
  }

  // Check provider.json
  const dir = baseDir ?? getPulseedDirPath();
  const configPath = path.join(dir, "provider.json");

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "api_key" in parsed &&
        typeof (parsed as Record<string, unknown>)["api_key"] === "string" &&
        (parsed as Record<string, string>)["api_key"].length > 0
      ) {
        return { name: "API key", status: "pass", detail: "api_key found in provider.json" };
      }
    } catch {
      // ignore parse errors — already checked in checkProviderConfig
    }
  }

  return {
    name: "API key",
    status: "fail",
    detail: "ANTHROPIC_API_KEY / OPENAI_API_KEY not set (checked env + provider.json)",
  };
}

export function checkGoals(baseDir?: string): CheckResult {
  const goalsDir = getGoalsDir(baseDir ?? getPulseedDirPath());

  if (!fs.existsSync(goalsDir)) {
    return { name: "Goals", status: "warn", detail: "goals directory not found" };
  }

  let jsonFiles: string[] = [];
  try {
    jsonFiles = fs.readdirSync(goalsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { name: "Goals", status: "warn", detail: "could not read goals directory" };
  }

  if (jsonFiles.length === 0) {
    return { name: "Goals", status: "warn", detail: "0 goals configured" };
  }

  const count = jsonFiles.length;
  return { name: "Goals", status: "pass", detail: `${count} goal${count === 1 ? "" : "s"} configured` };
}

export function checkLogDirectory(baseDir?: string): CheckResult {
  const logsDir = getLogsDir(baseDir ?? getPulseedDirPath());
  const displayDir = logsDir.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(logsDir)) {
    return { name: "Log directory", status: "fail", detail: `${displayDir} not found` };
  }

  try {
    fs.accessSync(logsDir, fs.constants.W_OK);
    return { name: "Log directory", status: "pass", detail: `${displayDir} writable` };
  } catch {
    return { name: "Log directory", status: "fail", detail: `${displayDir} not writable` };
  }
}

export function checkBuild(buildPath = getCliRunnerBuildPath(import.meta.url)): CheckResult {
  const displayPath = path.relative(process.cwd(), buildPath) || buildPath;

  if (fs.existsSync(buildPath)) {
    return { name: "Build", status: "pass", detail: `${displayPath} exists` };
  }
  return { name: "Build", status: "fail", detail: `${displayPath} not found (run: npm run build)` };
}

export async function checkDaemon(baseDir?: string): Promise<CheckResult> {
  const dir = baseDir ?? getPulseedDirPath();
  const pidManager = new PIDManager(dir);
  const pidFileExists = fs.existsSync(pidManager.getPath());
  const pidStatus = await pidManager.inspect();
  const daemonConfig = await loadDaemonConfig(dir);
  const runtimeRoot = resolveDaemonRuntimeRoot(dir, daemonConfig.runtime_root);
  const runtimeHealth = await new RuntimeHealthStore(runtimeRoot).loadSnapshot();
  const daemonStateRaw = await readJsonFileOrNull(path.join(dir, "daemon-state.json"));
  const daemonState = daemonStateRaw !== null
    ? DaemonStateSchema.safeParse(daemonStateRaw)
    : null;

  if (!pidFileExists && !pidStatus.running) {
    return { name: "Daemon", status: "pass", detail: "stopped (clean state)" };
  }

  const pidInfo = pidStatus.info ?? await pidManager.readPID();
  if (pidInfo === null && pidFileExists) {
    return { name: "Daemon", status: "warn", detail: "PID file exists but is unreadable" };
  }

  const runtimePid = pidStatus.runtimePid ?? pidInfo?.runtime_pid ?? pidInfo?.pid ?? null;
  const watchdogPid = pidInfo?.watchdog_pid ?? pidStatus.ownerPid ?? null;
  const runtimeAlive = typeof runtimePid === "number" && pidStatus.alivePids.includes(runtimePid);
  const watchdogAlive = typeof watchdogPid === "number" && pidStatus.alivePids.includes(watchdogPid);
  const runtimeState = daemonState?.success ? daemonState.data.status : null;
  const runtimeKpi = runtimeHealth?.kpi;
  const kpiSummary = runtimeKpi ? formatCompactKpiDetail(runtimeKpi) : null;
  const healthStatus = runtimeKpi
    ? compactRuntimeHealthKpi(runtimeKpi)?.status ?? "degraded"
    : "degraded";
  const taskKpis = await summarizeTaskOutcomeLedgers(dir);
  const taskSummary =
    taskKpis.total_tasks > 0
      ? `task success=${taskKpis.succeeded}/${taskKpis.terminal_tasks} (${formatPercent(taskKpis.success_rate)}), retry=${taskKpis.retried}/${taskKpis.total_tasks} (${formatPercent(taskKpis.retry_rate)})${
          taskKpis.p95_created_to_completed_ms !== null
            ? `, total p95=${formatDurationMs(taskKpis.p95_created_to_completed_ms)}`
            : ""
        }`
      : null;

  if (runtimeState === "crashed" || runtimeState === "stopping") {
    return {
      name: "Daemon",
      status: "fail",
      detail:
        runtimeState === "crashed"
          ? `daemon state reports crashed${kpiSummary ? `; ${kpiSummary}` : ""}`
          : `daemon state reports stopping${kpiSummary ? `; ${kpiSummary}` : ""}`,
    };
  }

  if (!runtimeAlive) {
    if (watchdogAlive) {
      return {
        name: "Daemon",
        status: "fail",
        detail: runtimePid !== null
          ? `daemon restarting (runtime PID: ${runtimePid}, watchdog PID: ${watchdogPid})`
          : `daemon restarting (watchdog PID: ${watchdogPid})`,
      };
    }
    return {
      name: "Daemon",
      status: pidFileExists ? "warn" : "pass",
      detail: runtimePid !== null
        ? `stale PID file (PID: ${runtimePid} not running)`
        : "stopped (clean state)",
    };
  }

  if (watchdogPid && watchdogPid !== runtimePid && !watchdogAlive) {
    return {
      name: "Daemon",
      status: "warn",
      detail: `running (PID: ${runtimePid}), watchdog PID: ${watchdogPid} missing`,
    };
  }

  const detailPrefix =
    runtimeState === "idle"
      ? `idle daemon running (PID: ${runtimePid})`
      : `running (PID: ${runtimePid})`;
  const detail =
    watchdogPid && watchdogPid !== runtimePid
      ? `${detailPrefix}, watchdog PID: ${watchdogPid}`
      : detailPrefix;
  const detailWithHealth = kpiSummary
    ? `${detail}; ${kpiSummary}${
        runtimeKpi?.degraded_at !== undefined
          ? `; degraded ${formatRelativeTimestamp(runtimeKpi.degraded_at)}`
          : runtimeKpi?.recovered_at !== undefined
            ? `; recovered ${formatRelativeTimestamp(runtimeKpi.recovered_at)}`
            : ""
      }${taskSummary ? `; ${taskSummary}` : ""}`
    : `${detail}; KPI telemetry unavailable${taskSummary ? `; ${taskSummary}` : ""}`;
  return {
    name: "Daemon",
    status: healthStatus === "failed" ? "fail" : healthStatus === "degraded" ? "warn" : "pass",
    detail: detailWithHealth,
  };
}

export function checkNotifications(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const notifPath = path.join(dir, "notification.json");

  if (fs.existsSync(notifPath)) {
    return { name: "Notifications", status: "pass", detail: "notification.json found" };
  }
  return { name: "Notifications", status: "warn", detail: "not configured (optional)" };
}

export async function checkDiskUsage(baseDir?: string): Promise<CheckResult> {
  const dir = baseDir ?? getPulseedDirPath();
  const displayDir = dir.replace(process.env["HOME"] ?? "", "~");

  const result = await execFileNoThrow("du", ["-sh", dir], { timeoutMs: 5000 });
  if (result.exitCode === 0 && result.stdout) {
    const size = result.stdout.split("\t")[0]?.trim() ?? "unknown";
    return { name: "Disk space", status: "warn", detail: `${displayDir} is ${size}` };
  }
  return { name: "Disk space", status: "warn", detail: `${displayDir} (could not determine size)` };
}

// ─── Output helpers ───

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "pass": return "\u2713";
    case "fail": return "\u2717";
    case "warn": return "\u26a0";
  }
}

function formatRow(result: CheckResult): string {
  const icon = statusIcon(result.status);
  const name = result.name.padEnd(20);
  return `${icon} ${name} ${result.detail}`;
}

// ─── Main command ───

export async function cmdDoctor(_args: string[]): Promise<number> {
  const baseDir = getPulseedDirPath();
  const repair = _args.includes("--repair");

  if (repair) {
    const runtimeRoot = path.join(baseDir, "runtime");
    const runtimePaths = createRuntimeStorePaths(runtimeRoot);
    const repairLogger: RuntimeMaintenanceLogger = {
      debug: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][debug] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
      info: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][info] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][warn] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
      error: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][error] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
    };

    const maintenanceReport = await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore: new ApprovalStore(runtimePaths),
      outboxStore: new OutboxStore(runtimePaths),
      runtimeHealthStore: new RuntimeHealthStore(runtimePaths),
      logger: repairLogger,
    });

    console.log(
      `Repair: approvals pruned=${maintenanceReport.approvals.prunedResolved}, outbox pruned=${maintenanceReport.outbox.pruned}, claims pruned=${maintenanceReport.claims.pruned}, health=${maintenanceReport.health.status ?? "unknown"}`
    );
  }

  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkPulseedDir(baseDir),
    checkProviderConfig(baseDir),
    checkApiKey(baseDir),
    checkGoals(baseDir),
    checkLogDirectory(baseDir),
    checkBuild(),
    await checkDaemon(baseDir),
    checkNotifications(baseDir),
    await checkDiskUsage(baseDir),
  ];

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  console.log("PulSeed Doctor");
  console.log("\u2500".repeat(14));

  for (const check of checks) {
    console.log(formatRow(check));
  }

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed, ${warned} warnings`);

  return failed > 0 ? 1 : 0;
}
