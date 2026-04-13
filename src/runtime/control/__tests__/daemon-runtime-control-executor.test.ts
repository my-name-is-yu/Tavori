import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDaemonRuntimeControlExecutor } from "../daemon-runtime-control-executor.js";
import { DaemonClient, isDaemonRunning } from "../../daemon/client.js";
import type { RuntimeControlOperation } from "../../store/index.js";

const { requestRuntimeControlMock } = vi.hoisted(() => ({
  requestRuntimeControlMock: vi.fn(),
}));

vi.mock("../../daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () {
    return {
      requestRuntimeControl: requestRuntimeControlMock,
    };
  }),
  isDaemonRunning: vi.fn(),
}));

function makeOperation(kind: RuntimeControlOperation["kind"] = "restart_daemon"): RuntimeControlOperation {
  return {
    operation_id: "op-1",
    kind,
    state: "acknowledged",
    requested_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    requested_by: { surface: "cli" },
    reply_target: { surface: "cli" },
    reason: "PulSeed を再起動して",
    expected_health: {
      daemon_ping: true,
      gateway_acceptance: true,
    },
  };
}

describe("createDaemonRuntimeControlExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestRuntimeControlMock.mockResolvedValue({ ok: true });
  });

  it("submits daemon restart requests through the daemon HTTP command surface", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue({
      running: true,
      port: 41700,
      authToken: "token-1",
    });

    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation(), {
      intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: true,
      state: "running",
    });

    expect(DaemonClient).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 41700,
      authToken: "token-1",
      baseDir: "/tmp/pulseed",
    });
    expect(requestRuntimeControlMock).toHaveBeenCalledWith({
      operationId: "op-1",
      kind: "restart_daemon",
      reason: "PulSeed を再起動して",
    });
  });

  it("fails without claiming restart when the daemon is not running", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue({
      running: false,
      port: 41700,
    });

    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation(), {
      intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: false,
      state: "failed",
      message: expect.stringContaining("not running"),
    });

    expect(requestRuntimeControlMock).not.toHaveBeenCalled();
  });

  it("does not route self-update through daemon restart", async () => {
    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation("self_update"), {
      intent: { kind: "self_update", reason: "PulSeed 自身を更新して" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: false,
      state: "failed",
    });

    expect(isDaemonRunning).not.toHaveBeenCalled();
    expect(requestRuntimeControlMock).not.toHaveBeenCalled();
  });
});
