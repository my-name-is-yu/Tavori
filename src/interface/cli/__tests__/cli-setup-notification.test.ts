import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationConfig } from "../../../runtime/types/notification.js";

const confirmMock = vi.fn();
const textMock = vi.fn();
const selectMock = vi.fn();
const noteMock = vi.fn();
const introMock = vi.fn();
const outroMock = vi.fn();
const cancelMock = vi.fn();
const logWarnMock = vi.fn();
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@clack/prompts", () => ({
  confirm: confirmMock,
  text: textMock,
  select: selectMock,
  note: noteMock,
  intro: introMock,
  outro: outroMock,
  cancel: cancelMock,
  log: {
    warn: logWarnMock,
    info: logInfoMock,
    error: logErrorMock,
  },
  isCancel: vi.fn(() => false),
}));

describe("setup notification step", () => {
  beforeEach(() => {
    vi.resetModules();
    confirmMock.mockReset();
    textMock.mockReset();
    selectMock.mockReset();
    noteMock.mockReset();
    introMock.mockReset();
    outroMock.mockReset();
    cancelMock.mockReset();
    logWarnMock.mockReset();
    logInfoMock.mockReset();
    logErrorMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../commands/setup/steps-identity.js");
    vi.doUnmock("../commands/setup/steps-provider.js");
    vi.doUnmock("../commands/setup/steps-adapter.js");
    vi.doUnmock("../commands/setup/steps-runtime.js");
    vi.doUnmock("../../../base/llm/provider-config.js");
    vi.doUnmock("../../../base/config/identity-loader.js");
    vi.doUnmock("node:fs");
  });

  it("returns null when notifications are skipped", async () => {
    confirmMock.mockResolvedValue(false);

    const { stepNotification } = await import("../commands/setup/steps-notification.js");
    const result = await stepNotification();

    expect(result).toBeNull();
    expect(textMock).not.toHaveBeenCalled();
  });

  it("returns config data without writing files", async () => {
    confirmMock.mockResolvedValue(true);
    textMock.mockResolvedValue("https://example.com/webhook");

    const { stepNotification } = await import("../commands/setup/steps-notification.js");
    const result = await stepNotification();

    expect(result).toEqual<NotificationConfig>({
      channels: [
        {
          type: "webhook",
          url: "https://example.com/webhook",
          report_types: [],
          format: "json",
        },
      ],
      do_not_disturb: {
        enabled: false,
        start_hour: 22,
        end_hour: 7,
        exceptions: ["urgent_alert", "approval_request"],
      },
      cooldown: {
        urgent_alert: 0,
        approval_request: 0,
        stall_escalation: 60,
        strategy_change: 30,
        goal_completion: 0,
        capability_escalation: 60,
      },
      goal_overrides: [],
      batching: {
        enabled: false,
        window_minutes: 30,
        digest_format: "compact",
      },
    });
  });

  it("rejects URLs without an http or https scheme", async () => {
    const { validateUrl } = await import("../commands/setup/steps-notification.js");

    expect(validateUrl("ftp://example.com/webhook")).toBe(
      "URL must start with http:// or https://"
    );
  });

  it("writes notification.json only after final confirmation", async () => {
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "overwrite"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const mkdirSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      mkdirSync: mkdirSyncMock,
      writeFileSync: writeFileSyncMock,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    textMock.mockResolvedValueOnce("https://example.com/webhook");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/pulseed-test/notification.json",
      expect.stringContaining("\"channels\"")
    );
    expect(writeFileSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining("notification.json"),
      expect.anything(),
      "utf-8"
    );
    expect(mkdirSyncMock).toHaveBeenCalledWith("/tmp/pulseed-test", { recursive: true });
  });

  it("warns when notification config write fails", async () => {
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "overwrite"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const mkdirSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn(() => {
      throw new Error("disk full");
    });
    vi.doMock("node:fs", () => ({
      mkdirSync: mkdirSyncMock,
      writeFileSync: writeFileSyncMock,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    textMock.mockResolvedValueOnce("https://example.com/webhook");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Could not save notification config: Error: disk full")
    );
  });
});
