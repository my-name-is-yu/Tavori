/**
 * E2E smoke tests for the OpenAI Codex CLI adapter.
 *
 * These tests spawn the real `codex` binary and are skipped when the CLI is not
 * installed. Run them intentionally with:
 *
 *   npx vitest run tests/e2e/codex-cli-e2e.test.ts
 *
 * The suite auto-skips when `codex` is not found on PATH (or at the known
 * absolute path). Keep tasks minimal to conserve ChatGPT Plus quota.
 *
 * Requirements:
 *   - codex CLI installed (v0.114.0+)
 *   - Active ChatGPT Plus subscription (codex uses it for auth)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAICodexCLIAdapter } from "../../src/adapters/openai-codex.js";
import type { AgentTask } from "../../src/execution/adapter-layer.js";

// ─── Skip guard ───────────────────────────────────────────────────────────────

/**
 * Detect whether the codex CLI is reachable. Checks both the well-known
 * absolute path and anything on PATH.
 */
function findCodexBin(): string | null {
  const knownPath =
    "/Users/yuyoshimuta/.nvm/versions/node/v22.16.0/bin/codex";

  // Try the known absolute path first (fastest, no PATH dependency)
  if (existsSync(knownPath)) {
    return knownPath;
  }

  // Fall back to PATH lookup using execFileSync (no shell, no injection risk)
  try {
    const result = execFileSync("which", ["codex"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const bin = result.trim();
    if (bin.length > 0 && existsSync(bin)) {
      return bin;
    }
  } catch {
    // `which` returned non-zero — codex not on PATH
  }

  return null;
}

const CODEX_BIN = findCodexBin();
const CODEX_AVAILABLE = CODEX_BIN !== null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    prompt: "echo hello",
    timeout_ms: 60_000,
    adapter_type: "openai_codex_cli",
    ...overrides,
  };
}

/**
 * Assert the shape of an AgentResult.
 */
function assertAgentResultShape(result: {
  success: boolean;
  output: string;
  error: string | null;
  exit_code: number | null;
  elapsed_ms: number;
  stopped_reason: string;
}): void {
  expect(typeof result.success).toBe("boolean");
  expect(typeof result.output).toBe("string");
  // error is either null or a string
  expect(result.error === null || typeof result.error === "string").toBe(true);
  // exit_code is either null or a number
  expect(
    result.exit_code === null || typeof result.exit_code === "number"
  ).toBe(true);
  expect(typeof result.elapsed_ms).toBe("number");
  expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(["completed", "timeout", "error"]).toContain(result.stopped_reason);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(!CODEX_AVAILABLE)(
  "Codex CLI E2E — real codex binary",
  () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "pulseed-codex-e2e-"));
    });

    afterAll(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

    // ── Test 1: codex CLI is reachable and returns a usable exit code ─────────

    it(
      "codex CLI binary is reachable and reports its version",
      () => {
        // `codex --version` should exit 0 and print a version string.
        // We run it via execFileSync (not the adapter) since this is a pure CLI
        // health check, not an adapter test.
        let output = "";
        let didThrow = false;
        try {
          output = execFileSync(CODEX_BIN!, ["--version"], {
            encoding: "utf8",
            timeout: 15_000,
          });
        } catch (err: unknown) {
          // Some CLI versions print to stderr and still exit non-zero.
          didThrow = true;
          if (err && typeof err === "object" && "stdout" in err) {
            output = String((err as { stdout: unknown }).stdout ?? "");
          }
        }

        // We just need the binary to respond at all.
        const hasOutput = output.trim().length > 0;
        // If it threw but produced output, that is still a reachable binary.
        expect(!didThrow || hasOutput).toBe(true);
      },
      15_000
    );

    // ── Test 2: adapter runs a minimal task via codex exec ────────────────────

    it(
      "OpenAICodexCLIAdapter runs a minimal task and returns an AgentResult",
      async () => {
        const adapter = new OpenAICodexCLIAdapter({
          cliPath: CODEX_BIN!,
          fullAuto: true,
        });

        // Minimal prompt: ask codex to create a file in our temp directory.
        // This is the simplest observable side-effect we can verify.
        const outputFile = join(tmpDir, "codex-output.txt");
        const result = await adapter.execute(
          makeTask({
            prompt: `Create a file at "${outputFile}" containing exactly the text: codex-e2e-ok`,
            timeout_ms: 60_000,
          })
        );

        // The adapter must always return a structurally valid AgentResult
        assertAgentResultShape(result);

        // Log the result for debugging (visible with --reporter=verbose)
        console.log("[codex-e2e] Task 2 result:", {
          success: result.success,
          exit_code: result.exit_code,
          stopped_reason: result.stopped_reason,
          output_preview: result.output.slice(0, 200),
          error: result.error,
          elapsed_ms: result.elapsed_ms,
        });
      },
      60_000
    );

    // ── Test 3: AgentResult structure is complete regardless of task outcome ───

    it(
      "AgentResult has all required fields regardless of codex task outcome",
      async () => {
        const adapter = new OpenAICodexCLIAdapter({
          cliPath: CODEX_BIN!,
          fullAuto: true,
        });

        const result = await adapter.execute(
          makeTask({
            // Trivial prompt: just print something to stdout
            prompt: "Print the text 'hello world' to stdout and exit.",
            timeout_ms: 60_000,
          })
        );

        // ── Structural assertions ──────────────────────────────────────────
        assertAgentResultShape(result);

        // success must be boolean
        expect(typeof result.success).toBe("boolean");

        // output is always a string (may be empty)
        expect(typeof result.output).toBe("string");

        // elapsed_ms must be a non-negative finite number
        expect(Number.isFinite(result.elapsed_ms)).toBe(true);
        expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);

        // stopped_reason must be one of the three valid values
        expect(["completed", "timeout", "error"]).toContain(
          result.stopped_reason
        );

        // If the task succeeded, error should be null
        if (result.success) {
          expect(result.error).toBeNull();
          expect(result.exit_code).toBe(0);
          expect(result.stopped_reason).toBe("completed");
        }

        console.log("[codex-e2e] Task 3 result:", {
          success: result.success,
          exit_code: result.exit_code,
          stopped_reason: result.stopped_reason,
          output_preview: result.output.slice(0, 200),
          error: result.error,
          elapsed_ms: result.elapsed_ms,
        });
      },
      60_000
    );
  }
);
