import { z } from "zod";
import type { AgentResult } from "../adapter-layer.js";
import type { AgentLoopResult } from "./agent-loop-result.js";

export const TaskAgentLoopOutputSchema = z.object({
  status: z.enum(["done", "blocked", "partial", "failed"]),
  finalAnswer: z.string(),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  testsRun: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    outputSummary: z.string(),
  })).default([]),
  completionEvidence: z.array(z.string()).default([]),
  verificationHints: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});

export type TaskAgentLoopOutput = z.infer<typeof TaskAgentLoopOutputSchema>;

export function taskAgentLoopResultToAgentResult(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): AgentResult {
  const done = result.success && result.output?.status === "done";
  const runtimeVerificationCommands = result.commandResults.filter((command) =>
    command.evidenceEligible && command.relevantToTask !== false
  );
  const fallbackOutput = result.output?.finalAnswer
    ?? result.finalText
    ?? result.output?.blockers.join("; ")
    ?? result.stopReason;
  return {
    success: done,
    output: fallbackOutput,
    error: done ? null : result.output?.blockers.join("; ") || result.finalText || result.stopReason,
    exit_code: null,
    elapsed_ms: result.elapsedMs,
    stopped_reason:
      result.stopReason === "timeout" ? "timeout" :
      done ? "completed" : "error",
    filesChanged: result.changedFiles.length > 0 || (result.output ? result.output.filesChanged.length > 0 : result.filesChanged),
    agentLoop: {
      traceId: result.traceId,
      sessionId: result.sessionId,
      turnId: result.turnId,
      stopReason: result.stopReason,
      modelTurns: result.modelTurns,
      toolCalls: result.toolCalls,
      compactions: result.compactions,
      completionEvidence: [
        ...(result.output?.completionEvidence ?? []),
        ...runtimeVerificationCommands.filter((command) => command.success).map((command) => `verified command: ${command.command}`),
      ],
      verificationHints: [
        ...(result.output?.verificationHints ?? []),
        ...runtimeVerificationCommands.filter((command) => !command.success).map((command) => `failed command: ${command.command}`),
      ],
      filesChangedPaths: [...new Set([...(result.output?.filesChanged ?? []), ...result.changedFiles])],
      ...(result.workspace
        ? {
            requestedCwd: result.workspace.requestedCwd,
            executionCwd: result.workspace.executionCwd,
            isolatedWorkspace: result.workspace.isolated,
            workspaceCleanupStatus: result.workspace.cleanupStatus,
            workspaceCleanupReason: result.workspace.cleanupReason,
          }
        : {}),
    },
  };
}
