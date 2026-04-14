import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";

describe("signal-bridge config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("loads the required config fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        bridge_url: "http://127.0.0.1:7583",
        account: "+15551234567",
        recipient_id: "+15557654321",
        identity_key: "signal:alpha",
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.poll_interval_ms).toBe(5000);
    expect(cfg.receive_timeout_ms).toBe(2000);
    expect(cfg.runtime_control_allowed_sender_ids).toEqual([]);
  });

  it("loads runtime control sender allowlist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        bridge_url: "http://127.0.0.1:7583",
        account: "+15551234567",
        recipient_id: "+15557654321",
        identity_key: "signal:alpha",
        runtime_control_allowed_sender_ids: ["+15557654321"],
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.runtime_control_allowed_sender_ids).toEqual(["+15557654321"]);
  });

  it("loads channel security and routing config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        bridge_url: "http://127.0.0.1:7583",
        account: "+15551234567",
        recipient_id: "+15557654321",
        identity_key: "signal:alpha",
        allowed_sender_ids: ["+15557654321"],
        denied_conversation_ids: ["group-deny"],
        conversation_goal_map: { "group-1": "goal-1" },
        sender_goal_map: { "+15557654321": "goal-user" },
        default_goal_id: "goal-default",
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.allowed_sender_ids).toEqual(["+15557654321"]);
    expect(cfg.denied_conversation_ids).toEqual(["group-deny"]);
    expect(cfg.conversation_goal_map).toEqual({ "group-1": "goal-1" });
    expect(cfg.sender_goal_map).toEqual({ "+15557654321": "goal-user" });
    expect(cfg.default_goal_id).toBe("goal-default");
  });

  it("rejects invalid runtime control sender allowlist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        bridge_url: "http://127.0.0.1:7583",
        account: "+15551234567",
        recipient_id: "+15557654321",
        identity_key: "signal:alpha",
        runtime_control_allowed_sender_ids: [123],
      }),
      "utf-8"
    );

    expect(() => loadConfig(tmpDir)).toThrow("runtime_control_allowed_sender_ids");
  });

  it("requires account", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        bridge_url: "http://127.0.0.1:7583",
        recipient_id: "+15557654321",
        identity_key: "signal:alpha",
      }),
      "utf-8"
    );

    expect(() => loadConfig(tmpDir)).toThrow("account");
  });
});
