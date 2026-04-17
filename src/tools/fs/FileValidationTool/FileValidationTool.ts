import { validateProtectedPath } from "./protected-path-policy.js";

export function validateFilePath(
  filePath: string,
  cwd: string,
  protectedPaths?: string[],
): { valid: boolean; resolved: string; error?: string } {
  return validateProtectedPath(filePath, { cwd, workspaceRoot: cwd, protectedPaths });
}
