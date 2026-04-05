import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import type { TrustManager } from "../../platform/traits/trust-manager.js";

export const ResetTrustInputSchema = z.object({
  domain: z.string().min(1, "domain is required"),
  balance: z.number().min(-100).max(100),
  reason: z.string().optional(),
});
export type ResetTrustInput = z.infer<typeof ResetTrustInputSchema>;

export class ResetTrustTool implements ITool<ResetTrustInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "reset_trust",
    aliases: ["override_trust", "set_trust"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: true,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: ["mutation", "trust", "state", "destructive"],
  };
  readonly inputSchema = ResetTrustInputSchema;

  constructor(private readonly trustManager: TrustManager) {}

  description(_context?: ToolDescriptionContext): string {
    return "Override the trust balance for a domain. IRREVERSIBLE — the trust history is lost after reset.";
  }

  async call(input: ResetTrustInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      if (!context.preApproved) {
        const reason = input.reason ?? "manual override";
        const approved = await context.approvalFn({
          toolName: this.metadata.name,
          input,
          reason: "Reset trust for domain \"" + input.domain + "\" to " + input.balance + ": " + reason,
          permissionLevel: "write_local",
          isDestructive: true,
          reversibility: "irreversible",
        });
        if (!approved) {
          return {
            success: false,
            data: null,
            summary: "Trust reset denied by user",
            error: "User denied trust reset",
            durationMs: Date.now() - startTime,
          };
        }
      }

      const reason = input.reason ?? "manual override via tool";
      await this.trustManager.setOverride(input.domain, input.balance, reason);
      return {
        success: true,
        data: { domain: input.domain, balance: input.balance },
        summary: "Trust reset: domain=" + input.domain + ", balance=" + input.balance,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ResetTrustTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ResetTrustInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Resetting trust balance is irreversible and requires user confirmation",
    };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
