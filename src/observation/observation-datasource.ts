import { ObservationLogEntrySchema } from "../types/state.js";
import type { ObservationLogEntry } from "../types/state.js";
import type { IDataSourceAdapter } from "./data-source-adapter.js";
import type { DataSourceQuery } from "../types/data-source.js";

/**
 * Find the first DataSource adapter that can serve the given dimension name.
 * Checks both getSupportedDimensions() and dimension_mapping config keys.
 * Returns null if no adapter matches.
 */
export function findDataSourceForDimension(
  dataSources: IDataSourceAdapter[],
  dimensionName: string,
  goalId?: string
): IDataSourceAdapter | null {
  const matches = (ds: IDataSourceAdapter): boolean => {
    const dims = ds.getSupportedDimensions?.() ?? [];
    if (dims.includes(dimensionName)) return true;
    if (ds.config?.dimension_mapping && dimensionName in ds.config.dimension_mapping) return true;
    return false;
  };

  // First pass: prefer a datasource explicitly scoped to this goalId
  for (const ds of dataSources) {
    const scopeGoalId = ds.config?.scope_goal_id as string | undefined;
    if (scopeGoalId === goalId && goalId !== undefined && matches(ds)) return ds;
  }

  // Second pass: fall back to an unscoped datasource
  for (const ds of dataSources) {
    const scopeGoalId = ds.config?.scope_goal_id as string | undefined;
    if (scopeGoalId === undefined && matches(ds)) return ds;
  }

  return null;
}

/**
 * Observe a goal dimension by querying a registered data source.
 *
 * Steps:
 *   1. Find the data source by sourceId.
 *   2. Build a DataSourceQuery, using dimension_mapping if configured.
 *   3. Call source.query().
 *   4. Convert result value to numeric if possible.
 *   5. Create and persist an ObservationLogEntry via applyObservation callback.
 *   6. Return the entry.
 */
export async function observeFromDataSource(
  dataSources: IDataSourceAdapter[],
  goalId: string,
  dimensionName: string,
  sourceId: string,
  applyObservation: (goalId: string, entry: ObservationLogEntry) => void
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

  await applyObservation(goalId, entry);

  return entry;
}
