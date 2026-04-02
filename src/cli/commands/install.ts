// ─── pulseed install / uninstall (macOS launchd integration) ───

import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileNoThrow } from "../../utils/execFileNoThrow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLIST_LABEL = "com.pulseed.daemon";
const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`
);

/** Build the plist XML string from the given parameters. */
export function buildPlist(opts: {
  nodePath: string;
  cliRunnerPath: string;
  goalIds: string[];
  configPath?: string;
  intervalMs?: number;
  stdoutLog: string;
  stderrLog: string;
  workingDir: string;
  envPath?: string;
  pulseedHome?: string;
}): string {
  const programArgs = [opts.nodePath, opts.cliRunnerPath, "start"];
  for (const id of opts.goalIds) {
    programArgs.push("--goal", id);
  }
  if (opts.configPath) {
    programArgs.push("--config", opts.configPath);
  }
  if (opts.intervalMs !== undefined) {
    programArgs.push("--check-interval-ms", String(opts.intervalMs));
  }

  const argEntries = programArgs
    .map((a) => `\t\t<string>${escapeXml(a)}</string>`)
    .join("\n");

  const envEntries: string[] = [];
  if (opts.envPath) {
    envEntries.push(
      `\t\t<key>PATH</key>\n\t\t<string>${escapeXml(opts.envPath)}</string>`
    );
  }
  if (opts.pulseedHome) {
    envEntries.push(
      `\t\t<key>PULSEED_HOME</key>\n\t\t<string>${escapeXml(opts.pulseedHome)}</string>`
    );
  }

  const envBlock =
    envEntries.length > 0
      ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envEntries.join("\n")}\n\t</dict>\n`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${PLIST_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${argEntries}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(opts.stdoutLog)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(opts.stderrLog)}</string>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(opts.workingDir)}</string>
${envBlock}</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function cmdInstall(args: string[]): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("launchd is only supported on macOS");
    return 1;
  }

  let values: { goal?: string[]; config?: string; interval?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        goal: { type: "string", multiple: true },
        config: { type: "string" },
        interval: { type: "string" },
      },
      strict: false,
    }) as { values: { goal?: string[]; config?: string; interval?: string } });
  } catch {
    console.error("Failed to parse arguments");
    return 1;
  }

  const goalIds = values.goal ?? [];
  if (goalIds.length === 0) {
    console.error("Error: at least one --goal is required");
    return 1;
  }

  const intervalMs =
    values.interval !== undefined ? parseInt(values.interval, 10) : undefined;
  if (intervalMs !== undefined && (isNaN(intervalMs) || intervalMs <= 0)) {
    console.error("--interval must be a positive integer (milliseconds)");
    return 1;
  }

  if (fs.existsSync(PLIST_PATH)) {
    console.warn(`Warning: plist already exists at ${PLIST_PATH}, overwriting`);
  }

  const nodePath = process.execPath;
  // This file is compiled to dist/cli/commands/install.js — go up two levels to dist/
  const cliRunnerPath = path.resolve(__dirname, "../../cli-runner.js");
  const home = os.homedir();
  const logsDir = path.join(home, ".pulseed", "logs");
  const stdoutLog = path.join(logsDir, "launchd-stdout.log");
  const stderrLog = path.join(logsDir, "launchd-stderr.log");

  const plistContent = buildPlist({
    nodePath,
    cliRunnerPath,
    goalIds,
    configPath: values.config,
    intervalMs,
    stdoutLog,
    stderrLog,
    workingDir: home,
    envPath: process.env["PATH"],
    pulseedHome: process.env["PULSEED_HOME"],
  });

  // Ensure LaunchAgents directory exists
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plistContent, "utf8");

  const result = await execFileNoThrow("launchctl", ["load", PLIST_PATH]);
  if (result.exitCode !== 0) {
    console.error(
      `Failed to load plist with launchctl: ${result.stderr.trim()}`
    );
    return 1;
  }

  console.log(`PulSeed daemon installed at: ${PLIST_PATH}`);
  console.log(`To check status: launchctl list ${PLIST_LABEL}`);
  console.log(`Logs: ${stdoutLog} / ${stderrLog}`);
  return 0;
}

export async function cmdUninstall(_args: string[]): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("launchd is only supported on macOS");
    return 1;
  }

  if (!fs.existsSync(PLIST_PATH)) {
    console.log("Not installed");
    return 1;
  }

  const result = await execFileNoThrow("launchctl", ["unload", PLIST_PATH]);
  if (result.exitCode !== 0) {
    // Warn but still proceed to remove the plist file
    console.warn(
      `Warning: launchctl unload returned an error: ${result.stderr.trim()}`
    );
  }

  fs.unlinkSync(PLIST_PATH);
  console.log(`PulSeed daemon uninstalled (removed ${PLIST_PATH})`);
  return 0;
}
