import { describe, expect, it, vi } from "vitest";
import { CorePhaseRuntime } from "../core-loop/phase-runtime.js";
import { StaticCorePhasePolicyRegistry } from "../core-loop/phase-policy.js";
import { buildObserveEvidenceSpec } from "../core-loop/phase-specs.js";

describe("CorePhaseRuntime", () => {
  it("returns skipped when no corePhaseRunner is configured", async () => {
    const runtime = new CorePhaseRuntime({
      policyRegistry: new StaticCorePhasePolicyRegistry(),
    });

    const result = await runtime.run(
      {
        ...buildObserveEvidenceSpec(),
        requiredTools: [],
        allowedTools: [],
        budget: {},
      },
      {
        goalTitle: "Goal",
        goalDescription: "Desc",
        dimensions: ["dim1"],
      },
      { goalId: "goal-1" },
    );

    expect(result.status).toBe("skipped");
  });

  it("marks low confidence outputs", async () => {
    const phaseRunner = {
      run: vi.fn().mockResolvedValue({
        success: true,
        output: {
          summary: "weak evidence",
          evidence: [],
          missing_info: ["more data"],
          confidence: 0.2,
        },
        finalText: "",
        stopReason: "completed",
        elapsedMs: 0,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    };
    const runtime = new CorePhaseRuntime({
      phaseRunner: phaseRunner as never,
      policyRegistry: new StaticCorePhasePolicyRegistry(),
    });

    const result = await runtime.run(
      {
        ...buildObserveEvidenceSpec(),
        requiredTools: [],
        allowedTools: [],
        budget: {},
      },
      {
        goalTitle: "Goal",
        goalDescription: "Desc",
        dimensions: ["dim1"],
      },
      { goalId: "goal-1" },
    );

    expect(result.status).toBe("low_confidence");
    expect(result.summary).toBe("weak evidence");
    expect(phaseRunner.run).toHaveBeenCalledOnce();
  });
});
