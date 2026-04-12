import type { CorePhaseKind } from "../../execution/agent-loop/core-phase-runner.js";
import type { CorePhaseIterationResult } from "../loop-result-types.js";

export interface CoreLoopRecordedPhase {
  phase: CorePhaseKind;
  status: CorePhaseIterationResult["status"];
  summary?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  stopReason?: string;
  lowConfidence?: boolean;
  error?: string;
}

export class CoreLoopEvidenceLedger {
  private readonly phases = new Map<CorePhaseKind, CoreLoopRecordedPhase>();

  record(phase: CoreLoopRecordedPhase): void {
    this.phases.set(phase.phase, phase);
  }

  toIterationPhaseResults(): CorePhaseIterationResult[] {
    return [...this.phases.values()];
  }

  augmentKnowledgeContext(input?: string): string | undefined {
    const extraBlocks: string[] = [];
    for (const phase of ["knowledge_refresh", "replanning_options", "verification_evidence"] as const) {
      const record = this.phases.get(phase);
      if (!record?.summary) continue;
      extraBlocks.push(`[${phase}]\n${record.summary}`);
    }
    return this.append(input, extraBlocks);
  }

  augmentWorkspaceContext(input?: string): string | undefined {
    const extraBlocks: string[] = [];
    for (const phase of ["observe_evidence", "stall_investigation"] as const) {
      const record = this.phases.get(phase);
      if (!record?.summary) continue;
      extraBlocks.push(`[${phase}]\n${record.summary}`);
    }
    return this.append(input, extraBlocks);
  }

  private append(input: string | undefined, blocks: string[]): string | undefined {
    if (blocks.length === 0) return input;
    const addition = blocks.join("\n\n");
    return input ? `${input}\n\n${addition}` : addition;
  }
}
