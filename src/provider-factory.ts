// ─── Provider Factory ───
//
// Shared factory helpers for building LLM clients and adapter registries.
// Used by both CLIRunner and TUI entry to avoid duplicating wiring logic.

import { LLMClient, type ILLMClient } from "./llm-client.js";
import { OllamaLLMClient } from "./ollama-client.js";
import { OpenAILLMClient } from "./openai-client.js";
import { AdapterRegistry } from "./adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "./adapters/claude-code-cli.js";
import { ClaudeAPIAdapter } from "./adapters/claude-api.js";
import { OpenAICodexCLIAdapter } from "./adapters/openai-codex.js";

/**
 * Build an LLM client based on MOTIVA_LLM_PROVIDER environment variable.
 *
 * - MOTIVA_LLM_PROVIDER=ollama  → OllamaLLMClient (OLLAMA_BASE_URL, OLLAMA_MODEL)
 * - MOTIVA_LLM_PROVIDER=openai  → OpenAILLMClient (OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL)
 * - (default)                   → LLMClient / Anthropic (ANTHROPIC_API_KEY required)
 */
export function buildLLMClient(): ILLMClient {
  const provider = process.env.MOTIVA_LLM_PROVIDER;

  if (provider === "ollama") {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const model = process.env.OLLAMA_MODEL ?? "qwen3:4b";
    return new OllamaLLMClient({ baseUrl, model });
  }

  if (provider === "openai") {
    return new OpenAILLMClient({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }

  // Default: Anthropic
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required (or set MOTIVA_LLM_PROVIDER=openai|ollama)"
    );
  }
  return new LLMClient(apiKey);
}

/**
 * Build an AdapterRegistry pre-populated with the standard adapters.
 * Registers ClaudeCodeCLIAdapter, ClaudeAPIAdapter, and OpenAICodexCLIAdapter.
 */
export function buildAdapterRegistry(llmClient: ILLMClient): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeCLIAdapter());
  registry.register(new ClaudeAPIAdapter(llmClient));
  registry.register(new OpenAICodexCLIAdapter());
  return registry;
}
