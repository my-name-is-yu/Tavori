import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  migrateProviderConfig,
  validateProviderConfig,
  MODEL_REGISTRY,
} from "../src/llm/provider-config.js";

// ─── Migration Tests ───

describe("migrateProviderConfig", () => {
  it("migrates codex provider to openai", () => {
    const result = migrateProviderConfig({
      llm_provider: "codex",
      default_adapter: "openai_codex_cli",
      codex: { cli_path: "/usr/local/bin/codex", model: "gpt-5.4-mini" },
      openai: { api_key: "sk-test" },
    });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.adapter).toBe("openai_codex_cli");
    expect(result.api_key).toBe("sk-test");
    expect(result.codex_cli_path).toBe("/usr/local/bin/codex");
  });

  it("migrates openai provider", () => {
    const result = migrateProviderConfig({
      llm_provider: "openai",
      default_adapter: "openai_api",
      openai: { api_key: "sk-openai", model: "gpt-4.1", base_url: "https://custom.api" },
    });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1");
    expect(result.adapter).toBe("openai_api");
    expect(result.api_key).toBe("sk-openai");
    expect(result.base_url).toBe("https://custom.api");
  });

  it("migrates anthropic provider", () => {
    const result = migrateProviderConfig({
      llm_provider: "anthropic",
      default_adapter: "claude_api",
      anthropic: { api_key: "sk-ant-test", model: "claude-sonnet-4-6" },
    });

    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.adapter).toBe("claude_api");
    expect(result.api_key).toBe("sk-ant-test");
  });

  it("migrates ollama provider", () => {
    const result = migrateProviderConfig({
      llm_provider: "ollama",
      default_adapter: "claude_api",
      ollama: { base_url: "http://localhost:11434", model: "llama3" },
    });

    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3");
    expect(result.adapter).toBe("claude_api");
    expect(result.base_url).toBe("http://localhost:11434");
    expect(result.api_key).toBeUndefined();
  });

  it("preserves a2a config unchanged", () => {
    const a2a = {
      agents: {
        test_agent: {
          base_url: "http://localhost:8080",
          auth_token: "token123",
        },
      },
    };

    const result = migrateProviderConfig({
      llm_provider: "codex",
      default_adapter: "openai_codex_cli",
      a2a,
    });

    expect(result.a2a).toEqual(a2a);
  });

  it("uses default model when provider section is missing", () => {
    const result = migrateProviderConfig({
      llm_provider: "openai",
      default_adapter: "openai_api",
    });

    expect(result.model).toBe("gpt-5.4-mini");
  });

  it("uses codex.model over openai.model for codex provider", () => {
    const result = migrateProviderConfig({
      llm_provider: "codex",
      default_adapter: "openai_codex_cli",
      codex: { model: "gpt-4.1" },
      openai: { model: "gpt-4o-mini" },
    });

    expect(result.model).toBe("gpt-4.1");
  });

  it("falls back to openai.model when codex.model is missing for codex provider", () => {
    const result = migrateProviderConfig({
      llm_provider: "codex",
      default_adapter: "openai_codex_cli",
      openai: { model: "gpt-4o-mini" },
    });

    expect(result.model).toBe("gpt-4o-mini");
  });
});

// ─── Validation Tests ───

describe("validateProviderConfig", () => {
  it("returns valid for a correct openai config", () => {
    const result = validateProviderConfig({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      api_key: "sk-test",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns valid for a correct anthropic config", () => {
    const result = validateProviderConfig({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "claude_api",
      api_key: "sk-ant-test",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns valid for ollama without api_key", () => {
    const result = validateProviderConfig({
      provider: "ollama",
      model: "llama3",
      adapter: "claude_api",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports error when model provider mismatches", () => {
    const result = validateProviderConfig({
      provider: "anthropic",
      model: "gpt-5.4-mini",
      adapter: "claude_api",
      api_key: "sk-ant-test",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('requires provider "openai" but got "anthropic"')
    );
  });

  it("reports error when model is incompatible with adapter", () => {
    const result = validateProviderConfig({
      provider: "openai",
      model: "gpt-4o-mini",
      adapter: "openai_codex_cli",
      api_key: "sk-test",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('not compatible with adapter "openai_codex_cli"')
    );
  });

  it("reports error when api_key is missing for openai", () => {
    const result = validateProviderConfig({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("API key required")
    );
  });

  it("reports error when api_key is missing for anthropic", () => {
    const result = validateProviderConfig({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "claude_api",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("API key required")
    );
  });

  it("skips model compatibility check for unknown models", () => {
    const result = validateProviderConfig({
      provider: "openai",
      model: "my-custom-model",
      adapter: "openai_api",
      api_key: "sk-test",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("skips model compatibility check for ollama models (dynamic)", () => {
    const result = validateProviderConfig({
      provider: "ollama",
      model: "llama3:70b",
      adapter: "claude_api",
    });

    expect(result.valid).toBe(true);
  });
});

// ─── MODEL_REGISTRY Tests ───

describe("MODEL_REGISTRY", () => {
  it("contains expected models", () => {
    expect(MODEL_REGISTRY["gpt-5.4-mini"]).toBeDefined();
    expect(MODEL_REGISTRY["gpt-4.1"]).toBeDefined();
    expect(MODEL_REGISTRY["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_REGISTRY["claude-haiku-4-5"]).toBeDefined();
  });

  it("gpt-4o-mini is not compatible with codex adapter", () => {
    const entry = MODEL_REGISTRY["gpt-4o-mini"];
    expect(entry.adapters).not.toContain("openai_codex_cli");
    expect(entry.adapters).toContain("openai_api");
  });

  it("claude models are anthropic provider", () => {
    expect(MODEL_REGISTRY["claude-sonnet-4-6"].provider).toBe("anthropic");
    expect(MODEL_REGISTRY["claude-haiku-4-5"].provider).toBe("anthropic");
  });
});

// ─── loadProviderConfig Tests (with fs mock) ───

// Mock node:fs/promises before any imports that use it
const mockAccess = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    access: (...args: unknown[]) => mockAccess(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

// Mock writeJsonFileAtomic to prevent actual file writes
vi.mock("../src/utils/json-io.js", () => ({
  writeJsonFileAtomic: vi.fn().mockResolvedValue(undefined),
}));

// Import loadProviderConfig AFTER mocks are set up (vi.mock is hoisted by vitest)
const { loadProviderConfig } = await import("../src/llm/provider-config.js");

describe("loadProviderConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "PULSEED_PROVIDER", "PULSEED_LLM_PROVIDER",
    "PULSEED_ADAPTER", "PULSEED_DEFAULT_ADAPTER",
    "PULSEED_MODEL",
    "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
    "OLLAMA_BASE_URL", "OLLAMA_MODEL",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockAccess.mockReset();
    mockReadFile.mockReset();
    // Default: file does not exist
    mockAccess.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns defaults when no file exists and no env vars", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await loadProviderConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.adapter).toBe("openai_codex_cli");
    warnSpy.mockRestore();
  });

  it("PULSEED_PROVIDER env var overrides file config", async () => {
    process.env["PULSEED_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const config = await loadProviderConfig();
    expect(config.provider).toBe("anthropic");
  });

  it("PULSEED_LLM_PROVIDER (old env var) works as fallback", async () => {
    process.env["PULSEED_LLM_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const config = await loadProviderConfig();
    expect(config.provider).toBe("anthropic");
  });

  it("PULSEED_MODEL env var overrides file model", async () => {
    process.env["PULSEED_MODEL"] = "my-custom-model";
    process.env["OPENAI_API_KEY"] = "sk-test";
    const config = await loadProviderConfig();
    expect(config.model).toBe("my-custom-model");
  });

  it("auto-migrates legacy config format", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({
      llm_provider: "codex",
      default_adapter: "openai_codex_cli",
      codex: { model: "gpt-5.4-mini" },
      openai: { api_key: "sk-test" },
    }));

    const config = await loadProviderConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.adapter).toBe("openai_codex_cli");
    expect(config.api_key).toBe("sk-test");
  });

  it("reads new flat format directly", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({
      provider: "openai",
      model: "gpt-4.1",
      adapter: "openai_api",
      api_key: "sk-test",
    }));

    const config = await loadProviderConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4.1");
    expect(config.adapter).toBe("openai_api");
    expect(config.api_key).toBe("sk-test");
  });

  it("auto-corrects gpt-4o-mini to gpt-5.4-mini when adapter is openai_codex_cli", async () => {
    process.env["OPENAI_MODEL"] = "gpt-4o-mini";
    process.env["OPENAI_API_KEY"] = "sk-test";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = await loadProviderConfig();

    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.adapter).toBe("openai_codex_cli");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not compatible with adapter "openai_codex_cli"'));
    warnSpy.mockRestore();
  });

  it("OPENAI_API_KEY env var overrides file api_key for openai provider", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(JSON.stringify({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      api_key: "sk-file",
    }));
    process.env["OPENAI_API_KEY"] = "sk-env";

    const config = await loadProviderConfig();
    expect(config.api_key).toBe("sk-env");
  });
});
