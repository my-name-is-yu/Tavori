import { describe, it, expect, vi } from "vitest";
import type { StateManager } from "../../src/state/state-manager.js";
import type { TrustManager } from "../../src/traits/trust-manager.js";
import type { PluginLoader } from "../../src/runtime/plugin-loader.js";

import {
  getMutationToolDefinitions,
  handleMutationToolCall,
} from "../../src/chat/self-knowledge-mutation-tools.js";
import type { MutationToolDeps } from "../../src/chat/self-knowledge-mutation-tools.js";

// ─── Module mocks for update_config ───

vi.mock("../../src/llm/provider-config.js", () => ({
  loadProviderConfig: vi.fn().mockResolvedValue({ provider: "openai", model: "gpt-4o", api_key: "sk-test" }),
  saveProviderConfig: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock helpers ───

function makeStateManager(overrides: Partial<StateManager> = {}): StateManager {
  return {
    saveGoal: vi.fn().mockResolvedValue(undefined),
    loadGoal: vi.fn().mockResolvedValue(null),
    archiveGoal: vi.fn().mockResolvedValue(false),
    deleteGoal: vi.fn().mockResolvedValue(false),
    listGoalIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as StateManager;
}

function makeTrustManager(): TrustManager {
  return {
    setOverride: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue({ balance: 0 }),
  } as unknown as TrustManager;
}

function makePluginLoader(state: Record<string, unknown> | null = null): PluginLoader {
  return {
    getPluginState: vi.fn().mockReturnValue(state ?? { trust_score: 50, usage_count: 0, success_count: 0, failure_count: 0 }),
    updatePluginState: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([]),
  } as unknown as PluginLoader;
}

function makeDeps(overrides: Partial<MutationToolDeps> = {}): MutationToolDeps {
  return {
    stateManager: makeStateManager(),
    ...overrides,
  };
}

// ─── getMutationToolDefinitions ───

describe("getMutationToolDefinitions()", () => {
  it("returns 7 tool definitions", () => {
    const tools = getMutationToolDefinitions();
    expect(tools).toHaveLength(7);
  });

  it("each definition has name, description, parameters", () => {
    for (const tool of getMutationToolDefinitions()) {
      expect(typeof tool.function.name).toBe("string");
      expect(typeof tool.function.description).toBe("string");
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it("includes all 7 expected tool names", () => {
    const names = getMutationToolDefinitions().map((t) => t.function.name);
    expect(names).toContain("set_goal");
    expect(names).toContain("update_goal");
    expect(names).toContain("archive_goal");
    expect(names).toContain("delete_goal");
    expect(names).toContain("toggle_plugin");
    expect(names).toContain("update_config");
    expect(names).toContain("reset_trust");
  });
});

// ─── set_goal ───

describe("handleMutationToolCall — set_goal", () => {
  it("creates a goal when description is provided", async () => {
    const sm = makeStateManager();
    const deps = makeDeps({ stateManager: sm });
    const result = await handleMutationToolCall("set_goal", { description: "Ship feature X" }, deps);
    const parsed = JSON.parse(result) as { success: boolean; goal_id: string; message: string };
    expect(parsed.success).toBe(true);
    expect(typeof parsed.goal_id).toBe("string");
    expect(parsed.message).toContain("Ship feature X");
    expect(sm.saveGoal).toHaveBeenCalledOnce();
  });

  it("returns error when description is missing", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall("set_goal", {}, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  it("returns error when description is empty string", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall("set_goal", { description: "   " }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBeDefined();
  });
});

// ─── update_goal ───

describe("handleMutationToolCall — update_goal", () => {
  it("updates a goal that exists", async () => {
    const existingGoal = {
      id: "g1",
      description: "old desc",
      status: "active",
      dimensions: [],
      children_ids: [],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const sm = makeStateManager({ loadGoal: vi.fn().mockResolvedValue(existingGoal) });
    const deps = makeDeps({ stateManager: sm });
    const result = await handleMutationToolCall(
      "update_goal",
      { goal_id: "g1", description: "new desc", status: "completed" },
      deps
    );
    const parsed = JSON.parse(result) as { success: boolean; goal_id: string };
    expect(parsed.success).toBe(true);
    expect(parsed.goal_id).toBe("g1");
    expect(sm.saveGoal).toHaveBeenCalledOnce();
  });

  it("returns error when goal_id is missing", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall("update_goal", {}, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  it("returns error when goal is not found", async () => {
    const sm = makeStateManager({ loadGoal: vi.fn().mockResolvedValue(null) });
    const deps = makeDeps({ stateManager: sm });
    const result = await handleMutationToolCall("update_goal", { goal_id: "missing-id" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("not found");
  });

  it("returns error when status is 'archived'", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall(
      "update_goal",
      { goal_id: "g1", status: "archived" },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("archive_goal");
  });
});

// ─── archive_goal ───

describe("handleMutationToolCall — archive_goal", () => {
  it("archives a goal when approved", async () => {
    const sm = makeStateManager({ archiveGoal: vi.fn().mockResolvedValue(true) });
    const deps = makeDeps({
      stateManager: sm,
      approvalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await handleMutationToolCall("archive_goal", { goal_id: "g1" }, deps);
    const parsed = JSON.parse(result) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(sm.archiveGoal).toHaveBeenCalledWith("g1");
  });

  it("returns error when user denies approval", async () => {
    const sm = makeStateManager({ archiveGoal: vi.fn().mockResolvedValue(true) });
    const deps = makeDeps({
      stateManager: sm,
      approvalFn: vi.fn().mockResolvedValue(false),
    });
    const result = await handleMutationToolCall("archive_goal", { goal_id: "g1" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("denied");
    expect(sm.archiveGoal).not.toHaveBeenCalled();
  });

  it("returns error when no approvalFn is configured", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall("archive_goal", { goal_id: "g1" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("approval");
  });

  it("returns error when goal is not found", async () => {
    const sm = makeStateManager({ archiveGoal: vi.fn().mockResolvedValue(false) });
    const deps = makeDeps({
      stateManager: sm,
      approvalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await handleMutationToolCall("archive_goal", { goal_id: "nonexistent" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("not found");
  });
});

// ─── delete_goal ───

describe("handleMutationToolCall — delete_goal", () => {
  it("deletes a goal when approved", async () => {
    const sm = makeStateManager({ deleteGoal: vi.fn().mockResolvedValue(true) });
    const deps = makeDeps({
      stateManager: sm,
      approvalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await handleMutationToolCall("delete_goal", { goal_id: "g1" }, deps);
    const parsed = JSON.parse(result) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(sm.deleteGoal).toHaveBeenCalledWith("g1");
  });

  it("returns error when user denies approval", async () => {
    const sm = makeStateManager({ deleteGoal: vi.fn().mockResolvedValue(true) });
    const deps = makeDeps({
      stateManager: sm,
      approvalFn: vi.fn().mockResolvedValue(false),
    });
    const result = await handleMutationToolCall("delete_goal", { goal_id: "g1" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("denied");
  });

  it("returns error when goal_id is missing", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall("delete_goal", {}, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBeDefined();
  });
});

// ─── toggle_plugin ───

describe("handleMutationToolCall — toggle_plugin", () => {
  it("returns not-supported error when approved (plugin enable/disable not implemented)", async () => {
    const pl = makePluginLoader({ trust_score: 50, usage_count: 0, success_count: 0, failure_count: 0 });
    const deps = makeDeps({
      pluginLoader: pl,
      approvalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await handleMutationToolCall(
      "toggle_plugin",
      { plugin_name: "slack-notifier", enabled: false },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("not yet supported");
    expect(pl.updatePluginState).not.toHaveBeenCalled();
  });

  it("returns not-supported error even for unknown plugin names", async () => {
    const pl = makePluginLoader(null);
    (pl.getPluginState as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const deps = makeDeps({
      pluginLoader: pl,
      approvalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await handleMutationToolCall(
      "toggle_plugin",
      { plugin_name: "nonexistent", enabled: true },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("not yet supported");
  });

  it("returns not-supported error when pluginLoader is not available", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall(
      "toggle_plugin",
      { plugin_name: "slack-notifier", enabled: true },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("not yet supported");
  });

  it("returns error when plugin_name is missing", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall("toggle_plugin", { enabled: true }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBeDefined();
  });
});

// ─── update_config ───

describe("handleMutationToolCall — update_config", () => {
  it("returns error when no fields are provided", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall("update_config", {}, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("required");
  });

  it("returns error when user denies approval", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(false) });
    const result = await handleMutationToolCall("update_config", { model: "gpt-4o" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("denied");
  });

  it("returns error for invalid provider value", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall("update_config", { provider: "invalid-llm" }, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("Invalid provider");
  });

  it("succeeds and reports updated fields (model update)", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall("update_config", { model: "gpt-4o-mini" }, deps);
    const parsed = JSON.parse(result) as { success: boolean; updated_fields: Record<string, string>; message: string };
    expect(parsed.success).toBe(true);
    expect(parsed.updated_fields.model).toBe("gpt-4o-mini");
    expect(parsed.message).toContain("updated");
  });

  it("does not echo api_key value in updated_fields", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall("update_config", { api_key: "sk-secret" }, deps);
    const parsed = JSON.parse(result) as { success: boolean; updated_fields: Record<string, string> };
    expect(parsed.success).toBe(true);
    expect(parsed.updated_fields.api_key_updated).toBe("true");
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
  });
});

// ─── reset_trust ───

describe("handleMutationToolCall — reset_trust", () => {
  it("resets trust when approved and trustManager is present", async () => {
    const tm = makeTrustManager();
    const deps = makeDeps({
      trustManager: tm,
      approvalFn: vi.fn().mockResolvedValue(true),
    });
    const result = await handleMutationToolCall(
      "reset_trust",
      { domain: "default", balance: 10, reason: "Manual reset for testing" },
      deps
    );
    const parsed = JSON.parse(result) as { success: boolean; domain: string; balance: number };
    expect(parsed.success).toBe(true);
    expect(parsed.domain).toBe("default");
    expect(parsed.balance).toBe(10);
    expect(tm.setOverride).toHaveBeenCalledWith("default", 10, "Manual reset for testing");
  });

  it("returns error when trustManager is absent", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall(
      "reset_trust",
      { domain: "default", balance: 0, reason: "test" },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("not available");
  });

  it("returns error when domain is missing", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall(
      "reset_trust",
      { balance: 0, reason: "test" },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("domain");
  });

  it("returns error when balance is not a number", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall(
      "reset_trust",
      { domain: "default", balance: "high", reason: "test" },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("number");
  });

  it("returns error when balance is out of range", async () => {
    const deps = makeDeps({ approvalFn: vi.fn().mockResolvedValue(true) });
    const result = await handleMutationToolCall(
      "reset_trust",
      { domain: "default", balance: 150, reason: "test" },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("-100");
  });

  it("returns error when user denies approval", async () => {
    const tm = makeTrustManager();
    const deps = makeDeps({
      trustManager: tm,
      approvalFn: vi.fn().mockResolvedValue(false),
    });
    const result = await handleMutationToolCall(
      "reset_trust",
      { domain: "default", balance: 50, reason: "test" },
      deps
    );
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("denied");
    expect(tm.setOverride).not.toHaveBeenCalled();
  });
});

// ─── Approval flow — config override ───

describe("handleMutationToolCall — approval config override", () => {
  it("allows set_goal without approval by default (approval level none)", async () => {
    const sm = makeStateManager();
    const approvalFn = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ stateManager: sm, approvalFn });
    await handleMutationToolCall("set_goal", { description: "Test goal" }, deps);
    // approvalFn should NOT be called since default is "none"
    expect(approvalFn).not.toHaveBeenCalled();
  });

  it("can override set_goal to require approval via approvalConfig", async () => {
    const sm = makeStateManager();
    const approvalFn = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      stateManager: sm,
      approvalFn,
      approvalConfig: { set_goal: "required" },
    });
    await handleMutationToolCall("set_goal", { description: "Test goal" }, deps);
    expect(approvalFn).toHaveBeenCalled();
  });

  it("can override delete_goal to skip approval via approvalConfig", async () => {
    const sm = makeStateManager({ deleteGoal: vi.fn().mockResolvedValue(true) });
    const approvalFn = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      stateManager: sm,
      approvalFn,
      approvalConfig: { delete_goal: "none" },
    });
    await handleMutationToolCall("delete_goal", { goal_id: "g1" }, deps);
    expect(approvalFn).not.toHaveBeenCalled();
    expect(sm.deleteGoal).toHaveBeenCalledWith("g1");
  });
});

// ─── Unknown tool ───

describe("handleMutationToolCall — unknown tool", () => {
  it("returns error JSON for unknown tool name", async () => {
    const deps = makeDeps();
    const result = await handleMutationToolCall("nonexistent_tool", {}, deps);
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("nonexistent_tool");
  });

  it("does not throw for unknown tool names", async () => {
    const deps = makeDeps();
    await expect(
      handleMutationToolCall("totally_unknown", {}, deps)
    ).resolves.toBeDefined();
  });
});
