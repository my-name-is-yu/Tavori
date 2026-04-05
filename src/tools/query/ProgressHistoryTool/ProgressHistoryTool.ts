import { z } from "zod";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { GapHistoryEntry } from "../../../base/types/gap.js";

export const ProgressHistoryInputSchema = z.object({
  goalId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(10),
  dimensionName: z.string().optional(),
});
export type ProgressHistoryInput = z.infer<typeof ProgressHistoryInputSchema>;

export type TrendLabel =
  | "improving"
  | "stagnating"
  | "declining"
  | "insufficient_data";

export interface HistoryDimensionSnapshot {
  name: string;
  value: number;
  confidence: number;
  gap: number;
}

export interface HistoryPoint {
  iteration: number;
  timestamp: string;
  dimensions: HistoryDimensionSnapshot[];
}

export interface ProgressHistoryOutput {
  goalId: string;
  history: HistoryPoint[];
  trend: TrendLabel;
}

/**
 * Compute trend from the last 3 gap values for the primary dimension.
 * Lower gap = better. Improving = gap decreasing consistently.
 */
function computeTrend(
  history: HistoryPoint[],
  dimensionName?: string
): TrendLabel {
  if (history.length < 3) return "insufficient_data";

  const last3 = history.slice(-3);

  const getGap = (point: HistoryPoint): number | null => {
    if (dimensionName) {
      const dim = point.dimensions.find((d) => d.name === dimensionName);
      return dim?.gap ?? null;
    }
    // Use average gap across all dimensions
    if (point.dimensions.length === 0) return null;
    const sum = point.dimensions.reduce((acc, d) => acc + d.gap, 0);
    return sum / point.dimensions.length;
  };

  const gaps = last3.map(getGap);
  if (gaps.some((g) => g === null)) return "insufficient_data";

  const [g0, g1, g2] = gaps as [number, number, number];

  const STAGNATE_THRESHOLD = 0.05;

  const diff1 = g1 - g0; // negative = improving
  const diff2 = g2 - g1; // negative = improving

  // Improving: both diffs consistently negative (gap shrinking)
  if (diff1 < -STAGNATE_THRESHOLD && diff2 < -STAGNATE_THRESHOLD) {
    return "improving";
  }

  // Declining: both diffs consistently positive (gap growing)
  if (diff1 > STAGNATE_THRESHOLD && diff2 > STAGNATE_THRESHOLD) {
    return "declining";
  }

  // Stagnating: changes within threshold
  if (
    Math.abs(diff1) <= STAGNATE_THRESHOLD &&
    Math.abs(diff2) <= STAGNATE_THRESHOLD
  ) {
    return "stagnating";
  }

  return "stagnating";
}

function entryToHistoryPoint(
  entry: GapHistoryEntry,
  dimensionName?: string
): HistoryPoint {
  let dims: HistoryDimensionSnapshot[];

  if (dimensionName) {
    const gapDim = entry.gap_vector.find(
      (g) => g.dimension_name === dimensionName
    );
    const confDim = entry.confidence_vector.find(
      (c) => c.dimension_name === dimensionName
    );
    if (gapDim) {
      dims = [
        {
          name: dimensionName,
          value: 1 - gapDim.normalized_weighted_gap, // approximate value as 1-gap
          confidence: confDim?.confidence ?? 0,
          gap: gapDim.normalized_weighted_gap,
        },
      ];
    } else {
      dims = [];
    }
  } else {
    dims = entry.gap_vector.map((g) => {
      const confDim = entry.confidence_vector.find(
        (c) => c.dimension_name === g.dimension_name
      );
      return {
        name: g.dimension_name,
        value: 1 - g.normalized_weighted_gap,
        confidence: confDim?.confidence ?? 0,
        gap: g.normalized_weighted_gap,
      };
    });
  }

  return {
    iteration: entry.iteration,
    timestamp: entry.timestamp,
    dimensions: dims,
  };
}

export class ProgressHistoryTool
  implements ITool<ProgressHistoryInput, ProgressHistoryOutput>
{
  readonly metadata: ToolMetadata = {
    name: "progress_history",
    aliases: ["get_progress", "observation_history"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = ProgressHistoryInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(
    input: ProgressHistoryInput,
    _context: ToolCallContext
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const rawHistory = await this.stateManager.loadGapHistory(input.goalId);
      const limited = rawHistory.slice(-input.limit);

      const history = limited.map((entry) =>
        entryToHistoryPoint(entry, input.dimensionName)
      );
      const trend = computeTrend(history, input.dimensionName);

      const output: ProgressHistoryOutput = {
        goalId: input.goalId,
        history,
        trend,
      };

      return {
        success: true,
        data: output,
        summary: `Progress history for goal "${input.goalId}": ${history.length} iterations, trend=${trend}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: { goalId: input.goalId, history: [], trend: "insufficient_data" },
        summary: `Progress history failed: ${(err as Error).message}`,
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
