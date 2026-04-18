import { InteractiveAutomationRegistry } from "./registry.js";
import type { InteractiveAutomationProviderFamily } from "./types.js";
import { AnthropicComputerUseProvider } from "./providers/anthropic-computer-use.js";
import { CodexAppAutomationProvider, type CodexAppComputerUseBridge } from "./providers/codex-app.js";
import { ManusBrowserProvider } from "./providers/manus-browser.js";
import { NoopInteractiveAutomationProvider } from "./providers/noop.js";
import { PerplexityResearchProvider } from "./providers/perplexity-research.js";

export interface DefaultInteractiveAutomationRegistryOptions {
  codexAppBridge?: CodexAppComputerUseBridge;
  defaultProviders?: Partial<Record<InteractiveAutomationProviderFamily, string>>;
}

export function createDefaultInteractiveAutomationRegistry(
  options: DefaultInteractiveAutomationRegistryOptions = {},
): InteractiveAutomationRegistry {
  const registry = new InteractiveAutomationRegistry({
    defaultProviders: {
      desktop: "codex_app",
      browser: "manus_browser",
      research: "perplexity_research",
      agent: "anthropic_computer_use",
      ...options.defaultProviders,
    },
  });
  registry.register(new CodexAppAutomationProvider(options.codexAppBridge));
  registry.register(new ManusBrowserProvider());
  registry.register(new PerplexityResearchProvider());
  registry.register(new AnthropicComputerUseProvider());
  registry.register(new NoopInteractiveAutomationProvider());
  return registry;
}
