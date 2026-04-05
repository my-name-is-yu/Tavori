import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";

export const EnvInputSchema = z.object({
  query: z.enum(["node_version", "platform", "env_var", "cwd", "memory", "uptime"]).default("platform"),
  varName: z.string().optional(),
});
export type EnvInput = z.infer<typeof EnvInputSchema>;

export interface EnvOutput {
  query: string;
  result: unknown;
}

const SENSITIVE_PATTERNS = ["KEY", "SECRET", "TOKEN", "PASSWORD"];

function isSensitive(varName: string): boolean {
  const upper = varName.toUpperCase();
  return SENSITIVE_PATTERNS.some((p) => upper.includes(p));
}

export class EnvTool implements ITool<EnvInput, EnvOutput> {
  readonly metadata: ToolMetadata = {
    name: "env_info",
    aliases: ["env", "environment"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 10,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = EnvInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: EnvInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      let result: unknown;

      switch (input.query) {
        case "node_version":
          result = process.version;
          break;

        case "platform":
          result = {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
          };
          break;

        case "env_var": {
          const varName = input.varName ?? "";
          if (!varName) {
            return {
              success: false,
              data: { query: input.query, result: null },
              summary: "varName is required for env_var query",
              error: "varName is required when query is 'env_var'",
              durationMs: Date.now() - startTime,
            };
          }
          if (isSensitive(varName)) {
            return {
              success: false,
              data: { query: input.query, result: null },
              summary: `Refused: '${varName}' looks like a sensitive variable`,
              error: `Access to sensitive environment variable '${varName}' is not allowed`,
              durationMs: Date.now() - startTime,
            };
          }
          result = process.env[varName];
          break;
        }

        case "cwd":
          result = context.cwd || process.cwd();
          break;

        case "memory": {
          const raw = process.memoryUsage();
          result = {
            rss: +(raw.rss / 1024 / 1024).toFixed(2),
            heapTotal: +(raw.heapTotal / 1024 / 1024).toFixed(2),
            heapUsed: +(raw.heapUsed / 1024 / 1024).toFixed(2),
            external: +(raw.external / 1024 / 1024).toFixed(2),
            unit: "MB",
          };
          break;
        }

        case "uptime": {
          const seconds = process.uptime();
          result = {
            seconds: +seconds.toFixed(2),
            formatted: formatUptime(seconds),
          };
          break;
        }

        default:
          result = null;
      }

      const output: EnvOutput = { query: input.query, result };
      const summaryData = input.query === "env_var"
        ? `${input.varName}=[present]`
        : JSON.stringify(result).slice(0, 100);
      return {
        success: true,
        data: output,
        summary: `env_info(${input.query}) -> ${summaryData}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { query: input.query, result: null },
        summary: `env_info failed: ${(err as Error).message}`,
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

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}
