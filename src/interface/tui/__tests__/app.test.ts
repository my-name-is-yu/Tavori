import React from "react";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, formatDaemonConnectionState } from "../app.js";

const testState = vi.hoisted(() => ({
  lastChatProps: null as null | { onSubmit: (value: string) => Promise<void> },
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
    useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
  };
});

vi.mock("../chat.js", async () => {
  return {
    Chat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      return null;
    },
  };
});

vi.mock("../fullscreen-chat.js", async () => {
  return {
    FullscreenChat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      return null;
    },
  };
});

vi.mock("../dashboard.js", () => ({
  Dashboard: () => null,
  statusLabel: (status: string) => status,
}));

vi.mock("../help-overlay.js", () => ({ HelpOverlay: () => null }));
vi.mock("../settings-overlay.js", () => ({ SettingsOverlay: () => null }));
vi.mock("../approval-overlay.js", () => ({ ApprovalOverlay: () => null }));
vi.mock("../report-view.js", () => ({ ReportView: () => null }));

function createDaemonClientMock() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    isConnected: vi.fn(() => true),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    startGoal: vi.fn(async () => {}),
    stopGoal: vi.fn(async () => {}),
    chat: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
  };
}

function createStateManagerMock() {
  return {
    listGoalIds: vi.fn(async () => [] as string[]),
    loadGoal: vi.fn(async () => null),
  };
}

function createChatRunnerMock() {
  return {
    startSession: vi.fn(),
    execute: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    onEvent: undefined,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("formatDaemonConnectionState", () => {
  it("renders connected, connecting, and disconnected labels", () => {
    expect(formatDaemonConnectionState("connected")).toBe("  [daemon connected]");
    expect(formatDaemonConnectionState("connecting")).toBe("  [daemon connecting]");
    expect(formatDaemonConnectionState("disconnected")).toBe("  [daemon disconnected]");
  });

  it("omits the badge when no daemon state is available", () => {
    expect(formatDaemonConnectionState(undefined)).toBeUndefined();
  });
});

describe("daemon-mode chat routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses ChatRunner when daemon mode has no active goal", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient,
      stateManager,
      chatRunner,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    expect(chatRunner.startSession).toHaveBeenCalledWith(process.cwd());
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("free form question");

    expect(chatRunner.execute).toHaveBeenCalledWith("free form question", process.cwd());
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes free-form text to daemon chat once an active goal is present", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient,
      stateManager,
      chatRunner,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    daemonClient.handlers.get("loop_update")?.({
      goalId: "goal-123",
      running: true,
      iteration: 1,
      status: "running",
      trustScore: 0,
    });
    await flush();

    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("question for the active goal");

    expect(daemonClient.chat).toHaveBeenCalledWith("goal-123", "question for the active goal");
    expect(chatRunner.execute).not.toHaveBeenCalled();

    screen.unmount();
  });
});
