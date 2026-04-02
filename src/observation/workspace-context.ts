import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkspaceContextOptions {
  workDir: string;
  maxFiles?: number;       // default: 5
  maxCharsPerFile?: number; // default: 4000
  externalFileMaxBytes?: number; // default: 10240 (10KB)
}

const ALLOWED_EXTERNAL_PREFIXES = [os.homedir(), "/tmp"];

const DENIED_PREFIXES = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.config'),
  path.join(os.homedir(), '.env'),
];

/**
 * Extract absolute file paths from a text string.
 * Matches paths starting with / that look like file paths.
 */
function extractAbsolutePaths(text: string): string[] {
  // Match absolute paths: /something/... (not just /)
  const matches = text.match(/\/[^\s'"`,;)>]+/g) ?? [];
  // Filter to plausible file paths (must have at least one path segment)
  return [...new Set(matches.filter((p) => p.split("/").length >= 2))];
}

/**
 * Extract relative file paths from a text string.
 * Matches paths like src/xxx.ts, docs/yyy.md, etc.
 */
function extractRelativePaths(text: string): string[] {
  // Match relative paths: word/word... with common file extensions or multiple segments
  const matches = text.match(/(?<![/\w])\w[\w.-]*(?:\/[\w.-]+)+/g) ?? [];
  // Filter to plausible relative file paths (must contain a dot for extension or multiple segments)
  return [...new Set(matches.filter((p) => {
    const parts = p.split("/");
    // Must have at least 2 parts and last part should look like a file (has extension or is recognizable)
    return parts.length >= 2 && parts[parts.length - 1].includes(".");
  }))];
}

/**
 * Returns true if the resolved path is under an allowed prefix
 * and not under any denied prefix (sensitive directories).
 * Allowed: home directory or /tmp, except sensitive subdirectories.
 */
function isAllowedExternalPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const isDenied = DENIED_PREFIXES.some(
    (prefix) => resolved.startsWith(prefix + path.sep) || resolved === prefix
  );
  if (isDenied) return false;
  return ALLOWED_EXTERNAL_PREFIXES.some(
    (prefix) => resolved.startsWith(prefix + path.sep) || resolved === prefix
  );
}

/**
 * Read an external file if it exists, is allowed, and is within size limit.
 * Returns the content string or null if not readable.
 */
async function readExternalFile(filePath: string, maxBytes: number): Promise<string | null> {
  if (!isAllowedExternalPath(filePath)) return null;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return null;
    return await fsp.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "to", "for", "of", "in", "on", "at",
  "and", "or", "not", "be", "was", "were", "has", "have", "had",
  "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "can", "its", "it", "this", "that", "with", "as", "by",
  "from", "up", "about", "into", "through", "during", "before",
  "after", "above", "below", "between", "each", "but", "also",
]);

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".DS_Store"]);

const SMALL_WORKSPACE_FILE_LIMIT = 10;

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_\/\.]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

async function collectFiles(dir: string, rootDir: string, depth: number, result: string[]): Promise<void> {
  if (depth > 3) return;
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const resolvedRoot = path.resolve(rootDir);
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, rootDir, depth + 1, result);
    } else if (entry.isFile()) {
      const resolved = path.resolve(full);
      if (resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot) {
        result.push(full);
      }
    }
  }
}

function fileMatchesKeywords(filePath: string, keywords: string[]): boolean {
  const name = path.basename(filePath).toLowerCase();
  return keywords.some((kw) => name.includes(kw));
}

async function fileContentMatchesKeywords(filePath: string, keywords: string[]): Promise<boolean> {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const content = raw.slice(0, 20480).toLowerCase();
    return keywords.some((kw) => content.includes(kw));
  } catch {
    return false;
  }
}

async function readFileSection(filePath: string, maxChars: number): Promise<string> {
  try {
    const content = await fsp.readFile(filePath, "utf-8");
    return content.slice(0, maxChars);
  } catch {
    return "";
  }
}

export function createWorkspaceContextProvider(
  options: WorkspaceContextOptions,
  getGoalDescription: (goalId: string) => string | undefined | Promise<string | undefined>,
  getGoalConstraints?: (goalId: string) => string[] | undefined | Promise<string[] | undefined>
): (goalId: string, dimensionName: string) => Promise<string> {
  const { workDir, maxFiles = 15, maxCharsPerFile = 6000, externalFileMaxBytes = 10240 } = options;

  return async (goalId: string, dimensionName: string): Promise<string> => {
    const goalDescription = (await getGoalDescription(goalId)) ?? "";
    const keywords = extractKeywords(goalDescription + " " + dimensionName);

    // Resolve effective workDir: use workspace_path constraint from goal if available
    let effectiveWorkDir = workDir;
    if (getGoalConstraints) {
      const constraints = (await getGoalConstraints(goalId)) ?? [];
      const workspaceConstraint = constraints.find((c) => c.startsWith("workspace_path:"));
      if (workspaceConstraint) {
        effectiveWorkDir = workspaceConstraint.slice("workspace_path:".length);
      }
    }

    const parts: string[] = [`# Workspace: ${effectiveWorkDir}`];

    // Read external absolute-path files mentioned in goal description
    const externalPaths = extractAbsolutePaths(goalDescription);
    for (const extPath of externalPaths) {
      const content = await readExternalFile(extPath, externalFileMaxBytes);
      if (content !== null) {
        parts.push(`## External file: ${extPath}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // Directory listing
    try {
      const entries = await fsp.readdir(effectiveWorkDir);
      parts.push(`## Directory listing\n${entries.join(", ")}`);
    } catch {
      /* skip */
    }

    // Always-include candidates
    const alwaysInclude = ["README.md", "package.json"];
    const alwaysIncludePaths: string[] = [];
    for (const rel of alwaysInclude) {
      const fp = path.join(effectiveWorkDir, rel);
      try {
        await fsp.access(fp);
        alwaysIncludePaths.push(fp);
      } catch {
        // not accessible
      }
    }

    // Relative path exact-match: files explicitly mentioned in goal description
    const relativePathsInGoal = extractRelativePaths(goalDescription);
    const pathMatchedPaths: string[] = [];
    for (const rel of relativePathsInGoal) {
      const fp = path.join(effectiveWorkDir, rel);
      try {
        await fsp.access(fp);
        pathMatchedPaths.push(fp);
      } catch {
        // not accessible
      }
    }

    // Collect all files (depth 3)
    const allFiles: string[] = [];
    await collectFiles(effectiveWorkDir, effectiveWorkDir, 0, allFiles);

    // Small workspace fast path: include ALL files when total count is small
    if (allFiles.length <= SMALL_WORKSPACE_FILE_LIMIT) {
      for (const fp of allFiles) {
        const rel = path.relative(effectiveWorkDir, fp);
        const content = await readFileSection(fp, maxCharsPerFile);
        if (content) {
          parts.push(`## ${rel}\n\`\`\`\n${content}\n\`\`\``);
        }
      }
      return parts.join("\n\n");
    }

    // Small workspace fast path: include ALL files when total count is small
    if (allFiles.length <= SMALL_WORKSPACE_FILE_LIMIT) {
      for (const fp of allFiles) {
        const rel = path.relative(workDir, fp);
        const content = await readFileSection(fp, maxCharsPerFile);
        if (content) {
          parts.push(`## ${rel}\n\`\`\`\n${content}\n\`\`\``);
        }
      }
      return parts.join("\n\n");
    }

    // Separate already-included from candidates
    const alwaysSet = new Set(alwaysIncludePaths);
    const pathMatchSet = new Set(pathMatchedPaths);
    const candidates = allFiles.filter((fp) => !alwaysSet.has(fp) && !pathMatchSet.has(fp));

    // Phase 1: filename match
    const nameMatched = candidates.filter((fp) => fileMatchesKeywords(fp, keywords));

    // Phase 2: content match (only if we still need more)
    // alwaysInclude and pathMatch are treated as priority (outside maxFiles cap),
    // so keyword-match fills remaining slots up to maxFiles
    const neededFromCandidates = Math.max(0, maxFiles - alwaysIncludePaths.length - pathMatchedPaths.length);
    let selected = nameMatched.slice(0, neededFromCandidates);

    if (selected.length < neededFromCandidates) {
      const remaining = candidates.filter((fp) => !selected.includes(fp));
      const contentMatchResults = await Promise.all(
        remaining.map(async (fp) => ({ fp, match: await fileContentMatchesKeywords(fp, keywords) }))
      );
      const contentMatched = contentMatchResults.filter((r) => r.match).map((r) => r.fp);
      selected = [
        ...selected,
        ...contentMatched.slice(0, neededFromCandidates - selected.length),
      ];
    }

    // Read always-include files first
    for (const fp of alwaysIncludePaths) {
      const rel = path.relative(effectiveWorkDir, fp);
      const content = await readFileSection(fp, maxCharsPerFile);
      if (content) {
        parts.push(`## ${rel}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // Read explicit path-matched files (priority, same as alwaysInclude)
    for (const fp of pathMatchedPaths) {
      const rel = path.relative(effectiveWorkDir, fp);
      const content = await readFileSection(fp, maxCharsPerFile);
      if (content) {
        parts.push(`## ${rel}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // Read selected keyword-matched files
    for (const fp of selected) {
      const rel = path.relative(effectiveWorkDir, fp);
      const content = await readFileSection(fp, maxCharsPerFile);
      if (content) {
        parts.push(`## ${rel}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    return parts.join("\n\n");
  };
}
