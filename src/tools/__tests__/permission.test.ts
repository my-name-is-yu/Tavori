import { describe, it, expect, vi } from "vitest";
import { ToolPermissionManager } from "../permission.js";
import type { ITool, ToolCallContext, ToolMetadata } from "../types.js";
import type { EthicsGateInterface, PermissionManagerDeps } from "../permission.js";

// --- Test helpers ---

function makeTool(overrides: Partial<ToolMetadata> = {}): ITool {
  const metadata: ToolMetadata = {
    name: "test-tool",
    description: "A test tool",
    permissionLevel: "write_local",
    isReadOnly: false,
    tags: [],
    version: "1.0.0",
    ...overrides,
  };
  return {
    metadata,
    inputSchema: { parse: (x: unknown) => x } as never,
    description: () => metadata.description,
    call: vi.fn(),
    checkPermissions: vi.fn(),
    isConcurrencySafe: () => true,
  };
}

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    ...overrides,
  };
}

// --- Tests ---

describe("ToolPermissionManager", () => {
  describe("Layer 1: deny-list", () => {
    it("blocks tool matching deny rule by name", async () => {
      const manager = new ToolPermissionManager({
        denyRules: [{ toolName: "dangerous", reason: "blocked by policy" }],
      });
      const tool = makeTool({ name: "dangerous" });
      const result = await manager.check(tool, {}, makeContext());
      expect(result.status).toBe("denied");
      expect((result as { status: string; reason: string }).reason).toBe("blocked by policy");
    });

    it("allows tool not matching deny rule", async () => {
      const manager = new ToolPermissionManager({
        denyRules: [{ toolName: "dangerous", reason: "blocked" }],
      });
      const tool = makeTool({ name: "safe-tool", isReadOnly: true });
      const result = await manager.check(tool, {}, makeContext());
      expect(result.status).toBe("allowed");
    });
  });

  describe("Read-only bypass", () => {
    it("always allows read-only tool after deny-list check", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ name: "reader", permissionLevel: "read_only", isReadOnly: true });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: -100 }));
      expect(result.status).toBe("allowed");
    });

    it("does not bypass deny-list for read-only tool", async () => {
      const manager = new ToolPermissionManager({
        denyRules: [{ toolName: "banned-reader", reason: "explicitly banned" }],
      });
      const tool = makeTool({ name: "banned-reader", permissionLevel: "read_only", isReadOnly: true });
      const result = await manager.check(tool, {}, makeContext());
      expect(result.status).toBe("denied");
    });
  });

  describe("Layer 2: trust-based gating", () => {
    it("read_metrics tool with trust < -50 returns needs_approval", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ permissionLevel: "read_metrics", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: -60 }));
      expect(result.status).toBe("needs_approval");
      expect((result as { reason: string }).reason).toMatch(/Trust balance/);
    });

    it("read_metrics tool with trust >= -50 returns needs_approval (default behavior)", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ permissionLevel: "read_metrics", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: 0 }));
      // Default for read_metrics is needs_approval unless allow-listed
      expect(result.status).toBe("needs_approval");
    });

    it("write_local tool with trust < -20 returns needs_approval", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ permissionLevel: "write_local", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: -30 }));
      expect(result.status).toBe("needs_approval");
      expect((result as { reason: string }).reason).toMatch(/Trust balance/);
    });

    it("write_local tool with sufficient trust returns allowed", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ permissionLevel: "write_local", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: 0 }));
      expect(result.status).toBe("allowed");
    });
  });

  describe("Layer 2: EthicsGate integration", () => {
    it("shell tool with ethicsGate rejecting returns denied", async () => {
      const ethicsGate: EthicsGateInterface = {
        check: vi.fn().mockResolvedValue({ verdict: "reject", reason: "dangerous command" }),
      };
      const manager = new ToolPermissionManager({ ethicsGate });
      const tool = makeTool({ name: "shell", permissionLevel: "execute", isReadOnly: false });
      const result = await manager.check(tool, { cmd: "rm -rf /" }, makeContext({ trustBalance: 50 }));
      expect(result.status).toBe("denied");
      expect((result as { reason: string }).reason).toMatch(/EthicsGate rejected/);
    });

    it("shell tool with ethicsGate throwing returns needs_approval", async () => {
      const ethicsGate: EthicsGateInterface = {
        check: vi.fn().mockRejectedValue(new Error("network error")),
      };
      const manager = new ToolPermissionManager({ ethicsGate });
      const tool = makeTool({ name: "shell", permissionLevel: "execute", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(result.status).toBe("needs_approval");
      expect((result as { reason: string }).reason).toMatch(/EthicsGate evaluation failed/);
    });

    it("shell tool with ethicsGate approving returns allowed", async () => {
      const ethicsGate: EthicsGateInterface = {
        check: vi.fn().mockResolvedValue({ verdict: "approve", reason: "looks safe" }),
      };
      const manager = new ToolPermissionManager({ ethicsGate });
      const tool = makeTool({ name: "shell", permissionLevel: "execute", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(result.status).toBe("allowed");
    });

    it("read-only non-shell tool does not consult ethicsGate", async () => {
      const ethicsGate: EthicsGateInterface = {
        check: vi.fn(),
      };
      const manager = new ToolPermissionManager({ ethicsGate });
      // read_only bypasses EthicsGate because it short-circuits after deny-list check
      const tool = makeTool({ name: "file-reader", permissionLevel: "read_only", isReadOnly: true });
      await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(ethicsGate.check).not.toHaveBeenCalled();
    });

    it("non-read-only non-shell tool consults ethicsGate", async () => {
      const ethicsGate: EthicsGateInterface = {
        check: vi.fn().mockResolvedValue({ verdict: "approve", reason: "ok" }),
      };
      const manager = new ToolPermissionManager({ ethicsGate });
      const tool = makeTool({ name: "write-tool", permissionLevel: "write_local", isReadOnly: false });
      await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(ethicsGate.check).toHaveBeenCalled();
    });
  });

  describe("Layer 3: allow-list", () => {
    it("allow rule matching read_metrics tool overrides default needs_approval", async () => {
      const manager = new ToolPermissionManager({
        allowRules: [{ toolName: "metrics-reader", reason: "pre-approved" }],
      });
      const tool = makeTool({ name: "metrics-reader", permissionLevel: "read_metrics", isReadOnly: false });
      const result = await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(result.status).toBe("allowed");
    });

    it("allow rule with inputMatcher matches correctly", async () => {
      const manager = new ToolPermissionManager({
        allowRules: [{
          toolName: "write-tool",
          inputMatcher: (input) => (input as { safe: boolean }).safe === true,
          reason: "safe input pre-approved",
        }],
      });
      const tool = makeTool({ name: "write-tool", permissionLevel: "write_local", isReadOnly: false });
      const resultSafe = await manager.check(tool, { safe: true }, makeContext());
      expect(resultSafe.status).toBe("allowed");

      const resultUnsafe = await manager.check(tool, { safe: false }, makeContext());
      // Falls through to default allowed for write_local
      expect(resultUnsafe.status).toBe("allowed");
    });
  });

  describe("Dynamic rule addition", () => {
    it("addDenyRule blocks tool dynamically", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ name: "new-danger", isReadOnly: true });
      
      // Before adding rule: passes (read-only)
      const before = await manager.check(tool, {}, makeContext());
      expect(before.status).toBe("allowed");

      // After adding deny rule: blocked
      manager.addDenyRule({ toolName: "new-danger", reason: "late block" });
      const after = await manager.check(tool, {}, makeContext());
      expect(after.status).toBe("denied");
    });

    it("addAllowRule allows read_metrics tool dynamically", async () => {
      const manager = new ToolPermissionManager({});
      const tool = makeTool({ name: "metrics", permissionLevel: "read_metrics", isReadOnly: false });
      
      const before = await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(before.status).toBe("needs_approval");

      manager.addAllowRule({ toolName: "metrics", reason: "now approved" });
      const after = await manager.check(tool, {}, makeContext({ trustBalance: 50 }));
      expect(after.status).toBe("allowed");
    });
  });
});
