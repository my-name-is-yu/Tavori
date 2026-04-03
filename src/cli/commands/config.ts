// ─── pulseed config, provider, datasource, and capability commands ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { getDatasourcesDir } from "../../utils/paths.js";
import { writeJsonFile, readJsonFile } from "../../utils/json-io.js";

import { StateManager } from "../../state/state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";

import { loadProviderConfig, saveProviderConfig } from "../../llm/provider-config.js";
import type { ProviderConfig } from "../../llm/provider-config.js";
import { buildLLMClient } from "../../llm/provider-factory.js";
import { ReportingEngine } from "../../reporting/reporting-engine.js";
import { CapabilityDetector } from "../../observation/capability-detector.js";
import { formatOperationError, printCharacterConfig } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";

function maskSecrets(config: ProviderConfig): ProviderConfig {
  return JSON.parse(JSON.stringify(config), (key, value) => {
    if (typeof value === "string" && (key === "api_key" || key === "apiKey")) {
      return value.length > 0 ? "****" : value;
    }
    return value as unknown;
  }) as ProviderConfig;
}

export async function cmdProvider(argv: string[]): Promise<number> {
  const providerSubcommand = argv[0];

  if (!providerSubcommand || providerSubcommand === "show") {
    const config = await loadProviderConfig();
    console.log(JSON.stringify(maskSecrets(config), null, 2));
    return 0;
  }

  if (providerSubcommand === "set") {
    let values: { provider?: string; model?: string; adapter?: string; llm?: string };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          provider: { type: "string" },
          model: { type: "string" },
          adapter: { type: "string" },
          llm: { type: "string" }, // backward compat alias for --provider
        },
        strict: false,
      }) as { values: { provider?: string; model?: string; adapter?: string; llm?: string } });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse provider set arguments", err));
      values = {};
    }

    // --llm is a backward compat alias for --provider
    const providerValue = values.provider ?? values.llm;

    const validProviders = ["anthropic", "openai", "ollama"];
    const validAdapters = ["claude_code_cli", "claude_api", "openai_codex_cli", "openai_api", "github_issue"];

    if (providerValue && !validProviders.includes(providerValue)) {
      // Accept "codex" as alias for "openai" (backward compat)
      if (providerValue === "codex") {
        values.provider = "openai";
      } else {
        getCliLogger().error(
          `Error: invalid --provider "${providerValue}". Valid: ${validProviders.join(", ")}`
        );
        return 1;
      }
    }

    if (values.adapter && !validAdapters.includes(values.adapter)) {
      getCliLogger().error(
        `Error: invalid --adapter "${values.adapter}". Valid: ${validAdapters.join(", ")}`
      );
      return 1;
    }

    const current = await loadProviderConfig();
    const resolvedProvider = (values.provider ?? providerValue) as ProviderConfig["provider"] | undefined;
    const updated: ProviderConfig = {
      ...current,
      ...(resolvedProvider ? { provider: resolvedProvider } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.adapter ? { adapter: values.adapter as ProviderConfig["adapter"] } : {}),
    };

    await saveProviderConfig(updated);
    console.log("Provider config updated:");
    console.log(JSON.stringify(maskSecrets(updated), null, 2));
    return 0;
  }

  getCliLogger().error(`Unknown provider subcommand: "${providerSubcommand}"`);
  getCliLogger().error("Available: provider show, provider set");
  return 1;
}

export async function cmdConfigCharacter(
  characterConfigManager: CharacterConfigManager,
  argv: string[]
): Promise<number> {
  let values: {
    show?: boolean;
    reset?: boolean;
    "caution-level"?: string;
    "stall-flexibility"?: string;
    "communication-directness"?: string;
    "proactivity-level"?: string;
  };

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        show: { type: "boolean" },
        reset: { type: "boolean" },
        "caution-level": { type: "string" },
        "stall-flexibility": { type: "string" },
        "communication-directness": { type: "string" },
        "proactivity-level": { type: "string" },
      },
      strict: false,
    }) as {
      values: {
        show?: boolean;
        reset?: boolean;
        "caution-level"?: string;
        "stall-flexibility"?: string;
        "communication-directness"?: string;
        "proactivity-level"?: string;
      };
    });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse character config arguments", err));
    values = {};
  }

  const hasFlags =
    values.show ||
    values.reset ||
    values["caution-level"] !== undefined ||
    values["stall-flexibility"] !== undefined ||
    values["communication-directness"] !== undefined ||
    values["proactivity-level"] !== undefined;

  if (!hasFlags) {
    console.log(`Usage: pulseed config character [options]

Options:
  --show                          Show current character config
  --reset                         Reset to defaults
  --caution-level <1-5>           Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>       Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5> Output style (1=considerate, 5=direct/facts only)
  --proactivity-level <1-5>       Report verbosity (1=events-only, 5=always-detailed)`);
    return 0;
  }

  if (values.reset) {
    await characterConfigManager.reset();
    const config = await characterConfigManager.load();
    console.log("Character config reset to defaults:");
    printCharacterConfig(config);
    return 0;
  }

  if (values.show) {
    const config = await characterConfigManager.load();
    console.log("Current character config:");
    printCharacterConfig(config);
    return 0;
  }

  const partial: Record<string, number> = {};

  const paramMap: Array<[string, string]> = [
    ["caution-level", "caution_level"],
    ["stall-flexibility", "stall_flexibility"],
    ["communication-directness", "communication_directness"],
    ["proactivity-level", "proactivity_level"],
  ];

  for (const [flag, key] of paramMap) {
    const raw = values[flag as keyof typeof values] as string | undefined;
    if (raw !== undefined) {
      const parsed = parseInt(raw, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 5) {
        getCliLogger().error(`Error: --${flag} must be an integer between 1 and 5 (got: ${raw})`);
        return 1;
      }
      partial[key] = parsed;
    }
  }

  try {
    const updated = await characterConfigManager.update(partial);
    console.log("Character config updated:");
    printCharacterConfig(updated);
    return 0;
  } catch (err) {
    getCliLogger().error(formatOperationError("update character config", err));
    return 1;
  }
}

// ─── Datasource commands ───

export async function cmdDatasourceAdd(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  const type = argv[0];
  if (!type) {
    getCliLogger().error("Error: type is required. Usage: pulseed datasource add <type> [options]");
    getCliLogger().error("  Types: file, http_api, github_issue, file_existence");
    return 1;
  }

  if (type !== "file" && type !== "http_api" && type !== "github_issue" && type !== "file_existence") {
    getCliLogger().error(`Error: unsupported type "${type}". Supported: file, http_api, github_issue, file_existence`);
    return 1;
  }

  let values: { name?: string; path?: string; url?: string };
  try {
    ({ values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
      },
      strict: false,
    }) as { values: { name?: string; path?: string; url?: string } });
  } catch (err) {
    getCliLogger().error(formatOperationError(`parse datasource add arguments for type "${type}"`, err));
    values = {};
  }

  const id = `ds_${Date.now()}`;
  const name =
    values.name ??
    (type === "file"
      ? `file:${values.path ?? id}`
      : type === "file_existence"
        ? `file_existence:${values.path ?? id}`
        : type === "github_issue"
          ? `github_issue:${id}`
          : `http_api:${values.url ?? id}`);

  const connection: Record<string, string> = {};
  let extraConfig: Record<string, unknown> = {};
  if (type === "file") {
    if (!values.path) {
      getCliLogger().error("Error: --path is required for file data source");
      return 1;
    }
    connection["path"] = values.path;
  } else if (type === "file_existence") {
    if (!values.path) {
      getCliLogger().error("Error: --path is required for file_existence data source");
      return 1;
    }
    connection["path"] = values.path;
    extraConfig = { filePaths: { file_exists: values.path } };
  } else if (type === "github_issue") {
    // No connection params needed — uses `gh` CLI
  } else {
    if (!values.url) {
      getCliLogger().error("Error: --url is required for http_api data source");
      return 1;
    }
    connection["url"] = values.url;
    connection["method"] = "GET";
  }

  const config = {
    id,
    name,
    type,
    connection,
    ...extraConfig,
    enabled: true,
    created_at: new Date().toISOString(),
  };

  const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
  await fsp.mkdir(datasourcesDir, { recursive: true });

  const configPath = path.join(datasourcesDir, `${id}.json`);
  await writeJsonFile(configPath, config);

  console.log(`Data source registered successfully!`);
  console.log(`  ID:   ${id}`);
  console.log(`  Type: ${type}`);
  console.log(`  Name: ${name}`);

  return 0;
}

export async function cmdDatasourceList(stateManager: StateManager): Promise<number> {
  const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());

  let dirExists = false;
  try { await fsp.access(datasourcesDir); dirExists = true; } catch { /* not found */ }

  if (!dirExists) {
    console.log("No data sources registered. Use `pulseed datasource add` to register one.");
    return 0;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(datasourcesDir);
  } catch (err) {
    getCliLogger().error(formatOperationError("read datasources directory", err));
    return 1;
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json"));

  if (jsonFiles.length === 0) {
    console.log("No data sources registered. Use `pulseed datasource add` to register one.");
    return 0;
  }

  console.log(`Found ${jsonFiles.length} data source(s):\n`);
  console.log("ID                          TYPE       ENABLED  NAME");
  console.log("─".repeat(72));

  for (const file of jsonFiles) {
    try {
      const cfg = await readJsonFile<{ id?: string; type?: string; name?: string; enabled?: boolean }>(path.join(datasourcesDir, file));
      const id = cfg.id ?? file.replace(".json", "");
      const type = cfg.type ?? "unknown";
      const enabled = cfg.enabled !== false ? "yes" : "no";
      const name = cfg.name ?? "(unnamed)";
      console.log(`${id.padEnd(28)} ${type.padEnd(10)} ${enabled.padEnd(8)} ${name}`);
    } catch (err) {
      getCliLogger().error(formatOperationError(`parse datasource config "${file}" during datasource listing`, err));
    }
  }

  return 0;
}

export async function cmdDatasourceRemove(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  const id = argv[0];
  if (!id) {
    getCliLogger().error("Error: id is required. Usage: pulseed datasource remove <id>");
    return 1;
  }

  const configPath = path.join(getDatasourcesDir(stateManager.getBaseDir()), `${id}.json`);

  try {
    await fsp.access(configPath);
  } catch {
    getCliLogger().error(`Error: Data source "${id}" not found.`);
    return 1;
  }

  await fsp.unlink(configPath);
  console.log(`Data source "${id}" removed.`);

  return 0;
}

export async function cmdDatasourceDedup(stateManager: StateManager): Promise<number> {
  const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());

  let entries: string[];
  try {
    entries = await fsp.readdir(datasourcesDir);
  } catch {
    console.log("No datasources directory found. Nothing to deduplicate.");
    return 0;
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    console.log("No datasources found. Nothing to deduplicate.");
    return 0;
  }

  // Load configs with their filenames
  const configs: Array<{ file: string; cfg: Record<string, unknown> }> = [];
  for (const file of jsonFiles) {
    try {
      const raw = await fsp.readFile(path.join(datasourcesDir, file), "utf-8");
      configs.push({ file, cfg: JSON.parse(raw) as Record<string, unknown> });
    } catch {
      // Skip unreadable files
    }
  }

  // Build dedup key: type + sorted dimension names
  function dedupKey(cfg: Record<string, unknown>): string {
    const type = (cfg["type"] as string | undefined) ?? "unknown";
    let dims: string[] = [];
    if (type === "shell") {
      const commands = (cfg["connection"] as Record<string, unknown> | undefined)?.["commands"];
      dims = commands ? Object.keys(commands as Record<string, unknown>).sort() : [];
    } else if (type === "file_existence") {
      const dimMapping = cfg["dimension_mapping"];
      dims = dimMapping ? Object.keys(dimMapping as Record<string, unknown>).sort() : [];
    }
    const scopeGoalId = (cfg["scope_goal_id"] as string | undefined) ?? "";
    return `${type}::${dims.join(",")}::${scopeGoalId}`;
  }

  // Group by dedup key; first entry (oldest by sorted filename) is the keeper
  const seen = new Map<string, string>(); // key → first filename
  const toRemove: string[] = [];

  for (const { file, cfg } of configs) {
    const key = dedupKey(cfg);
    if (seen.has(key)) {
      toRemove.push(file);
    } else {
      seen.set(key, file);
    }
  }

  if (toRemove.length === 0) {
    console.log("No duplicate datasources found.");
    return 0;
  }

  for (const file of toRemove) {
    try {
      await fsp.unlink(path.join(datasourcesDir, file));
    } catch (err) {
      getCliLogger().error(formatOperationError(`remove duplicate datasource "${file}"`, err));
    }
  }

  console.log(`Removed ${toRemove.length} duplicate datasource(s).`);
  return 0;
}

// ─── Capability commands ───

export async function cmdCapabilityList(stateManager: StateManager): Promise<number> {
  const llmClient = await buildLLMClient();
  const reportingEngine = new ReportingEngine(stateManager);
  const capabilityDetector = new CapabilityDetector(stateManager, llmClient, reportingEngine);

  let registry;
  try {
    registry = await capabilityDetector.loadRegistry();
  } catch (err) {
    getCliLogger().error(formatOperationError("load capability registry", err));
    return 1;
  }

  if (registry.capabilities.length === 0) {
    console.log("No capabilities registered. Capabilities are registered automatically during goal execution.");
    return 0;
  }

  console.log(`Found ${registry.capabilities.length} capability(ies):\n`);
  console.log("NAME                         TYPE        STATUS               ACQUISITION_METHOD");
  console.log("─".repeat(80));

  for (const cap of registry.capabilities) {
    const name = cap.name.padEnd(28);
    const type = cap.type.padEnd(11);
    const status = cap.status.padEnd(20);
    const method = cap.acquisition_context !== undefined
      ? "(acquired)"
      : "(manual)";
    console.log(`${name} ${type} ${status} ${method}`);
  }

  return 0;
}

export async function cmdCapabilityRemove(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  const name = argv[0];
  if (!name) {
    getCliLogger().error("Error: name is required. Usage: pulseed capability remove <name>");
    return 1;
  }

  const llmClient = await buildLLMClient();
  const reportingEngine = new ReportingEngine(stateManager);
  const capabilityDetector = new CapabilityDetector(stateManager, llmClient, reportingEngine);

  let cap;
  try {
    cap = await capabilityDetector.findCapabilityByName(name);
  } catch (err) {
    getCliLogger().error(formatOperationError(`look up capability "${name}"`, err));
    return 1;
  }

  if (!cap) {
    getCliLogger().error(`Error: Capability "${name}" not found.`);
    return 1;
  }

  try {
    await capabilityDetector.removeCapability(cap.id);
    console.log(`Capability "${name}" removed.`);
    return 0;
  } catch (err) {
    getCliLogger().error(formatOperationError(`remove capability "${name}"`, err));
    return 1;
  }
}
