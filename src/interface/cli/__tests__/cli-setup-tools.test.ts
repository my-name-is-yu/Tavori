import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../../base/llm/provider-factory.js", () => ({
  buildLLMClient: vi.fn().mockResolvedValue({
    sendMessage: vi.fn().mockResolvedValue({ content: "mock" }),
    parseJSON: vi.fn().mockResolvedValue({}),
  }),
  buildAdapterRegistry: vi.fn().mockResolvedValue({
    register: vi.fn(),
    getAdapter: vi.fn(),
    getAdapterCapabilities: vi.fn().mockReturnValue([]),
  }),
}));

import { StateManager } from "../../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { buildDeps } from "../setup.js";

describe("CLI buildDeps tool wiring", () => {
  let tempDir: string;
  let originalPulseedHome: string | undefined;
  let originalOpenAIKey: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cli-setup-"));
    originalPulseedHome = process.env["PULSEED_HOME"];
    originalOpenAIKey = process.env["OPENAI_API_KEY"];
    process.env["PULSEED_HOME"] = tempDir;
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    if (originalOpenAIKey === undefined) {
      delete process.env["OPENAI_API_KEY"];
    } else {
      process.env["OPENAI_API_KEY"] = originalOpenAIKey;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("wires ToolExecutor into CLI runtime and executes a read-only tool", async () => {
    const stateManager = new StateManager(tempDir);
    const characterConfigManager = new CharacterConfigManager(stateManager);
    const deps = await buildDeps(
      stateManager,
      characterConfigManager,
      undefined,
      undefined,
      undefined,
      undefined,
      process.cwd(),
    );

    expect(deps.toolRegistry.get("glob")).toBeDefined();
    expect(deps.toolRegistry.get("observe-goal")).toBeDefined();

    const coreLoopDeps = (deps.coreLoop as unknown as { deps: Record<string, unknown> }).deps;
    expect(coreLoopDeps["toolExecutor"]).toBe(deps.toolExecutor);
    expect(coreLoopDeps["toolRegistry"]).toBe(deps.toolRegistry);
    expect((coreLoopDeps["observationEngine"] as { toolExecutor?: unknown }).toolExecutor).toBe(deps.toolExecutor);
    expect((coreLoopDeps["taskLifecycle"] as { toolExecutor?: unknown }).toolExecutor).toBe(deps.toolExecutor);

    const result = await deps.toolExecutor.execute(
      "glob",
      { pattern: "package.json", path: "." },
      {
        cwd: process.cwd(),
        goalId: "cli-setup-tools",
        trustBalance: 100,
        preApproved: true,
        trusted: true,
        approvalFn: async () => true,
      },
    );

    expect(result.success).toBe(true);
    expect(result.artifacts?.some((artifact) => artifact.endsWith("package.json"))).toBe(true);
  });
});
