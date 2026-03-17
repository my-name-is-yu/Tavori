import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import yaml from "js-yaml";
import {
  PluginManifestSchema,
  PluginStateSchema,
  type PluginManifest,
  type PluginState,
  type PluginType,
  type INotifier,
} from "../types/plugin.js";
import type { AdapterRegistry, IAdapter } from "../execution/adapter-layer.js";
import type { DataSourceRegistry, IDataSourceAdapter } from "../observation/data-source-adapter.js";
import type { NotifierRegistry } from "./notifier-registry.js";

// ─── PluginLoader ───

/**
 * Discovers, loads, validates, and registers plugins from ~/.motiva/plugins/.
 *
 * Design principles:
 *  - Plugin load failures never crash Motiva. Every error is caught, logged,
 *    and returned as an error-state PluginState.
 *  - Supports both plugin.yaml and plugin.json manifest formats.
 *  - Routes each plugin to the correct registry based on manifest.type.
 */
export class PluginLoader {
  private adapterRegistry: AdapterRegistry;
  private dataSourceRegistry: DataSourceRegistry;
  private notifierRegistry: NotifierRegistry;
  private pluginsDir: string;

  constructor(
    adapterRegistry: AdapterRegistry,
    dataSourceRegistry: DataSourceRegistry,
    notifierRegistry: NotifierRegistry,
    pluginsDir?: string
  ) {
    this.adapterRegistry = adapterRegistry;
    this.dataSourceRegistry = dataSourceRegistry;
    this.notifierRegistry = notifierRegistry;
    this.pluginsDir = pluginsDir ?? path.join(os.homedir(), ".motiva", "plugins");
  }

  /**
   * Discover all plugin directories and attempt to load each one.
   * Returns a PluginState for every candidate directory (success or error).
   */
  async loadAll(): Promise<PluginState[]> {
    const pluginDirs = await this.discoverPluginDirs();
    if (pluginDirs.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      pluginDirs.map((dir) => this.loadOne(dir))
    );

    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : this.buildErrorState(pluginDirs[i], r.reason)
    );
  }

  /**
   * Load a single plugin from the given directory.
   * Throws on any failure (caller catches and converts to error state).
   */
  async loadOne(pluginDir: string): Promise<PluginState> {
    // 1. Read and validate manifest
    const manifest = await this.loadManifest(pluginDir);

    // 2. Dynamically import the entry point
    const entryPath = path.resolve(pluginDir, manifest.entry_point);
    let module: { default?: unknown };
    try {
      // Use pathToFileURL for cross-platform compatibility in ESM
      const { pathToFileURL } = await import("node:url");
      module = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`エントリポイントのインポートに失敗: ${entryPath} — ${msg}`);
    }

    const impl = module.default;
    if (impl === undefined || impl === null) {
      throw new Error(
        `プラグインのエントリポイントにdefaultエクスポートがありません: ${entryPath}`
      );
    }

    // 3. Validate interface compliance
    this.validateInterface(manifest.type, impl);

    // 4. Register in the appropriate registry
    await this.registerPlugin(manifest, impl, pluginDir);

    return this.buildSuccessState(manifest);
  }

  /**
   * Scan pluginsDir for subdirectories that contain plugin.yaml or plugin.json.
   */
  async discoverPluginDirs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.pluginsDir);
    } catch {
      // Directory doesn't exist yet — not an error
      return [];
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      const dirPath = path.join(this.pluginsDir, entry);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const hasManifest = await this.hasManifestFile(dirPath);
      if (hasManifest) {
        candidates.push(dirPath);
      }
    }
    return candidates;
  }

  /**
   * Read and parse the plugin manifest (plugin.yaml or plugin.json).
   * Validates against PluginManifestSchema.
   */
  async loadManifest(pluginDir: string): Promise<PluginManifest> {
    // Try YAML first, then JSON
    const yamlPath = path.join(pluginDir, "plugin.yaml");
    const jsonPath = path.join(pluginDir, "plugin.json");

    let raw: unknown;

    // Attempt YAML
    const yamlContent = await readFileSafe(yamlPath);
    if (yamlContent !== null) {
      try {
        raw = yaml.load(yamlContent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`plugin.yaml の解析に失敗: ${yamlPath} — ${msg}`);
      }
    } else {
      // Attempt JSON
      const jsonContent = await readFileSafe(jsonPath);
      if (jsonContent !== null) {
        try {
          raw = JSON.parse(jsonContent);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`plugin.json の解析に失敗: ${jsonPath} — ${msg}`);
        }
      } else {
        throw new Error(
          `マニフェストファイルが見つかりません (plugin.yaml / plugin.json): ${pluginDir}`
        );
      }
    }

    const result = PluginManifestSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`マニフェストのスキーマ検証に失敗:\n${issues}`);
    }

    return result.data;
  }

  /**
   * Check that the plugin implementation exports all required methods for its type.
   */
  validateInterface(type: PluginType, impl: unknown): void {
    const requiredMethods: Record<PluginType, string[]> = {
      adapter: ["execute", "adapterType"],
      data_source: ["connect", "query", "disconnect", "healthCheck"],
      notifier: ["name", "notify", "supports"],
    };

    const required = requiredMethods[type];
    for (const method of required) {
      if (!(method in (impl as object))) {
        throw new Error(
          `プラグインに必須メソッド "${method}" がありません (type: ${type})`
        );
      }
    }
  }

  /**
   * Register the plugin implementation in the appropriate registry.
   */
  async registerPlugin(
    manifest: PluginManifest,
    impl: unknown,
    _pluginDir: string
  ): Promise<void> {
    switch (manifest.type) {
      case "adapter":
        this.adapterRegistry.register(impl as IAdapter);
        break;
      case "data_source":
        this.dataSourceRegistry.register(impl as IDataSourceAdapter);
        break;
      case "notifier":
        this.notifierRegistry.register(manifest.name, impl as INotifier);
        break;
    }
  }

  // ─── State builders ───

  buildSuccessState(manifest: PluginManifest): PluginState {
    return PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "loaded",
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
  }

  buildErrorState(pluginDir: string, reason: unknown): PluginState {
    const errorMessage =
      reason instanceof Error ? reason.message : String(reason);
    const dirName = path.basename(pluginDir);

    console.error(`[PluginLoader] プラグインのロードに失敗: ${pluginDir}\n  ${errorMessage}`);

    // Build a minimal manifest for the error state
    const fallbackManifest: PluginManifest = PluginManifestSchema.parse({
      name: sanitizeName(dirName),
      version: "0.0.0",
      type: "adapter",
      capabilities: ["unknown"],
      description: "(load failed)",
    });

    return PluginStateSchema.parse({
      name: sanitizeName(dirName),
      manifest: fallbackManifest,
      status: "error",
      error_message: errorMessage,
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
  }

  // ─── Private helpers ───

  private async hasManifestFile(dirPath: string): Promise<boolean> {
    for (const filename of ["plugin.yaml", "plugin.json"]) {
      try {
        await fs.access(path.join(dirPath, filename));
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }
}

// ─── Module-level helpers ───

/** Read a file and return its content, or null if it doesn't exist. */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Convert an arbitrary directory name to a valid plugin name.
 * Replaces invalid characters with hyphens and lowercases the result.
 */
function sanitizeName(dirName: string): string {
  const sanitized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-"); // collapse consecutive hyphens
  return sanitized || "unknown";
}
