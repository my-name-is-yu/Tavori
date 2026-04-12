import { describe, expect, it } from "vitest";
import {
  classifyAgentLoopCommandResult,
  taskAgentLoopResultToAgentResult,
} from "../index.js";

describe("classifyAgentLoopCommandResult", () => {
  it("marks focused verification commands as evidence-eligible", () => {
    expect(classifyAgentLoopCommandResult({ toolName: "shell_command", command: "test -f src/app.ts" })).toMatchObject({
      category: "verification",
      evidenceEligible: true,
    });
    expect(classifyAgentLoopCommandResult({ toolName: "verify", command: "custom check" })).toMatchObject({
      category: "verification",
      evidenceEligible: true,
    });
  });

  it("does not treat generic observation commands as completion evidence", () => {
    expect(classifyAgentLoopCommandResult({ toolName: "shell_command", command: "pwd" })).toMatchObject({
      category: "observation",
      evidenceEligible: false,
    });
  });
});

describe("taskAgentLoopResultToAgentResult command evidence filtering", () => {
  it("only promotes verification-eligible command results into completion evidence", () => {
    const agentResult = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "",
      stopReason: "completed",
      elapsedMs: 10,
      modelTurns: 2,
      toolCalls: 2,
      compactions: 0,
      filesChanged: false,
      changedFiles: [],
      commandResults: [
        {
          toolName: "shell_command",
          command: "pwd",
          cwd: "/tmp",
          success: true,
          category: "observation",
          evidenceEligible: false,
          outputSummary: "Command succeeded",
          durationMs: 1,
        },
        {
          toolName: "shell_command",
          command: "test -f src/app.ts",
          cwd: "/tmp",
          success: true,
          category: "verification",
          evidenceEligible: true,
          outputSummary: "Command succeeded",
          durationMs: 1,
        },
      ],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(agentResult.agentLoop?.completionEvidence).toEqual(["verified command: test -f src/app.ts"]);
  });
});
