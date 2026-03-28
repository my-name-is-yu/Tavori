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
import { OpenClawACPAdapter } from "../adapters/openclaw-acp.js";
import type { ProviderConfig } from "./provider-config.js";

/**
 * Build an LLM client based on provider configuration.
 *
 * Configuration priority (highest to lowest):
 *   1. PULSEED_PROVIDER environment variable
 *   2. ~/.pulseed/provider.json provider field
 *   3. Default: OpenAI
 *
 * Providers:
 *   - "anthropic" → LLMClient (api_key required)
 *   - "openai"    → OpenAILLMClient or CodexLLMClient depending on adapter
 *   - "ollama"    → OllamaLLMClient
 */
export async function buildLLMClient(): Promise<ILLMClient> {
  const config = await loadProviderConfig();

  switch (config.provider) {
    case "openai": {
      // Use CodexLLMClient when adapter is openai_codex_cli
      if (config.adapter === "openai_codex_cli") {
        if (!config.api_key) {
          throw new LLMError(
            "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
          );
        }
        return new CodexLLMClient({
          cliPath: config.codex_cli_path,
          model: config.model,
          lightModel: config.light_model,
        });
      }
      // Otherwise use OpenAILLMClient
      if (!config.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new OpenAILLMClient({
        apiKey: config.api_key,
        model: config.model,
        baseURL: config.base_url,
        lightModel: config.light_model,
      });
    }

    case "ollama":
      return new OllamaLLMClient({
        baseUrl: config.base_url ?? "http://localhost:11434",
        model: config.model ?? "qwen3:4b",
        lightModel: config.light_model,
      });

    case "anthropic":
      if (!config.api_key) {
        throw new LLMError(
          "ANTHROPIC_API_KEY is not set.\nSet it via: export ANTHROPIC_API_KEY=sk-ant-..."
        );
      }
      return new LLMClient(config.api_key, undefined, config.light_model);

    default:
      // Unknown provider falls back to OpenAI
      if (!config.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new OpenAILLMClient({
        apiKey: config.api_key,
        model: config.model,
        baseURL: config.base_url,
        lightModel: config.light_model,
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
  const envBaseUrl = process.env["PULSEED_A2A_BASE_URL"];
  if (envBaseUrl && !config.a2a?.agents) {
    registry.register(new A2AAdapter({
      baseUrl: envBaseUrl,
      authToken: process.env["PULSEED_A2A_AUTH_TOKEN"],
    }));
  }

  // OpenClaw from provider config
  if (config.openclaw) {
    registry.register(new OpenClawACPAdapter({
      cliPath: config.openclaw.cli_path,
      profile: config.openclaw.profile,
      model: config.openclaw.model,
      workDir: config.openclaw.work_dir,
    }));
  }

  // Environment variable shortcut
  if (process.env["PULSEED_OPENCLAW_CLI_PATH"] && !config.openclaw) {
    registry.register(new OpenClawACPAdapter({
      cliPath: process.env["PULSEED_OPENCLAW_CLI_PATH"],
      profile: process.env["PULSEED_OPENCLAW_PROFILE"],
    }));
  }

  return registry;
}
