import { describe, expect, it } from "vitest";
import { CoreDecisionEngine } from "../core-loop/decision-engine.js";
import type { LoopIterationResult } from "../loop-result-types.js";

function makeIterationResult(overrides: Partial<LoopIterationResult> = {}): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0.4,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
    ...overrides,
  };
}

describe("CoreDecisionEngine", () => {
  it("stops as completed only after minIterations is satisfied", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateRunDecision({
      iterationResult: makeIterationResult({
        completionJudgment: {
          is_complete: true,
          blocking_dimensions: [],
          low_confidence_dimensions: [],
          needs_verification_task: false,
          checked_at: new Date().toISOString(),
        },
      }),
      loopIndex: 1,
      minIterations: 2,
      maxConsecutiveErrors: 3,
      counters: {
        consecutiveErrors: 0,
        consecutiveDenied: 0,
        consecutiveEscalations: 0,
      },
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.finalStatus).toBe("completed");
  });

  it("stops as stalled when escalation level reaches 3", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateRunDecision({
      iterationResult: makeIterationResult({
        stallDetected: true,
        stallReport: {
          stall_type: "dimension_stall",
          goal_id: "goal-1",
          dimension_name: "dim1",
          task_id: null,
          detected_at: new Date().toISOString(),
          escalation_level: 3,
          suggested_cause: "approach_failure",
          decay_factor: 0.5,
        },
      }),
      loopIndex: 0,
      minIterations: 1,
      maxConsecutiveErrors: 3,
      counters: {
        consecutiveErrors: 0,
        consecutiveDenied: 0,
        consecutiveEscalations: 0,
      },
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.finalStatus).toBe("stalled");
  });

  it("requests knowledge acquisition only for worthwhile high-confidence refresh evidence", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateKnowledgeAcquisition({
      phase: {
        status: "completed",
        output: {
          summary: "Need migration constraints",
          required_knowledge: ["Database migration constraints"],
          acquisition_candidates: ["soil lookup"],
          confidence: 0.82,
          worthwhile: true,
        },
      },
      hasKnowledgeManager: true,
      hasToolExecutor: true,
    });

    expect(decision.shouldAcquire).toBe(true);
    expect(decision.question).toContain("Database migration constraints");
  });

  it("does not request knowledge acquisition for low-confidence refresh evidence", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateKnowledgeAcquisition({
      phase: {
        status: "low_confidence",
        output: {
          summary: "Maybe need more info",
          required_knowledge: ["Something vague"],
          acquisition_candidates: [],
          confidence: 0.4,
          worthwhile: true,
        },
      },
      hasKnowledgeManager: true,
      hasToolExecutor: true,
    });

    expect(decision.shouldAcquire).toBe(false);
  });

  it("builds task generation hints from high-confidence replanning evidence", () => {
    const engine = new CoreDecisionEngine();
    const hints = engine.buildTaskGenerationHints({
      phase: {
        status: "completed",
        output: {
          summary: "Prefer the focused path",
          recommended_action: "pivot",
          candidates: [
            {
              title: "Patch dim1 first",
              rationale: "smallest fix",
              expected_evidence_gain: "high",
              blast_radius: "low",
              target_dimensions: ["dim1"],
              dependencies: [],
            },
          ],
          confidence: 0.9,
        },
      },
      goalDimensions: ["dim1", "dim2"],
    });

    expect(hints.targetDimensionOverride).toBe("dim1");
    expect(hints.knowledgeContextPrefix).toContain("Replanning directive:");
    expect(hints.knowledgeContextPrefix).toContain("Patch dim1 first");
  });

  it("builds stall action hints from high-confidence replanning evidence", () => {
    const engine = new CoreDecisionEngine();
    const hints = engine.buildStallActionHints({
      phase: {
        status: "completed",
        output: {
          summary: "Stay on current course",
          recommended_action: "continue",
          candidates: [
            {
              title: "Keep current path",
              rationale: "smallest change",
              expected_evidence_gain: "medium",
              blast_radius: "low",
              target_dimensions: [],
              dependencies: [],
            },
          ],
          confidence: 0.9,
        },
      },
    });

    expect(hints.recommendedAction).toBe("continue");
  });

  it("builds next-iteration directive from replanning evidence", () => {
    const engine = new CoreDecisionEngine();
    const directive = engine.buildNextIterationDirective({
      knowledgeRefreshPhase: null,
      replanningPhase: {
        status: "completed",
        output: {
          summary: "Shift to dim1",
          recommended_action: "pivot",
          candidates: [
            {
              title: "Focus dim1",
              rationale: "best payoff",
              expected_evidence_gain: "high",
              blast_radius: "low",
              target_dimensions: ["dim1"],
              dependencies: [],
            },
          ],
          confidence: 0.9,
        },
      },
      goalDimensions: ["dim1", "dim2"],
      fallbackFocusDimension: "dim2",
    });

    expect(directive).toEqual(
      expect.objectContaining({
        sourcePhase: "replanning_options",
        focusDimension: "dim1",
        preferredAction: "pivot",
      })
    );
  });
});
