// Tool-based observation support for ObservationEngine
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { ToolPermissionManager } from "../../tools/permission.js";
import type { Dimension } from "../../orchestrator/goal/types/goal.js";
import { parseToolOutput } from "../../tools/shared/parse-tool-output.js";

export interface ToolObservationResult {
  rawData: unknown;
  parsedValue: number | string | boolean | null;
  confidence: number;
  toolName: string;
  durationMs: number;
}

/**
 * Observe a dimension using the tool executor.
 * Routes to the appropriate tool based on observation_method.type.
 * Returns null if the method is unsupported or the tool call fails.
 */
export async function observeWithTools(
  toolExecutor: ToolExecutor,
  dimension: Dimension,
  context: ToolCallContext,
): Promise<ToolObservationResult | null> {
  const method = dimension.observation_method;
  if (!method || !method.endpoint) return null;

  try {
    switch (method.type) {
      case "file_check": {
        const result = await toolExecutor.execute("glob", { pattern: method.endpoint }, context);
        if (!result.success) return null;
        const files = result.data as string[];
        return { rawData: files, parsedValue: files.length > 0 ? 1 : 0, confidence: 0.98, toolName: "glob", durationMs: result.durationMs };
      }
      case "mechanical": {
        const result = await toolExecutor.execute("shell", { command: method.endpoint, timeoutMs: 30_000 }, context);
        if (!result.success) return null;
        const parsedMech = parseToolOutput("shell", result.data);
        return { rawData: result.data, parsedValue: parsedMech.value, confidence: 0.95, toolName: "shell", durationMs: result.durationMs };
      }
      case "api_query": {
        const result = await toolExecutor.execute("http_fetch", { url: method.endpoint, method: "GET" }, context);
        if (!result.success) return null;
        const parsedApi = parseToolOutput("http_fetch", result.data);
        return { rawData: result.data, parsedValue: parsedApi.value, confidence: 0.90, toolName: "http_fetch", durationMs: result.durationMs };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Register shell allow rules in the permission manager for all mechanical dimensions.
 */
export function registerObservationAllowRules(
  permissionManager: ToolPermissionManager,
  dimensions: Dimension[],
): void {
  for (const dim of dimensions) {
    const method = dim.observation_method;
    if (method?.type === "mechanical" && method.endpoint) {
      const allowedCommand = method.endpoint;
      permissionManager.addAllowRule({
        toolName: "shell",
        inputMatcher: (input) => {
          const cmd = (input as { command: string }).command;
          return cmd === allowedCommand;
        },
        reason: `Observation command for dimension "${dim.name}"`,
      });
    }
  }
}
