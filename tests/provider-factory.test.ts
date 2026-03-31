import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock heavy dependencies so no real clients are constructed ───

vi.mock("../src/llm/llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(function() { return { _tag: "LLMClient" }; }),
}));

vi.mock("../src/llm/ollama-client.js", () => ({
  OllamaLLMClient: vi.fn().mockImplementation(function() { return { _tag: "OllamaLLMClient" }; }),
}));

vi.mock("../src/llm/openai-client.js", () => ({
  OpenAILLMClient: vi.fn().mockImplementation(function() { return { _tag: "OpenAILLMClient" }; }),
}));

vi.mock("../src/llm/codex-llm-client.js", () => ({
  CodexLLMClient: vi.fn().mockImplementation(function() { return { _tag: "CodexLLMClient" }; }),
}));

vi.mock("../src/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(function() { return { register: vi.fn() }; }),
}));

vi.mock("../src/adapters/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/adapters/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/adapters/openai-codex.js", () => ({
  OpenAICodexCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../src/adapters/github-issue.js", () => ({
  GitHubIssueAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

// ─── Mock provider-config so we control what each test sees ───

const mockLoadProviderConfig = vi.fn();

vi.mock("../src/llm/provider-config.js", () => ({
  loadProviderConfig: () => mockLoadProviderConfig(),
}));

import { buildLLMClient } from "../src/llm/provider-factory.js";
import { LLMClient } from "../src/llm/llm-client.js";

// ─── Tests ───

describe("buildLLMClient — early API key validation", () => {
  beforeEach(() => {
    mockLoadProviderConfig.mockReset();
  });

  // ── anthropic ──────────────────────────────────────────────────────────────

  describe("provider: anthropic", () => {
    it("throws when api_key is absent", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "claude_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "claude_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/export ANTHROPIC_API_KEY/);
    });

    it("succeeds when api_key is present", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "claude_api",
        api_key: "sk-ant-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });

    it("passes config.model to LLMClient constructor", async () => {
      const MockedLLMClient = vi.mocked(LLMClient);
      MockedLLMClient.mockClear();

      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-opus-4-5",
        adapter: "claude_api",
        api_key: "sk-ant-test",
      });

      await buildLLMClient();

      expect(MockedLLMClient).toHaveBeenCalledOnce();
      // constructor: (apiKey, guardrailRunner, lightModel, model)
      expect(MockedLLMClient).toHaveBeenCalledWith("sk-ant-test", undefined, undefined, "claude-opus-4-5");
    });
  });

  // ── openai ─────────────────────────────────────────────────────────────────

  describe("provider: openai", () => {
    it("throws when api_key is absent (openai_api adapter)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/OPENAI_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/export OPENAI_API_KEY/);
    });

    it("succeeds when api_key is present (openai_api adapter)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
        api_key: "sk-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });
  });

  // ── openai with codex adapter ─────────────────────────────────────────────

  describe("provider: openai with openai_codex_cli adapter", () => {
    it("succeeds when api_key is absent (CodexLLMClient uses codex CLI auth)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });

    it("succeeds when api_key is present", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        api_key: "sk-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });
  });

  // ── ollama ─────────────────────────────────────────────────────────────────

  describe("provider: ollama", () => {
    it("succeeds without any API key (ollama needs no key)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "ollama",
        model: "qwen3:4b",
        adapter: "claude_api",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });
  });

  // ── default fallback (unknown provider → OpenAI) ───────────────────────────

  describe("provider: default fallback", () => {
    it("throws when api_key is absent in default fallback path", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        // @ts-expect-error intentionally unknown provider to exercise default branch
        provider: "unknown-provider",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/OPENAI_API_KEY is not set/);
    });

    it("succeeds when api_key is present in default fallback path", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        // @ts-expect-error intentionally unknown provider to exercise default branch
        provider: "unknown-provider",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
        api_key: "sk-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });
  });
});
