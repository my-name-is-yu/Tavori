import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { makeTempDir, cleanupTempDir } from "./helpers/temp-dir.js";

vi.mock("../src/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-notify-test-placeholder"),
  };
});

import { getPulseedDirPath } from "../src/utils/paths.js";
import { cmdNotify } from "../src/cli/commands/notify.js";

describe("cmdNotify", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-notify-test-");
    vi.mocked(getPulseedDirPath).mockReturnValue(tmpDir);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    cleanupTempDir(tmpDir);
  });

  // ─── add slack ───

  it("add slack channel creates config file", async () => {
    const code = await cmdNotify([
      "add",
      "slack",
      "--webhook-url",
      "https://hooks.slack.com/services/TEST",
    ]);

    expect(code).toBe(0);

    const configPath = path.join(tmpDir, "notification.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(raw.channels).toHaveLength(1);
    expect(raw.channels[0].type).toBe("slack");
    expect(raw.channels[0].webhook_url).toBe("https://hooks.slack.com/services/TEST");
  });

  it("add slack channel without --webhook-url returns error", async () => {
    const code = await cmdNotify(["add", "slack"]);
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("--webhook-url is required")
    );
  });

  // ─── add webhook ───

  it("add webhook channel appends to existing config", async () => {
    // Pre-create config with a slack channel
    const initial = {
      channels: [
        {
          type: "slack",
          webhook_url: "https://hooks.slack.com/services/EXISTING",
          report_types: [],
          format: "compact",
        },
      ],
      do_not_disturb: { enabled: false, start_hour: 22, end_hour: 7, exceptions: [] },
      cooldown: {},
      goal_overrides: [],
      batching: { enabled: false, window_minutes: 30, digest_format: "compact" },
    };
    fs.writeFileSync(
      path.join(tmpDir, "notification.json"),
      JSON.stringify(initial),
      "utf-8"
    );

    const code = await cmdNotify([
      "add",
      "webhook",
      "--url",
      "https://my-server.com/hook",
      "--header",
      "Authorization: Bearer token123",
    ]);

    expect(code).toBe(0);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "notification.json"), "utf-8")
    );
    expect(raw.channels).toHaveLength(2);
    expect(raw.channels[1].type).toBe("webhook");
    expect(raw.channels[1].url).toBe("https://my-server.com/hook");
    expect(raw.channels[1].headers["Authorization"]).toBe("Bearer token123");
  });

  it("add webhook channel without --url returns error", async () => {
    const code = await cmdNotify(["add", "webhook"]);
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("--url is required")
    );
  });

  // ─── add email ───

  it("add email channel creates channel with correct smtp config", async () => {
    const code = await cmdNotify([
      "add",
      "email",
      "--address",
      "user@example.com",
      "--smtp-host",
      "smtp.example.com",
      "--smtp-port",
      "465",
    ]);

    expect(code).toBe(0);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "notification.json"), "utf-8")
    );
    expect(raw.channels).toHaveLength(1);
    expect(raw.channels[0].type).toBe("email");
    expect(raw.channels[0].address).toBe("user@example.com");
    expect(raw.channels[0].smtp.host).toBe("smtp.example.com");
    expect(raw.channels[0].smtp.port).toBe(465);
  });

  // ─── list ───

  it("list shows channels in order", async () => {
    // Add two channels
    await cmdNotify([
      "add",
      "slack",
      "--webhook-url",
      "https://hooks.slack.com/services/AAA",
    ]);
    await cmdNotify(["add", "webhook", "--url", "https://my-server.com/hook"]);

    consoleSpy.mockClear();
    const code = await cmdNotify(["list"]);

    expect(code).toBe(0);

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(output).toContain("[0]");
    expect(output).toContain("slack");
    expect(output).toContain("https://hooks.slack.com/services/AAA");
    expect(output).toContain("[1]");
    expect(output).toContain("webhook");
    expect(output).toContain("https://my-server.com/hook");
  });

  it("list shows 'No channels configured' when config is empty", async () => {
    const code = await cmdNotify(["list"]);

    expect(code).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith("No channels configured");
  });

  // ─── remove ───

  it("remove by index works", async () => {
    await cmdNotify([
      "add",
      "slack",
      "--webhook-url",
      "https://hooks.slack.com/services/AAA",
    ]);
    await cmdNotify(["add", "webhook", "--url", "https://my-server.com/hook"]);

    const code = await cmdNotify(["remove", "0"]);

    expect(code).toBe(0);

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "notification.json"), "utf-8")
    );
    expect(raw.channels).toHaveLength(1);
    expect(raw.channels[0].type).toBe("webhook");
  });

  it("remove with invalid index returns error", async () => {
    await cmdNotify([
      "add",
      "slack",
      "--webhook-url",
      "https://hooks.slack.com/services/AAA",
    ]);

    consoleErrSpy.mockClear();
    const code = await cmdNotify(["remove", "5"]);

    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("out of bounds")
    );
  });

  it("remove without index argument returns error", async () => {
    const code = await cmdNotify(["remove"]);
    expect(code).toBe(1);
  });

  // ─── test ───

  it("test prints dry-run payload for all channels", async () => {
    await cmdNotify([
      "add",
      "slack",
      "--webhook-url",
      "https://hooks.slack.com/services/AAA",
    ]);

    consoleSpy.mockClear();
    const code = await cmdNotify(["test"]);

    expect(code).toBe(0);

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(output).toContain("dry-run");
    expect(output).toContain("PulSeed notification test");
    expect(output).toContain("https://hooks.slack.com/services/AAA");
  });

  it("test with specific index prints only that channel", async () => {
    await cmdNotify([
      "add",
      "slack",
      "--webhook-url",
      "https://hooks.slack.com/services/AAA",
    ]);
    await cmdNotify(["add", "webhook", "--url", "https://my-server.com/hook"]);

    consoleSpy.mockClear();
    const code = await cmdNotify(["test", "1"]);

    expect(code).toBe(0);

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(output).toContain("https://my-server.com/hook");
    expect(output).not.toContain("https://hooks.slack.com/services/AAA");
  });

  it("test with no channels shows 'No channels configured'", async () => {
    const code = await cmdNotify(["test"]);
    expect(code).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith("No channels configured");
  });

  // ─── unknown subcommand ───

  it("unknown subcommand returns 1 with usage message", async () => {
    const code = await cmdNotify(["bogus"]);
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: pulseed notify")
    );
  });
});
