#!/usr/bin/env node
// --- TUI Entry Point ---
//
// Connects to the PulSeed daemon (auto-starting if needed) and renders the
// Ink-based TUI as a thin client.  Use `pulseed tui` or `npm run tui` to launch.

import os from "os";
import path from "path";
import { execFileSync } from "child_process";

import { StateManager } from "../../base/state/state-manager.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { DaemonClient, isDaemonRunning } from "../../runtime/daemon-client.js";
import { App } from "./app.js";
import { getCliLogger } from "../cli/cli-logger.js";
import { ensureProviderConfig } from "../cli/ensure-api-key.js";

// --- Daemon auto-start ---

async function startDaemonDetached(baseDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  // Resolve cli-runner.js relative to this file (entry.ts -> cli/cli-runner.js)
  const scriptPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "cli",
    "cli-runner.js"
  );

  const child = spawn(process.execPath, [scriptPath, "daemon", "start", "--detach"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PULSEED_HOME: baseDir },
  });
  child.unref();
}

async function waitForDaemon(
  baseDir: string,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { running, port } = await isDaemonRunning(baseDir);
    if (running) return port;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Daemon failed to start within timeout");
}

// --- Breadcrumb helpers ---

function getCwd(): string {
  const raw = process.cwd();
  const home = os.homedir();
  return raw.startsWith(home) ? "~" + raw.slice(home.length) : raw;
}

function getGitBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

// --- TUI Entry ---

export async function startTUI(): Promise<void> {
  // 1. Ensure provider config exists
  try {
    await ensureProviderConfig();
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 2. Determine base dir
  const baseDir = process.env.PULSEED_HOME ?? getPulseedDirPath();

  // 3. Check for running daemon and connect (or auto-start)
  let daemonClient: DaemonClient;

  try {
    const { running, port } = await isDaemonRunning(baseDir);

    if (running) {
      daemonClient = new DaemonClient({ host: "127.0.0.1", port });
    } else {
      await startDaemonDetached(baseDir);
      const readyPort = await waitForDaemon(baseDir, 10_000);
      daemonClient = new DaemonClient({ host: "127.0.0.1", port: readyPort });
    }

    daemonClient.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getCliLogger().error(`Error: Failed to connect to daemon: ${message}`);
    process.exit(1);
  }

  // 4. Create minimal deps that TUI still needs locally
  const stateManager = new StateManager(baseDir);
  await stateManager.init();

  // 5. Compute breadcrumb context for the header
  const providerConfig = await loadProviderConfig();
  const cwd = getCwd();
  const gitBranch = getGitBranch();
  const providerName = providerConfig.provider;

  // 6. Handle SIGTERM gracefully
  process.on("SIGTERM", () => {
    daemonClient.disconnect();
    process.exit(0);
  });

  // 7. Render Ink app with daemonClient
  const { render } = await import("ink");
  const React = await import("react");

  const { waitUntilExit } = render(
    React.createElement(App, {
      daemonClient,
      stateManager,
      cwd,
      gitBranch,
      providerName,
    }),
    { exitOnCtrlC: false }
  );

  await waitUntilExit();
}

// --- CLI entry (when run directly as a binary) ---

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("entry.js") || process.argv[1].endsWith("entry.ts"));

if (isMain) {
  startTUI().catch((err) => {
    getCliLogger().error(String(err));
    process.exit(1);
  });
}
