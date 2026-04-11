import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationConfigSchema } from "../../base/types/notification.js";
import {
  applyNaturalLanguageNotificationRouting,
  applyNaturalLanguageNotificationRoutingToConfig,
} from "../notification-routing.js";

describe("notification routing natural language updates", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes weekly reports only to Discord from a natural language instruction", () => {
    const config = NotificationConfigSchema.parse({});

    const update = applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "週次レポートはDiscordだけに送って"
    );

    expect(update.config.plugin_notifiers.mode).toBe("only");
    expect(update.config.plugin_notifiers.routes).toEqual([
      {
        id: "discord-bot",
        enabled: true,
        report_types: ["weekly_report"],
      },
    ]);
  });

  it("disables one notifier while leaving plugin routing in all mode", () => {
    const config = NotificationConfigSchema.parse({});

    const update = applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "WhatsAppには通知を送らない"
    );

    expect(update.config.plugin_notifiers.mode).toBe("all");
    expect(update.config.plugin_notifiers.routes).toEqual([
      {
        id: "whatsapp-webhook",
        enabled: false,
        report_types: [],
      },
    ]);
  });

  it("can disable all plugin notifier delivery", () => {
    const config = NotificationConfigSchema.parse({});

    const update = applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "プラグイン通知は全部止めて"
    );

    expect(update.config.plugin_notifiers.mode).toBe("none");
  });

  it("does not overwrite an invalid notification config when applying a route", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-routing-invalid-"));
    tmpDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "notification.json");
    const invalidJson = JSON.stringify({ channels: [{ type: "webhook", url: "not-a-url" }] });
    fs.writeFileSync(configPath, invalidJson, "utf-8");

    await expect(
      applyNaturalLanguageNotificationRouting("Discordだけ", configPath)
    ).rejects.toThrow(/Invalid notification config/);

    expect(fs.readFileSync(configPath, "utf-8")).toBe(invalidJson);
  });
});
