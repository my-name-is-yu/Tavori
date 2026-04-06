import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as url from "node:url";
import yaml from "js-yaml";
import { getPluginsDir } from "../base/utils/paths.js";
import { writeJsonFileAtomic } from "../base/utils/json-io.js";
import { ValidationError } from "../base/utils/errors.js";
import type { Logger } from "./logger.js";
import {
  PluginManifestSchema,
  PluginStateSchema,
  type PluginManifest,
  type PluginState,
  type PluginType,
  type INotifier,
} from "../base/types/plugin.js";
import type { AdapterRegistry, IAdapter } from "../orchestrator/execution/adapter-layer.js";
import type { DataSourceRegistry, IDataSourceAdapter } from "../platform/observation/data-source-adapter.js";
import type { NotifierRegistry } from "./notifier-registry.js";
import type { IScheduleSource } from "./schedule-source.js";

// ─── PluginLoader ───

/**
 * Discovers, loads, validates, and registers plugins from ~/.pulseed/plugins/.
 *
 * Design principles:
 *  - Plugin load failures never crash PulSeed. Every error is caught, logged,
 *    and returned as an error-state PluginState.
 *  - Supports both plugin.yaml and plugin.json manifest formats.
 *  - Routes each plugin to the correct registry based on manifest.type.
 */
export class PluginLoader {
  private adapterRegistry: AdapterRegistry;
  private dataSourceRegistry: DataSourceRegistry;
  private notifierRegistry: NotifierRegistry;
  private pluginsDir: string;
  private pluginStates: Map<string, PluginState> = new Map();
  private scheduleSources: Map<string, IScheduleSource> = new Map();
  private readonly logger?: Logger;

  constructor(
    adapterRegistry: AdapterRegistry,
    dataSourceRegistry: DataSourceRegistry,
    notifierRegistry: NotifierRegistry,
    pluginsDir?: string,
    logger?: Logger
  ) {
    this.adapterRegistry = adapterRegistry;
    this.dataSourceRegistry = dataSourceRegistry;
    this.notifierRegistry = notifierRegistry;
    this.pluginsDir = pluginsDir ?? getPluginsDir();
    this.logger = logger;
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

    // 1b. Semver compatibility check
    const pulseedVersion = getPulseedVersion();
    const minVer = manifest.min_pulseed_version;
    const maxVer = manifest.max_pulseed_version;
    if (!satisfiesRange(pulseedVersion, minVer, maxVer)) {
      const range = [
        minVer ? `>=${minVer}` : "",
        maxVer ? `<=${maxVer}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      this.logger?.warn(
        `[PluginLoader] Skipping incompatible plugin "${manifest.name}": requires PulSeed ${range}, got ${pulseedVersion}`
      );
      return this.buildIncompatibleState(manifest, pulseedVersion, range);
    }

    // 2. Dynamically import the entry point
    const entryPath = path.resolve(pluginDir, manifest.entry_point);
    if (!entryPath.startsWith(pluginDir + path.sep) && entryPath !== pluginDir) {
      throw new ValidationError(`Plugin entry point escapes plugin directory: ${manifest.entry_point}`);
    }
    let module: { default?: unknown };
    try {
      // Use pathToFileURL for cross-platform compatibility in ESM
      const { pathToFileURL } = await import("node:url");
      module = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to import plugin entry point: ${entryPath} — ${msg}`);
    }

    const impl = module.default;
    if (impl === undefined || impl === null) {
      throw new Error(
        `Plugin entry point has no default export: ${entryPath}`
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
        throw new Error(`Failed to parse plugin.yaml: ${yamlPath} — ${msg}`);
      }
    } else {
      // Attempt JSON
      const jsonContent = await readFileSafe(jsonPath);
      if (jsonContent !== null) {
        try {
          raw = JSON.parse(jsonContent);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to parse plugin.json: ${jsonPath} — ${msg}`);
        }
      } else {
        throw new Error(
          `Manifest file not found (plugin.yaml / plugin.json): ${pluginDir}`
        );
      }
    }

    const result = PluginManifestSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new ValidationError(`Plugin manifest schema validation failed:\n${issues}`);
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
      schedule_source: ["id", "fetchEntries", "healthCheck"],
    };

    const required = requiredMethods[type];
    for (const method of required) {
      if (!(method in (impl as object))) {
        throw new ValidationError(
          `Plugin is missing required method "${method}" (type: ${type})`
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
      case "schedule_source":
        this.scheduleSources.set((impl as IScheduleSource).id, impl as IScheduleSource);
        break;
    }
  }

  /**
   * Return all loaded schedule source plugins.
   */
  getScheduleSources(): IScheduleSource[] {
    return Array.from(this.scheduleSources.values());
  }

  // ─── State builders ───

  buildSuccessState(manifest: PluginManifest): PluginState {
    const state = PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "loaded",
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
    this.pluginStates.set(manifest.name, state);
    return state;
  }

  buildIncompatibleState(manifest: PluginManifest, pulseedVersion: string, range: string): PluginState {
    const state = PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "incompatible",
      error_message: `Requires PulSeed ${range}, got ${pulseedVersion}`,
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
    this.pluginStates.set(manifest.name, state);
    return state;
  }

  buildErrorState(pluginDir: string, reason: unknown): PluginState {
    const errorMessage =
      reason instanceof Error ? reason.message : String(reason);
    const dirName = path.basename(pluginDir);

    this.logger?.error(`[PluginLoader] Failed to load plugin: ${pluginDir}\n  ${errorMessage}`);

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

  /**
   * Return the PluginState for a given plugin name, or null if not found.
   */
  getPluginState(pluginName: string): PluginState | null {
    return this.pluginStates.get(pluginName) ?? null;
  }

  /**
   * Update the in-memory plugin state and persist to disk.
   */
  async updatePluginState(
    pluginName: string,
    updates: Partial<Pick<PluginState, "trust_score" | "usage_count" | "success_count" | "failure_count">>
  ): Promise<void> {
    const existing = this.pluginStates.get(pluginName);
    if (existing === undefined) {
      return;
    }
    const updated = PluginStateSchema.parse({ ...existing, ...updates });
    this.pluginStates.set(pluginName, updated);

    // Persist to disk: ~/.pulseed/plugins/<name>/state.json
    const statePath = path.join(this.pluginsDir, pluginName, "state.json");
    await writeJsonFileAtomic(statePath, updated);
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

// ─── PulSeed version (read once from package.json) ───

let _pulseedVersion: string | undefined;

function getPulseedVersion(): string {
  if (_pulseedVersion !== undefined) return _pulseedVersion;
  try {
    const pkgPath = path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      "../../package.json"
    );
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf-8")) as { version: string };
    _pulseedVersion = pkg.version;
  } catch {
    _pulseedVersion = "0.0.0";
  }
  return _pulseedVersion;
}

// ─── Semver utilities (no external deps) ───

export function parseSemver(version: string): { major: number; minor: number; patch: number } {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number }
): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

export function satisfiesRange(version: string, min?: string, max?: string): boolean {
  const v = parseSemver(version);
  if (min !== undefined && compareSemver(v, parseSemver(min)) < 0) return false;
  if (max !== undefined && compareSemver(v, parseSemver(max)) > 0) return false;
  return true;
}

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
