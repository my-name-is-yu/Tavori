import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrustStateTool } from "../TrustStateTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

const MOCK_STORE = {
  balances: {
    "claude-code-cli": { domain: "claude-code-cli", balance: 25, success_delta: 3, failure_delta: -10 },
    "openai-codex": { domain: "openai-codex", balance: -5, success_delta: 3, failure_delta: -10 },
  },
  override_log: [
    { timestamp: "2024-01-01T00:00:00Z", override_type: "trust_grant", domain: "claude-code-cli", balance_before: 20, balance_after: 25 },
  ],
};

describe("TrustStateTool", () => {
  let stateManager: StateManager;
  let tool: TrustStateTool;

  beforeEach(() => {
    stateManager = {
      readRaw: vi.fn(),
    } as unknown as StateManager;
    tool = new TrustStateTool(stateManager);
  });

  it("returns metadata with correct name and tags", () => {
    expect(tool.metadata.name).toBe("trust_state");
    expect(tool.metadata.tags).toContain("self-grounding");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("trust");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({}, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({})).toBe(true);
  });

  it("returns all adapter trust states when no adapterId given", async () => {
    vi.mocked(stateManager.readRaw).mockResolvedValue(MOCK_STORE);
    const result = await tool.call({}, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { adapters: Array<{ adapterId: string; balance: number; highTrust: boolean }> };
    expect(data.adapters).toHaveLength(2);
    const cli = data.adapters.find((a) => a.adapterId === "claude-code-cli");
    expect(cli).toBeDefined();
    expect(cli!.highTrust).toBe(true); // balance=25 >= 20
    const oai = data.adapters.find((a) => a.adapterId === "openai-codex");
    expect(oai!.highTrust).toBe(false); // balance=-5 < 20
  });

  it("returns specific adapter trust state when adapterId given", async () => {
    vi.mocked(stateManager.readRaw).mockResolvedValue(MOCK_STORE);
    const result = await tool.call({ adapterId: "claude-code-cli" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { adapterId: string; balance: number; highTrust: boolean; recentEvents: unknown[] };
    expect(data.adapterId).toBe("claude-code-cli");
    expect(data.balance).toBe(25);
    expect(data.highTrust).toBe(true);
    expect(data.recentEvents).toHaveLength(1);
  });

  it("returns default balance for unknown adapterId", async () => {
    vi.mocked(stateManager.readRaw).mockResolvedValue(MOCK_STORE);
    const result = await tool.call({ adapterId: "unknown-adapter" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { balance: number; highTrust: boolean };
    expect(data.balance).toBe(0);
    expect(data.highTrust).toBe(false);
  });

  it("handles missing trust store gracefully (null)", async () => {
    vi.mocked(stateManager.readRaw).mockResolvedValue(null);
    const result = await tool.call({}, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { adapters: unknown[] };
    expect(data.adapters).toHaveLength(0);
  });

  it("handles stateManager error gracefully", async () => {
    vi.mocked(stateManager.readRaw).mockRejectedValue(new Error("io error"));
    const result = await tool.call({}, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("io error");
  });
});
