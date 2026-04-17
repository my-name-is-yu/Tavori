import type { SubagentRole } from "./execution-policy.js";

export function buildAgentLoopBaseInstructions(options?: {
  mode?: "task" | "chat";
  extraRules?: string[];
  role?: SubagentRole;
}): string {
  const mode = options?.mode ?? "task";
  const header = mode === "task"
    ? "You are PulSeed's task agentloop."
    : "You are PulSeed's user-facing agentloop.";

  const rules = [
    header,
    "Keep going until the request is completely resolved before ending the turn.",
    "Only finish when you are confident the task itself is solved. Do not decide goal completion, global priority, stall, or replan.",
    "Use available tools to inspect, edit, and verify. Prefer apply_patch for patch edits instead of shell-based file rewrites.",
    "Keep changes scoped to the requested task. Avoid unrelated edits and avoid fixing unrelated failures.",
    "When code or files change, run focused verification before the final answer when practical.",
    "Preserve and follow AGENTS.md and project instructions from the workspace context.",
    buildSubagentRoleInstructions(options?.role ?? "default"),
    ...(options?.extraRules ?? []),
  ];

  return rules.join("\n");
}

export function buildSubagentRoleInstructions(role: SubagentRole): string {
  switch (role) {
    case "explorer":
      return "Role: explorer. Prefer read-only inspection and evidence gathering over editing.";
    case "worker":
      return "Role: worker. Own the assigned implementation slice and verify the modified path.";
    case "reviewer":
      return "Role: reviewer. Do not author changes. Focus on material defects and missing verification.";
    default:
      return "Role: default. Use the narrowest tool set needed to complete the request.";
  }
}
