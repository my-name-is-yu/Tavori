import { resolve } from "node:path";

const BLOCKED_PATTERNS = [".env", "credentials", "secret", ".ssh/", "id_rsa", "node_modules/"];

export function validateFilePath(
  filePath: string,
  cwd: string,
): { valid: boolean; resolved: string; error?: string } {
  const resolvedCwd = resolve(cwd);
  const resolved = resolve(cwd, filePath);
  if (!resolved.startsWith(resolvedCwd)) {
    return { valid: false, resolved, error: "Path traversal outside working directory" };
  }
  const lower = resolved.toLowerCase();
  for (const p of BLOCKED_PATTERNS) {
    if (lower.includes(p)) {
      return { valid: false, resolved, error: `Blocked: path contains sensitive pattern "${p}"` };
    }
  }
  return { valid: true, resolved };
}
