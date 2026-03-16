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

// ─── Options ───

export interface ObservationEngineOptions {
  crossValidationEnabled?: boolean; // default: false
  divergenceThreshold?: number;     // default: 0.20
}

// ─── Cross-Validation Result ───

export interface CrossValidationResult {
  dimensionName: string;
  mechanicalValue: number;
  llmValue: number;
  diverged: boolean;
  divergenceRatio: number;
  resolution: "mechanical_wins";
}

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
  private dataSources: IDataSourceAdapter[];
  private readonly llmClient?: ILLMClient;
  private readonly contextProvider?: (goalId: string, dimensionName: string) => Promise<string>;
  private readonly options: ObservationEngineOptions;

  constructor(
    stateManager: StateManager,
    dataSources: IDataSourceAdapter[] = [],
    llmClient?: ILLMClient,
    contextProvider?: (goalId: string, dimensionName: string) => Promise<string>,
    options: ObservationEngineOptions = {}
  ) {
    this.stateManager = stateManager;
    this.dataSources = dataSources;
    this.llmClient = llmClient;
    this.contextProvider = contextProvider;
    this.options = options;
  }

  // ─── Cross-Validation ───

  /**
   * Compare a mechanical observation value against an LLM-produced value.
   * Logs a warning when the two diverge beyond the configured threshold.
   * The mechanical value always wins — LLM is used for diagnostics only.
   */
  private crossValidate(
    goalId: string,
    dimensionName: string,
    mechanicalValue: number,
    llmValue: number
  ): CrossValidationResult {
    const threshold = this.options.divergenceThreshold ?? 0.20;
    const denominator = Math.max(Math.abs(mechanicalValue), Math.abs(llmValue), 1);
    const ratio = Math.abs(mechanicalValue - llmValue) / denominator;
    const diverged = ratio > threshold;

    if (diverged) {
      console.warn(
        `[CrossValidation] DIVERGED goal="${goalId}" dim="${dimensionName}" ` +
        `mechanical=${mechanicalValue} llm=${llmValue} ` +
        `ratio=${ratio.toFixed(3)} threshold=${threshold} resolution=mechanical_wins`
      );
    }

    return {
      dimensionName,
      mechanicalValue,
      llmValue,
      diverged,
      divergenceRatio: ratio,
      resolution: "mechanical_wins",
    };
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
  // ─── Dimension Name Normalization ───

  /**
   * Strip trailing _2, _3, ... _N suffixes that LLMs sometimes append to
   * deduplicate JSON keys.  Only applied to names from external (LLM) input.
   *
   * Examples:
   *   "todo_count_2"  → "todo_count"
   *   "quality_3"     → "quality"
   *   "step_count"    → "step_count"  (trailing token is not a digit-only suffix)
   *   "coverage"      → "coverage"
   */
  private normalizeDimensionName(name: string): string {
    const stripped = name.replace(/_\d+$/, "");
    if (stripped !== name) {
      console.warn(`[ObservationEngine] normalizeDimensionName: stripped "${name}" → "${stripped}"`);
    }
    return stripped;
  }

  applyObservation(goalId: string, entry: ObservationLogEntry): void {
    const goal = this.stateManager.loadGoal(goalId);
    if (goal === null) {
      throw new Error(`applyObservation: goal "${goalId}" not found`);
    }

    const safeName = this.normalizeDimensionName(entry.dimension_name);
    const dimIndex = goal.dimensions.findIndex((d) => d.name === safeName);
    if (dimIndex === -1) {
      throw new Error(
        `applyObservation: dimension "${entry.dimension_name}" not found in goal "${goalId}"`
      );
    }

    const dim = goal.dimensions[dimIndex]!;

    // Monotonic progress: for min thresholds, never decrease; for max, never increase.
    // This prevents temperature-induced noise from regressing observed progress.
    let effectiveValue = entry.extracted_value;
    if (typeof effectiveValue === 'number' && typeof dim.current_value === 'number') {
      // NOTE: range thresholds intentionally not clamped — progress direction is ambiguous.
      // Assumes earlier observations are reliable; no mechanism to override a false-high floor.
      if (dim.threshold.type === 'min' && effectiveValue < dim.current_value) {
        effectiveValue = dim.current_value;
      } else if (dim.threshold.type === 'max' && effectiveValue > dim.current_value) {
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

    // Workspace context for LLM observations — fetched lazily per dimension, cached within
    // this observe() call to avoid re-reading the same files for multiple dimensions.
    const contextCache = new Map<string, string>();
    let warnedNoProvider = false;

    const fetchWorkspaceContext = async (gId: string, dimensionName: string): Promise<string | undefined> => {
      const cacheKey = `${gId}::${dimensionName}`;
      if (contextCache.has(cacheKey)) return contextCache.get(cacheKey);
      if (this.contextProvider) {
        try {
          const ctx = await this.contextProvider(gId, dimensionName);
          contextCache.set(cacheKey, ctx);
          return ctx;
        } catch (err) {
          console.warn(
            `[ObservationEngine] contextProvider failed: ${err instanceof Error ? err.message : String(err)}. LLM observation will proceed without workspace context.`
          );
        }
      } else {
        if (!warnedNoProvider) {
          warnedNoProvider = true;
          console.warn(
            `[ObservationEngine] No contextProvider configured. LLM observation will proceed without workspace context (scores may be unreliable).`
          );
        }
      }
      return undefined;
    };

    for (let idx = 0; idx < observeCount; idx++) {
      const dim = goal.dimensions[idx]!;
      const method: ObservationMethod = methods[idx] ?? dim.observation_method;

      // 1. Try DataSource first
      const dataSource = this.findDataSourceForDimension(dim.name, goalId);
      if (dataSource) {
        try {
          await this.observeFromDataSource(goalId, dim.name, dataSource.sourceId);

          // Cross-validation: also run LLM and compare (for logging/diagnostics only)
          if (this.options.crossValidationEnabled && this.llmClient) {
            try {
              const updatedGoal = this.stateManager.loadGoal(goalId);
              const dimState = updatedGoal?.dimensions.find((d) => d.name === dim.name);
              const mechanicalValue = typeof dimState?.current_value === "number" ? dimState.current_value : 0;

              const ctx = await fetchWorkspaceContext(goalId, dim.name);
              const llmEntry = await this.observeWithLLM(
                goalId,
                dim.name,
                goal.description,
                dim.label ?? dim.name,
                JSON.stringify(dim.threshold),
                ctx,
                mechanicalValue,
                true // dryRun — do NOT write to state
              );
              const llmValue = typeof llmEntry.extracted_value === "number" ? llmEntry.extracted_value : 0;
              this.crossValidate(goalId, dim.name, mechanicalValue, llmValue);
            } catch (err) {
              console.warn(`[CrossValidation] LLM comparison failed for "${dim.name}": ${err}`);
            }
          }

          continue;
        } catch (err) {
          console.warn(
            `[ObservationEngine] DataSource observation failed for dimension "${dim.name}" (source: ${dataSource.sourceId}): ${err instanceof Error ? err.message : String(err)}. Falling through to LLM fallback.`
          );
        }
      }

      // 2. Try LLM if available
      if (this.llmClient) {
        const ctx = await fetchWorkspaceContext(goalId, dim.name);
        try {
          await this.observeWithLLM(
            goalId,
            dim.name,
            goal.description,
            dim.label ?? dim.name,
            JSON.stringify(dim.threshold),
            ctx,
            typeof dim.current_value === "number" ? dim.current_value : null
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
  private findDataSourceForDimension(dimensionName: string, goalId?: string): IDataSourceAdapter | null {
    for (const ds of this.dataSources) {
      // If the DataSource is scoped to a specific goal, only match when goalId matches
      const scopeGoalId = ds.config?.scope_goal_id as string | undefined;
      if (scopeGoalId !== undefined && scopeGoalId !== goalId) {
        continue;
      }

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
    workspaceContext?: string,
    previousScore?: number | null,
    dryRun?: boolean
  ): Promise<ObservationLogEntry> {
    if (!this.llmClient) {
      throw new Error("observeWithLLM: llmClient is not configured");
    }

    console.log(
      `[ObservationEngine] LLM observation for dimension "${dimensionLabel}" (goal: ${goalId})`
    );

    const hasContext = !!workspaceContext && workspaceContext.trim().length > 0;

    const previousScoreText =
      previousScore !== undefined && previousScore !== null
        ? previousScore.toFixed(2)
        : "none";

    const contextContent = hasContext
      ? workspaceContext!
      : "WARNING: No workspace content was provided. Score MUST be 0.0 per Rule 2.";

    const prompt =
      `You are an independent observer evaluating a goal dimension.\n` +
      `Your task: score the dimension from 0.0 (not achieved) to 1.0 (fully achieved).\n\n` +
      `CRITICAL RULES:\n` +
      `1. Base your score ONLY on the evidence in the workspace content below. Do not invent or assume.\n` +
      `2. If no workspace content is provided, score MUST be 0.0.\n` +
      `3. Read every line of the provided content before scoring.\n` +
      `4. Return ONLY valid JSON: {"score": <0.0-1.0>, "reason": "<one sentence>"}\n\n` +
      `Goal: ${goalDescription}\n` +
      `Dimension: ${dimensionLabel}\n` +
      `Target threshold: ${thresholdDescription}\n` +
      `Previous score: ${previousScoreText}\n\n` +
      `=== FEW-SHOT CALIBRATION ===\n` +
      `Example A — evidence confirms achievement:\n` +
      `  Context: grep output shows 0 TODO matches in codebase\n` +
      `  Output: {"score": 1.0, "reason": "No TODOs found; target of 0 achieved"}\n\n` +
      `Example B — evidence shows shortfall:\n` +
      `  Context: grep output shows 3 matches: src/foo.ts:42: TODO fix this\n` +
      `  Output: {"score": 0.0, "reason": "3 TODOs remain; target is 0"}\n\n` +
      `Example C — no content provided:\n` +
      `  Context: (empty)\n` +
      `  Output: {"score": 0.0, "reason": "No evidence available; cannot confirm achievement"}\n` +
      `=== END CALIBRATION ===\n\n` +
      `=== WORKSPACE CONTENT ===\n` +
      `${contextContent}\n` +
      `=== END CONTENT ===\n\n` +
      `Score the dimension now based strictly on the above content.`;

    const response = await this.llmClient.sendMessage([
      { role: "user", content: prompt },
    ]);

    const parsed = this.llmClient.parseJSON(response.content, LLMObservationResponseSchema);

    console.log(
      `[ObservationEngine] LLM observation result for "${dimensionLabel}": score=${parsed.score.toFixed(3)}`
    );

    // Scale LLM 0-1 score to threshold's native scale for min/max types.
    // LLM returns 0.0-1.0 (normalized), but gap-calculator expects the raw
    // value in the threshold's scale (e.g., min:5 expects value >= 5).
    let extractedValue: number = parsed.score;
    try {
      const threshold = JSON.parse(thresholdDescription);
      if (threshold.type === "min" && typeof threshold.value === "number" && threshold.value > 1) {
        extractedValue = parsed.score * threshold.value;
      } else if (threshold.type === "max" && typeof threshold.value === "number" && threshold.value > 1) {
        extractedValue = parsed.score * threshold.value;
      }
    } catch { /* keep original score if threshold parsing fails */ }

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
      extracted_value: extractedValue,
      confidence: 0.70,
      notes: `LLM evaluation: ${parsed.reason}`,
    });

    if (!dryRun) {
      this.applyObservation(goalId, entry);
    }

    return entry;
  }

  /**
   * Return the registered data source adapters.
   */
  getDataSources(): IDataSourceAdapter[] {
    return this.dataSources;
  }

  /**
   * Dynamically add a data source adapter at runtime.
   * The adapter becomes immediately available for subsequent observe() calls.
   */
  addDataSource(adapter: IDataSourceAdapter): void {
    this.dataSources.push(adapter);
  }

  /**
   * Dynamically remove a data source adapter at runtime.
   * Returns true if the adapter was found and removed, false otherwise.
   */
  removeDataSource(sourceId: string): boolean {
    const index = this.dataSources.findIndex((ds) => ds.sourceId === sourceId);
    if (index === -1) {
      return false;
    }
    this.dataSources.splice(index, 1);
    return true;
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
