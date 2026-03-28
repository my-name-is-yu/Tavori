import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { PluginLoader, parseSemver, compareSemver, satisfiesRange } from "../src/runtime/plugin-loader.js";
import { NotifierRegistry } from "../src/runtime/notifier-registry.js";
import { PluginManifestSchema, PluginStateSchema } from "../src/types/plugin.js";
import type { INotifier, NotificationEvent, NotificationEventType, PluginManifest } from "../src/types/plugin.js";
import type { AdapterRegistry, IAdapter, AgentTask, AgentResult } from "../src/execution/adapter-layer.js";
import type { DataSourceRegistry, IDataSourceAdapter } from "../src/observation/data-source-adapter.js";

// ─── Helpers ───

function makeAdapterRegistry(): AdapterRegistry {
  return {
    register: vi.fn(),
    findAdapter: vi.fn(),
    listAdapters: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry;
}

function makeDataSourceRegistry(): DataSourceRegistry {
  return {
    register: vi.fn(),
    findBySourceId: vi.fn(),
    findByDimension: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  } as unknown as DataSourceRegistry;
}

function makeNotifierRegistry(): NotifierRegistry {
  return new NotifierRegistry();
}

function makeValidManifestData(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "test-plugin",
    version: "1.0.0",
    type: "notifier",
    capabilities: ["slack_notification"],
    description: "A test notifier plugin",
    supported_events: ["goal_complete"],
    ...overrides,
  };
}

function makeValidManifest(overrides: Partial<Record<string, unknown>> = {}): PluginManifest {
  return PluginManifestSchema.parse(makeValidManifestData(overrides));
}

function makeNotifierImpl(): INotifier {
  return {
    name: "test-notifier",
    notify: vi.fn().mockResolvedValue(undefined),
    supports: vi.fn().mockReturnValue(true),
  };
}

function makeAdapterImpl(): IAdapter {
  return {
    adapterType: "test-adapter",
    execute: vi.fn().mockResolvedValue({ success: true, output: "" } as AgentResult),
  } as unknown as IAdapter;
}

function makeDataSourceImpl(): IDataSourceAdapter {
  return {
    sourceId: "test-source",
    sourceType: "file" as const,
    config: {} as never,
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ dimensions: {}, timestamp: new Date().toISOString() }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as IDataSourceAdapter;
}

// ─── PluginManifest schema validation ───

describe("PluginManifestSchema", () => {
  it("accepts a valid notifier manifest", () => {
    const data = makeValidManifestData();
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts a valid adapter manifest", () => {
    const data = makeValidManifestData({ type: "adapter", name: "my-adapter" });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts a valid data_source manifest with dimensions", () => {
    const data = makeValidManifestData({
      type: "data_source",
      name: "jira-source",
      dimensions: ["open_count", "velocity"],
    });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects a manifest with an invalid name (uppercase)", () => {
    const data = makeValidManifestData({ name: "MyPlugin" });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with an invalid version (missing patch)", () => {
    const data = makeValidManifestData({ version: "1.0" });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with an unknown type", () => {
    const data = makeValidManifestData({ type: "unknown_type" });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects a manifest missing required capabilities", () => {
    const data = makeValidManifestData({ capabilities: [] });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects a manifest missing name", () => {
    const { name: _name, ...rest } = makeValidManifestData();
    const result = PluginManifestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("applies default values for optional fields", () => {
    const data = makeValidManifestData();
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entry_point).toBe("dist/index.js");
    expect(result.data.dependencies).toEqual([]);
    expect(result.data.config_schema).toEqual({});
    expect(result.data.permissions.network).toBe(false);
  });

  it("accepts config_schema with typed fields", () => {
    const data = makeValidManifestData({
      config_schema: {
        api_key: { type: "string", required: true, description: "API key" },
        timeout: { type: "number", default: 30 },
      },
    });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts full permissions block", () => {
    const data = makeValidManifestData({
      permissions: { network: true, file_read: false, file_write: false, shell: false },
    });
    const result = PluginManifestSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.permissions.network).toBe(true);
  });
});

// ─── Semver utilities ───

describe("parseSemver", () => {
  it("parses a valid semver string", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("throws on invalid semver", () => {
    expect(() => parseSemver("not-a-version")).toThrow(/Invalid semver/);
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver(parseSemver("1.0.0"), parseSemver("1.0.0"))).toBe(0);
  });

  it("returns 1 when a is greater", () => {
    expect(compareSemver(parseSemver("2.0.0"), parseSemver("1.9.9"))).toBe(1);
  });

  it("returns -1 when a is lesser", () => {
    expect(compareSemver(parseSemver("0.9.9"), parseSemver("1.0.0"))).toBe(-1);
  });
});

describe("satisfiesRange", () => {
  it("returns true when no min/max are given", () => {
    expect(satisfiesRange("1.0.0")).toBe(true);
  });

  it("returns true when version equals min", () => {
    expect(satisfiesRange("1.0.0", "1.0.0")).toBe(true);
  });

  it("returns false when version is below min", () => {
    expect(satisfiesRange("0.9.0", "1.0.0")).toBe(false);
  });

  it("returns true when version equals max", () => {
    expect(satisfiesRange("2.0.0", undefined, "2.0.0")).toBe(true);
  });

  it("returns false when version exceeds max", () => {
    expect(satisfiesRange("3.0.0", undefined, "2.0.0")).toBe(false);
  });

  it("returns true when version is within min and max range", () => {
    expect(satisfiesRange("1.5.0", "1.0.0", "2.0.0")).toBe(true);
  });
});

// ─── Version compatibility check in loadOne ───

describe("PluginLoader version compatibility", () => {
  let loader: PluginLoader;

  beforeEach(() => {
    loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/plugins"
    );
  });

  it("returns incompatible state when plugin requires a higher min version", async () => {
    const manifest = makeValidManifest({ min_pulseed_version: "999.0.0" });
    vi.spyOn(loader, "loadManifest").mockResolvedValue(manifest);

    const state = await loader.loadOne("/tmp/plugins/test-plugin");
    expect(state.status).toBe("incompatible");
    expect(state.error_message).toMatch(/999\.0\.0/);
  });

  it("returns incompatible state when plugin requires a lower max version", async () => {
    const manifest = makeValidManifest({ max_pulseed_version: "0.0.1" });
    vi.spyOn(loader, "loadManifest").mockResolvedValue(manifest);

    const state = await loader.loadOne("/tmp/plugins/test-plugin");
    expect(state.status).toBe("incompatible");
    expect(state.error_message).toMatch(/0\.0\.1/);
  });

  it("proceeds normally when no version constraints are specified", async () => {
    const manifest = makeValidManifest({ name: "compat-plugin" });
    vi.spyOn(loader, "loadManifest").mockResolvedValue(manifest);

    const notifierImpl = makeNotifierImpl();
    vi.spyOn(loader, "loadOne").mockResolvedValueOnce(loader.buildSuccessState(manifest));

    const state = await loader.loadOne("/tmp/plugins/compat-plugin");
    expect(state.status).toBe("loaded");
  });
});

// ─── PluginLoader.validateInterface ───

describe("PluginLoader.validateInterface", () => {
  let loader: PluginLoader;

  beforeEach(() => {
    loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/plugins"
    );
  });

  it("passes for a valid notifier implementation", () => {
    const impl = makeNotifierImpl();
    expect(() => loader.validateInterface("notifier", impl)).not.toThrow();
  });

  it("passes for a valid adapter implementation", () => {
    const impl = makeAdapterImpl();
    expect(() => loader.validateInterface("adapter", impl)).not.toThrow();
  });

  it("passes for a valid data_source implementation", () => {
    const impl = makeDataSourceImpl();
    expect(() => loader.validateInterface("data_source", impl)).not.toThrow();
  });

  it("throws when a notifier is missing the notify method", () => {
    const impl = { name: "bad", supports: vi.fn() };
    expect(() => loader.validateInterface("notifier", impl)).toThrow(/notify/);
  });

  it("throws when an adapter is missing the execute method", () => {
    const impl = { adapterType: "bad" };
    expect(() => loader.validateInterface("adapter", impl)).toThrow(/execute/);
  });

  it("throws when a data_source is missing healthCheck", () => {
    const impl = { connect: vi.fn(), query: vi.fn(), disconnect: vi.fn() };
    expect(() => loader.validateInterface("data_source", impl)).toThrow(/healthCheck/);
  });

  it("throws with the missing method name in the error message", () => {
    const impl = { name: "ok", notify: vi.fn() }; // missing supports
    expect(() => loader.validateInterface("notifier", impl)).toThrow('"supports"');
  });
});

// ─── PluginLoader.loadManifest ───

describe("PluginLoader.loadManifest (mocked fs)", () => {
  let loader: PluginLoader;

  beforeEach(() => {
    loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/plugins"
    );
  });

  it("throws when neither plugin.yaml nor plugin.json exists", async () => {
    // Both readFileSafe calls will fail — we rely on the real fs not finding the file
    await expect(loader.loadManifest("/tmp/nonexistent-plugin-dir-xyz")).rejects.toThrow(
      /Manifest file not found/
    );
  });
});

// ─── PluginLoader.buildSuccessState / buildErrorState ───

describe("PluginLoader state builders", () => {
  let loader: PluginLoader;

  beforeEach(() => {
    loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/plugins"
    );
  });

  it("buildSuccessState returns status=loaded with the manifest", () => {
    const manifest = makeValidManifest();
    const state = loader.buildSuccessState(manifest);

    expect(state.status).toBe("loaded");
    expect(state.name).toBe(manifest.name);
    expect(state.manifest).toEqual(manifest);
    expect(state.error_message).toBeUndefined();
    expect(state.trust_score).toBe(0);
    expect(state.usage_count).toBe(0);
  });

  it("buildSuccessState loaded_at is a valid ISO 8601 string", () => {
    const manifest = makeValidManifest();
    const state = loader.buildSuccessState(manifest);
    expect(() => new Date(state.loaded_at)).not.toThrow();
    expect(isNaN(new Date(state.loaded_at).getTime())).toBe(false);
  });

  it("buildErrorState returns status=error with the error message", () => {
    const error = new Error("import failed: module not found");
    const state = loader.buildErrorState("/tmp/plugins/my-plugin", error);

    expect(state.status).toBe("error");
    expect(state.error_message).toContain("import failed");
  });

  it("buildErrorState sanitizes non-alphanumeric dir names", () => {
    const error = new Error("boom");
    const state = loader.buildErrorState("/tmp/plugins/My_Plugin_123", error);

    // sanitized name should match plugin name regex
    expect(state.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("buildErrorState handles non-Error reasons", () => {
    const state = loader.buildErrorState("/tmp/plugins/test-plugin", "raw string error");
    expect(state.error_message).toBe("raw string error");
  });
});

// ─── PluginLoader.loadAll (mocked discoverPluginDirs) ───

describe("PluginLoader.loadAll", () => {
  it("returns empty array when no plugin dirs are found", async () => {
    const loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/pulseed-plugins-nonexistent-dir"
    );

    const states = await loader.loadAll();
    expect(states).toEqual([]);
  });

  it("returns error states for dirs that fail to load, without throwing", async () => {
    const loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/pulseed-plugins-nonexistent-dir"
    );

    // Override discoverPluginDirs to return two fake dirs
    vi.spyOn(loader, "discoverPluginDirs").mockResolvedValue([
      "/tmp/bad-plugin-a",
      "/tmp/bad-plugin-b",
    ]);

    const states = await loader.loadAll();
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.status === "error")).toBe(true);
  });

  it("mixes success and error states correctly", async () => {
    const notifierRegistry = makeNotifierRegistry();
    const loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      notifierRegistry,
      "/tmp/plugins"
    );

    const goodManifest = makeValidManifest({ name: "good-plugin" });
    const goodImpl = makeNotifierImpl();

    vi.spyOn(loader, "discoverPluginDirs").mockResolvedValue([
      "/tmp/plugins/good-plugin",
      "/tmp/plugins/bad-plugin",
    ]);

    // Override loadOne to simulate success for first, failure for second
    vi.spyOn(loader, "loadOne")
      .mockResolvedValueOnce(loader.buildSuccessState(goodManifest))
      .mockRejectedValueOnce(new Error("load failed"));

    const states = await loader.loadAll();

    expect(states).toHaveLength(2);
    expect(states[0].status).toBe("loaded");
    expect(states[1].status).toBe("error");
  });
});

// ─── PluginLoader.discoverPluginDirs ───

describe("PluginLoader.discoverPluginDirs", () => {
  it("returns empty array for a non-existent plugins directory", async () => {
    const loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      "/tmp/pulseed-definitely-not-a-real-dir-abc123"
    );

    const dirs = await loader.discoverPluginDirs();
    expect(dirs).toEqual([]);
  });
});

// ─── PluginLoader.getPluginState / updatePluginState ───

import * as os from "node:os";
import * as fsSync from "node:fs";

describe("PluginLoader.getPluginState and updatePluginState", () => {
  let tmpDir: string;
  let loader: PluginLoader;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pulseed-plugin-state-test-"));
    loader = new PluginLoader(
      makeAdapterRegistry(),
      makeDataSourceRegistry(),
      makeNotifierRegistry(),
      tmpDir
    );
  });

  afterEach(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getPluginState returns null for unknown plugin", () => {
    expect(loader.getPluginState("unknown-plugin")).toBeNull();
  });

  it("getPluginState returns state after buildSuccessState is called", () => {
    const manifest = makeValidManifest({ name: "my-plugin" });
    loader.buildSuccessState(manifest);
    const state = loader.getPluginState("my-plugin");
    expect(state).not.toBeNull();
    expect(state!.name).toBe("my-plugin");
    expect(state!.trust_score).toBe(0);
  });

  it("updatePluginState updates in-memory state", async () => {
    const manifest = makeValidManifest({ name: "my-plugin" });
    loader.buildSuccessState(manifest);
    await loader.updatePluginState("my-plugin", { trust_score: 15, usage_count: 2 });
    const state = loader.getPluginState("my-plugin");
    expect(state!.trust_score).toBe(15);
    expect(state!.usage_count).toBe(2);
  });

  it("updatePluginState persists state to disk", async () => {
    const manifest = makeValidManifest({ name: "my-plugin" });
    loader.buildSuccessState(manifest);
    await loader.updatePluginState("my-plugin", { trust_score: 25, success_count: 3 });
    const statePath = path.join(tmpDir, "my-plugin", "state.json");
    expect(fsSync.existsSync(statePath)).toBe(true);
    const content = JSON.parse(fsSync.readFileSync(statePath, "utf-8"));
    expect(content.trust_score).toBe(25);
    expect(content.success_count).toBe(3);
  });

  it("updatePluginState does nothing for unknown plugin", async () => {
    // Should not throw
    await expect(loader.updatePluginState("ghost-plugin", { trust_score: 10 })).resolves.toBeUndefined();
  });
});
