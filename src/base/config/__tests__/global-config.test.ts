import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const originalPulseedHome = process.env["PULSEED_HOME"];

async function withTempPulseedHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-config-"));
  process.env["PULSEED_HOME"] = tmpDir;
  try {
    return await run(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (originalPulseedHome === undefined) {
    delete process.env["PULSEED_HOME"];
  } else {
    process.env["PULSEED_HOME"] = originalPulseedHome;
  }
});

describe("loadGlobalConfig", () => {
  it("defaults no_flicker to true when config file is absent", async () => {
    await withTempPulseedHome(async () => {
      const { loadGlobalConfig } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({
        daemon_mode: false,
        no_flicker: true,
        interactive_automation: {
          enabled: false,
          default_desktop_provider: "codex_app",
          default_browser_provider: "manus_browser",
          default_research_provider: "perplexity_research",
          require_approval: "always",
        },
      });
    });
  });

  it("preserves an explicit false no_flicker setting from config.json", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ no_flicker: false }, null, 2),
        "utf8",
      );

      const { loadGlobalConfig } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({
        daemon_mode: false,
        no_flicker: false,
        interactive_automation: {
          enabled: false,
        },
      });
    });
  });

  it("preserves interactive automation settings from config.json", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            default_desktop_provider: "codex_app",
            require_approval: "write",
            denied_apps: ["Bank"],
          },
        }, null, 2),
        "utf8",
      );

      const { getConfigKeys, loadGlobalConfig } = await import("../global-config.js");
      await expect(loadGlobalConfig()).resolves.toMatchObject({
        interactive_automation: {
          enabled: true,
          default_desktop_provider: "codex_app",
          default_browser_provider: "manus_browser",
          default_research_provider: "perplexity_research",
          require_approval: "write",
          denied_apps: ["Bank"],
        },
      });
      expect(getConfigKeys()).toContain("interactive_automation");
    });
  });

  it("loads interactive automation settings synchronously for tool registration", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            denied_apps: ["Protected App"],
          },
        }, null, 2),
        "utf8",
      );

      const { loadGlobalConfigSync } = await import("../global-config.js");
      expect(loadGlobalConfigSync()).toMatchObject({
        interactive_automation: {
          enabled: true,
          denied_apps: ["Protected App"],
        },
      });
    });
  });
});
