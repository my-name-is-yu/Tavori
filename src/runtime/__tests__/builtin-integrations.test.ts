import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_INTEGRATIONS, listBuiltinIntegrations } from "../builtin-integrations.js";

const originalPulseedHome = process.env["PULSEED_HOME"];

async function withTempPulseedHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-builtin-integrations-"));
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

describe("builtin integrations", () => {
  it("exposes the Soil, MCP, foreign plugin, and automation builtin descriptors", () => {
    expect(BUILTIN_INTEGRATIONS.map((integration) => integration.id)).toEqual([
      "soil-display",
      "mcp-bridge",
      "foreign-plugin-bridge",
      "interactive-automation",
    ]);
    expect(BUILTIN_INTEGRATIONS.every((integration) => integration.source === "builtin")).toBe(true);
    expect(BUILTIN_INTEGRATIONS.every((integration) => integration.capabilities.length > 0)).toBe(true);
  });

  it("reports interactive automation as disabled by default", async () => {
    await withTempPulseedHome(async () => {
      const listed = listBuiltinIntegrations();
      expect(listed.find((integration) => integration.id === "interactive-automation")?.status).toBe("disabled");
    });
  });

  it("reports interactive automation as available when enabled in config", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
          },
        }),
        "utf8",
      );

      const listed = listBuiltinIntegrations();
      expect(listed.find((integration) => integration.id === "interactive-automation")?.status).toBe("available");
    });
  });
});
