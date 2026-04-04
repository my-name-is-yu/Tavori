import type { Goal } from "../../base/types/goal.js";

// ─── Types ───

export interface StateDiffThresholds {
  /** Absolute change in normalized value that counts as meaningful. Default: 0.05 */
  value_delta: number;
  /** Absolute change in confidence that counts as meaningful. Default: 0.10 */
  confidence_delta: number;
  /** Whether a change in observation layer counts as meaningful. Default: true */
  layer_change: boolean;
}

export interface IterationSnapshot {
  iteration: number;
  timestamp: string;
  dimensions: Record<
    string,
    {
      current_value: number;
      confidence: number;
      observation_layer: string;
    }
  >;
}

export interface StateDiffResult {
  hasChange: boolean;
  /** Names of dimensions that changed */
  changedDimensions: string[];
  /** Human-readable explanation */
  reason?: string;
}

// ─── Defaults ───

const DEFAULT_THRESHOLDS: StateDiffThresholds = {
  value_delta: 0.05,
  confidence_delta: 0.10,
  layer_change: true,
};

// ─── StateDiffCalculator ───

export class StateDiffCalculator {
  private readonly thresholds: StateDiffThresholds;

  constructor(thresholds?: Partial<StateDiffThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Build a snapshot from the current goal state.
   * current_value is coerced to a number (non-numeric values become 0).
   */
  buildSnapshot(goal: Goal, iteration: number): IterationSnapshot {
    const dimensions: IterationSnapshot["dimensions"] = {};

    for (const dim of goal.dimensions) {
      const rawValue = dim.current_value;
      const numericValue =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "boolean"
          ? rawValue
            ? 1
            : 0
          : 0;

      dimensions[dim.name] = {
        current_value: numericValue,
        confidence: dim.confidence,
        observation_layer: dim.last_observed_layer ?? "self_report",
      };
    }

    return {
      iteration,
      timestamp: new Date().toISOString(),
      dimensions,
    };
  }

  /**
   * Compare two snapshots. Returns hasChange=true if any dimension changed
   * meaningfully per the configured thresholds. When previous is null (first
   * iteration) always returns hasChange=true.
   */
  compare(
    previous: IterationSnapshot | null,
    current: IterationSnapshot
  ): StateDiffResult {
    if (previous === null) {
      return { hasChange: true, changedDimensions: [], reason: "first iteration" };
    }

    const changedDimensions: string[] = [];

    for (const [name, curr] of Object.entries(current.dimensions)) {
      const prev = previous.dimensions[name];

      // Dimension is new (not present in previous snapshot) — treat as changed
      if (!prev) {
        changedDimensions.push(name);
        continue;
      }

      const valueDelta = Math.abs(curr.current_value - prev.current_value);
      const confidenceDelta = Math.abs(curr.confidence - prev.confidence);
      const layerChanged = curr.observation_layer !== prev.observation_layer;

      if (
        valueDelta >= this.thresholds.value_delta ||
        confidenceDelta >= this.thresholds.confidence_delta ||
        (this.thresholds.layer_change && layerChanged)
      ) {
        changedDimensions.push(name);
      }
    }

    // Reverse check: dimensions present in previous but absent in current
    for (const name of Object.keys(previous.dimensions)) {
      if (!(name in current.dimensions)) {
        changedDimensions.push(name);
      }
    }

    if (changedDimensions.length > 0) {
      return {
        hasChange: true,
        changedDimensions,
        reason: `changed dimensions: ${changedDimensions.join(", ")}`,
      };
    }

    return {
      hasChange: false,
      changedDimensions: [],
      reason: "no meaningful change across all dimensions",
    };
  }
}
