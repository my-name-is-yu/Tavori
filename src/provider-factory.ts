// ─── Provider Factory ───
//
// Shared factory helpers for building LLM clients and adapter registries.
// Used by both CLIRunner and TUI entry to avoid duplicating wiring logic.

import { LLMClient, type ILLMClient } from "./llm-client.js";
import { OllamaLLMClient } from "./ollama-client.js";
import { OpenAILLMClient } from "./openai-client.js";
import { CodexLLMClient } from "./codex-llm-client.js";
import { loadProviderConfig } from "./provider-config.js";
import { AdapterRegistry } from "./adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "./adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "./adapters/claude-api.js";
import { OpenAICodexCLIAdapter } from "./adapters/openai-codex.js";
import { GitHubIssueAdapter } from "./adapters/github-issue.js";

/**
 * Build an LLM client based on provider configuration.
 *
 * Configuration priority (highest to lowest):
 *   1. MOTIVA_LLM_PROVIDER environment variable
 *   2. ~/.motiva/provider.json llm_provider field
 *   3. Default: Anthropic
 *
 * Providers:
 *   - "anthropic" → LLMClient (ANTHROPIC_API_KEY required)
 *   - "openai"    → OpenAILLMClient (OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL)
 *   - "ollama"    → OllamaLLMClient (OLLAMA_BASE_URL, OLLAMA_MODEL)
 *   - "codex"     → CodexLLMClient (codex CLI required, OPENAI_MODEL optional)
 */
export function buildLLMClient(): ILLMClient {
  const config = loadProviderConfig();

  switch (config.llm_provider) {
    case "codex":
      return new CodexLLMClient({
        cliPath: config.codex?.cli_path,
        model: config.codex?.model,
      });

    case "openai":
      return new OpenAILLMClient({
        apiKey: config.openai?.api_key,
        model: config.openai?.model,
        baseURL: config.openai?.base_url,
      });

    case "ollama":
      return new OllamaLLMClient({
        baseUrl: config.ollama?.base_url ?? "http://localhost:11434",
        model: config.ollama?.model ?? "qwen3:4b",
      });

    default:
      // "anthropic" or any unknown value falls back to Anthropic
      if (!config.anthropic?.api_key) {
        throw new Error(
          "ANTHROPIC_API_KEY is required (or set MOTIVA_LLM_PROVIDER=openai|ollama|codex)"
        );
      }
      return new LLMClient(config.anthropic.api_key);
  }
}

/**
 * Build an AdapterRegistry pre-populated with the standard adapters.
 * Registers ClaudeCodeCLIAdapter, ClaudeAPIAdapter, OpenAICodexCLIAdapter, and GitHubIssueAdapter.
 */
export function buildAdapterRegistry(llmClient: ILLMClient): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeCLIAdapter());
  registry.register(new ClaudeAPIAdapter(llmClient));
  registry.register(new OpenAICodexCLIAdapter());
  registry.register(new GitHubIssueAdapter());
  return registry;
}
