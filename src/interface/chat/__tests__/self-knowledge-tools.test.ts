import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { StateManager } from "../../../base/state/state-manager.js";

// ─── Module imports ───
import {
  getSelfKnowledgeToolDefinitions,
  handleSelfKnowledgeToolCall,
} from "../self-knowledge-tools.js";
import type { SelfKnowledgeDeps } from "../self-knowledge-tools.js";

// ─── Shared helpers ───

function makeMockStateManager(
  goalIds: string[] = [],
  goals: Record<string, object> = {}
): StateManager {
  return {
    listGoalIds: vi.fn().mockResolvedValue(goalIds),
    loadGoal: vi.fn().mockImplementation(async (id: string) => goals[id] ?? null),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeDeps(overrides: Partial<SelfKnowledgeDeps> = {}): SelfKnowledgeDeps {
  return {
    stateManager: makeMockStateManager(),
    homeDir: "/tmp/test-pulseed",
    ...overrides,
  };
}

// ─── getSelfKnowledgeToolDefinitions ───

describe("getSelfKnowledgeToolDefinitions()", () => {
  it("returns 6 tool definitions", () => {
    const tools = getSelfKnowledgeToolDefinitions();
    expect(tools).toHaveLength(6);
  });

  it("each definition has name, description, parameters", () => {
    const tools = getSelfKnowledgeToolDefinitions();
    for (const tool of tools) {
      expect(tool.function.name).toBeDefined();
      expect(typeof tool.function.name).toBe("string");
      expect(tool.function.description).toBeDefined();
      expect(typeof tool.function.description).toBe("string");
      expect(tool.function.parameters).toBeDefined();
    }
  });

  it("tool names match expected values", () => {
    const tools = getSelfKnowledgeToolDefinitions();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("get_goals");
    expect(names).toContain("get_sessions");
    expect(names).toContain("get_trust_state");
    expect(names).toContain("get_config");
    expect(names).toContain("get_plugins");
    expect(names).toContain("get_architecture");
  });
});

// ─── handleSelfKnowledgeToolCall — get_goals ───

describe("handleSelfKnowledgeToolCall — get_goals", () => {
  it("returns goal data as JSON when goals exist", async () => {
    const sm = makeMockStateManager(
      ["goal-1"],
      {
        "goal-1": {
          id: "goal-1",
          title: "Ship feature X",
          description: "Deliver feature X",
          status: "active",
          loop_status: "running",
          dimensions: [
            {
              name: "dim1",
              label: "Coverage",
              current_value: 80,
              threshold: { type: "min", value: 90 },
              confidence: 0.9,
            },
          ],
        },
      }
    );
    const deps = makeDeps({ stateManager: sm });
    const result = await handleSelfKnowledgeToolCall("get_goals", {}, deps);
    const parsed = JSON.parse(result) as { goals: Array<{ id: string; title: string }> };
    expect(parsed.goals).toHaveLength(1);
    expect(parsed.goals[0].id).toBe("goal-1");
    expect(parsed.goals[0].title).toBe("Ship feature X");
  });

  it("returns empty array JSON when no goals exist", async () => {
    const sm = makeMockStateManager([], {});
    const deps = makeDeps({ stateManager: sm });
    const result = await handleSelfKnowledgeToolCall("get_goals", {}, deps);
    const parsed = JSON.parse(result) as { goals: unknown[] };
    expect(parsed.goals).toHaveLength(0);
  });
});

// ─── handleSelfKnowledgeToolCall — get_trust_state ───

describe("handleSelfKnowledgeToolCall — get_trust_state", () => {
  it("returns trust balance when trustManager is present", async () => {
    const trustManager = {
      getBalance: vi.fn().mockResolvedValue({ balance: 42 }),
    };
    const deps = makeDeps({ trustManager });
    const result = await handleSelfKnowledgeToolCall("get_trust_state", {}, deps);
    const parsed = JSON.parse(result) as { trust_score: number };
    expect(parsed.trust_score).toBe(42);
    expect(trustManager.getBalance).toHaveBeenCalledWith("default");
  });

  it("returns unavailable when trustManager is absent", async () => {
    const deps = makeDeps({ trustManager: undefined });
    const result = await handleSelfKnowledgeToolCall("get_trust_state", {}, deps);
    const parsed = JSON.parse(result) as { trust_score: string };
    expect(parsed.trust_score).toBe("unavailable");
  });

  it("includes static fields regardless of trustManager", async () => {
    const deps = makeDeps({ trustManager: undefined });
    const result = await handleSelfKnowledgeToolCall("get_trust_state", {}, deps);
    const parsed = JSON.parse(result) as {
      delta_success: number;
      delta_failure: number;
      high_trust_threshold: number;
      ethics_gate_level: string;
      execution_boundary: string;
      trust_balance_range: number[];
    };
    expect(parsed.delta_success).toBe(3);
    expect(parsed.delta_failure).toBe(-10);
    expect(parsed.high_trust_threshold).toBe(20);
    expect(parsed.ethics_gate_level).toBe("L1");
    expect(parsed.execution_boundary).toBeDefined();
    expect(parsed.execution_boundary).toContain("uses available tools directly");
    expect(parsed.execution_boundary).toContain("Explicit confirmation is required");
    expect(parsed.trust_balance_range).toEqual([-100, 100]);
  });
});

// ─── handleSelfKnowledgeToolCall — get_config ───

describe("handleSelfKnowledgeToolCall — get_config", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-selfknowledge-test-"));
    await fsp.mkdir(path.join(tmpDir, ".pulseed"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns provider.json data when file exists", async () => {
    const providerPath = path.join(tmpDir, ".pulseed", "provider.json");
    await fsp.writeFile(
      providerPath,
      JSON.stringify({ provider: "openai", model: "gpt-4o", default_adapter: "openai_codex_cli" }),
      "utf-8"
    );
    const deps = makeDeps({ homeDir: tmpDir });
    const result = await handleSelfKnowledgeToolCall("get_config", {}, deps);
    const parsed = JSON.parse(result) as {
      provider: string;
      model: string;
      default_adapter: string;
      pulseed_home_dir: string;
    };
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.default_adapter).toBe("openai_codex_cli");
    expect(parsed.pulseed_home_dir).toContain(".pulseed");
  });

  it("returns defaults when provider.json does not exist", async () => {
    const deps = makeDeps({ homeDir: tmpDir });
    const result = await handleSelfKnowledgeToolCall("get_config", {}, deps);
    const parsed = JSON.parse(result) as {
      provider: string;
      model: string;
      default_adapter: string;
    };
    expect(parsed.provider).toBe("unknown");
    expect(parsed.model).toBe("unknown");
    expect(parsed.default_adapter).toBe("claude-code-cli");
  });
});

// ─── handleSelfKnowledgeToolCall — get_plugins ───

describe("handleSelfKnowledgeToolCall — get_plugins", () => {
  it("returns plugin list when pluginLoader is present", async () => {
    const pluginLoader = {
      loadAll: vi.fn().mockResolvedValue([
        { name: "slack-notifier", type: "notifier", enabled: true },
        { name: "github-issues", type: "datasource", enabled: false },
      ]),
    };
    const deps = makeDeps({ pluginLoader });
    const result = await handleSelfKnowledgeToolCall("get_plugins", {}, deps);
    const parsed = JSON.parse(result) as {
      plugins: Array<{ name: string; type: string; enabled: boolean }>;
      builtin_integrations: Array<{ id: string; source: string }>;
    };
    expect(parsed.plugins).toHaveLength(2);
    expect(parsed.plugins[0].name).toBe("slack-notifier");
    expect(parsed.plugins[1].name).toBe("github-issues");
    expect(parsed.builtin_integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "soil-display", source: "builtin" }),
    ]));
  });

  it("returns unavailable message when pluginLoader is absent", async () => {
    const deps = makeDeps({ pluginLoader: undefined });
    const result = await handleSelfKnowledgeToolCall("get_plugins", {}, deps);
    const parsed = JSON.parse(result) as { message: string; plugins: unknown[]; builtin_integrations: unknown[] };
    expect(parsed.message).toBeDefined();
    expect(parsed.message.toLowerCase()).toContain("not available");
    expect(parsed.plugins).toHaveLength(0);
    expect(parsed.builtin_integrations.length).toBeGreaterThan(0);
  });

  it("fills defaults for missing type and enabled fields", async () => {
    const pluginLoader = {
      loadAll: vi.fn().mockResolvedValue([{ name: "bare-plugin" }]),
    };
    const deps = makeDeps({ pluginLoader });
    const result = await handleSelfKnowledgeToolCall("get_plugins", {}, deps);
    const parsed = JSON.parse(result) as {
      plugins: Array<{ name: string; type: string; enabled: boolean }>;
    };
    expect(parsed.plugins[0].type).toBe("unknown");
    expect(parsed.plugins[0].enabled).toBe(true);
  });
});

// ─── handleSelfKnowledgeToolCall — get_architecture ───

describe("handleSelfKnowledgeToolCall — get_architecture", () => {
  it("returns static architecture text", async () => {
    const deps = makeDeps();
    const result = await handleSelfKnowledgeToolCall("get_architecture", {}, deps);
    const parsed = JSON.parse(result) as { architecture: string };
    expect(typeof parsed.architecture).toBe("string");
    expect(parsed.architecture.length).toBeGreaterThan(0);
  });

  it("contains Layer keyword in the architecture text", async () => {
    const deps = makeDeps();
    const result = await handleSelfKnowledgeToolCall("get_architecture", {}, deps);
    const parsed = JSON.parse(result) as { architecture: string };
    expect(parsed.architecture).toContain("Layer");
  });

  it("contains core loop description", async () => {
    const deps = makeDeps();
    const result = await handleSelfKnowledgeToolCall("get_architecture", {}, deps);
    const parsed = JSON.parse(result) as { architecture: string };
    expect(parsed.architecture.toLowerCase()).toContain("core loop");
  });

  it("contains execution boundary description", async () => {
    const deps = makeDeps();
    const result = await handleSelfKnowledgeToolCall("get_architecture", {}, deps);
    const parsed = JSON.parse(result) as { architecture: string };
    expect(parsed.architecture.toLowerCase()).toContain("execution boundary");
    expect(parsed.architecture).toContain("uses available tools directly");
    expect(parsed.architecture).toContain("require explicit confirmation");
  });
});

// ─── handleSelfKnowledgeToolCall — unknown tool ───

describe("handleSelfKnowledgeToolCall — unknown tool", () => {
  it("returns error JSON string without throwing", async () => {
    const deps = makeDeps();
    const result = await handleSelfKnowledgeToolCall("nonexistent_tool", {}, deps);
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toContain("nonexistent_tool");
  });

  it("does not throw for unknown tool names", async () => {
    const deps = makeDeps();
    await expect(
      handleSelfKnowledgeToolCall("totally_unknown", {}, deps)
    ).resolves.toBeDefined();
  });
});
