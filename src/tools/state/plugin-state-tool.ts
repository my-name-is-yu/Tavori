import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import type { PluginLoader } from "../../runtime/plugin-loader.js";

export const PluginStateToolInputSchema = z.object({
  pluginId: z.string().optional(),
});
export type PluginStateToolInput = z.infer<typeof PluginStateToolInputSchema>;

export class PluginStateTool implements ITool<PluginStateToolInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "get_plugins",
    aliases: ["plugin_state", "list_plugins"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 4000,
    tags: ["plugins", "self-knowledge"],
  };
  readonly inputSchema = PluginStateToolInputSchema;

  constructor(private readonly pluginLoader: PluginLoader) {}

  description(_context?: ToolDescriptionContext): string {
    return "List loaded PulSeed plugins and their status (name, type, enabled). Optionally filter by pluginId.";
  }

  async call(input: PluginStateToolInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const allStates = await this.pluginLoader.loadAll();
      const plugins = allStates.map((p) => ({
        name: p.name,
        type: p.manifest.type,
        enabled: p.status === "loaded",
        status: p.status,
      }));

      if (input.pluginId) {
        const match = plugins.find((p) => p.name === input.pluginId);
        if (!match) {
          return {
            success: false,
            data: null,
            summary: `Plugin not found: ${input.pluginId}`,
            error: `Plugin not found: ${input.pluginId}`,
            durationMs: Date.now() - startTime,
          };
        }
        return {
          success: true,
          data: match,
          summary: `Plugin ${match.name}: type=${match.type}, enabled=${String(match.enabled)}, status=${match.status}`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        success: true,
        data: { plugins },
        summary: `Found ${plugins.length} plugin(s)`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "PluginStateTool failed: " + (err as Error).message,
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
