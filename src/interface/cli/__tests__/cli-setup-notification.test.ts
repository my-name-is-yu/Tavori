import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationConfig } from "../../../runtime/types/notification.js";
import type { SetupImportSelection } from "../commands/setup/import/types.js";

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
const logSuccessMock = vi.fn();

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
    success: logSuccessMock,
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
    logSuccessMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../commands/setup/steps-identity.js");
    vi.doUnmock("../commands/setup/steps-provider.js");
    vi.doUnmock("../commands/setup/steps-adapter.js");
    vi.doUnmock("../commands/setup/steps-runtime.js");
    vi.doUnmock("../commands/setup/steps-notification.js");
    vi.doUnmock("../../../base/llm/provider-config.js");
    vi.doUnmock("../../../base/config/identity-loader.js");
    vi.doUnmock("../../../runtime/daemon/client.js");
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.doUnmock("../commands/setup/import/flow.js");
    vi.doUnmock("../commands/setup/import/apply.js");
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
      plugin_notifiers: {
        mode: "all",
        routes: [],
      },
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

  it("preselects custom model when modifying an unknown current model", async () => {
    selectMock.mockResolvedValueOnce("__custom__");
    textMock.mockResolvedValueOnce("my-custom-model");

    const { stepModel } = await import("../commands/setup/steps-provider.js");
    const result = await stepModel("openai", "my-custom-model");

    expect(result).toBe("my-custom-model");
    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "__custom__",
      })
    );
    expect(textMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "my-custom-model",
      })
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
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
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
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

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

  it("can go back to a previous setup section before saving", async () => {
    const stepUserNameMock = vi.fn()
      .mockResolvedValueOnce("User 1")
      .mockResolvedValueOnce("User 2");
    const stepSeedyNameMock = vi.fn()
      .mockResolvedValueOnce("Seedy 1")
      .mockResolvedValueOnce("Seedy 2");
    const stepProviderMock = vi.fn(async () => "openai");
    const saveProviderConfigMock = vi.fn(async () => {});
    const writeUserMdMock = vi.fn();
    const writeSeedMdMock = vi.fn();

    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
      stepUserName: stepUserNameMock,
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: writeSeedMdMock,
      writeRootMd: vi.fn(),
      writeUserMd: writeUserMdMock,
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepUserNameMock).toHaveBeenCalledTimes(2);
    expect(stepProviderMock).toHaveBeenCalledTimes(2);
    expect(writeUserMdMock).toHaveBeenCalledWith("/tmp/pulseed-test", "User 2");
    expect(writeSeedMdMock).toHaveBeenCalledWith("/tmp/pulseed-test", "Seedy 2");
    expect(saveProviderConfigMock).toHaveBeenCalledTimes(1);
  });

  it("can go back from runtime settings to provider settings", async () => {
    const stepProviderMock = vi.fn(async () => "openai");
    const stepDaemonMock = vi.fn(async () => ({ start: false, port: 41700 }));
    const saveProviderConfigMock = vi.fn(async () => {});

    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: vi.fn(async () => "Seedy"),
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-test"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "openai_codex_cli"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: stepDaemonMock,
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepProviderMock).toHaveBeenCalledTimes(2);
    expect(stepDaemonMock).toHaveBeenCalledTimes(2);
    expect(saveProviderConfigMock).toHaveBeenCalledTimes(1);
  });

  it("updates only provider settings when modifying an existing config", async () => {
    const stepUserNameMock = vi.fn(async () => "User");
    const stepSeedyNameMock = vi.fn(async () => "Seedy");
    const stepDaemonMock = vi.fn(async () => ({ start: false, port: 41700 }));
    const stepNotificationMock = vi.fn(async () => null);
    const saveProviderConfigMock = vi.fn(async () => {});

    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "modify"),
      stepUserName: stepUserNameMock,
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: vi.fn(async () => "openai"),
      stepModel: vi.fn(async () => "gpt-5.4-mini"),
      stepApiKey: vi.fn(async () => "sk-existing"),
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: vi.fn(async () => "agent_loop"),
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: stepDaemonMock,
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: stepNotificationMock,
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(async () => ({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        api_key: "sk-existing",
        codex_cli_path: "/usr/local/bin/codex",
      })),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock.mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepUserNameMock).not.toHaveBeenCalled();
    expect(stepSeedyNameMock).not.toHaveBeenCalled();
    expect(stepDaemonMock).not.toHaveBeenCalled();
    expect(stepNotificationMock).not.toHaveBeenCalled();
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "agent_loop",
        codex_cli_path: "/usr/local/bin/codex",
      })
    );
    expect((saveProviderConfigMock.mock.calls[0] as unknown[] | undefined)?.[0]).not.toHaveProperty("api_key");
  });

  it("starts daemon and gateway after saving daemon config", async () => {
    const spawnChild = {
      pid: 12345,
      unref: vi.fn(),
      once: vi.fn(),
    };
    spawnChild.once.mockImplementation((event: string, callback: () => void) => {
      if (event === "spawn") queueMicrotask(callback);
      return spawnChild;
    });
    const spawnMock = vi.fn(() => spawnChild);
    const isDaemonRunningMock = vi.fn(async () => ({ running: true, port: 41701 }));

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));
    vi.doMock("../../../runtime/daemon/client.js", () => ({
      isDaemonRunning: isDaemonRunningMock,
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: vi.fn(async () => "reset"),
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
      stepDaemon: vi.fn(async () => ({ start: true, port: 41701 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const writeFileSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: writeFileSyncMock,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/pulseed-test/daemon.json",
      expect.stringContaining("\"event_server_port\": 41701"),
      "utf-8"
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [expect.any(String), "daemon", "start", "--detach"],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        env: expect.objectContaining({ PULSEED_HOME: "/tmp/pulseed-test" }),
      })
    );
    expect(spawnChild.unref).toHaveBeenCalled();
    expect(isDaemonRunningMock).toHaveBeenCalledWith("/tmp/pulseed-test");
    expect(logSuccessMock).toHaveBeenCalledWith(
      "Daemon and gateway started (PID: 12345) on port 41701."
    );
  });

  it("still asks for Seedy name after importing from OpenClaw", async () => {
    const stepExistingConfigMock = vi.fn(async () => "keep");
    const stepSeedyNameMock = vi.fn(async () => "Imported Seedy");
    const stepProviderMock = vi.fn(async (initial?: string) => initial ?? "openai");
    const stepModelMock = vi.fn(async (_provider: string, initial?: string) => initial ?? "gpt-5.4-mini");
    const stepApiKeyMock = vi.fn(async (_provider: string, _detected: Record<string, boolean>, initial?: string) => initial ?? "sk-test");
    const stepAdapterMock = vi.fn(async (_model: string, _provider: string, initial?: string) => initial ?? "agent_loop");
    const saveProviderConfigMock = vi.fn(async () => {});
    const applySetupImportSelectionMock = vi.fn(async () => ({
      created_at: "2026-04-13T00:00:00.000Z",
      sources: [{ id: "openclaw", label: "OpenClaw", rootDir: "/tmp/openclaw" }],
      items: [],
    }));

    const importSelection: SetupImportSelection = {
      sources: [{ id: "openclaw", label: "OpenClaw", rootDir: "/tmp/openclaw", items: [] }],
      items: [
        {
          id: "openclaw:provider:config.json",
          source: "openclaw",
          sourceLabel: "OpenClaw",
          kind: "provider",
          label: "anthropic / claude-sonnet-4-6 / agent_loop",
          decision: "import",
          reason: "provider defaults",
          providerSettings: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            adapter: "agent_loop",
            apiKey: "sk-imported",
          },
        },
      ],
      providerSettings: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "agent_loop",
        apiKey: "sk-imported",
      },
    };

    vi.doMock("../commands/setup/import/flow.js", () => ({
      stepSetupImport: vi.fn(async () => importSelection),
      providerConfigPatchFromImport: vi.fn((settings: NonNullable<SetupImportSelection["providerSettings"]>) => ({
        provider: settings.provider,
        model: settings.model,
        adapter: settings.adapter,
        api_key: settings.apiKey,
      })),
    }));
    vi.doMock("../commands/setup/import/apply.js", () => ({
      applySetupImportSelection: applySetupImportSelectionMock,
    }));
    vi.doMock("../commands/setup/steps-identity.js", () => ({
      getBanner: () => "banner",
      stepExistingConfig: stepExistingConfigMock,
      stepUserName: vi.fn(async () => "User"),
      stepSeedyName: stepSeedyNameMock,
    }));
    vi.doMock("../commands/setup/steps-provider.js", () => ({
      stepRootPreset: vi.fn(async () => "default"),
      stepProvider: stepProviderMock,
      stepModel: stepModelMock,
      stepApiKey: stepApiKeyMock,
    }));
    vi.doMock("../commands/setup/steps-adapter.js", () => ({
      stepAdapter: stepAdapterMock,
    }));
    vi.doMock("../commands/setup/steps-runtime.js", () => ({
      ensurePulseedDir: vi.fn(() => "/tmp/pulseed-test"),
      stepDaemon: vi.fn(async () => ({ start: false, port: 41700 })),
      writeSeedMd: vi.fn(),
      writeRootMd: vi.fn(),
      writeUserMd: vi.fn(),
    }));
    vi.doMock("../commands/setup/steps-notification.js", () => ({
      stepNotification: vi.fn(async () => null),
    }));
    vi.doMock("../../../base/llm/provider-config.js", () => ({
      MODEL_REGISTRY: {
        "claude-sonnet-4-6": {
          provider: "anthropic",
          adapters: ["claude_code_cli", "claude_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: saveProviderConfigMock,
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    }));

    confirmMock.mockResolvedValueOnce(true);
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(stepExistingConfigMock).not.toHaveBeenCalled();
    expect(stepSeedyNameMock).toHaveBeenCalledTimes(1);
    expect(stepProviderMock).toHaveBeenCalledWith("anthropic");
    expect(stepModelMock).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-6");
    expect(stepAdapterMock).toHaveBeenCalledWith("claude-sonnet-4-6", "anthropic", "agent_loop");
    expect(stepApiKeyMock).toHaveBeenCalledWith("anthropic", expect.any(Object), "sk-imported", "agent_loop");
    expect(saveProviderConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "agent_loop",
      })
    );
    expect((saveProviderConfigMock.mock.calls[0] as unknown[] | undefined)?.[0]).not.toHaveProperty("api_key");
    expect(applySetupImportSelectionMock).toHaveBeenCalledWith("/tmp/pulseed-test", importSelection);
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
      MODEL_REGISTRY: {
        "gpt-5.4-mini": {
          provider: "openai",
          adapters: ["openai_codex_cli", "openai_api", "agent_loop"],
        },
      },
      loadProviderConfig: vi.fn(),
      saveProviderConfig: vi.fn(async () => {}),
      validateProviderConfig: vi.fn(() => ({ valid: true, errors: [] })),
    }));
    vi.doMock("../../../base/config/identity-loader.js", () => ({
      clearIdentityCache: vi.fn(),
    }));
    const mkdirSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn((filePath: string) => {
      if (filePath.endsWith("notification.json")) {
        throw new Error("disk full");
      }
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
    selectMock
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("save");

    const { runSetupWizard } = await import("../commands/setup-wizard.js");
    const code = await runSetupWizard();

    expect(code).toBe(0);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Setup saved, but could not save notification config: Error: disk full")
    );
  });
});
