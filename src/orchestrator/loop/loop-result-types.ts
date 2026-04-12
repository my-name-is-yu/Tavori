import type { DriveScore } from "../../base/types/drive.js";
import type { CompletionJudgment } from "../../base/types/satisficing.js";
import type { StallAnalysis, StallReport } from "../../base/types/stall.js";
import type { TransferCandidate } from "../../base/types/cross-portfolio.js";
import type { TaskCycleResult } from "../execution/task/task-execution-types.js";
import type { VerificationLayer1Result } from "./verification-layer1.js";
import type { CorePhaseKind } from "../execution/agent-loop/core-phase-runner.js";

export interface CorePhaseIterationResult {
  phase: CorePhaseKind;
  status: "skipped" | "completed" | "low_confidence" | "failed";
  summary?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  stopReason?: string;
  lowConfidence?: boolean;
  error?: string;
}

export interface NextIterationDirective {
  sourcePhase: "knowledge_refresh" | "replanning_options" | "stall_investigation";
  reason: string;
  focusDimension?: string;
  preferredAction?: "continue" | "refine" | "pivot";
  requestedPhase?: "knowledge_refresh" | "normal";
}

export interface LoopIterationResult {
  loopIndex: number;
  goalId: string;
  gapAggregate: number;
  driveScores: DriveScore[];
  taskResult: TaskCycleResult | null;
  stallDetected: boolean;
  stallReport: StallReport | null;
  /** M14-S2: cause analysis result when a stall is detected */
  stallAnalysis?: StallAnalysis;
  pivotOccurred: boolean;
  completionJudgment: CompletionJudgment;
  elapsedMs: number;
  error: string | null;
  /** Alerts for milestones that are at_risk or behind (optional) */
  milestoneAlerts?: Array<{ goalId: string; status: string; pace_ratio: number }>;
  /** Transfer candidates detected from cross-goal knowledge (suggestion-only, Phase 1) */
  transfer_candidates?: TransferCandidate[];
  /** Total tokens consumed by LLM calls during this iteration (task generation + verification). */
  tokensUsed?: number;
  /**
   * When true, this iteration was skipped because no meaningful state change was
   * detected (Pillar 2: State Diff + Loop Skip). Only observation ran; gap
   * calculation, task generation, execution, and verification were bypassed.
   */
  skipped?: boolean;
  /** Reason for the skip, when skipped=true. */
  skipReason?: string;
  /** Result from Phase 7 tool-based verification (Layer 1). Present when toolExecutor is set and task has success_criteria. */
  toolVerification?: VerificationLayer1Result;
  /** Tool-based workspace evidence gathered during stall detection (Phase 6). */
  toolStallEvidence?: import("./stall-evidence.js").StallEvidence;
  /** True when stall detection was suppressed by an active WaitStrategy plateau_until. */
  waitSuppressed?: boolean;
  /** True when a WaitStrategy reached its wait_until expiry this iteration. */
  waitExpired?: boolean;
  /** Strategy ID of the active WaitStrategy, if any. */
  waitStrategyId?: string;
  /** Agentic core phase results collected during the iteration. */
  corePhaseResults?: CorePhaseIterationResult[];
  /** Deterministic scheduler directive for the next iteration of the same goal. */
  nextIterationDirective?: NextIterationDirective;
}

/**
 * Factory that returns a zeroed-out LoopIterationResult for the given goalId
 * and loopIndex. Accepts optional overrides for fields that vary per call-site.
 */
export function makeEmptyIterationResult(
  goalId: string,
  loopIndex: number,
  overrides?: Partial<LoopIterationResult>
): LoopIterationResult {
  return {
    loopIndex,
    goalId,
    gapAggregate: 0,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
    ...overrides,
  };
}

export interface LoopResult {
  goalId: string;
  totalIterations: number;
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped";
  iterations: LoopIterationResult[];
  startedAt: string;
  completedAt: string;
  /** Human-readable explanation when finalStatus is "error" */
  errorMessage?: string;
  /** Total tokens consumed across all iterations */
  tokensUsed?: number;
}
