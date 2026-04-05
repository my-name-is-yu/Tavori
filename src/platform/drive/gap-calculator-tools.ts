import type { Dimension } from "../../base/types/goal.js";
import type { ToolCallContext, ToolResult } from "../../tools/types.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { parseToolOutput as parseRawToolOutput } from "../../tools/shared/parse-tool-output.js";

/**
 * Direct measurement result from a tool call.
 * Used by GapCalculator to refresh stale dimension values.
 */
export interface DirectMeasurement {
  value: number | string | boolean;
  confidence: number;
  measuredAt: Date;
  toolUsed: string;
}

/**
 * Staleness threshold: trigger direct measurement when confidence is below this.
 */
const STALENESS_THRESHOLD = 0.6;

/**
 * Check if a dimension needs fresh measurement.
 * Returns true when confidence is low (stale or uncertain data).
 */
export function needsDirectMeasurement(dimension: Dimension): boolean {
  return dimension.confidence < STALENESS_THRESHOLD;
}

/**
 * Attempt direct measurement of a dimension's current value using tools.
 * Returns null if:
 *   - The dimension does not have a tool-compatible observation method.
 *   - The tool call fails.
 *
 * Compatible observation method types: "file_check", "mechanical", "api_query"
 * Each maps to a tool: glob, shell, http_fetch respectively.
 */
export async function measureDirectly(
  dimension: Dimension,
  toolExecutor: ToolExecutor,
  context: ToolCallContext,
): Promise<DirectMeasurement | null> {
  const method = dimension.observation_method;
  if (!method?.endpoint) return null;

  const toolName = resolveToolName(method.type);
  if (!toolName) return null;

  const input = buildToolInput(method.type, method.endpoint);
  const result = await toolExecutor.execute(toolName, input, context);

  if (!result.success) return null;

  return {
    value: parseToolOutput(toolName, result),
    confidence: confidenceForTool(toolName),
    measuredAt: new Date(),
    toolUsed: toolName,
  };
}

// ─── Helpers ───

function resolveToolName(
  methodType: string,
): "glob" | "shell" | "http_fetch" | null {
  switch (methodType) {
    case "file_check": return "glob";
    case "mechanical":  return "shell";
    case "api_query":   return "http_fetch";
    default:            return null;
  }
}

function buildToolInput(
  methodType: string,
  endpoint: string,
): Record<string, unknown> {
  switch (methodType) {
    case "file_check": return { pattern: endpoint };
    case "mechanical": return { command: endpoint, timeoutMs: 30_000 };
    case "api_query":  return { url: endpoint, method: "GET" };
    default:           return {};
  }
}

function confidenceForTool(toolName: string): number {
  switch (toolName) {
    case "glob":       return 0.98;
    case "shell":      return 0.95;
    case "http_fetch": return 0.90;
    default:           return 0.85;
  }
}

/**
 * Parse tool output into a scalar value suitable for gap calculation.
 * Delegates to shared parseRawToolOutput utility.
 */
function parseToolOutput(
  toolName: string,
  result: ToolResult,
): number | string | boolean {
  const parsed = parseRawToolOutput(toolName, result.data);
  if (parsed.value === null) return "";
  return parsed.value;
}
