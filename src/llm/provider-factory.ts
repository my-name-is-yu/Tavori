// ─── Provider Factory ───
//
// Shared factory helpers for building LLM clients and adapter registries.
// Used by both CLIRunner and TUI entry to avoid duplicating wiring logic.

import { LLMClient, type ILLMClient } from "./llm-client.js";
import { LLMError } from "../utils/errors.js";
import { OllamaLLMClient } from "./ollama-client.js";
import { OpenAILLMClient } from "./openai-client.js";
import { CodexLLMClient } from "./codex-llm-client.js";
import { loadProviderConfig } from "./provider-config.js";
import { AdapterRegistry } from "../execution/adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "../adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "../adapters/claude-api.js";
import { OpenAICodexCLIAdapter } from "../adapters/openai-codex.js";
import { GitHubIssueAdapter } from "../adapters/github-issue.js";
import { A2AAdapter } from "../adapters/a2a-adapter.js";
import { BrowserUseCLIAdapter } from "../adapters/browser-use-cli.js";
import type { ProviderConfig } from "./provider-config.js";

/**
 * Build an LLM client based on provider configuration.
 *
 * Configuration priority (highest to lowest):
 *   1. CONATUS_LLM_PROVIDER environment variable
 *   2. ~/.conatus/provider.json llm_provider field
 *   3. Default: OpenAI
 *
 * Providers:
 *   - "anthropic" → LLMClient (ANTHROPIC_API_KEY required)
 *   - "openai"    → OpenAILLMClient (OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL)
 *   - "ollama"    → OllamaLLMClient (OLLAMA_BASE_URL, OLLAMA_MODEL)
 *   - "codex"     → CodexLLMClient (codex CLI required, OPENAI_MODEL optional)
 */
export async function buildLLMClient(): Promise<ILLMClient> {
  const config = await loadProviderConfig();

  switch (config.llm_provider) {
    case "codex":
      if (!config.openai?.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new CodexLLMClient({
        cliPath: config.codex?.cli_path,
        model: config.codex?.model,
      });

    case "openai":
      if (!config.openai?.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new OpenAILLMClient({
        apiKey: config.openai.api_key,
        model: config.openai?.model,
        baseURL: config.openai?.base_url,
      });

    case "ollama":
      return new OllamaLLMClient({
        baseUrl: config.ollama?.base_url ?? "http://localhost:11434",
        model: config.ollama?.model ?? "qwen3:4b",
      });

    case "anthropic":
      if (!config.anthropic?.api_key) {
        throw new LLMError(
          "ANTHROPIC_API_KEY is not set.\nSet it via: export ANTHROPIC_API_KEY=sk-ant-..."
        );
      }
      return new LLMClient(config.anthropic.api_key);

    default:
      // Unknown or unset value falls back to OpenAI
      if (!config.openai?.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new OpenAILLMClient({
        apiKey: config.openai.api_key,
        model: config.openai?.model,
        baseURL: config.openai?.base_url,
      });
  }
}

/**
 * Build an AdapterRegistry pre-populated with the standard adapters.
 * Registers ClaudeCodeCLIAdapter, ClaudeAPIAdapter, OpenAICodexCLIAdapter, GitHubIssueAdapter,
 * and any A2A agents configured in provider config or environment variables.
 */
export async function buildAdapterRegistry(
  llmClient: ILLMClient,
  providerConfig?: ProviderConfig
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeCLIAdapter());
  registry.register(new ClaudeAPIAdapter(llmClient));
  registry.register(new OpenAICodexCLIAdapter());
  registry.register(new GitHubIssueAdapter());
  registry.register(new BrowserUseCLIAdapter());

  // Register A2A agents from config
  const config = providerConfig ?? await loadProviderConfig();
  if (config.a2a?.agents) {
    for (const [name, agentConfig] of Object.entries(config.a2a.agents)) {
      registry.register(new A2AAdapter({
        adapterType: name.startsWith("a2a") ? name : `a2a_${name}`,
        baseUrl: agentConfig.base_url,
        authToken: agentConfig.auth_token,
        capabilities: agentConfig.capabilities,
        preferStreaming: agentConfig.prefer_streaming,
        pollIntervalMs: agentConfig.poll_interval_ms,
        maxWaitMs: agentConfig.max_wait_ms,
      }));
    }
  }

  // Single-agent env var shortcut
  const envBaseUrl = process.env["CONATUS_A2A_BASE_URL"];
  if (envBaseUrl && !config.a2a?.agents) {
    registry.register(new A2AAdapter({
      baseUrl: envBaseUrl,
      authToken: process.env["CONATUS_A2A_AUTH_TOKEN"],
    }));
  }

  return registry;
}
