import { describe, expect, it } from "vitest";
import {
  assessAgentLoopRolloutReadiness,
  evaluateAgentLoopCases,
} from "../agent-loop-evaluator.js";

describe("evaluateAgentLoopCases", () => {
  it("summarizes success, blocked, timeout, and averages across cases", async () => {
    const summary = await evaluateAgentLoopCases([
      {
        name: "success-case",
        metadata: { interruptedResume: true },
        run: async () => ({
          success: true,
          output: null,
          finalText: "ok",
          stopReason: "completed",
          elapsedMs: 10,
          modelTurns: 2,
          toolCalls: 1,
          compactions: 0,
          filesChanged: false,
          changedFiles: [],
          commandResults: [{
            toolName: "verify",
            command: "test -f src/app.ts",
            cwd: "/tmp",
            success: true,
            category: "verification",
            evidenceEligible: true,
            relevantToTask: true,
            outputSummary: "ok",
            durationMs: 1,
          }],
          traceId: "trace-1",
          sessionId: "session-1",
          turnId: "turn-1",
        }),
      },
      {
        name: "blocked-case",
        run: async () => ({
          success: false,
          output: null,
          finalText: "",
          stopReason: "stalled_tool_loop",
          elapsedMs: 20,
          modelTurns: 4,
          toolCalls: 4,
          compactions: 1,
          filesChanged: false,
          changedFiles: [],
          commandResults: [],
          traceId: "trace-2",
          sessionId: "session-2",
          turnId: "turn-2",
        }),
      },
      {
        name: "timeout-case",
        metadata: { humanRepairRequired: true, interruptedResume: true },
        run: async () => ({
          success: false,
          output: null,
          finalText: "",
          stopReason: "timeout",
          elapsedMs: 30,
          modelTurns: 3,
          toolCalls: 2,
          compactions: 0,
          filesChanged: false,
          changedFiles: [],
          commandResults: [],
          traceId: "trace-3",
          sessionId: "session-3",
          turnId: "turn-3",
        }),
      },
    ]);

    expect(summary.totalCases).toBe(3);
    expect(summary.passedCases).toBe(1);
    expect(summary.successRate).toBeCloseTo(1 / 3);
    expect(summary.blockedRate).toBeCloseTo(1 / 3);
    expect(summary.timeoutRate).toBeCloseTo(1 / 3);
    expect(summary.repeatedLoopRate).toBeCloseTo(1 / 3);
    expect(summary.validationExecutionRate).toBeCloseTo(1 / 3);
    expect(summary.completedWithoutHumanRepairRate).toBeCloseTo(1 / 3);
    expect(summary.interruptedResumeSuccessRate).toBeCloseTo(1 / 2);
    expect(summary.avgModelTurns).toBe(3);
    expect(summary.avgToolCalls).toBeCloseTo(7 / 3);
    expect(summary.avgCompactions).toBeCloseTo(1 / 3);
  });

  it("assesses rollout readiness against explicit criteria", () => {
    const assessment = assessAgentLoopRolloutReadiness({
      totalCases: 2,
      passedCases: 2,
      successRate: 1,
      blockedRate: 0,
      timeoutRate: 0,
      repeatedLoopRate: 0,
      validationExecutionRate: 1,
      completedWithoutHumanRepairRate: 1,
      interruptedResumeSuccessRate: 1,
      avgModelTurns: 2,
      avgToolCalls: 1,
      avgCompactions: 0,
      results: [],
    });

    expect(assessment.ready).toBe(true);
    expect(assessment.reasons).toEqual([]);
  });
});
