import type {
  ITool,
  ToolCallContext,
  PermissionCheckResult,
  ToolPermissionLevel,
} from "./types.js";

/**
 * 3-layer permission model for tool invocations.
 *
 * Layer 1: Registry deny-list (static rules, no computation). Deny beats allow.
 * Layer 2: Per-call permission check (trust-based + EthicsGate integration)
 * Layer 3: Interactive approval prompt (for operations that need user consent)
 */
export class ToolPermissionManager {
  private readonly denyList: PermissionRule[] = [];
  private readonly allowList: PermissionRule[] = [];
  private readonly ethicsGate?: EthicsGateInterface;
  private readonly trustManager?: TrustManagerInterface;

  constructor(deps: PermissionManagerDeps) {
    this.ethicsGate = deps.ethicsGate;
    this.trustManager = deps.trustManager;
    this.denyList = deps.denyRules ?? [];
    this.allowList = deps.allowRules ?? [];
  }

  async check(
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    // --- Layer 1: Registry Deny-List ---
    for (const rule of this.denyList) {
      if (this.ruleMatches(rule, tool, input, context)) {
        return { status: "denied", reason: rule.reason };
      }
    }

    // Read-only tools are always allowed after deny-list check
    if (tool.metadata.isReadOnly) {
      return { status: "allowed" };
    }

    // --- Layer 2: Trust-Based + EthicsGate ---
    const trustBalance = context.trustBalance;
    const requiredTrust = this.getRequiredTrust(tool.metadata.permissionLevel);
    if (trustBalance < requiredTrust) {
      return {
        status: "needs_approval",
        reason: `Trust balance (${trustBalance}) below threshold (${requiredTrust}) for ${tool.metadata.permissionLevel} operations`,
      };
    }

    // EthicsGate integration for non-read-only tools (shell and future write tools)
    if ((tool.metadata.name === "shell" || tool.metadata.permissionLevel !== "read_only") && this.ethicsGate) {
      const description = `Tool "${tool.metadata.name}" invocation: ${JSON.stringify(input).slice(0, 200)}`;
      try {
        const ethicsResult = await this.ethicsGate.check("task", context.goalId, description);
        if (ethicsResult.verdict === "reject") {
          return {
            status: "denied",
            reason: `EthicsGate rejected: ${ethicsResult.reason}`,
          };
        }
      } catch {
        return {
          status: "needs_approval",
          reason: "EthicsGate evaluation failed; manual approval required",
        };
      }
    }

    // --- Layer 3: Allow-List / Default ---
    for (const rule of this.allowList) {
      if (this.ruleMatches(rule, tool, input, context)) {
        return { status: "allowed" };
      }
    }

    // Default for read_metrics: needs approval unless allow-listed
    if (tool.metadata.permissionLevel === "read_metrics") {
      return {
        status: "needs_approval",
        reason: `Shell command requires approval: ${JSON.stringify(input).slice(0, 100)}`,
      };
    }

    return { status: "allowed" };
  }

  addDenyRule(rule: PermissionRule): void {
    this.denyList.push(rule);
  }

  addAllowRule(rule: PermissionRule): void {
    this.allowList.push(rule);
  }

  // --- Private ---

  private getRequiredTrust(level: ToolPermissionLevel): number {
    switch (level) {
      case "read_only": return -100;
      case "read_metrics": return -50;
      case "write_local": return -20;
      case "execute": return 0;
      case "write_remote": return 10;
    }
  }

  private ruleMatches(
    rule: PermissionRule,
    tool: ITool,
    input: unknown,
    context: ToolCallContext,
  ): boolean {
    if (rule.toolName && rule.toolName !== tool.metadata.name) return false;
    if (rule.permissionLevel && rule.permissionLevel !== tool.metadata.permissionLevel) return false;
    if (rule.inputMatcher && !rule.inputMatcher(input)) return false;
    if (rule.goalId && rule.goalId !== context.goalId) return false;
    return true;
  }
}

// --- Supporting Types ---

// Minimal interfaces to avoid hard dependency on EthicsGate/TrustManager
export interface EthicsGateInterface {
  check(subjectType: string, subjectId: string, description: string, context?: string): Promise<{ verdict: string; reason: string }>;
}

export interface TrustManagerInterface {
  // Placeholder for future trust-based features
}

export interface PermissionManagerDeps {
  ethicsGate?: EthicsGateInterface;
  trustManager?: TrustManagerInterface;
  denyRules?: PermissionRule[];
  allowRules?: PermissionRule[];
}

export interface PermissionRule {
  toolName?: string;
  permissionLevel?: ToolPermissionLevel;
  inputMatcher?: (input: unknown) => boolean;
  goalId?: string;
  reason: string;
}
