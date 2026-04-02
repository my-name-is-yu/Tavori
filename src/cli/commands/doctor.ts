// ─── pulseed doctor — installation health check ───

import * as fs from "node:fs";
import * as path from "node:path";
import { getPulseedDirPath, getLogsDir, getGoalsDir } from "../../utils/paths.js";
import { execFileNoThrow } from "../../utils/execFileNoThrow.js";

// ─── Types ───

type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
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

export function checkBuild(): CheckResult {
  // This file lives at src/cli/commands/doctor.ts (or dist/cli/commands/doctor.js).
  // Walk up four levels to reach the package root.
  const packageRoot = path.resolve(new URL(import.meta.url).pathname, "..", "..", "..", "..");
  const buildPath = path.join(packageRoot, "dist", "cli-runner.js");

  if (fs.existsSync(buildPath)) {
    return { name: "Build", status: "pass", detail: "dist/cli-runner.js exists" };
  }
  return { name: "Build", status: "fail", detail: "dist/cli-runner.js not found (run: npm run build)" };
}

export function checkDaemon(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const pidFile = path.join(dir, "pulseed.pid");

  if (!fs.existsSync(pidFile)) {
    return { name: "Daemon", status: "pass", detail: "not running (clean state)" };
  }

  let pid: number;
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    // PID files may contain JSON (e.g. {"pid": 1234}) or plain integers
    if (content.startsWith("{")) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      pid = Number(parsed["pid"]);
    } else {
      pid = parseInt(content, 10);
    }
    if (isNaN(pid)) throw new Error("invalid pid");
  } catch {
    return { name: "Daemon", status: "warn", detail: "PID file exists but is unreadable" };
  }

  try {
    process.kill(pid, 0);
    return { name: "Daemon", status: "pass", detail: `running (PID: ${pid})` };
  } catch {
    return { name: "Daemon", status: "warn", detail: `stale PID file (PID: ${pid} not running)` };
  }
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

  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkPulseedDir(baseDir),
    checkProviderConfig(baseDir),
    checkApiKey(baseDir),
    checkGoals(baseDir),
    checkLogDirectory(baseDir),
    checkBuild(),
    checkDaemon(baseDir),
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
