import type { CorePhaseRunner, CorePhaseSpec } from "../../execution/agent-loop/core-phase-runner.js";
import type { AgentLoopToolPolicy } from "../../execution/agent-loop/agent-loop-turn-context.js";
import type { CorePhasePolicyRegistry } from "./phase-policy.js";
import type { CorePhaseInvocationContext } from "./phase-specs.js";

export interface CorePhaseExecution<TOutput> {
  phase: CorePhaseSpec<unknown, TOutput>["phase"];
  status: "skipped" | "completed" | "low_confidence" | "failed";
  output?: TOutput;
  summary?: string;
  lowConfidence?: boolean;
  error?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  stopReason?: string;
}

export interface CorePhaseRuntimeDeps {
  phaseRunner?: CorePhaseRunner;
  policyRegistry: CorePhasePolicyRegistry;
}

export class CorePhaseRuntime {
  constructor(private readonly deps: CorePhaseRuntimeDeps) {}

  async run<TInput, TOutput>(
    spec: CorePhaseSpec<TInput, TOutput> & { runWhen?: (ctx: CorePhaseInvocationContext) => boolean },
    input: TInput,
    context: CorePhaseInvocationContext,
  ): Promise<CorePhaseExecution<TOutput>> {
    const policy = this.deps.policyRegistry.get(spec.phase);
    if (!this.deps.phaseRunner || !policy.enabled || (spec.runWhen && !spec.runWhen(context))) {
      return { phase: spec.phase, status: "skipped" };
    }

    const toolPolicy: AgentLoopToolPolicy = {
      allowedTools: policy.allowedTools.length > 0 ? policy.allowedTools : spec.allowedTools,
      requiredTools: policy.requiredTools.length > 0 ? policy.requiredTools : spec.requiredTools,
    };

    try {
      const result = await this.deps.phaseRunner.run(
        {
          ...spec,
          allowedTools: toolPolicy.allowedTools ?? [],
          requiredTools: toolPolicy.requiredTools ?? [],
          budget: policy.budget,
          failPolicy: policy.failPolicy,
        },
        input,
        { goalId: context.goalId, ...(context.taskId ? { taskId: context.taskId } : {}), toolPolicy },
      );
      const summary = this.summarize(result.output);
      const lowConfidence = this.isLowConfidence(result.output);
      return {
        phase: spec.phase,
        status: lowConfidence ? "low_confidence" : result.success ? "completed" : "failed",
        ...(result.output ? { output: result.output } : {}),
        ...(summary ? { summary } : {}),
        ...(lowConfidence ? { lowConfidence } : {}),
        traceId: result.traceId,
        sessionId: result.sessionId,
        turnId: result.turnId,
        stopReason: result.stopReason,
      };
    } catch (err) {
      return {
        phase: spec.phase,
        status: policy.failPolicy === "return_low_confidence" ? "low_confidence" : "failed",
        lowConfidence: policy.failPolicy === "return_low_confidence",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private summarize(output: unknown): string | undefined {
    if (!output || typeof output !== "object") return undefined;
    const candidate = output as Record<string, unknown>;
    if (typeof candidate["summary"] === "string" && candidate["summary"].trim().length > 0) {
      return candidate["summary"];
    }
    return JSON.stringify(output);
  }

  private isLowConfidence(output: unknown): boolean {
    if (!output || typeof output !== "object") return false;
    const value = (output as Record<string, unknown>)["confidence"];
    return typeof value === "number" && value < 0.5;
  }
}
