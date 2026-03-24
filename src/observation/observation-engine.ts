import { ObservationLogSchema } from "../types/state.js";
import type { ObservationLogEntry, ObservationLog } from "../types/state.js";
import type { ObservationLayer, ObservationMethod } from "../types/core.js";
import type { StateManager } from "../state-manager.js";
import type { KnowledgeGapSignal } from "../types/knowledge.js";
import type { IDataSourceAdapter } from "./data-source-adapter.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { Logger } from "../runtime/logger.js";
import {
  observeForTask as _observeForTask,
} from "./observation-task.js";
import type { TaskDomain } from "../types/pipeline.js";
import type { AgentTask } from "../execution/adapter-layer.js";
import type { TaskObservationContext } from "./observation-task.js";
export type { TaskObservationContext } from "./observation-task.js";
import {
  applyProgressCeiling,
  getConfidenceTier,
  createObservationEntry,
  needsVerificationTask,
  resolveContradiction,
  normalizeDimensionName,
  detectKnowledgeGap,
  loadOrEmptyObservationLog,
} from "./observation-helpers.js";
import type { ObservationEngineOptions, CrossValidationResult } from "./observation-helpers.js";
import { observeWithLLM as llmObserve, ObservationPersistenceError } from "./observation-llm.js";
import {
  applyObservation as applyObservationFn,
  observeFromDataSource as observeFromDataSourceFn,
} from "./observation-apply.js";

// Re-export types and helpers for backward compatibility
export type { ObservationEngineOptions, CrossValidationResult } from "./observation-helpers.js";
export {
  applyProgressCeiling,
  getConfidenceTier,
  createObservationEntry,
  needsVerificationTask,
  resolveContradiction,
  detectKnowledgeGap,
} from "./observation-helpers.js";

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
  private readonly logger?: Logger;

  constructor(
    stateManager: StateManager,
    dataSources: IDataSourceAdapter[] = [],
    llmClient?: ILLMClient,
    contextProvider?: (goalId: string, dimensionName: string) => Promise<string>,
    options: ObservationEngineOptions = {},
    logger?: Logger
  ) {
    this.stateManager = stateManager;
    this.dataSources = dataSources;
    this.llmClient = llmClient;
    this.contextProvider = contextProvider;
    this.options = options;
    this.logger = logger;
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

    // Apply confidence penalty proportional to divergence when LLM hallucinated.
    // Penalty = min(0.30, divergenceRatio * 0.5) — caps at 0.30.
    const confidencePenalty = diverged ? Math.min(0.30, ratio * 0.5) : 0;

    if (diverged) {
      this.logger?.warn(
        `[CrossValidation] DIVERGED goal="${goalId}" dim="${dimensionName}" ` +
        `mechanical=${mechanicalValue} llm=${llmValue} ` +
        `ratio=${ratio.toFixed(3)} threshold=${threshold} ` +
        `confidencePenalty=${confidencePenalty.toFixed(3)} resolution=mechanical_wins`
      );
    }

    return {
      dimensionName,
      mechanicalValue,
      llmValue,
      diverged,
      divergenceRatio: ratio,
      resolution: "mechanical_wins",
      confidencePenalty,
    };
  }

  // ─── Progress Ceiling ───

  /**
   * Apply progress ceiling based on observation layer.
   * Returns min(progress, ceiling).
   */
  applyProgressCeiling(progress: number, layer: ObservationLayer): number {
    return applyProgressCeiling(progress, layer);
  }

  // ─── Confidence Tier ───

  /**
   * Return the ConfidenceTier and valid confidence range for a given layer.
   */
  getConfidenceTier(layer: ObservationLayer): ReturnType<typeof getConfidenceTier> {
    return getConfidenceTier(layer);
  }

  // ─── Create Observation Entry ───

  /**
   * Construct a new ObservationLogEntry.
   * Confidence is clamped to the layer's valid range.
   */
  createObservationEntry(params: Parameters<typeof createObservationEntry>[0]): ObservationLogEntry {
    return createObservationEntry(params);
  }

  // ─── Evidence Gate ───

  /**
   * Returns true when effective progress meets the threshold but confidence
   * is below 0.85, meaning a mechanical verification task should be generated.
   */
  needsVerificationTask(effectiveProgress: number, confidence: number, threshold: number): boolean {
    return needsVerificationTask(effectiveProgress, confidence, threshold);
  }

  // ─── Contradiction Resolution ───

  /**
   * Resolve contradictions among multiple observation entries.
   */
  resolveContradiction(entries: ObservationLogEntry[]): ObservationLogEntry {
    return resolveContradiction(entries);
  }

  // ─── Dimension Name Normalization ───

  /**
   * Strip trailing _2, _3, ... _N suffixes that LLMs sometimes append to
   * deduplicate JSON keys.  Only applied to names from external (LLM) input.
   */
  normalizeDimensionName(name: string): string {
    return normalizeDimensionName(name, this.logger);
  }

  // ─── Apply Observation to Goal ───

  applyObservation(goalId: string, entry: ObservationLogEntry): Promise<void> {
    return applyObservationFn(goalId, entry, this.stateManager, this.options);
  }

  // ─── Observation Log Persistence ───

  /**
   * Load the observation log for a goal.
   * Returns an empty log if none exists.
   */
  async getObservationLog(goalId: string): Promise<ObservationLog> {
    return loadOrEmptyObservationLog(this.stateManager, goalId);
  }

  /**
   * Persist the observation log for a goal.
   */
  async saveObservationLog(goalId: string, log: ObservationLog): Promise<void> {
    if (goalId !== log.goal_id) throw new Error("goalId mismatch");
    const parsed = ObservationLogSchema.parse(log);
    await this.stateManager.saveObservationLog(parsed);
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
    const goal = await this.stateManager.loadGoal(goalId);
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
          this.logger?.warn(
            `[ObservationEngine] contextProvider failed: ${err instanceof Error ? err.message : String(err)}. LLM observation will proceed without workspace context.`
          );
        }
      } else {
        if (!warnedNoProvider) {
          warnedNoProvider = true;
          this.logger?.warn(
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

          // Cross-validation: also run LLM and compare.
          // When divergence is detected, apply a confidence penalty to the dimension
          // so downstream scoring treats the observation with appropriate skepticism.
          if (this.options.crossValidationEnabled && this.llmClient) {
            try {
              const updatedGoal = await this.stateManager.loadGoal(goalId);
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
                null, // no previousScore — bypass jump suppression for cross-validation
                true // dryRun — do NOT write to state
              );
              const llmValue = typeof llmEntry.extracted_value === "number" ? llmEntry.extracted_value : 0;
              const result = this.crossValidate(goalId, dim.name, mechanicalValue, llmValue);

              // Apply confidence penalty when LLM observation diverges from mechanical truth
              if (result.diverged && result.confidencePenalty > 0) {
                const currentGoal = await this.stateManager.loadGoal(goalId);
                if (currentGoal) {
                  const dimIdx = currentGoal.dimensions.findIndex((d) => d.name === dim.name);
                  if (dimIdx !== -1) {
                    const currentDim = currentGoal.dimensions[dimIdx]!;
                    const penalizedConfidence = Math.max(0.10, (currentDim.confidence ?? 0.5) - result.confidencePenalty);
                    const updatedDims = [...currentGoal.dimensions];
                    updatedDims[dimIdx] = { ...currentDim, confidence: penalizedConfidence };
                    await this.stateManager.saveGoal({
                      ...currentGoal,
                      dimensions: updatedDims,
                      updated_at: new Date().toISOString(),
                    });
                    this.logger?.warn(
                      `[CrossValidation] Confidence penalized for "${dim.name}": ` +
                      `${(currentDim.confidence ?? 0.5).toFixed(3)} → ${penalizedConfidence.toFixed(3)} ` +
                      `(penalty=${result.confidencePenalty.toFixed(3)}, LLM hallucination detected)`
                    );
                  }
                }
              }
            } catch (err) {
              this.logger?.warn(`[CrossValidation] LLM comparison failed for "${dim.name}": ${err}`);
            }
          }

          continue;
        } catch (err) {
          this.logger?.warn(
            `[ObservationEngine] DataSource observation failed for dimension "${dim.name}" (source: ${dataSource.sourceId}): ${err instanceof Error ? err.message : String(err)}. Falling through to LLM fallback.`
          );
        }
      }

      // 2. Try LLM if available
      if (this.llmClient) {
        const ctx = await fetchWorkspaceContext(goalId, dim.name);
        try {
          // Only pass previousScore when there's actual observation history.
          // The seed current_value in a new goal is not a real observation and
          // should not trigger the §3.3 score-jump suppression guard.
          // current_value may have been written by the verifier (not by an observation).
          // Use the last history entry so jump-suppression (§3.3) only compares genuine observations.
          const hasPriorObs = Array.isArray(dim.history) && dim.history.length > 0;
          const lastObsEntry =
            hasPriorObs ? dim.history[dim.history.length - 1] : null;
          const previousScore =
            lastObsEntry && typeof lastObsEntry.value === "number"
              ? lastObsEntry.value
              : null;
          await this.observeWithLLM(
            goalId,
            dim.name,
            goal.description,
            dim.label ?? dim.name,
            JSON.stringify(dim.threshold),
            ctx,
            previousScore
          );
          continue;
        } catch (err) {
          this.logger?.warn(
            `[ObservationEngine] LLM observation failed for dimension "${dim.name}": ${err instanceof Error ? err.message : String(err)}. Falling back to self_report.`
          );
          // If persistence failed but LLM succeeded, recover the observed value
          // so the self_report fallback uses the real score instead of null.
          if (err instanceof ObservationPersistenceError) {
            const recoveredValue = err.entry.extracted_value;
            this.logger?.warn(
              `[ObservationEngine] Recovering LLM-observed value=${recoveredValue} for dimension "${dim.name}" via self_report fallback.`
            );
            const recoveryEntry = createObservationEntry({
              goalId,
              dimensionName: dim.name,
              layer: "self_report",
              method,
              trigger: "periodic",
              rawResult: recoveredValue,
              extractedValue:
                typeof recoveredValue === "number" ||
                typeof recoveredValue === "string" ||
                typeof recoveredValue === "boolean" ||
                recoveredValue === null
                  ? (recoveredValue as number | string | boolean | null)
                  : null,
              confidence: err.entry.confidence,
            });
            await this.applyObservation(goalId, recoveryEntry);
            continue;
          }
        }
      } else if (this.dataSources.length > 0) {
        // DataSources exist but none match this dimension and no LLM client
        this.logger?.warn(
          `[ObservationEngine] Warning: dimension "${dim.name}" has no matching DataSource and no LLM client available for observation`
        );
      }

      // 3. Fall back to self_report (no LLM result available)
      const entry = createObservationEntry({
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

      await this.applyObservation(goalId, entry);
    }
  }

  // ─── Data Source Observation ───

  /**
   * Observe a goal dimension by querying a registered data source.
   */
  async observeFromDataSource(
    goalId: string,
    dimensionName: string,
    sourceId: string
  ): Promise<ObservationLogEntry> {
    return observeFromDataSourceFn(
      goalId,
      dimensionName,
      sourceId,
      this.dataSources,
      (gId, entry) => this.applyObservation(gId, entry)
    );
  }

  // ─── DataSource Dimension Lookup ───

  /**
   * Find the first DataSource adapter that can serve the given dimension name.
   */
  private findDataSourceForDimension(dimensionName: string, goalId?: string): IDataSourceAdapter | null {
    const matches = (ds: IDataSourceAdapter): boolean => {
      const dims = ds.getSupportedDimensions?.() ?? [];
      if (dims.includes(dimensionName)) return true;
      if (ds.config?.dimension_mapping && dimensionName in ds.config.dimension_mapping) return true;
      return false;
    };

    // First pass: prefer a datasource explicitly scoped to this goalId
    for (const ds of this.dataSources) {
      const scopeGoalId = ds.config?.scope_goal_id as string | undefined;
      if (scopeGoalId === goalId && goalId !== undefined && matches(ds)) return ds;
    }

    // Second pass: fall back to an unscoped datasource
    for (const ds of this.dataSources) {
      const scopeGoalId = ds.config?.scope_goal_id as string | undefined;
      if (scopeGoalId === undefined && matches(ds)) return ds;
    }

    return null;
  }

  // ─── LLM Observation ───

  /**
   * Observe a goal dimension using the LLM client.
   *
   * @param goalId             The goal being observed.
   * @param dimensionName      The dimension name (snake_case).
   * @param goalDescription    Human-readable goal description.
   * @param dimensionLabel     Human-readable dimension label.
   * @param thresholdDescription  JSON-stringified threshold for context.
   * @param workspaceContext   Optional pre-fetched workspace context.
   * @param previousScore      Previous observed score for trend context.
   * @param dryRun             If true, do not write to state.
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
    return llmObserve(
      goalId,
      dimensionName,
      goalDescription,
      dimensionLabel,
      thresholdDescription,
      this.llmClient,
      this.options,
      (gId, entry) => this.applyObservation(gId, entry),
      workspaceContext,
      previousScore,
      dryRun,
      this.logger
    );
  }

  /**
   * Return the registered data source adapters.
   */
  getDataSources(): IDataSourceAdapter[] {
    return this.dataSources;
  }

  /**
   * Dynamically add a data source adapter at runtime.
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
   */
  detectKnowledgeGap(
    entries: ObservationLogEntry[],
    dimensionName?: string
  ): KnowledgeGapSignal | null {
    return detectKnowledgeGap(entries, dimensionName);
  }

  // ─── Task-Scoped Observation ───

  /**
   * Collect domain-specific pre-execution context for a task.
   *
   * Delegates to the standalone `_observeForTask` function from
   * `observation-task.ts`. The `contextProvider` on this class returns
   * `Promise<string>` while `ObserveForTaskDeps` expects
   * `Promise<string | null>`, so we adapt inline (both are compatible at
   * runtime since `string` satisfies `string | null`).
   *
   * @param task    The agent task requiring pre-execution context.
   * @param domain  The task domain that governs the collection strategy.
   */
  async observeForTask(task: AgentTask, domain: TaskDomain): Promise<TaskObservationContext> {
    return _observeForTask(
      { contextProvider: this.contextProvider, logger: this.logger },
      task,
      domain
    );
  }
}
