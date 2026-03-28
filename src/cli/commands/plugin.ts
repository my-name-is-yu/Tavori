import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { PluginManifestSchema } from "../../types/plugin.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPluginsDir } from "../../utils/paths.js";
import { parseSemver, compareSemver, satisfiesRange } from "../../runtime/plugin-loader.js";

const execFile = promisify(cp.execFile);

function defaultPluginsDir(): string {
  return getPluginsDir();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(pluginDir: string) {
  const yamlPath = path.join(pluginDir, "plugin.yaml");
  const jsonPath = path.join(pluginDir, "plugin.json");

  let raw: unknown;
  if (await pathExists(yamlPath)) {
    const content = await fsp.readFile(yamlPath, "utf-8");
    raw = yaml.load(content);
  } else if (await pathExists(jsonPath)) {
    const content = await fsp.readFile(jsonPath, "utf-8");
    raw = JSON.parse(content);
  } else {
    return null;
  }

  return PluginManifestSchema.safeParse(raw);
}

export async function cmdPluginList(pluginsDir?: string): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();

  if (!(await pathExists(dir))) {
    console.log("No plugins installed. Use `pulseed plugin install <path>` to install one.");
    return 0;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    logger.error(formatOperationError("read plugins directory", err));
    return 1;
  }

  const rows: { name: string; version: string; type: string; description: string }[] = [];

  for (const entry of entries) {
    const pluginDir = path.join(dir, entry);
    let stat: Awaited<ReturnType<typeof fsp.stat>> | undefined;
    try {
      stat = await fsp.stat(pluginDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const result = await readManifest(pluginDir);
    if (!result || !result.success) continue;

    const m = result.data;
    rows.push({
      name: m.name,
      version: m.version,
      type: m.type,
      description: m.description.length > 40 ? m.description.slice(0, 37) + "..." : m.description,
    });
  }

  if (rows.length === 0) {
    console.log("No plugins installed. Use `pulseed plugin install <path>` to install one.");
    return 0;
  }

  console.log(`Found ${rows.length} plugin(s):\n`);
  console.log(`${"NAME".padEnd(24)} ${"VERSION".padEnd(10)} ${"TYPE".padEnd(14)} DESCRIPTION`);
  console.log("─".repeat(80));
  for (const r of rows) {
    console.log(`${r.name.padEnd(24)} ${r.version.padEnd(10)} ${r.type.padEnd(14)} ${r.description}`);
  }

  return 0;
}

/** Returns true when the argument looks like a local filesystem path. */
function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../");
}

/** Returns true when the argument looks like an npm package name. */
function isNpmPackage(arg: string): boolean {
  return arg.startsWith("@") || /^[a-zA-Z0-9]/.test(arg);
}

/** Read and validate plugin manifest from an npm-installed package directory. */
async function readNpmManifest(pluginDir: string, packageName: string) {
  // Resolve the package dir inside node_modules
  const pkgName = packageName.startsWith("@")
    ? packageName.split("/").slice(0, 2).join("/")
    : packageName.split("/")[0];
  const nodeModulesDir = path.join(pluginDir, "node_modules", pkgName);
  return readManifest(nodeModulesDir);
}

/** Check PulSeed version compatibility, log a warning if incompatible, return false to abort. */
function checkVersionCompat(
  manifest: { name: string; version: string; min_pulseed_version?: string; max_pulseed_version?: string },
  pulseedVersion: string
): boolean {
  const minVer = manifest.min_pulseed_version;
  const maxVer = manifest.max_pulseed_version;
  if (!satisfiesRange(pulseedVersion, minVer, maxVer)) {
    const range = [
      minVer ? `>=${minVer}` : "",
      maxVer ? `<=${maxVer}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    getCliLogger().warn(
      `Plugin "${manifest.name}" requires PulSeed ${range}, but current version is ${pulseedVersion}. Aborting install.`
    );
    return false;
  }
  return true;
}

function getPulseedVersion(): string {
  try {
    const pkgPath = path.resolve(new URL(".", import.meta.url).pathname, "../../../package.json");
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function cmdPluginInstall(
  pluginsDir: string | undefined,
  argv: string[],
  _getPulseedVersion?: () => string,
  _execFileFn?: typeof execFile
): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const source = argv[0];
  const force = argv.includes("--force");

  if (!source) {
    logger.error("Error: source path or package name is required. Usage: pulseed plugin install <path|package> [--force]");
    return 1;
  }

  // ── npm package install ──────────────────────────────────────────────────
  if (!isLocalPath(source) && isNpmPackage(source)) {
    const packageName = source;
    const pluginDir = path.join(dir, packageName.replace(/\//g, "__").replace(/@/g, ""));

    if ((await pathExists(pluginDir)) && !force) {
      logger.error(`Error: plugin "${packageName}" is already installed. Use --force to overwrite.`);
      return 1;
    }

    try {
      await fsp.mkdir(pluginDir, { recursive: true });
    } catch (err) {
      logger.error(formatOperationError("create plugin directory", err));
      return 1;
    }

    const execFn = _execFileFn ?? execFile;
    try {
      await execFn("npm", ["install", "--prefix", pluginDir, packageName]);
    } catch (err) {
      logger.error(formatOperationError("npm install", err));
      return 1;
    }

    const result = await readNpmManifest(pluginDir, packageName);
    if (!result) {
      logger.error(`Error: plugin manifest not found after npm install of "${packageName}".`);
      return 1;
    }
    if (!result.success) {
      logger.error(`Error: invalid plugin manifest — ${result.error.message}`);
      return 1;
    }

    const manifest = result.data;
    const pulseedVer = _getPulseedVersion ? _getPulseedVersion() : getPulseedVersion();
    if (!checkVersionCompat(manifest, pulseedVer)) return 1;

    if (manifest.permissions.shell) {
      logger.warn(`Plugin "${manifest.name}" requests shell execution permission.`);
    }

    console.log(`Plugin "${manifest.name}" v${manifest.version} installed from npm.`);
    return 0;
  }

  // ── Local path install (existing flow) ───────────────────────────────────
  const sourcePath = source;

  if (!(await pathExists(sourcePath))) {
    logger.error(`Error: source path "${sourcePath}" does not exist.`);
    return 1;
  }

  const result = await readManifest(sourcePath);
  if (!result) {
    logger.error(`Error: plugin manifest not found in "${sourcePath}". Expected plugin.yaml or plugin.json.`);
    return 1;
  }
  if (!result.success) {
    logger.error(`Error: invalid plugin manifest — ${result.error.message}`);
    return 1;
  }

  const manifest = result.data;
  const destDir = path.join(dir, manifest.name);

  if ((await pathExists(destDir)) && !force) {
    logger.error(`Error: plugin "${manifest.name}" is already installed. Use --force to overwrite.`);
    return 1;
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.cp(sourcePath, destDir, { recursive: true });
  } catch (err) {
    logger.error(formatOperationError("copy plugin", err));
    return 1;
  }

  // Verify after copy
  const verify = await readManifest(destDir);
  if (!verify || !verify.success) {
    logger.error(`Error: plugin copy failed — manifest unreadable after install.`);
    return 1;
  }

  const pulseedVer = _getPulseedVersion ? _getPulseedVersion() : getPulseedVersion();
  if (!checkVersionCompat(manifest, pulseedVer)) return 1;

  if (manifest.permissions.shell) {
    getCliLogger().warn(`Plugin "${manifest.name}" requests shell execution permission.`);
  }

  console.log(`Plugin "${manifest.name}" v${manifest.version} installed.`);
  return 0;
}

export async function cmdPluginUpdate(
  pluginsDir: string | undefined,
  argv: string[],
  _execFileFn?: typeof execFile
): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const name = argv[0];

  if (!name) {
    logger.error("Error: plugin name is required. Usage: pulseed plugin update <name>");
    return 1;
  }

  const pluginDir = path.join(dir, name);
  if (!(await pathExists(pluginDir))) {
    logger.error(`Error: plugin "${name}" not found.`);
    return 1;
  }

  const execFn = _execFileFn ?? execFile;
  try {
    await execFn("npm", ["update", "--prefix", pluginDir]);
  } catch (err) {
    logger.error(formatOperationError("npm update", err));
    return 1;
  }

  console.log(`Plugin "${name}" updated.`);
  return 0;
}

export async function cmdPluginSearch(
  _pluginsDir: string | undefined,
  argv: string[],
  _execFileFn?: typeof execFile
): Promise<number> {
  const logger = getCliLogger();
  const keyword = argv[0];

  if (!keyword) {
    logger.error("Error: keyword is required. Usage: pulseed plugin search <keyword>");
    return 1;
  }

  const execFn = _execFileFn ?? execFile;
  let stdout: string;
  try {
    const result = await execFn("npm", ["search", `@pulseed-plugins/${keyword}`, "--json"]);
    stdout = result.stdout;
  } catch (err) {
    logger.error(formatOperationError("npm search", err));
    return 1;
  }

  let packages: { name: string; version: string; description: string }[] = [];
  try {
    packages = JSON.parse(stdout) as { name: string; version: string; description: string }[];
  } catch {
    logger.error("Error: failed to parse npm search results.");
    return 1;
  }

  if (packages.length === 0) {
    console.log(`No plugins found for keyword "${keyword}".`);
    return 0;
  }

  console.log(`Found ${packages.length} plugin(s):\n`);
  console.log(`${"NAME".padEnd(40)} ${"VERSION".padEnd(10)} DESCRIPTION`);
  console.log("─".repeat(80));
  for (const pkg of packages) {
    const desc = pkg.description?.length > 28 ? pkg.description.slice(0, 25) + "..." : (pkg.description ?? "");
    console.log(`${pkg.name.padEnd(40)} ${pkg.version.padEnd(10)} ${desc}`);
  }

  return 0;
}

export async function cmdPluginRemove(pluginsDir: string | undefined, argv: string[]): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const name = argv[0];

  if (!name) {
    logger.error("Error: plugin name is required. Usage: pulseed plugin remove <name>");
    return 1;
  }

  const pluginDir = path.join(dir, name);

  if (!(await pathExists(pluginDir))) {
    logger.error(`Error: plugin "${name}" not found.`);
    return 1;
  }

  try {
    await fsp.rm(pluginDir, { recursive: true });
  } catch (err) {
    logger.error(formatOperationError("remove plugin", err));
    return 1;
  }

  console.log(`Plugin "${name}" removed.`);
  return 0;
}
