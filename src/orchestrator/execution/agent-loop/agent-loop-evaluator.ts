import type { AgentLoopResult } from "./agent-loop-result.js";

export interface AgentLoopEvaluationCase<TOutput> {
  name: string;
  run: () => Promise<AgentLoopResult<TOutput>>;
  metadata?: {
    humanRepairRequired?: boolean;
    interruptedResume?: boolean;
  };
}

export interface AgentLoopEvaluationCaseResult<TOutput> {
  name: string;
  result: AgentLoopResult<TOutput>;
  passed: boolean;
  validationExecuted: boolean;
  completedWithoutHumanRepair: boolean;
  interruptedResume: boolean;
}

export interface AgentLoopEvaluationSummary<TOutput> {
  totalCases: number;
  passedCases: number;
  successRate: number;
  blockedRate: number;
  timeoutRate: number;
  repeatedLoopRate: number;
  validationExecutionRate: number;
  completedWithoutHumanRepairRate: number;
  interruptedResumeSuccessRate: number;
  avgModelTurns: number;
  avgToolCalls: number;
  avgCompactions: number;
  results: AgentLoopEvaluationCaseResult<TOutput>[];
}

export async function evaluateAgentLoopCases<TOutput>(
  cases: readonly AgentLoopEvaluationCase<TOutput>[],
): Promise<AgentLoopEvaluationSummary<TOutput>> {
  const results: AgentLoopEvaluationCaseResult<TOutput>[] = [];

  for (const testCase of cases) {
    const result = await testCase.run();
    const validationExecuted = result.commandResults.some((entry) => entry.success && entry.evidenceEligible);
    const interruptedResume = testCase.metadata?.interruptedResume === true;
    results.push({
      name: testCase.name,
      result,
      passed: result.success,
      validationExecuted,
      interruptedResume,
      completedWithoutHumanRepair: result.success && testCase.metadata?.humanRepairRequired !== true,
    });
  }

  const totalCases = results.length;
  const passedCases = results.filter((entry) => entry.passed).length;
  const blockedCases = results.filter((entry) =>
    entry.result.stopReason === "schema_error"
    || entry.result.stopReason === "stalled_tool_loop"
    || entry.result.stopReason === "consecutive_tool_errors",
  ).length;
  const timeoutCases = results.filter((entry) => entry.result.stopReason === "timeout").length;
  const repeatedLoopCases = results.filter((entry) => entry.result.stopReason === "stalled_tool_loop").length;
  const validationExecutedCases = results.filter((entry) => entry.validationExecuted).length;
  const completedWithoutHumanRepairCases = results.filter((entry) => entry.completedWithoutHumanRepair).length;
  const interruptedResumeCases = results.filter((entry) => entry.interruptedResume).length;
  const interruptedResumePassedCases = results.filter((entry) => entry.interruptedResume && entry.passed).length;

  return {
    totalCases,
    passedCases,
    successRate: totalCases === 0 ? 0 : passedCases / totalCases,
    blockedRate: totalCases === 0 ? 0 : blockedCases / totalCases,
    timeoutRate: totalCases === 0 ? 0 : timeoutCases / totalCases,
    repeatedLoopRate: totalCases === 0 ? 0 : repeatedLoopCases / totalCases,
    validationExecutionRate: totalCases === 0 ? 0 : validationExecutedCases / totalCases,
    completedWithoutHumanRepairRate: totalCases === 0 ? 0 : completedWithoutHumanRepairCases / totalCases,
    interruptedResumeSuccessRate: interruptedResumeCases === 0 ? 0 : interruptedResumePassedCases / interruptedResumeCases,
    avgModelTurns: totalCases === 0 ? 0 : average(results.map((entry) => entry.result.modelTurns)),
    avgToolCalls: totalCases === 0 ? 0 : average(results.map((entry) => entry.result.toolCalls)),
    avgCompactions: totalCases === 0 ? 0 : average(results.map((entry) => entry.result.compactions)),
    results,
  };
}

export interface AgentLoopRolloutCriteria {
  minSuccessRate: number;
  minValidationExecutionRate: number;
  maxRepeatedLoopRate: number;
  minInterruptedResumeSuccessRate: number;
}

export interface AgentLoopRolloutAssessment {
  ready: boolean;
  reasons: string[];
}

export const defaultAgentLoopRolloutCriteria: AgentLoopRolloutCriteria = {
  minSuccessRate: 0.8,
  minValidationExecutionRate: 0.7,
  maxRepeatedLoopRate: 0.1,
  minInterruptedResumeSuccessRate: 0.8,
};

export function assessAgentLoopRolloutReadiness<TOutput>(
  summary: AgentLoopEvaluationSummary<TOutput>,
  criteria: Partial<AgentLoopRolloutCriteria> = {},
): AgentLoopRolloutAssessment {
  const resolved = { ...defaultAgentLoopRolloutCriteria, ...criteria };
  const reasons: string[] = [];

  if (summary.successRate < resolved.minSuccessRate) {
    reasons.push(`successRate ${summary.successRate.toFixed(2)} < ${resolved.minSuccessRate.toFixed(2)}`);
  }
  if (summary.validationExecutionRate < resolved.minValidationExecutionRate) {
    reasons.push(`validationExecutionRate ${summary.validationExecutionRate.toFixed(2)} < ${resolved.minValidationExecutionRate.toFixed(2)}`);
  }
  if (summary.repeatedLoopRate > resolved.maxRepeatedLoopRate) {
    reasons.push(`repeatedLoopRate ${summary.repeatedLoopRate.toFixed(2)} > ${resolved.maxRepeatedLoopRate.toFixed(2)}`);
  }
  if (summary.results.some((entry) => entry.interruptedResume)
    && summary.interruptedResumeSuccessRate < resolved.minInterruptedResumeSuccessRate) {
    reasons.push(`interruptedResumeSuccessRate ${summary.interruptedResumeSuccessRate.toFixed(2)} < ${resolved.minInterruptedResumeSuccessRate.toFixed(2)}`);
  }

  return {
    ready: reasons.length === 0,
    reasons,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
