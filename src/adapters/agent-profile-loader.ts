// ─── AgentProfileLoader ───
//
// Loads agent definition files from ~/.pulseed/agents/*.md.
// Each file has YAML frontmatter (AgentProfile fields) + a system prompt body.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import { AgentProfileSchema, type AgentProfileWithPrompt } from "../types/agent-profile.js";

// ─── AgentProfileLoader ───

export class AgentProfileLoader {
  constructor(private readonly agentsDir: string) {}

  /** Load all *.md files from agentsDir. Skips invalid files with a warning. */
  async loadAll(): Promise<AgentProfileWithPrompt[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.agentsDir);
    } catch {
      return [];
    }

    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    const results: AgentProfileWithPrompt[] = [];

    for (const file of mdFiles) {
      const filePath = path.join(this.agentsDir, file);
      try {
        const profile = await this.loadOne(filePath);
        results.push(profile);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[agent-profile-loader] Skipping ${file}: ${msg}`);
      }
    }

    return results;
  }

  /** Load and validate a single agent profile file. Throws on invalid content. */
  async loadOne(filePath: string): Promise<AgentProfileWithPrompt> {
    const content = await fsp.readFile(filePath, "utf-8");
    const { frontmatter, body } = AgentProfileLoader.parseFrontmatter(content);
    const parsed = AgentProfileSchema.parse(frontmatter);
    return { ...parsed, system_prompt: body.trim(), file_path: filePath };
  }

  /**
   * Split content on --- delimiters and parse YAML frontmatter.
   * Expects format:
   *   ---
   *   key: value
   *   ---
   *   body text
   */
  static parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const lines = content.split("\n");

    // Must start with ---
    if (lines[0]?.trim() !== "---") {
      return { frontmatter: {}, body: content };
    }

    // Find the closing ---
    const closeIdx = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (closeIdx === -1) {
      return { frontmatter: {}, body: content };
    }

    const yamlLines = lines.slice(1, closeIdx).join("\n");
    const bodyLines = lines.slice(closeIdx + 1).join("\n");

    let frontmatter: Record<string, unknown>;
    try {
      const parsed = yaml.load(yamlLines);
      frontmatter = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      frontmatter = {};
    }

    return { frontmatter, body: bodyLines };
  }

  /** Find a profile by exact name. Returns null if not found. */
  findByName(profiles: AgentProfileWithPrompt[], name: string): AgentProfileWithPrompt | null {
    return profiles.find((p) => p.name === name) ?? null;
  }

  /** Find all profiles that include the given capability. */
  findByCapability(profiles: AgentProfileWithPrompt[], capability: string): AgentProfileWithPrompt[] {
    return profiles.filter((p) => p.capabilities.includes(capability));
  }
}
