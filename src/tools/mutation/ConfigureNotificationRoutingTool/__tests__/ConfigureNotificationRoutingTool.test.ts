import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigureNotificationRoutingTool } from "../ConfigureNotificationRoutingTool.js";
import type { ToolCallContext } from "../../../types.js";

vi.mock("../../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../base/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-routing-tool-placeholder"),
  };
});

import { getPulseedDirPath } from "../../../../base/utils/paths.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: true,
    approvalFn: async () => true,
  };
}

describe("ConfigureNotificationRoutingTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-routing-tool-"));
    vi.mocked(getPulseedDirPath).mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes plugin notifier routing from a natural language instruction", async () => {
    const tool = new ConfigureNotificationRoutingTool();

    const result = await tool.call(
      { instruction: "週次レポートはDiscordだけに送って" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "notification.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(config["plugin_notifiers"]).toEqual({
      mode: "only",
      routes: [
        {
          id: "discord-bot",
          enabled: true,
          report_types: ["weekly_report"],
        },
      ],
    });
  });

  it("requires approval when not pre-approved", async () => {
    const tool = new ConfigureNotificationRoutingTool();

    await expect(
      tool.checkPermissions({ instruction: "Discordだけ" }, { ...makeContext(), preApproved: false })
    ).resolves.toMatchObject({ status: "needs_approval" });
  });
});
