import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { load as parseYaml } from "js-yaml";

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function pathExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function readJson(filePath: string): unknown | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
      return parseYaml(raw) as unknown;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function readEnvFile(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const entries = raw
      .split(/\r?\n/)
      .flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return [];
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
        if (!match) return [];
        const value = match[2]!.trim().replace(/^['"]|['"]$/g, "");
        return [[match[1]!, value] as const];
      });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function listImmediateDirs(parentDir: string): string[] {
  try {
    return fs.readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentDir, entry.name));
  } catch {
    return [];
  }
}

export function safeImportName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imported";
}

export async function uniqueImportPath(parentDir: string, name: string): Promise<string> {
  const baseName = safeImportName(name);
  let candidate = path.join(parentDir, baseName);
  let suffix = 2;
  while (await pathExistsAsync(candidate)) {
    candidate = path.join(parentDir, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

export async function copyDirectoryNoSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  const stat = await fsp.lstat(sourceDir);
  if (stat.isSymbolicLink()) {
    throw new Error("refusing to copy symlink");
  }
  if (!stat.isDirectory()) {
    throw new Error("source is not a directory");
  }

  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const entryStat = await fsp.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      await copyDirectoryNoSymlinks(sourcePath, targetPath);
    } else if (entryStat.isFile()) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}
