import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getPulseedDirPath } from "../../../../base/utils/paths.js";
import { DEFAULT_SEED, DEFAULT_USER } from "../../../../base/config/identity-loader.js";
import { findAvailablePort, isPortAvailable, DEFAULT_PORT, getProcessOnPort } from "../../../../runtime/port-utils.js";
import { isDaemonRunning } from "../../../../runtime/daemon-client.js";
import { PIDManager } from "../../../../runtime/pid-manager.js";
import { DaemonStateSchema } from "../../../../runtime/types/daemon.js";
import { ROOT_PRESETS } from "../presets/root-presets.js";
import type { RootPresetKey } from "../presets/root-presets.js";
import { guardCancel } from "./utils.js";

export async function stepDaemon(): Promise<{ start: boolean; port: number }> {
  const baseDir = path.join(homedir(), ".pulseed");

  const { running: alreadyRunning, port: currentPort } = await isDaemonRunning(baseDir);

  if (alreadyRunning) {
    try {
      const stateFile = path.join(baseDir, "daemon-state.json");
      if (fs.existsSync(stateFile)) {
        const stateContent = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const parseResult = DaemonStateSchema.safeParse(stateContent);
        if (parseResult.success) {
          const activeGoals = parseResult.data.active_goals;
          if (activeGoals.length > 0) {
            p.log.info(`Active goals: ${activeGoals.join(", ")}`);
          } else {
            p.log.info("(no active goals)");
          }
        }
      }
    } catch {
      // Silently ignore errors reading/parsing daemon state
    }

    const action = guardCancel(
      await p.select({
        message: `A daemon is already running on port ${currentPort}. What would you like to do?`,
        options: [
          {
            value: "stop" as const,
            label: "Stop and reconfigure",
            hint: "stop the running daemon, then configure a new one",
          },
          {
            value: "keep" as const,
            label: "Keep running (skip daemon setup)",
            hint: "leave daemon as-is and continue",
          },
        ],
      })
    );

    if (action === "keep") {
      return { start: false, port: currentPort };
    }

    const pidManager = new PIDManager(baseDir);
    const pidInfo = await pidManager.readPID();
    if (pidInfo !== null) {
      try {
        process.kill(pidInfo.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await pidManager.cleanup();
        p.log.success("Daemon stopped.");
      } catch {
        p.log.warn("Could not stop daemon. It may have already exited.");
        await pidManager.cleanup();
      }
    }
  }

  const start = guardCancel(
    await p.confirm({
      message: "Start PulSeed as a background daemon after setup?",
      initialValue: false,
    })
  );

  if (!start) return { start: false, port: DEFAULT_PORT };

  let suggestedPort: number;
  const defaultFree = await isPortAvailable(DEFAULT_PORT);
  if (defaultFree) {
    suggestedPort = DEFAULT_PORT;
  } else {
    try {
      suggestedPort = await findAvailablePort(DEFAULT_PORT + 1);
    } catch {
      suggestedPort = DEFAULT_PORT + 1;
    }
  }

  if (!defaultFree) {
    const processName = await getProcessOnPort(DEFAULT_PORT);
    if (processName) {
      p.log.warn(`Port ${DEFAULT_PORT} is in use by: ${processName}`);
    } else {
      p.log.warn(`Port ${DEFAULT_PORT} is in use by another process`);
    }
  }

  const suggestedLabel = defaultFree
    ? `Use port ${DEFAULT_PORT}`
    : `Use port ${suggestedPort} instead (41700 is in use)`;

  const portChoice = guardCancel(
    await p.select({
      message: "Select a port for the daemon:",
      options: [
        {
          value: "suggested" as const,
          label: suggestedLabel,
          hint: defaultFree ? "default port" : "auto-detected available port",
        },
        {
          value: "custom" as const,
          label: "Enter a custom port",
        },
      ],
    })
  );

  if (portChoice === "suggested") {
    return { start: true, port: suggestedPort };
  }

  let finalPort: number;
  for (;;) {
    const portInput = guardCancel(
      await p.text({
        message: "Enter a port number:",
        placeholder: String(suggestedPort),
        validate: (value) => {
          if (!value) return "Port is required.";
          const parsed = parseInt(value, 10);
          if (isNaN(parsed) || !Number.isInteger(parsed)) return "Port must be a whole number.";
          if (parsed < 1024 || parsed > 65535) return "Port must be between 1024 and 65535.";
          return undefined;
        },
      })
    );
    const candidate = parseInt(portInput, 10);
    if (await isPortAvailable(candidate)) {
      finalPort = candidate;
      break;
    }
    p.log.warn(`Port ${candidate} is already in use. Please try another.`);
  }

  return { start: true, port: finalPort };
}

export function ensurePulseedDir(): string {
  const dir = getPulseedDirPath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function writeSeedMd(dir: string, agentName: string): void {
  const content = DEFAULT_SEED.replace(/^#\s+.+$/m, `# ${agentName}`);
  fs.writeFileSync(path.join(dir, "SEED.md"), content, "utf-8");
}

export function writeRootMd(dir: string, presetKey: RootPresetKey): void {
  fs.writeFileSync(path.join(dir, "ROOT.md"), ROOT_PRESETS[presetKey].content, "utf-8");
}

export function writeUserMd(dir: string, userName: string): void {
  const content = DEFAULT_USER.replace(/^(#[^\n]*)\n/m, `$1\n\nName: ${userName}\n`);
  fs.writeFileSync(path.join(dir, "USER.md"), content, "utf-8");
}
