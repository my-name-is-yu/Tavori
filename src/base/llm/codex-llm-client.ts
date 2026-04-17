import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { BaseLLMClient, MAX_RETRY_ATTEMPTS, RETRY_DELAYS_MS } from "./base-llm-client.js";
import {
  type ILLMClient,
  type LLMMessage,
  type LLMRequestOptions,
  type LLMResponse,
} from "./llm-client.js";
import { sleep } from "../utils/sleep.js";
import { LLMError } from "../utils/errors.js";

// ─── Constants ───

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per call

/**
 * Build a single prompt string from messages and system prompt.
 * Format:
 *   System instruction: <system>
 *
 *   user: <content>
 *   assistant: <content>
 *   ...
 */
function buildPrompt(messages: LLMMessage[], system?: string): string {
  const parts: string[] = [];

  if (system) {
    parts.push(`System instruction: ${system}`);
    parts.push("");
  }

  for (const msg of messages) {
    parts.push(`${msg.role}: ${msg.content}`);
  }

  return parts.join("\n");
}

// ─── CodexLLMClient ───

export interface CodexLLMClientConfig {
  /** Path to the codex CLI executable. Default: "codex" */
  cliPath?: string;
  /** Model to pass via --model flag. Default: uses codex's default (OPENAI_MODEL env or codex config) */
  model?: string;
  /** Light model for routine/cheap calls (model_tier: 'light'). Optional. */
  lightModel?: string;
  /** Repository path passed to Codex for workspace-aware execution. Default: "." */
  repoPath?: string;
  /** Timeout per call in milliseconds. Default: 120000 (2 minutes) */
  timeoutMs?: number;
  /** Sandbox passed to codex exec. Default: workspace-write. */
  sandboxPolicy?: string;
  /** Pass --skip-git-repo-check. Default: true. */
  skipGitRepoCheck?: boolean;
}

/**
 * ILLMClient implementation that uses the `codex exec` CLI for LLM calls.
 * Routes all PulSeed internal LLM calls through the Codex CLI, which uses
 * the ChatGPT subscription (no separate API key needed).
 *
 * Uses `codex exec -s danger-full-access -o <tmpfile> "PROMPT"` per call.
 * The -o flag writes the final response to a temp file for clean output.
 * Usage stats are not available from the CLI and will always be 0.
 *
 * Set PULSEED_LLM_PROVIDER=codex to activate via CLIRunner / provider-factory.
 */
export class CodexLLMClient extends BaseLLMClient implements ILLMClient {
  private readonly cliPath: string;
  private readonly model: string | undefined;
  private readonly repoPath: string;
  private readonly timeoutMs: number;
  private readonly sandboxPolicy: string;
  private readonly skipGitRepoCheck: boolean;

  constructor(config: CodexLLMClientConfig = {}) {
    super();
    this.cliPath = config.cliPath ?? "codex";
    this.model = config.model;
    this.lightModel = config.lightModel;
    this.repoPath = config.repoPath?.trim() || ".";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sandboxPolicy = config.sandboxPolicy ?? "workspace-write";
    this.skipGitRepoCheck = config.skipGitRepoCheck ?? true;
  }

  /**
   * Send a message to the Codex CLI with retry logic.
   * Retries up to MAX_RETRY_ATTEMPTS times with exponential backoff on spawn failures.
   */
  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const model = this.resolveEffectiveModel(options?.model ?? this.model ?? "", options?.model_tier) || undefined;
    const system = options?.system;

    const prompt = buildPrompt(messages, system);

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const content = await this._spawnCodex(prompt, model);
        return {
          content,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
          stop_reason: "end_turn",
        };
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRY_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
        }
      }
    }

    throw lastError;
  }

  /** CodexLLMClient does not support native provider function/tool calling. */
  supportsToolCalling(): boolean { return false; }

  /**
   * Spawn `codex exec -s <sandbox> [-o <tmpfile>] [--model <model>] "PROMPT"`
   * and return the response content read from the temp output file.
   */
  private async _spawnCodex(prompt: string, model?: string): Promise<string> {
    // Create a temporary directory asynchronously to avoid blocking the event loop
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-codex-"));
    const tmpFile = path.join(tmpDir, "response.txt");

    return new Promise((resolve, reject) => {

      // Build spawn args: exec -s <sandbox> -o <tmpfile> [--model <model>] -
      // Prompt is sent via stdin (using "-" as positional arg) to avoid arg length limits.
      // --path is not supported by codex-cli 0.114.0+; use cwd instead (see src/adapters/openai-codex.ts)
      const spawnArgs: string[] = [
        "exec",
        "-s",
        this.sandboxPolicy,
        "-o",
        tmpFile,
      ];

      if (this.skipGitRepoCheck) {
        spawnArgs.splice(3, 0, "--skip-git-repo-check");
      }

      if (model) {
        spawnArgs.push("--model", model);
      }

      spawnArgs.push("-");

      const child = spawn(this.cliPath, spawnArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
        cwd: this.repoPath,
      });

      let timedOut = false;
      let stderrData = "";
      child.stderr.on("data", (chunk: Buffer) => { stderrData += chunk.toString(); });

      // Timeout: send SIGTERM, then SIGKILL after 5s
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // process already exited
          }
        }, 5000);
      }, this.timeoutMs);

      // Suppress EPIPE errors on stdin
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") throw err;
      });

      // Write prompt via stdin and close
      child.stdin.write(prompt);
      child.stdin.end();

      child.on("error", (err: Error) => {
        clearTimeout(timeoutHandle);
        _cleanupTmp(tmpDir, tmpFile).catch((cleanupErr) => {
          console.debug("CodexLLMClient: _cleanupTmp failed (non-critical)", String(cleanupErr));
        });
        reject(new LLMError(`CodexLLMClient: spawn error — ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timeoutHandle);

        if (timedOut) {
          _cleanupTmp(tmpDir, tmpFile).catch((cleanupErr) => {
            console.debug("CodexLLMClient: _cleanupTmp failed (non-critical)", String(cleanupErr));
          });
          reject(
            new LLMError(
              `CodexLLMClient: timed out after ${this.timeoutMs}ms`
            )
          );
          return;
        }

        if (code !== 0) {
          _cleanupTmp(tmpDir, tmpFile).catch((cleanupErr) => {
            console.debug("CodexLLMClient: _cleanupTmp failed (non-critical)", String(cleanupErr));
          });
          const detail = stderrData.trim() ? ` — ${stderrData.trim().slice(0, 500)}` : "";
          reject(
            new LLMError(
              `CodexLLMClient: process exited with code ${code}${detail}`
            )
          );
          return;
        }

        // Read response from temp file
        fsp.readFile(tmpFile, "utf-8")
          .then((raw) => {
            _cleanupTmp(tmpDir, tmpFile).catch((cleanupErr) => {
              console.debug("CodexLLMClient: _cleanupTmp failed (non-critical)", String(cleanupErr));
            });
            resolve(raw.trim());
          })
          .catch((readErr) => {
            _cleanupTmp(tmpDir, tmpFile).catch((cleanupErr) => {
              console.debug("CodexLLMClient: _cleanupTmp failed (non-critical)", String(cleanupErr));
            });
            reject(
              new LLMError(
                `CodexLLMClient: failed to read output file — ${String(readErr)}`
              )
            );
          });
      });
    });
  }
}

// ─── Helpers ───

async function _cleanupTmp(tmpDir: string, tmpFile: string): Promise<void> {
  try {
    await fsp.access(tmpFile);
    await fsp.unlink(tmpFile);
  } catch {
    // file may not exist — ignore
  }
  try {
    await fsp.rmdir(tmpDir);
  } catch {
    // best-effort cleanup
  }
}
