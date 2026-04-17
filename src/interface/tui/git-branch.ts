import { execFileSync } from "node:child_process";

export function getGitBranch(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
