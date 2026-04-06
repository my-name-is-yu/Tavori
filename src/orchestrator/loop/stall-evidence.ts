/**
 * stall-evidence.ts — Tool-based evidence gathering for stall detection.
 */
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";

export interface StallEvidence {
  hasWorkspaceChanges: boolean;
  targetArtifactsExist: boolean;
  toolErrors: string[];
}

export async function gatherStallEvidence(
  toolExecutor: ToolExecutor,
  toolContext: ToolCallContext,
  workspacePath?: string,
  targetPattern?: string,
): Promise<StallEvidence> {
  const evidence: StallEvidence = {
    hasWorkspaceChanges: true, // default optimistic
    targetArtifactsExist: true,
    toolErrors: [],
  };

  // Check git-diff for workspace changes
  try {
    const diffResult = await toolExecutor.execute(
      "git-diff",
      { target: "unstaged", path: workspacePath ?? "." },
      toolContext,
    );
    if (diffResult.success) {
      const output = typeof diffResult.data === "string" ? diffResult.data : "";
      evidence.hasWorkspaceChanges = output.trim().length > 0;
    }
  } catch (err) {
    evidence.toolErrors.push(`git-diff: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check glob for target artifacts
  if (targetPattern) {
    try {
      const globResult = await toolExecutor.execute(
        "glob",
        { pattern: targetPattern },
        toolContext,
      );
      if (globResult.success) {
        const output = typeof globResult.data === "string" ? globResult.data : "";
        evidence.targetArtifactsExist = output.trim().length > 0;
      }
    } catch (err) {
      evidence.toolErrors.push(`glob: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return evidence;
}
