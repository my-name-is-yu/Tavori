import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectApiKeys,
  getModelsForProvider,
  getAdaptersForModel,
  maskKey,
  PROVIDERS,
  PROVIDER_LABELS,
  ENV_KEY_NAMES,
  RECOMMENDED_MODELS,
  RECOMMENDED_ADAPTERS,
} from "../commands/setup-shared.js";
import { ROOT_PRESETS } from "../commands/presets/root-presets.js";

// ─── detectApiKeys ───

describe("detectApiKeys", () => {
  beforeEach(() => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("returns false for both when no keys are set", () => {
    const result = detectApiKeys();
    expect(result.openai).toBe(false);
    expect(result.anthropic).toBe(false);
  });

  it("returns true for openai when OPENAI_API_KEY is set", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-openai-key";
    const result = detectApiKeys();
    expect(result.openai).toBe(true);
    expect(result.anthropic).toBe(false);
  });

  it("returns true for anthropic when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const result = detectApiKeys();
    expect(result.openai).toBe(false);
    expect(result.anthropic).toBe(true);
  });

  it("returns true for both when both keys are set", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-openai-key";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    const result = detectApiKeys();
    expect(result.openai).toBe(true);
    expect(result.anthropic).toBe(true);
  });
});

// ─── getModelsForProvider ───

describe("getModelsForProvider", () => {
  it("returns openai models for openai provider", () => {
    const models = getModelsForProvider("openai");
    expect(models.length).toBeGreaterThan(0);
    // All returned models should be from openai provider
    expect(models).toContain("gpt-5.4-mini");
    expect(models).toContain("gpt-4.1");
  });

  it("returns anthropic models for anthropic provider", () => {
    const models = getModelsForProvider("anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain("claude-sonnet-4-6");
    expect(models).toContain("claude-haiku-4-5");
  });

  it("does not mix providers (openai models should not include anthropic models)", () => {
    const openaiModels = getModelsForProvider("openai");
    const anthropicModels = getModelsForProvider("anthropic");
    const overlap = openaiModels.filter((m) => anthropicModels.includes(m));
    expect(overlap).toHaveLength(0);
  });

  it("returns empty array for unknown provider", () => {
    const models = getModelsForProvider("unknown-provider");
    expect(models).toHaveLength(0);
  });
});

// ─── getAdaptersForModel ───

describe("getAdaptersForModel", () => {
  it("returns correct adapters for gpt-5.4-mini", () => {
    const adapters = getAdaptersForModel("gpt-5.4-mini", "openai");
    expect(adapters).toContain("openai_codex_cli");
    expect(adapters).toContain("openai_api");
  });

  it("returns correct adapters for claude-sonnet-4-6", () => {
    const adapters = getAdaptersForModel("claude-sonnet-4-6", "anthropic");
    expect(adapters).toContain("claude_code_cli");
    expect(adapters).toContain("claude_api");
  });

  it("returns openai fallback adapters for unknown model with openai provider", () => {
    const adapters = getAdaptersForModel("my-custom-model", "openai");
    expect(adapters).toContain("openai_codex_cli");
    expect(adapters).toContain("openai_api");
  });

  it("returns anthropic fallback adapters for unknown model with anthropic provider", () => {
    const adapters = getAdaptersForModel("my-custom-model", "anthropic");
    expect(adapters).toContain("claude_code_cli");
    expect(adapters).toContain("claude_api");
  });

  it("returns openai_api for unknown model with ollama provider", () => {
    const adapters = getAdaptersForModel("my-ollama-model", "ollama");
    expect(adapters).toContain("openai_api");
  });

  it("returns empty array for unknown model with unknown provider", () => {
    const adapters = getAdaptersForModel("my-custom-model", "unknown");
    expect(adapters).toHaveLength(0);
  });
});

// ─── maskKey ───

describe("maskKey", () => {
  it("returns (not set) for undefined", () => {
    expect(maskKey(undefined)).toBe("(not set)");
  });

  it("returns **** for short keys (8 chars or fewer)", () => {
    expect(maskKey("short")).toBe("****");
    expect(maskKey("12345678")).toBe("****");
  });

  it("keeps first 4 and last 4 chars for longer keys", () => {
    expect(maskKey("sk-test-key-12345678")).toBe("sk-t...5678");
    expect(maskKey("sk-ant-abcd1234")).toBe("sk-a...1234");
  });

  it("handles exactly 9 characters", () => {
    const masked = maskKey("123456789");
    expect(masked).toBe("1234...6789");
  });
});

// ─── ROOT_PRESETS ───

describe("ROOT_PRESETS", () => {
  const PRESET_KEYS = ["default", "professional", "caveman"] as const;

  it("contains all 3 expected presets", () => {
    for (const key of PRESET_KEYS) {
      expect(ROOT_PRESETS).toHaveProperty(key);
    }
  });

  it.each(PRESET_KEYS)("preset %s has required fields (name, description, content)", (key) => {
    const preset = ROOT_PRESETS[key];
    expect(typeof preset.name).toBe("string");
    expect(preset.name.length).toBeGreaterThan(0);
    expect(typeof preset.description).toBe("string");
    expect(preset.description.length).toBeGreaterThan(0);
    expect(typeof preset.content).toBe("string");
    expect(preset.content.length).toBeGreaterThan(0);
  });

  it.each(PRESET_KEYS)("preset %s content starts with # How I Work or similar heading", (key) => {
    const preset = ROOT_PRESETS[key];
    // Content should start with a markdown heading
    expect(preset.content.trimStart()).toMatch(/^#/);
  });

  it.each(PRESET_KEYS)("preset %s avoids delegate-only wording", (key) => {
    const preset = ROOT_PRESETS[key];
    expect(preset.content.toLowerCase()).not.toContain("always delegate");
    expect(preset.content.toLowerCase()).not.toContain("delegate always");
  });
});

// ─── Constants sanity checks ───

describe("setup-shared constants", () => {
  it("PROVIDERS contains openai, anthropic, ollama", () => {
    expect(PROVIDERS).toContain("openai");
    expect(PROVIDERS).toContain("anthropic");
    expect(PROVIDERS).toContain("ollama");
  });

  it("PROVIDER_LABELS has a label for each provider", () => {
    for (const prov of PROVIDERS) {
      expect(PROVIDER_LABELS).toHaveProperty(prov);
      expect(typeof PROVIDER_LABELS[prov]).toBe("string");
      expect(PROVIDER_LABELS[prov].length).toBeGreaterThan(0);
    }
  });

  it("ENV_KEY_NAMES maps openai and anthropic to env var names", () => {
    expect(ENV_KEY_NAMES["openai"]).toBe("OPENAI_API_KEY");
    expect(ENV_KEY_NAMES["anthropic"]).toBe("ANTHROPIC_API_KEY");
  });

  it("RECOMMENDED_MODELS provides a model for each provider", () => {
    for (const prov of PROVIDERS) {
      expect(RECOMMENDED_MODELS).toHaveProperty(prov);
      expect(typeof RECOMMENDED_MODELS[prov]).toBe("string");
    }
  });

  it("RECOMMENDED_ADAPTERS provides adapters for openai and anthropic", () => {
    expect(RECOMMENDED_ADAPTERS).toHaveProperty("openai");
    expect(RECOMMENDED_ADAPTERS).toHaveProperty("anthropic");
  });
});

// ─── runSetupWizard export check ───

describe("setup-wizard module", () => {
  it("exports runSetupWizard as a function", async () => {
    const mod = await import("../commands/setup-wizard.js");
    expect(typeof mod.runSetupWizard).toBe("function");
  });
});
