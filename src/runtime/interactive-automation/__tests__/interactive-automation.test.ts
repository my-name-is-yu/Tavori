import { describe, expect, it, vi } from "vitest";
import {
  CodexAppAutomationProvider,
  createDefaultInteractiveAutomationRegistry,
  InteractiveAutomationRegistry,
  ManusBrowserProvider,
  NoopInteractiveAutomationProvider,
  PerplexityResearchProvider,
  type InteractiveAutomationProvider,
} from "../index.js";

describe("InteractiveAutomationRegistry", () => {
  it("resolves default providers by family and capability", () => {
    const registry = new InteractiveAutomationRegistry({
      defaultProviders: { desktop: "desktop-a" },
    });
    const desktopProvider: InteractiveAutomationProvider = {
      id: "desktop-a",
      family: "desktop",
      capabilities: ["desktop_state"],
      isAvailable: async () => ({ available: true }),
      describeEnvironment: async () => ({
        providerId: "desktop-a",
        family: "desktop",
        capabilities: ["desktop_state"],
        available: true,
      }),
    };
    registry.register(desktopProvider);

    expect(registry.resolve({ family: "desktop", capability: "desktop_state" })?.id).toBe("desktop-a");
    expect(registry.resolve({ family: "desktop", capability: "web_research" })).toBeUndefined();
  });

  it("does not silently fall back when a configured default provider is missing", () => {
    const registry = new InteractiveAutomationRegistry({
      defaultProviders: { research: "typo-provider" },
    });
    registry.register({
      id: "perplexity_research",
      family: "research",
      capabilities: ["web_research"],
      isAvailable: async () => ({ available: true }),
      describeEnvironment: async () => ({
        providerId: "perplexity_research",
        family: "research",
        capabilities: ["web_research"],
        available: true,
      }),
    });

    expect(registry.resolve({ family: "research", capability: "web_research" })).toBeUndefined();
  });

  it("rejects duplicate provider ids", () => {
    const registry = new InteractiveAutomationRegistry();
    const provider = new NoopInteractiveAutomationProvider();
    registry.register(provider);

    expect(() => registry.register(provider)).toThrow(/already registered/);
  });
});

describe("providers", () => {
  it("keeps codex_app unavailable when no host bridge is injected", async () => {
    const provider = new CodexAppAutomationProvider();

    await expect(provider.isAvailable()).resolves.toMatchObject({ available: false });
    await expect(provider.click({ app: "Safari", x: 1, y: 2 })).resolves.toMatchObject({
      success: false,
    });
  });

  it("delegates codex_app desktop calls to the injected bridge", async () => {
    const provider = new CodexAppAutomationProvider({
      listApps: async () => [{ name: "Notes" }],
      getAppState: async (input) => ({ app: input.app, title: "Note" }),
      click: async () => ({ success: true, summary: "clicked" }),
      typeText: async () => ({ success: true, summary: "typed" }),
    });

    await expect(provider.isAvailable()).resolves.toEqual({ available: true });
    await expect(provider.listApps()).resolves.toEqual([{ name: "Notes" }]);
    await expect(provider.getAppState({ app: "Notes" })).resolves.toMatchObject({ title: "Note" });
  });

  it("keeps Perplexity unavailable without an API key", async () => {
    const provider = new PerplexityResearchProvider({ apiKey: "" });

    await expect(provider.isAvailable()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("PERPLEXITY_API_KEY"),
    });
  });

  it("maps Perplexity search responses through an injected fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "PulSeed", url: "https://example.com", snippet: "result" }],
      citations: ["https://example.com"],
    }), { status: 200 }));
    const provider = new PerplexityResearchProvider({
      apiKey: "test-key",
      baseUrl: "https://perplexity.test",
      fetch: fetchMock,
    });

    await expect(provider.researchWeb({ query: "PulSeed" })).resolves.toMatchObject({
      query: "PulSeed",
      results: [{ title: "PulSeed", url: "https://example.com", snippet: "result" }],
      citations: ["https://example.com"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://perplexity.test/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
      }),
    );
  });

  it("keeps Manus unavailable without an API key", async () => {
    const provider = new ManusBrowserProvider({ apiKey: "" });

    await expect(provider.isAvailable()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("MANUS_API_KEY"),
    });
  });

  it("creates a default registry with codex, anthropic, manus, and perplexity providers", () => {
    const registry = createDefaultInteractiveAutomationRegistry();

    expect(registry.resolve({ family: "desktop", capability: "desktop_state" })?.id).toBe("codex_app");
    expect(registry.resolve({ family: "browser", capability: "browser_control" })?.id).toBe("manus_browser");
    expect(registry.resolve({ family: "research", capability: "web_research" })?.id).toBe("perplexity_research");
    expect(registry.resolve({ family: "agent", capability: "agentic_workflow" })?.id).toBe("anthropic_computer_use");
  });

  it("maps Manus browser workflow responses through an injected fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      summary: "workflow started",
      session_id: "session-1",
    }), { status: 200 }));
    const provider = new ManusBrowserProvider({
      apiKey: "test-key",
      baseUrl: "https://manus.test",
      fetch: fetchMock,
    });

    await expect(provider.runBrowserWorkflow({ task: "Open dashboard" })).resolves.toMatchObject({
      success: true,
      summary: "workflow started",
      sessionId: "session-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://manus.test/browser/workflows",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
      }),
    );
  });
});
