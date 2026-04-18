import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyController } from "../../concurrency.js";
import { ToolExecutor } from "../../executor.js";
import { ToolPermissionManager } from "../../permission.js";
import { ToolRegistry } from "../../registry.js";
import type { ToolCallContext } from "../../types.js";
import { createBuiltinTools } from "../../builtin/index.js";
import {
  InteractiveAutomationRegistry,
  type InteractiveAutomationProvider,
} from "../../../runtime/interactive-automation/index.js";
import {
  BrowserRunWorkflowTool,
  DesktopClickTool,
  DesktopGetAppStateTool,
  DesktopListAppsTool,
  DesktopTypeTextTool,
  ResearchAnswerWithSourcesTool,
  ResearchWebTool,
} from "../index.js";

const originalPulseedHome = process.env["PULSEED_HOME"];

async function withTempPulseedHome<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-automation-tools-"));
  process.env["PULSEED_HOME"] = tmpDir;
  try {
    return await run(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
  }
}

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeRegistry(): InteractiveAutomationRegistry {
  const registry = new InteractiveAutomationRegistry({
    defaultProviders: {
      desktop: "desktop-test",
      research: "research-test",
      browser: "browser-test",
    },
  });
  const desktopProvider: InteractiveAutomationProvider = {
    id: "desktop-test",
    family: "desktop",
    capabilities: ["desktop_state", "desktop_input"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "desktop-test",
      family: "desktop",
      capabilities: ["desktop_state", "desktop_input"],
      available: true,
    }),
    listApps: async () => [{ name: "Notes" }],
    getAppState: async (input) => ({ app: input.app, title: "Note" }),
    click: async () => ({ success: true, summary: "clicked" }),
    typeText: async () => ({ success: true, summary: "typed" }),
  };
  const researchProvider: InteractiveAutomationProvider = {
    id: "research-test",
    family: "research",
    capabilities: ["web_research"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "research-test",
      family: "research",
      capabilities: ["web_research"],
      available: true,
    }),
    researchWeb: async (input) => ({
      query: input.query,
      results: [{ title: "Result", url: "https://example.com" }],
      citations: ["https://example.com"],
    }),
    answerWithSources: async () => ({
      answer: "Answer",
      citations: ["https://example.com"],
    }),
  };
  const browserProvider: InteractiveAutomationProvider = {
    id: "browser-test",
    family: "browser",
    capabilities: ["browser_control", "agentic_workflow"],
    isAvailable: async () => ({ available: true }),
    describeEnvironment: async () => ({
      providerId: "browser-test",
      family: "browser",
      capabilities: ["browser_control", "agentic_workflow"],
      available: true,
    }),
    runBrowserWorkflow: async () => ({ success: true, summary: "workflow done", sessionId: "s1" }),
    getBrowserState: async () => ({ success: true, summary: "state read", sessionId: "s1" }),
  };
  registry.register(desktopProvider);
  registry.register(researchProvider);
  registry.register(browserProvider);
  return registry;
}

describe("interactive automation tools", () => {
  it("reads desktop app lists and app state through the configured provider", async () => {
    const registry = makeRegistry();
    const listTool = new DesktopListAppsTool(registry);
    const stateTool = new DesktopGetAppStateTool(registry);

    await expect(listTool.call({}, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "desktop-test", apps: [{ name: "Notes" }] },
    });
    await expect(stateTool.call({ app: "Notes" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "desktop-test", state: { title: "Note" } },
    });
  });

  it("marks desktop mutation tools as approval-gated and non-concurrency-safe", async () => {
    const registry = makeRegistry();
    const clickTool = new DesktopClickTool(registry);
    const typeTool = new DesktopTypeTextTool(registry);

    expect(clickTool.metadata.isReadOnly).toBe(false);
    expect(clickTool.metadata.permissionLevel).toBe("execute");
    await expect(clickTool.checkPermissions({ app: "Notes", button: "left", clickCount: 1 })).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(typeTool.checkPermissions({ app: "Notes", text: "secret" })).resolves.toMatchObject({
      status: "needs_approval",
    });
    expect(clickTool.isConcurrencySafe({ app: "Notes", button: "left", clickCount: 1 })).toBe(false);
  });

  it("denies desktop mutation tools for configured protected apps", async () => {
    const registry = makeRegistry();
    const clickTool = new DesktopClickTool(registry, {
      requireApproval: "always",
      deniedApps: ["System Settings"],
    });

    await expect(clickTool.checkPermissions({ app: "System Settings", button: "left", clickCount: 1 })).resolves.toMatchObject({
      status: "denied",
      reason: expect.stringContaining("protected app"),
    });
  });

  it("requires semantic approval before executing desktop mutation tools", async () => {
    const registry = makeRegistry();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new DesktopClickTool(registry));
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const approvalFn = vi.fn().mockResolvedValue(false);

    const result = await executor.execute(
      "desktop_click",
      { app: "Notes", x: 10, y: 20 },
      makeContext({ approvalFn }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("User denied approval");
    expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "desktop_click",
      reason: expect.stringContaining("requires approval"),
    }));
  });

  it("runs research tools as read-only provider calls", async () => {
    const registry = makeRegistry();
    const webTool = new ResearchWebTool(registry);
    const answerTool = new ResearchAnswerWithSourcesTool(registry);

    expect(webTool.metadata.isReadOnly).toBe(true);
    await expect(webTool.call({ query: "PulSeed" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: {
        providerId: "research-test",
        results: [{ title: "Result", url: "https://example.com" }],
      },
    });
    await expect(answerTool.call({ question: "What is PulSeed?" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: {
        providerId: "research-test",
        answer: "Answer",
        citations: ["https://example.com"],
      },
    });
  });

  it("approval-gates browser workflows", async () => {
    const registry = makeRegistry();
    const tool = new BrowserRunWorkflowTool(registry);

    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.permissionLevel).toBe("write_remote");
    await expect(tool.checkPermissions({ task: "Submit the form" })).resolves.toMatchObject({
      status: "needs_approval",
    });
    await expect(tool.call({ task: "Open the dashboard" }, makeContext())).resolves.toMatchObject({
      success: true,
      data: { providerId: "browser-test", result: { sessionId: "s1" } },
    });
  });

  it("registers automation tools for enabled production defaults and injected registries", async () => {
    const defaultTools = await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({ interactive_automation: { enabled: true } }),
        "utf8",
      );
      return createBuiltinTools().map((tool) => tool.metadata.name);
    });
    const withAutomation = createBuiltinTools({ interactiveAutomationRegistry: makeRegistry() })
      .map((tool) => tool.metadata.name);

    expect(defaultTools).toContain("desktop_click");
    expect(withAutomation).toEqual(expect.arrayContaining([
      "desktop_list_apps",
      "desktop_get_app_state",
      "desktop_click",
      "desktop_type_text",
      "research_web",
      "research_answer_with_sources",
      "browser_run_workflow",
      "browser_get_state",
    ]));
  });

  it("does not register automation tools when config disables automation and no registry is injected", () => {
    const tools = createBuiltinTools().map((tool) => tool.metadata.name);

    expect(tools).not.toContain("desktop_click");
  });

  it("applies global config denied_apps when registering default automation tools", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            denied_apps: ["Protected App"],
          },
        }),
        "utf8",
      );

      const tool = createBuiltinTools()
        .find((candidate) => candidate.metadata.name === "desktop_click") as DesktopClickTool | undefined;

      expect(tool).toBeDefined();
      await expect(tool!.checkPermissions({ app: "Protected App", button: "left", clickCount: 1 })).resolves.toMatchObject({
        status: "denied",
      });
    });
  });

  it("uses configured default providers when creating the production registry", async () => {
    await withTempPulseedHome(async (tmpDir) => {
      await fs.writeFile(
        path.join(tmpDir, "config.json"),
        JSON.stringify({
          interactive_automation: {
            enabled: true,
            default_research_provider: "noop",
          },
        }),
        "utf8",
      );

      const tool = createBuiltinTools()
        .find((candidate) => candidate.metadata.name === "research_web") as ResearchWebTool | undefined;

      expect(tool).toBeDefined();
      await expect(tool!.call({ query: "PulSeed" }, makeContext())).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("noop is unavailable"),
      });
    });
  });
});
