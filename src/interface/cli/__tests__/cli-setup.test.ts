/**
 * CLI setup wizard tests
 *
 * Tests for src/cli/commands/setup.ts:
 *   - Non-interactive mode with flags
 *   - Correct provider.json generation
 *   - Auto-detection of API keys from env
 *   - Validation of incompatible model/adapter combinations
 *   - Interactive mode with mocked readline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as tty from "node:tty";

vi.mock("node:tty", () => ({
  isatty: vi.fn(() => false),
}));

// ─── Test helpers ───

let tmpDir: string;

function getConfigPath(): string {
  return path.join(tmpDir, "provider.json");
}

async function readConfig(): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(getConfigPath(), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeConfig(raw: string): Promise<void> {
  await fsp.writeFile(getConfigPath(), raw, "utf-8");
}

// ─── Setup / Teardown ───

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-test-"));
  process.env["PULSEED_HOME"] = tmpDir;
  // Clear relevant env vars
  delete process.env["OPENAI_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["PULSEED_PROVIDER"];
  delete process.env["PULSEED_ADAPTER"];
  delete process.env["PULSEED_MODEL"];
  // Reset module cache so PROVIDER_CONFIG_PATH re-evaluates with new PULSEED_HOME
  vi.resetModules();
});

afterEach(async () => {
  delete process.env["PULSEED_HOME"];
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Non-interactive mode tests ───

describe("cmdSetup non-interactive", () => {
  it("saves config with --provider --model --adapter flags", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key-12345678";
    const { cmdSetup } = await import("../commands/setup.js");

    const result = await cmdSetup([
      "--provider", "openai",
      "--model", "gpt-5.4-mini",
      "--adapter", "openai_codex_cli",
    ]);

    expect(result).toBe(0);

    const config = await readConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.adapter).toBe("openai_codex_cli");
    expect(config.api_key).toBe("sk-test-key-12345678");
  });

  it("uses default model when --model is not provided", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key-12345678";
    const { cmdSetup } = await import("../commands/setup.js");

    const result = await cmdSetup(["--provider", "openai"]);

    expect(result).toBe(0);

    const config = await readConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.adapter).toBe("openai_codex_cli");
  });

  it("uses default model for anthropic when --model is not provided", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-12345678";
    const { cmdSetup } = await import("../commands/setup.js");

    const result = await cmdSetup(["--provider", "anthropic"]);

    expect(result).toBe(0);

    const config = await readConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.adapter).toBe("claude_code_cli");
  });

  it("returns error for invalid provider", async () => {
    const { cmdSetup } = await import("../commands/setup.js");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cmdSetup(["--provider", "invalid"]);

    expect(result).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid provider")
    );

    consoleSpy.mockRestore();
  });

  it("returns error for incompatible model and provider", async () => {
    const { cmdSetup } = await import("../commands/setup.js");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cmdSetup([
      "--provider", "anthropic",
      "--model", "gpt-5.4-mini",
    ]);

    expect(result).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not compatible with provider")
    );

    consoleSpy.mockRestore();
  });

  it("returns error for incompatible adapter and model", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-key-12345678";
    const { cmdSetup } = await import("../commands/setup.js");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cmdSetup([
      "--provider", "openai",
      "--model", "gpt-5.4-mini",
      "--adapter", "claude_code_cli",
    ]);

    expect(result).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("not compatible with model")
    );

    consoleSpy.mockRestore();
  });

  it("returns error when --provider is missing in non-interactive mode", async () => {
    const { cmdSetup } = await import("../commands/setup.js");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cmdSetup(["--model", "gpt-5.4-mini"]);

    expect(result).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("--provider is required")
    );

    consoleSpy.mockRestore();
  });
});

// ─── API key auto-detection tests ───

describe("cmdSetup API key detection", () => {
  it("detects OPENAI_API_KEY from environment", async () => {
    process.env["OPENAI_API_KEY"] = "sk-env-detected-key-1234";
    const { cmdSetup } = await import("../commands/setup.js");

    const result = await cmdSetup(["--provider", "openai"]);

    expect(result).toBe(0);

    const config = await readConfig();
    expect(config.api_key).toBe("sk-env-detected-key-1234");
  });

  it("detects ANTHROPIC_API_KEY from environment", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-env-key-5678";
    const { cmdSetup } = await import("../commands/setup.js");

    const result = await cmdSetup(["--provider", "anthropic"]);

    expect(result).toBe(0);

    const config = await readConfig();
    expect(config.api_key).toBe("sk-ant-env-key-5678");
  });

  it("returns error when no API key is available for openai_api adapter", async () => {
    const { cmdSetup } = await import("../commands/setup.js");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cmdSetup(["--provider", "openai", "--adapter", "openai_api"]);

    expect(result).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("API key required")
    );

    consoleSpy.mockRestore();
  });

  it("does not require API key for ollama", async () => {
    const { cmdSetup } = await import("../commands/setup.js");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await cmdSetup(["--provider", "ollama"]);

    expect(result).toBe(0);

    const config = await readConfig();
    expect(config.provider).toBe("ollama");
    expect(config.api_key).toBeUndefined();

    consoleSpy.mockRestore();
  });
});

// ─── Interactive mode tests ───

describe("cmdSetup interactive", () => {
  it("exports cmdSetup function", async () => {
    const mod = await import("../commands/setup.js");
    expect(typeof mod.cmdSetup).toBe("function");
  });
});

// ─── ensureProviderConfig auto-trigger tests ───

describe("ensureProviderConfig", () => {
  it("loads config normally when provider.json exists", async () => {
    process.env["OPENAI_API_KEY"] = "sk-ensure-test-key";
    // Write config directly
    await writeConfig(JSON.stringify({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
    }));

    const providerConfigMod = await import("../../../base/llm/provider-config.js");
    const loadSpy = vi.spyOn(providerConfigMod, "loadProviderConfig").mockImplementation(async () => {
      const raw = await fsp.readFile(getConfigPath(), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        provider: parsed.provider as "openai",
        model: parsed.model as string,
        adapter: parsed.adapter as "openai_codex_cli",
        api_key: process.env["OPENAI_API_KEY"],
      };
    });

    const { ensureProviderConfig } = await import("../ensure-api-key.js");
    const config = await ensureProviderConfig();

    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4-mini");

    loadSpy.mockRestore();
  });

  it("starts the setup wizard when provider.json is missing and stdin is a TTY", async () => {
    vi.mocked(tty.isatty).mockReturnValue(true);
    const setupMod = await import("../commands/setup.js");
    const setupSpy = vi.spyOn(setupMod, "cmdSetup").mockResolvedValue(0);
    const providerConfigMod = await import("../../../base/llm/provider-config.js");
    const loadSpy = vi.spyOn(providerConfigMod, "loadProviderConfig").mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      api_key: "sk-from-wizard",
    });

    const { ensureProviderConfig } = await import("../ensure-api-key.js");
    const config = await ensureProviderConfig();

    expect(setupSpy).toHaveBeenCalledWith([]);
    expect(config.provider).toBe("openai");
    expect(loadSpy).toHaveBeenCalled();
    setupSpy.mockRestore();
    loadSpy.mockRestore();
    vi.mocked(tty.isatty).mockReset();
  });

  it("throws a clear error when provider.json is missing and stdin is not a TTY", async () => {
    vi.mocked(tty.isatty).mockReturnValue(false);
    const { ensureProviderConfig } = await import("../ensure-api-key.js");
    const providerConfigMod = await import("../../../base/llm/provider-config.js");
    const loadSpy = vi.spyOn(providerConfigMod, "loadProviderConfig").mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      api_key: "sk-default",
    });

    const config = await ensureProviderConfig();

    expect(config.provider).toBe("openai");
    expect(loadSpy).toHaveBeenCalled();

    await expect(ensureProviderConfig({ requireInteractiveSetup: true })).rejects.toThrow(
      /no provider configuration found/i
    );
    loadSpy.mockRestore();
    vi.mocked(tty.isatty).mockReset();
  });

  it("falls back to loadProviderConfig when provider.json is invalid JSON and setup is not required", async () => {
    await writeConfig("{not-json");

    vi.mocked(tty.isatty).mockReturnValue(true);
    const providerConfigMod = await import("../../../base/llm/provider-config.js");
    const loadSpy = vi.spyOn(providerConfigMod, "loadProviderConfig").mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "claude_code_cli",
      api_key: "sk-ant-from-wizard",
    });

    const { ensureProviderConfig } = await import("../ensure-api-key.js");
    const config = await ensureProviderConfig();

    expect(config.provider).toBe("anthropic");
    expect(loadSpy).toHaveBeenCalled();
    loadSpy.mockRestore();
    vi.mocked(tty.isatty).mockReset();
  });

  it("throws a clear error when provider.json is invalid JSON and stdin is not a TTY", async () => {
    await writeConfig("{not-json");

    vi.mocked(tty.isatty).mockReturnValue(false);
    const { ensureProviderConfig } = await import("../ensure-api-key.js");
    const providerConfigMod = await import("../../../base/llm/provider-config.js");
    const loadSpy = vi.spyOn(providerConfigMod, "loadProviderConfig").mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      api_key: "sk-default",
    });

    const config = await ensureProviderConfig();

    expect(config.provider).toBe("openai");
    expect(loadSpy).toHaveBeenCalled();

    await expect(
      ensureProviderConfig({ requireInteractiveSetup: true })
    ).rejects.toThrow(/invalid json/i);
    loadSpy.mockRestore();
    vi.mocked(tty.isatty).mockReset();
  });

  it("starts the setup wizard for invalid JSON when interactive setup is required", async () => {
    await writeConfig("{not-json");

    vi.mocked(tty.isatty).mockReturnValue(true);
    const setupMod = await import("../commands/setup.js");
    const setupSpy = vi.spyOn(setupMod, "cmdSetup").mockResolvedValue(0);
    const providerConfigMod = await import("../../../base/llm/provider-config.js");
    const loadSpy = vi.spyOn(providerConfigMod, "loadProviderConfig").mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "claude_code_cli",
      api_key: "sk-ant-from-wizard",
    });

    const { ensureProviderConfig } = await import("../ensure-api-key.js");
    const config = await ensureProviderConfig({ requireInteractiveSetup: true });

    expect(setupSpy).toHaveBeenCalledWith([]);
    expect(config.provider).toBe("anthropic");
    expect(loadSpy).toHaveBeenCalled();
    setupSpy.mockRestore();
    loadSpy.mockRestore();
    vi.mocked(tty.isatty).mockReset();
  });
});
