import { resolve } from "node:path";

export type AgentLoopSandboxMode = "read_only" | "workspace_write" | "danger_full_access";
export type AgentLoopApprovalPolicy = "on_request" | "never" | "untrusted";
export type SubagentRole = "default" | "explorer" | "worker" | "reviewer";

export interface AgentLoopSecurityConfig {
  sandbox_mode?: AgentLoopSandboxMode;
  approval_policy?: AgentLoopApprovalPolicy;
  network_access?: boolean;
  protected_paths?: string[];
  trust_project_instructions?: boolean;
}

export interface ExecutionPolicy {
  sandboxMode: AgentLoopSandboxMode;
  approvalPolicy: AgentLoopApprovalPolicy;
  networkAccess: boolean;
  workspaceRoot: string;
  protectedPaths: string[];
  trustProjectInstructions: boolean;
}

export function defaultExecutionPolicy(workspaceRoot: string): ExecutionPolicy {
  return {
    sandboxMode: "workspace_write",
    approvalPolicy: "on_request",
    networkAccess: false,
    workspaceRoot: resolve(workspaceRoot),
    protectedPaths: [],
    trustProjectInstructions: true,
  };
}

export function resolveExecutionPolicy(input: {
  workspaceRoot: string;
  security?: AgentLoopSecurityConfig;
}): ExecutionPolicy {
  const base = defaultExecutionPolicy(input.workspaceRoot);
  const security = input.security;
  if (!security) return base;

  return {
    sandboxMode: security.sandbox_mode ?? base.sandboxMode,
    approvalPolicy: security.approval_policy ?? base.approvalPolicy,
    networkAccess: security.network_access ?? base.networkAccess,
    workspaceRoot: base.workspaceRoot,
    protectedPaths: [...(security.protected_paths ?? [])],
    trustProjectInstructions: security.trust_project_instructions ?? base.trustProjectInstructions,
  };
}

export function summarizeExecutionPolicy(policy: ExecutionPolicy): string {
  const lines = [
    `sandbox_mode: ${policy.sandboxMode}`,
    `approval_policy: ${policy.approvalPolicy}`,
    `network_access: ${policy.networkAccess ? "on" : "off"}`,
    `workspace_root: ${policy.workspaceRoot}`,
    `trust_project_instructions: ${policy.trustProjectInstructions ? "on" : "off"}`,
  ];
  if (policy.protectedPaths.length > 0) {
    lines.push(`protected_paths: ${policy.protectedPaths.join(", ")}`);
  }
  return lines.join("\n");
}

export function withExecutionPolicyOverrides(
  policy: ExecutionPolicy,
  overrides: Partial<Pick<ExecutionPolicy, "sandboxMode" | "approvalPolicy" | "networkAccess" | "trustProjectInstructions">>,
): ExecutionPolicy {
  return {
    ...policy,
    ...overrides,
  };
}
