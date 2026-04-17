#!/usr/bin/env node

import os from "os";
import React from "react";
import { render } from "ink";
import { TUITestApp } from "./test-app.js";
import { resetTuiDebugLog, getTuiDebugLogPath, logTuiDebug } from "./debug-log.js";
import {
  AlternateScreen,
  MouseTracking,
  isNoFlickerEnabled,
} from "./flicker/index.js";
import { DEFAULT_CURSOR_STYLE, HIDE_CURSOR, SHOW_CURSOR, STEADY_BAR_CURSOR } from "./flicker/dec.js";
import { getGitBranch } from "./git-branch.js";
import { createNoFlickerOutputController } from "./output-controller.js";
import { setTrustedTuiControlStream } from "./terminal-output.js";

function getCwd(): string {
  const raw = process.cwd();
  const home = os.homedir();
  return raw.startsWith(home) ? "~" + raw.slice(home.length) : raw;
}

export async function startTUITest(): Promise<void> {
  if (!process.env.PULSEED_TUI_DEBUG_LOG) {
    process.env.PULSEED_TUI_DEBUG_LOG = "1";
  }
  resetTuiDebugLog();
  logTuiDebug("test-entry", "start", { logPath: getTuiDebugLogPath() });

  const noFlicker = await isNoFlickerEnabled();
  const outputController = noFlicker ? createNoFlickerOutputController() : null;
  outputController?.install();
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (noFlicker) {
      outputController?.writeTerminal(DEFAULT_CURSOR_STYLE + SHOW_CURSOR);
    }
    outputController?.destroy();
    setTrustedTuiControlStream(null);
  };

  try {
    const terminalStream = outputController?.terminalStream ?? process.stdout;
    setTrustedTuiControlStream(terminalStream);
    if (noFlicker) {
      outputController?.writeTerminal(STEADY_BAR_CURSOR + HIDE_CURSOR);
    }

    const appElement = React.createElement(TUITestApp, {
      cwd: getCwd(),
      gitBranch: getGitBranch(),
      noFlicker,
      controlStream: terminalStream,
    });

    const { waitUntilExit } = render(
      React.createElement(
        AlternateScreen,
        { enabled: noFlicker, stream: terminalStream },
        React.createElement(
          MouseTracking,
          { stream: terminalStream },
          appElement,
        ),
      ),
      {
        exitOnCtrlC: false,
        incrementalRendering: noFlicker,
        maxFps: noFlicker ? 60 : 30,
        patchConsole: false,
        stdout: outputController?.renderStdout ?? process.stdout,
        stderr: outputController?.renderStderr ?? process.stderr,
      },
    );
    await waitUntilExit();
  } finally {
    cleanup();
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("test-entry.js") ||
    process.argv[1].endsWith("test-entry.ts"));

if (isMain) {
  startTUITest().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
