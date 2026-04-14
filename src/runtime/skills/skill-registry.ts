import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSkillsDir } from "../../base/utils/paths.js";
import {
  isPathInside,
  parseSkillFile,
  toSafeSkillId,
  type SkillSource,
} from "./skill-parser.js";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  relativePath: string;
  source: SkillSource;
}

export interface SkillRegistryOptions {
  homeSkillsDir?: string;
  workspaceRoot?: string;
}

export class SkillRegistry {
  private readonly homeSkillsDir: string;
  private readonly workspaceRoot: string | undefined;

  constructor(options: SkillRegistryOptions = {}) {
    this.homeSkillsDir = options.homeSkillsDir ?? getSkillsDir();
    this.workspaceRoot = options.workspaceRoot;
  }

  async list(): Promise<SkillRecord[]> {
    const home = await this.scanRoot(this.homeSkillsDir, "home");
    const workspaceSkillsDir = this.workspaceRoot
      ? path.join(this.workspaceRoot, "skills")
      : undefined;
    const workspace = workspaceSkillsDir
      ? await this.scanRoot(workspaceSkillsDir, "workspace")
      : [];
    return [...home, ...workspace].sort((a, b) => a.id.localeCompare(b.id));
  }

  async search(query: string): Promise<SkillRecord[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const skills = await this.list();
    return skills.filter((skill) => [
      skill.id,
      skill.name,
      skill.description,
      skill.relativePath,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }

  async get(idOrName: string): Promise<SkillRecord | null> {
    const normalized = idOrName.trim().toLowerCase();
    const skills = await this.list();
    return skills.find((skill) =>
      skill.id.toLowerCase() === normalized ||
      skill.name.toLowerCase() === normalized
    ) ?? null;
  }

  async read(idOrName: string): Promise<{ skill: SkillRecord; body: string } | null> {
    const skill = await this.get(idOrName);
    if (!skill) return null;
    return { skill, body: await fsp.readFile(skill.path, "utf-8") };
  }

  async install(sourcePath: string, options: { namespace?: string; force?: boolean } = {}): Promise<SkillRecord> {
    const stat = await fsp.stat(sourcePath);
    const skillFile = stat.isDirectory() ? path.join(sourcePath, "SKILL.md") : sourcePath;
    if (!skillFile.endsWith("SKILL.md")) {
      throw new Error("skill install source must be a SKILL.md file or a directory containing SKILL.md");
    }
    const content = await fsp.readFile(skillFile, "utf-8");
    const parsed = parseSkillFile(content, skillFile, "home", path.dirname(skillFile));
    const namespace = toSafeSkillId(options.namespace?.trim() || "imported") || "imported";
    const parsedId = parsed.id === "." ? "" : parsed.id;
    const safeName = toSafeSkillId(parsedId || path.basename(path.dirname(skillFile)) || parsed.name);
    const destDir = path.join(this.homeSkillsDir, namespace, safeName);
    const destFile = path.join(destDir, "SKILL.md");
    if (!isPathInside(this.homeSkillsDir, destFile)) {
      throw new Error("skill install destination must stay inside the skills directory");
    }
    if (fs.existsSync(destFile) && !options.force) {
      throw new Error(`skill "${namespace}/${safeName}" already exists; use --force to overwrite`);
    }
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.copyFile(skillFile, destFile);
    return {
      ...parseSkillFile(content, destFile, "home", this.homeSkillsDir),
      id: `${namespace}/${safeName}`,
      relativePath: path.relative(this.homeSkillsDir, destFile),
    };
  }

  private async scanRoot(root: string, source: SkillRecord["source"]): Promise<SkillRecord[]> {
    const found: SkillRecord[] = [];
    await walk(root, async (file) => {
      if (path.basename(file) !== "SKILL.md") return;
      try {
        const content = await fsp.readFile(file, "utf-8");
        found.push(parseSkillFile(content, file, source, root));
      } catch {
        // Ignore unreadable skill files while keeping the registry usable.
      }
    });
    return found;
  }
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}
