import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_PROTECTED_PATH_PATTERNS = [
  ".git",
  ".codex",
  ".agents",
  ".pulseed",
  "AGENTS.md",
  "AGENTS.override.md",
  ".env",
  ".env.local",
  ".env.production",
  "credentials",
  "secret",
  ".ssh",
  "id_rsa",
  "node_modules",
];

export interface ProtectedPathPolicyInput {
  cwd: string;
  workspaceRoot?: string;
  protectedPaths?: string[];
}

export interface ProtectedPathValidationResult {
  valid: boolean;
  resolved: string;
  error?: string;
}

export function validateProtectedPath(
  filePath: string,
  input: ProtectedPathPolicyInput,
): ProtectedPathValidationResult {
  const workspaceRoot = canonicalPath(input.workspaceRoot ?? input.cwd);
  const resolved = canonicalPath(resolve(input.cwd, filePath));
  const pathFromWorkspace = relative(workspaceRoot, resolved);

  if (pathFromWorkspace.startsWith("..") || isAbsolute(pathFromWorkspace)) {
    return { valid: false, resolved, error: "Path traversal outside workspace root" };
  }

  const protectedPatterns = [
    ...DEFAULT_PROTECTED_PATH_PATTERNS,
    ...(input.protectedPaths ?? []),
  ];
  const normalized = normalizeForMatch(pathFromWorkspace === "" ? "." : pathFromWorkspace);
  for (const pattern of protectedPatterns) {
    const protectedPattern = normalizeForMatch(pattern);
    const isBroadToken = !protectedPattern.includes("/") && !protectedPattern.startsWith(".");
    if (
      normalized === protectedPattern
      || normalized.startsWith(`${protectedPattern}/`)
      || normalized.includes(`/${protectedPattern}/`)
      || (isBroadToken && normalized.includes(protectedPattern))
    ) {
      return {
        valid: false,
        resolved,
        error: `Blocked: path targets protected area "${pattern}"`,
      };
    }
  }

  return { valid: true, resolved };
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function normalizeForMatch(value: string): string {
  return value.split(sep).join("/").replace(/^\.\/+/, "").toLowerCase();
}
