import type { CorePhaseKind } from "../../execution/agent-loop/core-phase-runner.js";
import type { AgentLoopBudget } from "../../execution/agent-loop/agent-loop-budget.js";

export interface CorePhasePolicy {
  enabled: boolean;
  maxInvocationsPerIteration: number;
  budget: Partial<AgentLoopBudget>;
  allowedTools: readonly string[];
  requiredTools: readonly string[];
  failPolicy: "return_low_confidence" | "fallback_deterministic" | "fail_cycle";
}

export interface CorePhasePolicyRegistry {
  get(phase: CorePhaseKind): CorePhasePolicy;
}

const DEFAULT_POLICY: CorePhasePolicy = {
  enabled: false,
  maxInvocationsPerIteration: 1,
  budget: {
    maxModelTurns: 6,
    maxToolCalls: 12,
    maxWallClockMs: 90_000,
    maxConsecutiveToolErrors: 2,
    maxRepeatedToolCalls: 2,
    maxSchemaRepairAttempts: 1,
    maxCompletionValidationAttempts: 1,
    maxCompactions: 1,
    compactionMaxMessages: 6,
  },
  allowedTools: [],
  requiredTools: [],
  failPolicy: "fallback_deterministic",
};

export const defaultCorePhasePolicies: Record<CorePhaseKind, CorePhasePolicy> = {
  observe_evidence: {
    ...DEFAULT_POLICY,
    enabled: true,
    allowedTools: [
      "read_pulseed_file",
      "glob",
      "grep",
      "git_log",
      "shell_command",
      "soil_query",
      "tool_search",
    ],
  },
  knowledge_refresh: {
    ...DEFAULT_POLICY,
    enabled: true,
    allowedTools: [
      "soil_query",
      "knowledge_query",
      "memory_recall",
      "glob",
      "grep",
      "read_pulseed_file",
    ],
    requiredTools: ["soil_query"],
    failPolicy: "return_low_confidence",
  },
  stall_investigation: {
    ...DEFAULT_POLICY,
    enabled: true,
    allowedTools: [
      "progress_history",
      "session_history",
      "git_log",
      "shell_command",
      "soil_query",
      "task_get",
    ],
    failPolicy: "return_low_confidence",
  },
  replanning_options: {
    ...DEFAULT_POLICY,
    enabled: false,
    allowedTools: [
      "task_get",
      "goal_state",
      "soil_query",
      "read_plan",
      "session_history",
      "memory_recall",
    ],
    failPolicy: "fallback_deterministic",
  },
  verification_evidence: {
    ...DEFAULT_POLICY,
    enabled: true,
    allowedTools: [
      "test_runner",
      "shell_command",
      "git_diff",
      "read_pulseed_file",
      "grep",
      "soil_query",
    ],
    failPolicy: "fallback_deterministic",
  },
};

export class StaticCorePhasePolicyRegistry implements CorePhasePolicyRegistry {
  constructor(
    private readonly policies: Partial<Record<CorePhaseKind, CorePhasePolicy>> = defaultCorePhasePolicies,
  ) {}

  get(phase: CorePhaseKind): CorePhasePolicy {
    return this.policies[phase] ?? DEFAULT_POLICY;
  }
}
