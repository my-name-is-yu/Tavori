import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { HIGH_TRUST_THRESHOLD } from "../../../platform/traits/types/trust.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const TrustStateInputSchema = z.object({
  adapterId: z.string().optional(),
});
export type TrustStateInput = z.infer<typeof TrustStateInputSchema>;

const TRUST_STORE_PATH = "trust/trust-store.json";

interface TrustStore {
  balances: Record<string, { domain: string; balance: number; success_delta: number; failure_delta: number }>;
  override_log?: Array<{ timestamp: string; override_type: string; domain: string; balance_before: number | null; balance_after: number | null }>;
}

export class TrustStateTool implements ITool<TrustStateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "trust_state",
    aliases: ["get_trust_state", "observe_trust"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = TrustStateInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TrustStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const raw = await this.stateManager.readRaw(TRUST_STORE_PATH) as TrustStore | null;
      const store: TrustStore = raw ?? { balances: {}, override_log: [] };

      if (input.adapterId) {
        return this._singleAdapter(input.adapterId, store, startTime);
      }
      return this._allAdapters(store, startTime);
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TrustStateTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private _singleAdapter(adapterId: string, store: TrustStore, startTime: number): ToolResult {
    const balance = store.balances[adapterId] ?? { domain: adapterId, balance: 0, success_delta: 3, failure_delta: -10 };
    const recentEvents = (store.override_log ?? [])
      .filter((e) => e.domain === adapterId)
      .slice(-10)
      .map((e) => ({
        delta: e.balance_after != null && e.balance_before != null ? e.balance_after - e.balance_before : null,
        reason: e.override_type,
        timestamp: e.timestamp,
      }));

    return {
      success: true,
      data: {
        adapterId,
        balance: balance.balance,
        highTrust: balance.balance >= HIGH_TRUST_THRESHOLD,
        recentEvents,
      },
      summary: `Adapter "${adapterId}": balance=${balance.balance}, highTrust=${balance.balance >= HIGH_TRUST_THRESHOLD}`,
      durationMs: Date.now() - startTime,
    };
  }

  private _allAdapters(store: TrustStore, startTime: number): ToolResult {
    const adapters = Object.values(store.balances).map((b) => ({
      adapterId: b.domain,
      balance: b.balance,
      highTrust: b.balance >= HIGH_TRUST_THRESHOLD,
    }));

    return {
      success: true,
      data: { adapters },
      summary: `${adapters.length} adapter trust state(s) found`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
