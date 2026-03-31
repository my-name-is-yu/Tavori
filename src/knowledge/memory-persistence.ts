import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { MemoryDataType, RetentionConfig } from "../types/memory-lifecycle.js";

// ─── Data file path resolution ───

/**
 * Map MemoryDataType to the corresponding short-term JSON file path.
 */
export function getDataFile(memoryDir: string, goalId: string, dataType: MemoryDataType): string {
  const fileNames: Record<MemoryDataType, string> = {
    experience_log: "experience-log.json",
    observation: "observations.json",
    strategy: "strategies.json",
    task: "tasks.json",
    knowledge: "knowledge.json",
  };
  return path.join(
    memoryDir,
    "short-term",
    "goals",
    goalId,
    fileNames[dataType]
  );
}

// ─── ID generation ───

/**
 * Generate a short unique ID with the given prefix.
 */
export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ─── Async versions of file utilities ───

/**
 * Write data to a file atomically (async version).
 */
export async function atomicWriteAsync(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const tmpPath = filePath + ".tmp";
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    await fsp.rename(tmpPath, filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Read and parse a JSON file using the provided Zod schema (async version).
 * Returns null if the file doesn't exist or parsing fails.
 */
export async function readJsonFileAsync<T>(filePath: string, schema: z.ZodTypeAny): Promise<T | null> {
  try {
    await fsp.access(filePath);
  } catch {
    return null;
  }
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    console.warn(`[memory-persistence] Failed to read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    console.warn(`[memory-persistence] JSON.parse failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  try {
    return schema.parse(raw) as T;
  } catch (err) {
    console.warn(`[memory-persistence] Schema validation failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Compute total size of a directory recursively in bytes (async version).
 */
export async function getDirectorySizeAsync(dirPath: string): Promise<number> {
  try {
    await fsp.access(dirPath);
  } catch {
    return 0;
  }
  let total = 0;
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySizeAsync(entryPath);
    } else {
      try {
        total += (await fsp.stat(entryPath)).size;
      } catch {
        // Ignore stat errors
      }
    }
  }
  return total;
}

// ─── Retention limit ───

/**
 * Get the retention loop limit for a goal, considering goal_type_overrides.
 * Since goalId does not encode goal type in MVP, use default unless caller
 * configures an override keyed by goalId prefix.
 */
export function getRetentionLimit(config: RetentionConfig, goalId: string): number {
  // Check if any override key is a prefix of goalId
  for (const [key, limit] of Object.entries(config.goal_type_overrides)) {
    if (goalId.startsWith(key) || goalId.includes(key)) {
      return limit;
    }
  }
  return config.default_retention_loops;
}
