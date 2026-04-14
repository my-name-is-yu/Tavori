import * as path from "node:path";

export type SkillSource = "home" | "workspace";

export interface ParsedSkillFile {
  id: string;
  name: string;
  description: string;
  path: string;
  relativePath: string;
  source: SkillSource;
}

export function parseSkillFile(
  content: string,
  filePath: string,
  source: SkillSource,
  root: string
): ParsedSkillFile {
  const parsed = splitFrontmatter(content);
  const firstHeading = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const description = parsed.attributes.description ?? firstBodyText(parsed.body);
  const name = firstHeading ?? parsed.attributes.name ?? path.basename(path.dirname(filePath));
  const relativePath = path.relative(root, filePath);

  return {
    id: toSafeSkillId(path.dirname(relativePath)),
    name,
    description,
    path: filePath,
    relativePath,
    source,
  };
}

export function toSafeSkillId(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
  return normalized === "." ? "" : normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitFrontmatter(content: string): {
  attributes: { name?: string; description?: string };
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { attributes: {}, body: content };
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    return { attributes: {}, body: content };
  }

  const attributes: { name?: string; description?: string } = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, "");
    if ((key === "name" || key === "description") && value.length > 0) {
      attributes[key] = value;
    }
  }

  return {
    attributes,
    body: lines.slice(end + 1).join("\n"),
  };
}

function firstBodyText(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---")) ?? "";
}
