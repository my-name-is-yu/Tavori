// ─── Global Config ───
//
// Manages ~/.pulseed/config.json — single source for all PulSeed user preferences.

import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getPulseedDirPath } from "../utils/paths.js";

const GlobalConfigSchema = z.object({
  daemon_mode: z.boolean().default(false),
  no_flicker: z.boolean().default(true),
  interactive_automation: z.object({
    enabled: z.boolean().default(false),
    default_desktop_provider: z.string().default("codex_app"),
    default_browser_provider: z.string().default("manus_browser"),
    default_research_provider: z.string().default("perplexity_research"),
    require_approval: z.enum(["always", "write", "destructive"]).default("always"),
    allowed_apps: z.array(z.string()).default([]),
    denied_apps: z.array(z.string()).default([
      "Password Manager",
      "Banking",
      "System Settings",
    ]),
  }).default({}),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

const DEFAULT_CONFIG: GlobalConfig = {
  daemon_mode: false,
  no_flicker: true,
  interactive_automation: {
    enabled: false,
    default_desktop_provider: "codex_app",
    default_browser_provider: "manus_browser",
    default_research_provider: "perplexity_research",
    require_approval: "always",
    allowed_apps: [],
    denied_apps: [
      "Password Manager",
      "Banking",
      "System Settings",
    ],
  },
};

function getConfigPath(): string {
  return path.join(getPulseedDirPath(), "config.json");
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return GlobalConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function loadGlobalConfigSync(): GlobalConfig {
  try {
    const raw = fsSync.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return GlobalConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export async function updateGlobalConfig(updates: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const current = await loadGlobalConfig();
  const updated = GlobalConfigSchema.parse({ ...current, ...updates });
  await saveGlobalConfig(updated);
  return updated;
}

export function getConfigKeys(): string[] {
  return Object.keys(DEFAULT_CONFIG);
}

export { GlobalConfigSchema, DEFAULT_CONFIG };
