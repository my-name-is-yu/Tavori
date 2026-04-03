import { StateManager } from "../state/state-manager.js";
import { ProgressPredictor } from "./progress-predictor.js";
import { StallReportSchema, StallStateSchema, StallAnalysisSchema } from "../types/stall.js";
import type { StallReport, StallState, StallAnalysis } from "../types/stall.js";
import type { CharacterConfig } from "../types/character.js";
import { DEFAULT_CHARACTER_CONFIG } from "../types/character.js";

// ─── Base feedback category → N loops mapping (at stall_flexibility=1, multiplier=1.0) ───

const BASE_FEEDBACK_CATEGORY_N: Record<string, number> = {
  immediate: 6,
  medium_term: 5,
  long_term: 10,
};

const BASE_DEFAULT_N = 5;

// ─── Minimum score-improvement delta to reset stall detection ───
// Improvements smaller than this are treated as noise (no reset).
const MIN_IMPROVEMENT_DELTA = 0.05;

// ─── Achieved-dimension gap threshold ───
// When ALL recent window entries are at or below this value, the dimension is
// considered achieved (satisficed) and should not be flagged as stalled.
// Aligned with SatisficingJudge: a gap this small means the dimension value
// effectively meets its threshold. Kept separate from MIN_IMPROVEMENT_DELTA
// because the two concepts are distinct: noise vs. completion.
const ACHIEVED_GAP_THRESHOLD = 0.02;

// ─── Time thresholds ───

const DEFAULT_DURATION_HOURS_BY_CATEGORY: Record<string, number> = {
  coding: 2,
  implementation: 2,
  research: 4,
  investigation: 4,
};

const DEFAULT_DURATION_HOURS_FALLBACK = 3;

// ─── Early zero-progress detection window ───
// When gap stays near-maximum (>=0.95) with negligible variance for this many loops,
// detect stall immediately without waiting for the full adjusted-N window.
const ZERO_PROGRESS_WINDOW = 3;
const ZERO_PROGRESS_GAP_FLOOR = 0.90;
const ZERO_PROGRESS_MAX_VARIANCE = 0.01;

// ─── Stall thresholds ───

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const ESCALATION_CAP = 3;

// ─── Decay factor constants ───

const DECAY_FACTOR_STALLED = 0.6;
const RECOVERY_SCHEDULE: Array<{ loops: number; factor: number }> = [
  { loops: 0, factor: 0.75 },
  { loops: 2, factor: 0.9 },
  { loops: 4, factor: 1.0 },
];

// ─── Repetitive pattern detection constants ───

const REPETITIVE_WINDOW = 3;
const SIMILARITY_THRESHOLD = 0.8;
const NO_CHANGE_PATTERNS = ["no changes made", "no modifications", "nothing to change", "no action taken"];

// ─── Exported interfaces ───

export interface StallTaskHistoryEntry {
  strategy_id: string | null;
  output: string;
}

export interface RepetitivePatternResult {
  isRepetitive: boolean;
  pattern: 'identical_actions' | 'oscillating' | 'no_change' | null;
  confidence: number;
}

/**
 * StallDetector detects stalls (circuit breaker) in the PulSeed orchestrator loop.
 * Supports 4 stall types: dimension_stall, time_exceeded, consecutive_failure, global_stall.
 */
export class StallDetector {
  private readonly stateManager: StateManager;
  private readonly characterConfig: CharacterConfig;
  private readonly predictor?: ProgressPredictor;

  constructor(stateManager: StateManager, characterConfig?: CharacterConfig, predictor?: ProgressPredictor) {
    this.stateManager = stateManager;
    this.characterConfig = characterConfig ?? DEFAULT_CHARACTER_CONFIG;
    this.predictor = predictor;
  }

  /**
   * Return the adjusted N value for a given feedback category.
   * stall_flexibility=1 (default, most flexible) → multiplier=1.0 (pivot fast)
   * stall_flexibility=5 (most persistent) → multiplier=2.0
   * Formula: multiplier = 0.75 + (stall_flexibility * 0.25)
   */
  private getAdjustedN(category?: string): number {
    const multiplier = 0.75 + this.characterConfig.stall_flexibility * 0.25;
    const base = category
      ? (BASE_FEEDBACK_CATEGORY_N[category] ?? BASE_DEFAULT_N)
      : BASE_DEFAULT_N;
    return Math.round(base * multiplier);
  }

  /**
   * Check if recent gap history shows zero progress (gap stuck near maximum).
   */
  private isZeroProgress(gapHistory: Array<{ normalized_gap: number }>): boolean {
    if (gapHistory.length < ZERO_PROGRESS_WINDOW) return false;
    const recent = gapHistory.slice(-ZERO_PROGRESS_WINDOW);
    const gaps = recent.map(e => e.normalized_gap);
    if (!gaps.every(g => g >= ZERO_PROGRESS_GAP_FLOOR)) return false;
    return Math.max(...gaps) - Math.min(...gaps) < ZERO_PROGRESS_MAX_VARIANCE;
  }

  /**
   * Compute bigram Dice coefficient similarity between two strings.
   * Returns 2 * |intersection| / (|bigrams_a| + |bigrams_b|).
   */
  private stringSimilarity(a: string, b: string): number {
    if (a.length === 0 || b.length === 0) return 0;

    const getBigrams = (s: string): string[] => {
      const bigrams: string[] = [];
      for (let i = 0; i < s.length - 1; i++) {
        bigrams.push(s.slice(i, i + 2));
      }
      return bigrams;
    };

    const bigramsA = getBigrams(a);
    const bigramsB = getBigrams(b);
    if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

    const setB = new Map<string, number>();
    for (const bg of bigramsB) {
      setB.set(bg, (setB.get(bg) ?? 0) + 1);
    }

    let intersection = 0;
    for (const bg of bigramsA) {
      const count = setB.get(bg) ?? 0;
      if (count > 0) {
        intersection++;
        setB.set(bg, count - 1);
      }
    }

    return (2 * intersection) / (bigramsA.length + bigramsB.length);
  }

  /**
   * Detect repetitive patterns in task execution history.
   * Checks for: identical_actions, oscillating, no_change patterns.
   */
  detectRepetitivePatterns(taskHistory: StallTaskHistoryEntry[]): RepetitivePatternResult {
    if (taskHistory.length < REPETITIVE_WINDOW) {
      return { isRepetitive: false, pattern: null, confidence: 0 };
    }

    const recent = taskHistory.slice(-REPETITIVE_WINDOW);
    const outputs = recent.map(e => e.output);

    // 1. no_change: last 3 outputs contain any NO_CHANGE_PATTERNS string (case-insensitive)
    const noChangeCount = recent.filter(entry =>
      NO_CHANGE_PATTERNS.some(p => entry.output.toLowerCase().includes(p))
    ).length;
    if (noChangeCount >= REPETITIVE_WINDOW) {
      return { isRepetitive: true, pattern: "no_change", confidence: 0.95 };
    }

    // 2. identical_actions: same strategy_id (non-null) and high output similarity
    const strategyIds = recent.map(e => e.strategy_id);
    const allSameStrategy = strategyIds[0] !== null && strategyIds.every(id => id === strategyIds[0]);
    if (allSameStrategy) {
      const sim01 = this.stringSimilarity(outputs[0], outputs[1]);
      const sim12 = this.stringSimilarity(outputs[1], outputs[2]);
      const avgSim = (sim01 + sim12) / 2;
      if (avgSim >= SIMILARITY_THRESHOLD) {
        return { isRepetitive: true, pattern: "identical_actions", confidence: avgSim };
      }
    }

    // 3. oscillating: A→B→A→B pattern (need 4+ entries)
    if (taskHistory.length >= 4) {
      const last4 = taskHistory.slice(-4);
      const o = last4.map(e => e.output);
      const sim02 = this.stringSimilarity(o[0], o[2]);
      const sim13 = this.stringSimilarity(o[1], o[3]);
      const sim01 = this.stringSimilarity(o[0], o[1]);
      if (sim02 >= SIMILARITY_THRESHOLD && sim13 >= SIMILARITY_THRESHOLD && sim01 < SIMILARITY_THRESHOLD) {
        return { isRepetitive: true, pattern: "oscillating", confidence: Math.min(sim02, sim13) };
      }
    }

    return { isRepetitive: false, pattern: null, confidence: 0 };
  }

  // ─── Public Methods ───

  /**
   * Check if a single dimension's gap has not improved for N loops.
   * N is determined by the feedbackCategory (immediate/medium_term/long_term).
   */
  checkDimensionStall(
    goalId: string,
    dimensionName: string,
    gapHistory: Array<{ normalized_gap: number }>,
    feedbackCategory?: string
  ): StallReport | null {
    const n = this.getAdjustedN(feedbackCategory);

    if (gapHistory.length < n + 1) {
      // Not enough history to determine a stall
      return null;
    }

    // Zero-progress detection: after confirming sufficient history,
    // check if recent entries show no progress at all
    if (this.isZeroProgress(gapHistory)) {
      return StallReportSchema.parse({
        stall_type: "dimension_stall",
        goal_id: goalId,
        dimension_name: dimensionName,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "approach_failure",
        decay_factor: DECAY_FACTOR_STALLED,
      });
    }

    const recent = gapHistory.slice(-n - 1);
    const oldest = recent[0].normalized_gap;
    const latest = recent[recent.length - 1].normalized_gap;

    // Achieved dimensions (all window entries near zero) are not stalled — they're done.
    // Checking the full window prevents a single noisy data point from suppressing a real stall.
    const isAchieved = recent.every(e => e.normalized_gap <= ACHIEVED_GAP_THRESHOLD);
    if (isAchieved) return null;

    // "No improvement" = latest gap has not decreased by at least MIN_IMPROVEMENT_DELTA
    // Trivial improvements (< 0.05) are treated as noise and do not reset stall detection.
    if (oldest - latest >= MIN_IMPROVEMENT_DELTA) {
      // Meaningful improvement — check predictor for early warning before returning null
      return this.checkPredictedStall(goalId, dimensionName, recent) ?? null;
    }

    return StallReportSchema.parse({
      stall_type: "dimension_stall",
      goal_id: goalId,
      dimension_name: dimensionName,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "approach_failure",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if a task has exceeded its time threshold (estimate × 2, or default by category).
   */
  checkTimeExceeded(task: {
    task_id?: string;
    goal_id: string;
    estimated_duration?: { value: number; unit: string } | null;
    started_at?: string | null;
    task_category?: string;
  }): StallReport | null {
    if (!task.started_at) {
      return null;
    }

    const startedAt = new Date(task.started_at);
    const now = new Date();
    const elapsedMs = now.getTime() - startedAt.getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    const thresholdHours = this.computeTimeThreshold(task.estimated_duration, task.task_category);

    if (elapsedHours <= thresholdHours) {
      return null;
    }

    return StallReportSchema.parse({
      stall_type: "time_exceeded",
      goal_id: task.goal_id,
      dimension_name: null,
      task_id: task.task_id ?? null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "external_dependency",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if a dimension has had 3+ consecutive failures.
   */
  checkConsecutiveFailures(
    goalId: string,
    dimensionName: string,
    consecutiveFailureCount: number
  ): StallReport | null {
    if (consecutiveFailureCount < CONSECUTIVE_FAILURE_THRESHOLD) {
      return null;
    }

    return StallReportSchema.parse({
      stall_type: "consecutive_failure",
      goal_id: goalId,
      dimension_name: dimensionName,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "approach_failure",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Check if ALL dimensions show no improvement for loopThreshold loops.
   * Returns null if any dimension improved.
   */
  checkGlobalStall(
    goalId: string,
    allDimensionGaps: Map<string, Array<{ normalized_gap: number }>>,
    loopThreshold = this.getAdjustedN()
  ): StallReport | null {
    if (allDimensionGaps.size === 0) {
      return null;
    }

    let zeroProgressCount = 0;
    let achievedCount = 0;

    for (const [, gapHistory] of allDimensionGaps) {
      if (gapHistory.length < loopThreshold + 1) {
        // Not enough data for this dimension — treat as not stalled (insufficient evidence)
        return null;
      }

      if (this.isZeroProgress(gapHistory)) {
        zeroProgressCount++;
        continue;
      }

      const recent = gapHistory.slice(-loopThreshold - 1);
      const oldest = recent[0].normalized_gap;
      const latest = recent[recent.length - 1].normalized_gap;

      // Skip achieved dimensions — they're done, not stalled.
      // A near-complete goal must not be flagged as "goal_infeasible".
      const isAchieved = recent.every(e => e.normalized_gap <= ACHIEVED_GAP_THRESHOLD);
      if (isAchieved) {
        achievedCount++;
        continue;
      }

      if (oldest - latest >= MIN_IMPROVEMENT_DELTA) {
        // At least one dimension improved meaningfully — not a global stall
        return null;
      }
    }

    // If all dimensions are achieved (or zero-progress with all achieved), no stall
    if (achievedCount + zeroProgressCount === allDimensionGaps.size && achievedCount > 0) {
      return null;
    }

    // Only trigger zero-progress global stall if ALL dimensions are zero-progress
    if (zeroProgressCount === allDimensionGaps.size) {
      return StallReportSchema.parse({
        stall_type: "global_stall",
        goal_id: goalId,
        dimension_name: null,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "goal_infeasible",
        decay_factor: DECAY_FACTOR_STALLED,
      });
    }

    // All remaining (non-achieved) dimensions are non-improving (normal stall path)
    return StallReportSchema.parse({
      stall_type: "global_stall",
      goal_id: goalId,
      dimension_name: null,
      task_id: null,
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "goal_infeasible",
      decay_factor: DECAY_FACTOR_STALLED,
    });
  }

  /**
   * Classify the root cause of a stall based on stall type and goal context.
   */
  classifyStallCause(
    stallType: string,
    goal: { dimensions?: Array<{ confidence?: number }> }
  ): string {
    // Check for low-confidence dimensions → information_deficit
    const hasLowConfidence = goal.dimensions?.some(
      (d) => d.confidence !== undefined && d.confidence < 0.5
    );

    if (hasLowConfidence) {
      return "information_deficit";
    }

    switch (stallType) {
      case "dimension_stall":
        return "approach_failure";

      case "time_exceeded":
        return "external_dependency";

      case "consecutive_failure":
        return "approach_failure";

      case "global_stall":
        return "goal_infeasible";

      default:
        return "approach_failure";
    }
  }

  /**
   * Analyze the root cause of a stall from gap history.
   * Returns a StallAnalysis with cause, confidence, evidence, and recommended_action.
   *
   * Patterns:
   *   - oscillating (high variance, stable mean) → parameter_issue → REFINE
   *   - flat (near-zero variance, near-zero delta) → strategy_wrong → PIVOT
   *   - diverging (monotonically increasing trend) → goal_unreachable → ESCALATE
   *   - fallback (unclear) → strategy_wrong → PIVOT
   */
  analyzeStallCause(gapHistory: Array<{ normalized_gap: number }>): StallAnalysis {
    const MIN_ENTRIES = 3;

    if (gapHistory.length < MIN_ENTRIES) {
      return StallAnalysisSchema.parse({
        cause: "strategy_wrong",
        confidence: 0.3,
        evidence: `Insufficient history (${gapHistory.length} entries, need ${MIN_ENTRIES})`,
        recommended_action: "pivot",
      });
    }

    const gaps = gapHistory.map((e) => e.normalized_gap);
    const n = gaps.length;

    // Mean
    const mean = gaps.reduce((s, v) => s + v, 0) / n;

    // Variance
    const variance =
      gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / n;

    // Delta (latest − oldest, positive means gap grew = worse)
    const delta = gaps[n - 1] - gaps[0];

    // Check divergence: monotonically increasing (gap grows each step)
    let monotonicallyIncreasing = true;
    for (let i = 1; i < n; i++) {
      if (gaps[i] <= gaps[i - 1]) {
        monotonicallyIncreasing = false;
        break;
      }
    }

    if (monotonicallyIncreasing && delta > 0.05) {
      return StallAnalysisSchema.parse({
        cause: "goal_unreachable",
        confidence: 0.8,
        evidence: `Gap is monotonically increasing (delta=${delta.toFixed(3)})`,
        recommended_action: "escalate",
      });
    }

    // Check oscillation: high variance + mean stays stable (|delta| small)
    const HIGH_VARIANCE_THRESHOLD = 0.01;
    const STABLE_DELTA_THRESHOLD = 0.05;

    if (variance > HIGH_VARIANCE_THRESHOLD && Math.abs(delta) < STABLE_DELTA_THRESHOLD) {
      return StallAnalysisSchema.parse({
        cause: "parameter_issue",
        confidence: 0.75,
        evidence: `Oscillating gap (variance=${variance.toFixed(4)}, delta=${delta.toFixed(3)})`,
        recommended_action: "refine",
      });
    }

    // Check flat: very low variance + small delta
    const LOW_VARIANCE_THRESHOLD = 0.005;
    const LOW_DELTA_THRESHOLD = 0.05;

    if (variance <= LOW_VARIANCE_THRESHOLD && Math.abs(delta) < LOW_DELTA_THRESHOLD) {
      return StallAnalysisSchema.parse({
        cause: "strategy_wrong",
        confidence: 0.75,
        evidence: `Flat gap with no progress (variance=${variance.toFixed(4)}, delta=${delta.toFixed(3)})`,
        recommended_action: "pivot",
      });
    }

    // Default fallback
    return StallAnalysisSchema.parse({
      cause: "strategy_wrong",
      confidence: 0.5,
      evidence: `Unclear pattern (variance=${variance.toFixed(4)}, delta=${delta.toFixed(3)})`,
      recommended_action: "pivot",
    });
  }

  /**
   * Compute the decay_factor for the dissatisfaction drive score.
   * - Stalled: 0.6
   * - Recently recovered: follows a schedule (0.75 → 0.90 → 1.0)
   * - Normal (not stalled, no recovery): 1.0
   */
  computeDecayFactor(isStalled: boolean, loopsSinceRecovery: number | null): number {
    if (isStalled) {
      return DECAY_FACTOR_STALLED;
    }

    if (loopsSinceRecovery === null) {
      // Not stalled, no recent recovery
      return 1.0;
    }

    // Recovery schedule: find the highest threshold that has been reached
    let factor = 1.0;
    for (const { loops, factor: scheduledFactor } of RECOVERY_SCHEDULE) {
      if (loopsSinceRecovery >= loops) {
        factor = scheduledFactor;
      }
    }

    return factor;
  }

  /**
   * Returns true if the plateau_until date is in the future (stall detection suppressed).
   */
  isSuppressed(plateauUntil: string | null): boolean {
    if (plateauUntil === null) {
      return false;
    }

    const until = new Date(plateauUntil);
    const now = new Date();
    return now < until;
  }

  /**
   * Load the StallState for a goal from StateManager.
   * Returns a default state if not found.
   */
  async getStallState(goalId: string): Promise<StallState> {
    const raw = await this.stateManager.readRaw(`stalls/${goalId}.json`);
    if (raw === null) {
      return StallStateSchema.parse({
        goal_id: goalId,
        dimension_escalation: {},
        global_escalation: 0,
        decay_factors: {},
        recovery_loops: {},
      });
    }

    return StallStateSchema.parse(raw);
  }

  /**
   * Persist the StallState for a goal via StateManager.
   */
  async saveStallState(goalId: string, state: StallState): Promise<void> {
    const parsed = StallStateSchema.parse(state);
    await this.stateManager.writeRaw(`stalls/${goalId}.json`, parsed);
  }

  /**
   * Get the current escalation level for a dimension (default: 0).
   */
  async getEscalationLevel(goalId: string, dimensionName: string): Promise<number> {
    const state = await this.getStallState(goalId);
    return state.dimension_escalation[dimensionName] ?? 0;
  }

  /**
   * Increment the escalation level for a dimension (cap at ESCALATION_CAP).
   * Persists and returns the new level.
   */
  async incrementEscalation(goalId: string, dimensionName: string): Promise<number> {
    const state = await this.getStallState(goalId);
    const current = state.dimension_escalation[dimensionName] ?? 0;
    const next = Math.min(current + 1, ESCALATION_CAP);
    state.dimension_escalation[dimensionName] = next;
    await this.saveStallState(goalId, state);
    return next;
  }

  /**
   * Reset the escalation level for a dimension to 0 and persist.
   */
  async resetEscalation(goalId: string, dimensionName: string): Promise<void> {
    const state = await this.getStallState(goalId);
    state.dimension_escalation[dimensionName] = 0;
    await this.saveStallState(goalId, state);
  }


  // ─── Private Helpers ───

  /**
   * Run ProgressPredictor on gap history and return a predicted stall report if warranted.
   * Returns null if no predictor, insufficient confidence, or no predicted stall.
   */
  private checkPredictedStall(
    goalId: string,
    dimensionName: string,
    gapHistory: Array<{ normalized_gap: number }>
  ): StallReport | null {
    if (!this.predictor) return null;

    const scores = gapHistory.map(e => e.normalized_gap);
    const prediction = this.predictor.predict(scores);
    if (!prediction || prediction.confidence <= 0.6) return null;

    if (prediction.trend === "stable") {
      return StallReportSchema.parse({
        stall_type: "predicted_plateau",
        goal_id: goalId,
        dimension_name: dimensionName,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "approach_failure",
        decay_factor: 0.3,
      });
    }

    if (prediction.trend === "worsening") {
      return StallReportSchema.parse({
        stall_type: "predicted_regression",
        goal_id: goalId,
        dimension_name: dimensionName,
        task_id: null,
        detected_at: new Date().toISOString(),
        escalation_level: 0,
        suggested_cause: "approach_failure",
        decay_factor: 0.5,
      });
    }

    return null;
  }

  /**
   * Compute the time threshold in hours for a task.
   */
  private computeTimeThreshold(
    estimatedDuration: { value: number; unit: string } | null | undefined,
    taskCategory?: string
  ): number {
    if (estimatedDuration) {
      const estimatedHours = this.durationToHours(estimatedDuration);
      return estimatedHours * 2;
    }

    if (taskCategory) {
      const defaultHours = DEFAULT_DURATION_HOURS_BY_CATEGORY[taskCategory];
      if (defaultHours !== undefined) {
        return defaultHours;
      }
    }

    return DEFAULT_DURATION_HOURS_FALLBACK;
  }

  /**
   * Convert a duration object to hours.
   */
  private durationToHours(duration: { value: number; unit: string }): number {
    switch (duration.unit) {
      case "minutes":
        return duration.value / 60;
      case "hours":
        return duration.value;
      case "days":
        return duration.value * 24;
      case "weeks":
        return duration.value * 24 * 7;
      default:
        return duration.value; // assume hours as fallback
    }
  }
}
