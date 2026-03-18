import { ObservationLogEntrySchema } from "../types/state.js";
import type { ObservationLogEntry } from "../types/state.js";
import type { ObservationLayer } from "../types/core.js";
import type { StateManager } from "../state-manager.js";
import type { IDataSourceAdapter } from "./data-source-adapter.js";
import type { DataSourceQuery } from "../types/data-source.js";
import type { ObservationEngineOptions } from "./observation-helpers.js";
import { LAYER_PRIORITY, normalizeDimensionName } from "./observation-helpers.js";

/**
 * Apply a completed observation entry to the persisted goal state.
 *
 * - Enforces monotonic floor for "min" thresholds (prevents noise from hiding progress).
 * - Only updates confidence when the incoming layer has >= priority than existing.
 * - Appends to dimension history.
 * - Optionally indexes the dimension name in the vector index (fire-and-forget).
 */
export async function applyObservation(
  goalId: string,
  entry: ObservationLogEntry,
  stateManager: StateManager,
  options: ObservationEngineOptions
): Promise<void> {
  const goal = await stateManager.loadGoal(goalId);
  if (goal === null) {
    throw new Error(`applyObservation: goal "${goalId}" not found`);
  }

  const safeName = normalizeDimensionName(entry.dimension_name);
  const dimIndex = goal.dimensions.findIndex((d) => d.name === safeName);
  if (dimIndex === -1) {
    throw new Error(
      `applyObservation: dimension "${entry.dimension_name}" not found in goal "${goalId}"`
    );
  }

  const dim = goal.dimensions[dimIndex]!;

  // Monotonic floor for min thresholds: never decrease an observed value below the
  // current floor. This prevents noise from hiding real progress on "higher is better"
  // dimensions. Max thresholds are NOT clamped — regressions (e.g. bug count going up)
  // must remain visible.
  let effectiveValue = entry.extracted_value;
  if (typeof effectiveValue === 'number' && typeof dim.current_value === 'number') {
    // NOTE: range thresholds intentionally not clamped — progress direction is ambiguous.
    // Assumes earlier observations are reliable; no mechanism to override a false-high floor.
    if (
      dim.threshold.type === 'min' &&
      effectiveValue < dim.current_value &&
      entry.confidence < (dim.confidence ?? 0)
    ) {
      effectiveValue = dim.current_value;
    }
  }

  // Determine if the incoming observation should update the dimension's confidence.
  // Only allow confidence updates from an equal or higher-priority layer.
  // This prevents a low-layer self_report from downgrading confidence that was
  // established by a mechanical or independent_review observation.
  const existingTier = dim.observation_method.confidence_tier as ObservationLayer;
  const existingPriority = LAYER_PRIORITY[existingTier] ?? 0;
  const incomingPriority = LAYER_PRIORITY[entry.layer] ?? 0;
  const shouldUpdateConfidence = incomingPriority >= existingPriority;

  // Update dimension values
  const updatedDim = {
    ...dim,
    current_value: effectiveValue,
    confidence: shouldUpdateConfidence ? entry.confidence : dim.confidence,
    last_updated: entry.timestamp,
    history: [
      ...dim.history,
      {
        value: entry.extracted_value,
        timestamp: entry.timestamp,
        confidence: entry.confidence,
        source_observation_id: entry.observation_id,
      },
    ],
  };

  const updatedDimensions = [...goal.dimensions];
  updatedDimensions[dimIndex] = updatedDim;

  const updatedGoal = {
    ...goal,
    dimensions: updatedDimensions,
    updated_at: new Date().toISOString(),
  };

  // Persist observation entry
  await stateManager.appendObservation(goalId, entry);

  // Persist updated goal
  await stateManager.saveGoal(updatedGoal);

  // Index dimension name for semantic search (fire-and-forget, non-blocking)
  if (options.vectorIndex) {
    const vi = options.vectorIndex;
    vi.add(`dim:${goalId}:${entry.dimension_name}`, entry.dimension_name, {
      goal_id: goalId,
      type: "dimension",
    }).catch(() => { /* non-fatal */ });
  }
}

/**
 * Observe a goal dimension by querying a registered data source.
 */
export async function observeFromDataSource(
  goalId: string,
  dimensionName: string,
  sourceId: string,
  dataSources: IDataSourceAdapter[],
  applyFn: (goalId: string, entry: ObservationLogEntry) => void
): Promise<ObservationLogEntry> {
  const source = dataSources.find((s) => s.sourceId === sourceId);
  if (!source) {
    throw new Error(
      `observeFromDataSource: data source "${sourceId}" not found. ` +
        `Available: [${dataSources.map((s) => s.sourceId).join(", ")}]`
    );
  }

  const query: DataSourceQuery = {
    dimension_name: dimensionName,
    timeout_ms: 10000,
  };

  const expression = source.config.dimension_mapping?.[dimensionName];
  if (expression !== undefined) {
    query.expression = expression;
  }

  const result = await source.query(query);

  let extractedValue: number | string | boolean | null;
  if (typeof result.value === "number") {
    extractedValue = result.value;
  } else if (typeof result.value === "string") {
    const parsed = parseFloat(result.value);
    extractedValue = isNaN(parsed) ? result.value : parsed;
  } else if (typeof result.value === "boolean" || result.value === null) {
    extractedValue = result.value;
  } else {
    extractedValue = 0;
  }

  if (extractedValue === null || extractedValue === undefined) {
    throw new Error(
      `Data source "${sourceId}" returned null for dimension "${dimensionName}"`
    );
  }

  const entry = ObservationLogEntrySchema.parse({
    observation_id: crypto.randomUUID(),
    timestamp: result.timestamp,
    trigger: "periodic",
    goal_id: goalId,
    dimension_name: dimensionName,
    layer: "mechanical",
    method: {
      type: "mechanical",
      source: "data_source",
      schedule: null,
      endpoint: sourceId,
      confidence_tier: "mechanical",
    },
    raw_result: result.raw,
    extracted_value: extractedValue,
    confidence: 0.90,
    notes: `Data source: ${sourceId}`,
  });

  applyFn(goalId, entry);

  return entry;
}
