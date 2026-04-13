import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";

describe("whatsapp-webhook config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("loads the required config fields", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        phone_number_id: "phone-1",
        access_token: "token-1",
        verify_token: "verify-1",
        recipient_id: "15551234567",
        identity_key: "whatsapp:alpha",
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.path).toBe("/webhook");
    expect(cfg.port).toBe(8788);
    expect(cfg.runtime_control_allowed_sender_ids).toEqual([]);
  });

  it("loads runtime control sender allowlist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        phone_number_id: "phone-1",
        access_token: "token-1",
        verify_token: "verify-1",
        recipient_id: "15551234567",
        identity_key: "whatsapp:alpha",
        runtime_control_allowed_sender_ids: ["15557654321"],
      }),
      "utf-8"
    );

    const cfg = loadConfig(tmpDir);
    expect(cfg.runtime_control_allowed_sender_ids).toEqual(["15557654321"]);
  });

  it("rejects invalid runtime control sender allowlist", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        phone_number_id: "phone-1",
        access_token: "token-1",
        verify_token: "verify-1",
        recipient_id: "15551234567",
        identity_key: "whatsapp:alpha",
        runtime_control_allowed_sender_ids: [123],
      }),
      "utf-8"
    );

    expect(() => loadConfig(tmpDir)).toThrow("runtime_control_allowed_sender_ids");
  });

  it("requires verify_token", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        phone_number_id: "phone-1",
        access_token: "token-1",
        recipient_id: "15551234567",
        identity_key: "whatsapp:alpha",
      }),
      "utf-8"
    );

    expect(() => loadConfig(tmpDir)).toThrow("verify_token");
  });
});
