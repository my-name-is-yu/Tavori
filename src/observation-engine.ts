import { z } from "zod";
import { ObservationLogEntrySchema, ObservationLogSchema } from "./types/state.js";
import type { ObservationLogEntry, ObservationLog } from "./types/state.js";
import type { ObservationLayer, ObservationMethod, ObservationTrigger, ConfidenceTier } from "./types/core.js";
import type { StateManager } from "./state-manager.js";
import { KnowledgeGapSignalSchema } from "./types/knowledge.js";
import type { KnowledgeGapSignal } from "./types/knowledge.js";
import type { IDataSourceAdapter } from "./data-source-adapter.js";
import type { DataSourceQuery } from "./types/data-source.js";
import type { ILLMClient } from "./llm-client.js";

// ─── Layer Configuration ───

interface LayerConfig {
  ceiling: number;
  tier: ConfidenceTier;
  range: [number, number];
}

const LAYER_CONFIG: Record<ObservationLayer, LayerConfig> = {
  mechanical: {
    ceiling: 1.0,
    tier: "mechanical",
    range: [0.85, 1.0],
  },
  independent_review: {
    ceiling: 0.90,
    tier: "independent_review",
    range: [0.50, 0.84],
  },
  self_report: {
    ceiling: 0.70,
    tier: "self_report",
    range: [0.10, 0.49],
  },
};

// ─── Layer Priority ───

const LAYER_PRIORITY: Record<ObservationLayer, number> = {
  mechanical: 3,
  independent_review: 2,
  self_report: 1,
};

// Zod schema for LLM observation response
const LLMObservationResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});

/**
 * ObservationEngine handles the 3-layer observation architecture.
 *
 * Layers (in descending trust order):
 *   mechanical         — confidence [0.85, 1.0],  progress ceiling 1.00
 *   independent_review — confidence [0.50, 0.84], progress ceiling 0.90
 *   self_report        — confidence [0.10, 0.49], progress ceiling 0.70
 *
 * Observation logs are persisted via StateManager.appendObservation.
 * Goal state updates are persisted via StateManager.saveGoal.
 */
export class ObservationEngine {
  private readonly stateManager: StateManager;
  private readonly dataSources: IDataSourceAdapter[];
  private readonly llmClient?: ILLMClient;
  private readonly contextProvider?: () => Promise<string>;

  constructor(
    stateManager: StateManager,
    dataSources: IDataSourceAdapter[] = [],
    llmClient?: ILLMClient,
    contextProvider?: () => Promise<string>
  ) {
    this.stateManager = stateManager;
    this.dataSources = dataSources;
    this.llmClient = llmClient;
    this.contextProvider = contextProvider;
  }

  // ─── Progress Ceiling ───

  /**
   * Apply progress ceiling based on observation layer.
   * Returns min(progress, ceiling).
   */
  applyProgressCeiling(progress: number, layer: ObservationLayer): number {
    const config = LAYER_CONFIG[layer];
    return Math.min(progress, config.ceiling);
  }

  // ─── Confidence Tier ───

  /**
   * Return the ConfidenceTier and valid confidence range for a given layer.
   */
  getConfidenceTier(layer: ObservationLayer): { tier: ConfidenceTier; range: [number, number] } {
    const config = LAYER_CONFIG[layer];
    return { tier: config.tier, range: config.range };
  }

  // ─── Create Observation Entry ───

  /**
   * Construct a new ObservationLogEntry.
   * Confidence is clamped to the layer's valid range.
   */
  createObservationEntry(params: {
    goalId: string;
    dimensionName: string;
    layer: ObservationLayer;
    method: ObservationMethod;
    trigger: ObservationTrigger;
    rawResult: unknown;
    extractedValue: number | string | boolean | null;
    confidence: number;
    notes?: string;
  }): ObservationLogEntry {
    const config = LAYER_CONFIG[params.layer];
    const [minConf, maxConf] = config.range;
    const clampedConfidence = Math.min(maxConf, Math.max(minConf, params.confidence));

    const entry = ObservationLogEntrySchema.parse({
      observation_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      trigger: params.trigger,
      goal_id: params.goalId,
      dimension_name: params.dimensionName,
      layer: params.layer,
      method: params.method,
      raw_result: params.rawResult,
      extracted_value: params.extractedValue,
      confidence: clampedConfidence,
      notes: params.notes ?? null,
    });

    return entry;
  }

  // ─── Evidence Gate ───

  /**
   * Returns true when effective progress meets the threshold but confidence
   * is below 0.85, meaning a mechanical verification task should be generated.
   */
  needsVerificationTask(effectiveProgress: number, confidence: number, threshold: number): boolean {
    return effectiveProgress >= threshold && confidence < 0.85;
  }

  // ─── Contradiction Resolution ───

  /**
   * Resolve contradictions among multiple observation entries.
   *
   * Resolution rules:
   *   1. Higher-priority layer wins (mechanical > independent_review > self_report).
   *   2. Within the same layer, take the pessimistic (lower) numeric value.
   *   3. For non-numeric values, take the first entry in the winning layer.
   *
   * Returns the single "winning" entry.
   * Throws if entries array is empty.
   */
  resolveContradiction(entries: ObservationLogEntry[]): ObservationLogEntry {
    if (entries.length === 0) {
      throw new Error("resolveContradiction: entries array must not be empty");
    }
    if (entries.length === 1) {
      return entries[0]!;
    }

    // Find highest priority layer present
    let maxPriority = -1;
    for (const entry of entries) {
      const priority = LAYER_PRIORITY[entry.layer];
      if (priority > maxPriority) {
        maxPriority = priority;
      }
    }

    // Collect all entries at the winning layer
    const winningLayer = entries.filter(
      (e) => LAYER_PRIORITY[e.layer] === maxPriority
    );

    if (winningLayer.length === 1) {
      return winningLayer[0]!;
    }

    // Within same layer: pessimistic (lowest numeric value)
    let best = winningLayer[0]!;
    for (let i = 1; i < winningLayer.length; i++) {
      const candidate = winningLayer[i]!;
      const bestVal = best.extracted_value;
      const candidateVal = candidate.extracted_value;
      if (typeof bestVal === "number" && typeof candidateVal === "number") {
        if (candidateVal < bestVal) {
          best = candidate;
        }
      }
    }

    return best;
  }

  // ─── Apply Observation to Goal ───

  /**
   * Apply an observation entry to the corresponding goal dimension.
   *
   * Steps:
   *   1. Load goal via StateManager.
   *   2. Find dimension by name.
   *   3. Update current_value and confidence.
   *   4. Append to dimension history.
   *   5. Persist observation log entry via StateManager.appendObservation.
   *   6. Persist updated goal via StateManager.saveGoal.
   */
  applyObservation(goalId: string, entry: ObservationLogEntry): void {
    const goal = this.stateManager.loadGoal(goalId);
    if (goal === null) {
      throw new Error(`applyObservation: goal "${goalId}" not found`);
    }

    const dimIndex = goal.dimensions.findIndex((d) => d.name === entry.dimension_name);
    if (dimIndex === -1) {
      throw new Error(
        `applyObservation: dimension "${entry.dimension_name}" not found in goal "${goalId}"`
      );
    }

    const dim = goal.dimensions[dimIndex]!;

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
      current_value: entry.extracted_value,
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
    this.stateManager.appendObservation(goalId, entry);

    // Persist updated goal
    this.stateManager.saveGoal(updatedGoal);
  }

  // ─── Observation Log Persistence ───

  /**
   * Load the observation log for a goal.
   * Returns an empty log if none exists.
   */
  getObservationLog(goalId: string): ObservationLog {
    const existing = this.stateManager.loadObservationLog(goalId);
    if (existing !== null) {
      return existing;
    }
    return ObservationLogSchema.parse({ goal_id: goalId, entries: [] });
  }

  /**
   * Persist the observation log for a goal.
   */
  saveObservationLog(goalId: string, log: ObservationLog): void {
    if (goalId !== log.goal_id) throw new Error("goalId mismatch");
    const parsed = ObservationLogSchema.parse(log);
    this.stateManager.saveObservationLog(parsed);
  }

  // ─── Observe ───

  /**
   * Perform an observation pass for all dimensions of a goal.
   *
   * For each dimension, the following priority order is used:
   *   1. DataSource — if a registered data source covers this dimension,
   *      call observeFromDataSource() (mechanical, confidence 0.90).
   *   2. LLM — if an LLM client is available, call observeWithLLM()
   *      (independent_review, confidence 0.70).
   *   3. self_report — fall back to re-recording the existing stored value.
   *
   * @param goalId   The goal to observe.
   * @param methods  Array of ObservationMethod descriptors (one per dimension,
   *                 in the same order as goal.dimensions).  Extra entries are
   *                 ignored; missing entries fall back to the dimension's own
   *                 observation_method.
   */
  async observe(goalId: string, methods: ObservationMethod[]): Promise<void> {
    const goal = this.stateManager.loadGoal(goalId);
    if (goal === null) {
      throw new Error(`observe: goal "${goalId}" not found`);
    }

    // When methods array is non-empty, only observe the dimensions corresponding to
    // the provided methods (the caller is explicitly selecting which dimensions to observe).
    // When methods is empty (e.g. CoreLoop passes []), observe all dimensions.
    const observeCount = methods.length > 0 ? methods.length : goal.dimensions.length;

    // Workspace context for LLM observations — fetched lazily on first LLM call.
    // This avoids calling contextProvider when all dimensions are covered by DataSources.
    let workspaceContext: string | undefined;
    let workspaceContextFetched = false;

    const fetchWorkspaceContext = async (): Promise<string | undefined> => {
      if (workspaceContextFetched) return workspaceContext;
      workspaceContextFetched = true;
      if (this.contextProvider) {
        try {
          workspaceContext = await this.contextProvider();
        } catch (err) {
          console.warn(
            `[ObservationEngine] contextProvider failed: ${err instanceof Error ? err.message : String(err)}. LLM observation will proceed without workspace context.`
          );
        }
      } else {
        console.warn(
          `[ObservationEngine] No contextProvider configured. LLM observation will proceed without workspace context (scores may be unreliable).`
        );
      }
      return workspaceContext;
    };

    for (let idx = 0; idx < observeCount; idx++) {
      const dim = goal.dimensions[idx]!;
      const method: ObservationMethod = methods[idx] ?? dim.observation_method;

      // 1. Try DataSource first
      const dataSource = this.findDataSourceForDimension(dim.name);
      if (dataSource) {
        await this.observeFromDataSource(goalId, dim.name, dataSource.sourceId);
        continue;
      }

      // 2. Try LLM if available
      if (this.llmClient) {
        const ctx = await fetchWorkspaceContext();
        try {
          await this.observeWithLLM(
            goalId,
            dim.name,
            goal.description,
            dim.label ?? dim.name,
            JSON.stringify(dim.threshold),
            ctx
          );
          continue;
        } catch (err) {
          console.warn(
            `[ObservationEngine] LLM observation failed for dimension "${dim.name}": ${err instanceof Error ? err.message : String(err)}. Falling back to self_report.`
          );
        }
      } else if (this.dataSources.length > 0) {
        // DataSources exist but none match this dimension and no LLM client
        console.warn(
          `[ObservationEngine] Warning: dimension "${dim.name}" has no matching DataSource and no LLM client available for observation`
        );
      }

      // 3. Fall back to self_report
      const entry = this.createObservationEntry({
        goalId,
        dimensionName: dim.name,
        layer: "self_report",
        method,
        trigger: "periodic",
        rawResult: dim.current_value,
        extractedValue:
          typeof dim.current_value === "number" ||
          typeof dim.current_value === "string" ||
          typeof dim.current_value === "boolean" ||
          dim.current_value === null
            ? (dim.current_value as number | string | boolean | null)
            : null,
        confidence: dim.confidence,
      });

      this.applyObservation(goalId, entry);
    }
  }

  // ─── Data Source Observation ───

  /**
   * Observe a goal dimension by querying a registered data source.
   *
   * Steps:
   *   1. Find the data source by sourceId.
   *   2. Build a DataSourceQuery, using dimension_mapping if configured.
   *   3. Call source.query().
   *   4. Convert result value to numeric if possible.
   *   5. Create and persist an ObservationLogEntry.
   *   6. Return the entry.
   */
  async observeFromDataSource(
    goalId: string,
    dimensionName: string,
    sourceId: string
  ): Promise<ObservationLogEntry> {
    const source = this.dataSources.find((s) => s.sourceId === sourceId);
    if (!source) {
      throw new Error(
        `observeFromDataSource: data source "${sourceId}" not found. ` +
          `Available: [${this.dataSources.map((s) => s.sourceId).join(", ")}]`
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

    this.applyObservation(goalId, entry);

    return entry;
  }

  // ─── DataSource Dimension Lookup ───

  /**
   * Find the first DataSource adapter that can serve the given dimension name.
   * Checks both getSupportedDimensions() and dimension_mapping config keys.
   * Returns null if no adapter matches.
   */
  private findDataSourceForDimension(dimensionName: string): IDataSourceAdapter | null {
    for (const ds of this.dataSources) {
      const dims = ds.getSupportedDimensions?.() ?? [];
      if (dims.includes(dimensionName)) return ds;
      // Also check dimension_mapping keys
      if (ds.config?.dimension_mapping && dimensionName in ds.config.dimension_mapping) {
        return ds;
      }
    }
    return null;
  }

  // ─── LLM Observation ───

  /**
   * Observe a goal dimension using the LLM client.
   *
   * The LLM is asked to score the dimension from 0.0 to 1.0.
   * The score is used as extractedValue, and confidence is fixed at 0.70
   * (middle of the independent_review range [0.50, 0.84]).
   *
   * @param goalId             The goal being observed.
   * @param dimensionName      The dimension name (snake_case).
   * @param goalDescription    Human-readable goal description.
   * @param dimensionLabel     Human-readable dimension label.
   * @param thresholdDescription  JSON-stringified threshold for context.
   */
  async observeWithLLM(
    goalId: string,
    dimensionName: string,
    goalDescription: string,
    dimensionLabel: string,
    thresholdDescription: string,
    workspaceContext?: string
  ): Promise<ObservationLogEntry> {
    if (!this.llmClient) {
      throw new Error("observeWithLLM: llmClient is not configured");
    }

    const contextSection = workspaceContext
      ? `\n=== Current Workspace State ===\n${workspaceContext}\n=== End Workspace State ===\n`
      : "";

    const prompt =
      `以下のゴールの次元を0.0〜1.0で評価してください。\n\n` +
      `ゴール: ${goalDescription}\n` +
      `評価次元: ${dimensionLabel}\n` +
      `目標値: ${thresholdDescription}\n` +
      contextSection +
      `\n現在の状態を考慮して、この次元の達成度を0.0（未達成）〜1.0（完全達成）で評価してください。\n\n` +
      `回答はJSON形式で: {"score": 0.0〜1.0, "reason": "評価理由"}`;

    const response = await this.llmClient.sendMessage([
      { role: "user", content: prompt },
    ]);

    const parsed = this.llmClient.parseJSON(response.content, LLMObservationResponseSchema);

    const entry = ObservationLogEntrySchema.parse({
      observation_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      trigger: "periodic",
      goal_id: goalId,
      dimension_name: dimensionName,
      layer: "independent_review",
      method: {
        type: "llm_review",
        source: "llm",
        schedule: null,
        endpoint: null,
        confidence_tier: "independent_review",
      },
      raw_result: { score: parsed.score, reason: parsed.reason },
      extracted_value: parsed.score,
      confidence: 0.70,
      notes: `LLM evaluation: ${parsed.reason}`,
    });

    this.applyObservation(goalId, entry);

    return entry;
  }

  /**
   * Return the registered data source adapters.
   */
  getDataSources(): IDataSourceAdapter[] {
    return this.dataSources;
  }

  /**
   * Return dimension info for all registered data sources that expose
   * getSupportedDimensions().
   */
  getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
    const result: Array<{ name: string; dimensions: string[] }> = [];
    for (const ds of this.dataSources) {
      if (typeof ds.getSupportedDimensions === "function") {
        result.push({ name: ds.config.name, dimensions: ds.getSupportedDimensions() });
      }
    }
    return result;
  }

  // ─── Knowledge Gap Detection ───

  /**
   * Detect whether a set of observation entries indicates a knowledge gap.
   *
   * Rule: if ALL entries have confidence < 0.3, interpretation is too
   * uncertain — emit an `interpretation_difficulty` signal.
   *
   * Returns null when confidence is sufficient (no gap detected).
   */
  detectKnowledgeGap(
    entries: ObservationLogEntry[],
    dimensionName?: string
  ): KnowledgeGapSignal | null {
    if (entries.length === 0) return null;

    const allLowConfidence = entries.every((e) => e.confidence < 0.3);
    if (!allLowConfidence) return null;

    return KnowledgeGapSignalSchema.parse({
      signal_type: "interpretation_difficulty",
      missing_knowledge:
        "Observation confidence is too low to interpret results reliably",
      source_step: "gap_recognition",
      related_dimension: dimensionName ?? null,
    });
  }
}
