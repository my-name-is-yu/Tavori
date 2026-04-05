import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";

export const ConfigToolInputSchema = z.object({
  key: z.string().optional(),
});
export type ConfigToolInput = z.infer<typeof ConfigToolInputSchema>;

interface ProviderConfig {
  provider?: unknown;
  model?: unknown;
  default_adapter?: unknown;
  pulseed_home_dir?: unknown;
  [key: string]: unknown;
}

export class ConfigTool implements ITool<ConfigToolInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "get_config",
    aliases: ["config", "read_config"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: ["config", "self-knowledge"],
  };
  readonly inputSchema = ConfigToolInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return "Read PulSeed runtime configuration (provider, model, default_adapter, home directory). Optionally filter by a specific config key.";
  }

  async call(input: ConfigToolInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const homeDir = process.env["HOME"] ?? "/tmp";
      const providerPath = path.join(homeDir, ".pulseed", "provider.json");
      const defaults: ProviderConfig = {
        provider: "unknown",
        model: "unknown",
        default_adapter: "claude-code-cli",
        pulseed_home_dir: path.join(homeDir, ".pulseed"),
      };
      let config: ProviderConfig = { ...defaults };
      if (fs.existsSync(providerPath)) {
        try {
          const raw = fs.readFileSync(providerPath, "utf-8");
          const parsed = JSON.parse(raw) as ProviderConfig;
          config = {
            provider: parsed["provider"] ?? defaults.provider,
            model: parsed["model"] ?? defaults.model,
            default_adapter: parsed["default_adapter"] ?? defaults.default_adapter,
            pulseed_home_dir: defaults.pulseed_home_dir,
          };
        } catch {
          // use defaults on parse failure
        }
      }
      if (input.key) {
        const value = config[input.key];
        const data = { key: input.key, value: value ?? null };
        return {
          success: true,
          data,
          summary: value !== undefined
            ? `Config ${input.key}=${String(value)}`
            : `Config key ${input.key} not found`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: config,
        summary: `Config: provider=${String(config.provider)}, model=${String(config.model)}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ConfigTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
