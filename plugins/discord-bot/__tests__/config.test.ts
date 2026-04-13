import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";

describe("discord-bot config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("loads the required config fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        application_id: "app-1",
        bot_token: "bot-1",
        channel_id: "chan-1",
        identity_key: "discord:alpha",
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.application_id).toBe("app-1");
    expect(cfg.command_name).toBe("pulseed");
    expect(cfg.port).toBe(8787);
    expect(cfg.ephemeral).toBe(false);
    expect(cfg.runtime_control_allowed_sender_ids).toEqual([]);
  });

  it("loads runtime control sender allowlist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        application_id: "app-1",
        bot_token: "bot-1",
        channel_id: "chan-1",
        identity_key: "discord:alpha",
        runtime_control_allowed_sender_ids: ["user-1"],
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.runtime_control_allowed_sender_ids).toEqual(["user-1"]);
  });

  it("rejects invalid runtime control sender allowlist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        application_id: "app-1",
        bot_token: "bot-1",
        channel_id: "chan-1",
        identity_key: "discord:alpha",
        runtime_control_allowed_sender_ids: [123],
      }),
      "utf-8"
    );

    expect(() => loadConfig(tmpDir)).toThrow("runtime_control_allowed_sender_ids");
  });

  it("requires identity_key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        application_id: "app-1",
        bot_token: "bot-1",
        channel_id: "chan-1",
      }),
      "utf-8"
    );

    expect(() => loadConfig(tmpDir)).toThrow("identity_key");
  });
});
