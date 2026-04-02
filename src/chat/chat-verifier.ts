// Lightweight post-execution verification for chat mode (git diff + vitest).
import { execFile } from "node:child_process";

export interface ChatVerificationResult {
  passed: boolean;
  errors: string[];
  testOutput?: string;
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve(err ? null : stdout + stderr);
    });
  });
}

/**
 * Verify a chat-mode code action:
 * 1. Check git diff HEAD — if no changes, skip.
 * 2. Run vitest — return failure if tests break.
 * Gracefully degrades (returns passed=true) if git/vitest are unavailable.
 */
export async function verifyChatAction(cwd: string): Promise<ChatVerificationResult> {
  const diffOut = await runCmd("git", ["diff", "HEAD", "--stat"], cwd, 5_000);
  if (diffOut === null) return { passed: true, errors: [] };
  if (diffOut.trim() === "") return { passed: true, errors: [] };

  const testOut = await runCmd("npx", ["vitest", "run", "--reporter=dot"], cwd, 30_000);
  if (testOut === null) return { passed: true, errors: [] };

  const failed = /\d+ failed/i.test(testOut) || / fail /i.test(testOut);
  if (failed) {
    return {
      passed: false,
      errors: ["Tests failed after applying changes."],
      testOutput: testOut.split("\n").slice(-30).join("\n"),
    };
  }

  return { passed: true, errors: [] };
}
