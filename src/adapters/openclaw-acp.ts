// ─── OpenClawACPAdapter ───
//
// IAdapter implementation that drives OpenClaw via the ACP (Agent Communication Protocol).
// OpenClaw is started as a stdio child process (`openclaw acp`). Messages are exchanged
// as newline-delimited JSON-RPC 2.0 over stdin/stdout.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";

// ─── ACP types ───

interface ACPRequest {
  jsonrpc: "2.0";
  id: number;
  method: "message/send";
  params: {
    message: string;
    sessionKey?: string;
  };
}

interface ACPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content: string;
    sessionKey: string;
    done: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
}

// ─── Config ───

export interface OpenClawACPConfig {
  /** Path to the openclaw executable. Default: "openclaw" */
  cliPath?: string;
  /** OpenClaw profile to use. Default: "default" */
  profile?: string;
  /** Model override passed to OpenClaw (optional). */
  model?: string;
  /** Working directory for the child process (optional). */
  workDir?: string;
}

// ─── Adapter ───

export class OpenClawACPAdapter implements IAdapter {
  readonly adapterType = "openclaw_acp";
  readonly capabilities = [
    "execute_code",
    "read_files",
    "write_files",
    "run_commands",
    "browse_web",
    "search",
  ] as const;

  private readonly cliPath: string;
  private readonly profile: string;
  private readonly model: string | undefined;
  private readonly workDir: string | undefined;

  private child: ChildProcess | null = null;
  private sessionKey: string | undefined;
  private requestId = 0;

  constructor(config: OpenClawACPConfig = {}) {
    this.cliPath = config.cliPath ?? "openclaw";
    this.profile = config.profile ?? "default";
    this.model = config.model;
    this.workDir = config.workDir;
  }

  // ─── IAdapter.execute ───

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();

    // Ensure the child process is running
    if (!this.child || this.child.exitCode !== null) {
      try {
        this.child = this.spawnProcess();
      } catch (err) {
        const elapsed = Date.now() - startedAt;
        const errMessage = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: "",
          error: errMessage,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };
      }
    }

    const requestId = ++this.requestId;
    const request: ACPRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method: "message/send",
      params: {
        message: task.prompt,
        ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
      },
    };

    // Setup timeout via AbortController
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), task.timeout_ms);

    try {
      const response = await this.sendRequest(request, controller.signal);
      clearTimeout(timeoutHandle);

      if (response.error) {
        const elapsed = Date.now() - startedAt;
        return {
          success: false,
          output: "",
          error: `ACP error ${response.error.code}: ${response.error.message}`,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };
      }

      if (!response.result) {
        const elapsed = Date.now() - startedAt;
        return {
          success: false,
          output: "",
          error: "ACP response missing result",
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "error",
        };
      }

      // Persist the session key for subsequent requests
      this.sessionKey = response.result.sessionKey;

      const elapsed = Date.now() - startedAt;
      return {
        success: true,
        output: response.result.content,
        error: null,
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "completed",
      };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const elapsed = Date.now() - startedAt;
      const errMessage = err instanceof Error ? err.message : String(err);

      if (controller.signal.aborted) {
        return {
          success: false,
          output: "",
          error: `Timed out after ${task.timeout_ms}ms`,
          exit_code: null,
          elapsed_ms: elapsed,
          stopped_reason: "timeout",
        };
      }

      return {
        success: false,
        output: "",
        error: errMessage,
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "error",
      };
    }
  }

  // ─── Private helpers ───

  private spawnProcess(): ChildProcess {
    const args = ["acp", "--profile", this.profile];
    if (this.model) {
      args.push("--model", this.model);
    }

    const child = spawn(this.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.workDir !== undefined ? { cwd: this.workDir } : {}),
    });

    // Suppress EPIPE: the spawned process may close stdin before we write
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") throw err;
    });

    return child;
  }

  /**
   * Write a JSON-RPC request to stdin and wait for the matching response from stdout.
   * Responses are newline-delimited JSON. Skips lines that do not parse or belong to
   * a different request ID.
   */
  private sendRequest(
    request: ACPRequest,
    signal: AbortSignal
  ): Promise<ACPResponse> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error("Child process not available"));
        return;
      }

      const child = this.child;
      let buffer = "";
      let settled = false;

      const cleanup = (): void => {
        child.stdout?.removeListener("data", onData);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        // Keep incomplete last line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // Skip non-JSON lines (e.g., startup messages)
            continue;
          }

          const resp = parsed as ACPResponse;
          if (resp.id === request.id) {
            settle(() => resolve(resp));
            return;
          }
        }
      };

      const onError = (err: Error): void => {
        settle(() => reject(err));
      };

      const onClose = (): void => {
        settle(() => reject(new Error("OpenClaw process closed unexpectedly")));
      };

      // Abort handling
      signal.addEventListener("abort", () => {
        settle(() => reject(new Error("Aborted")));
      });

      child.stdout?.on("data", onData);
      child.on("error", onError);
      child.on("close", onClose);

      // Send the request
      const line = JSON.stringify(request) + "\n";
      child.stdin?.write(line, "utf8");
    });
  }
}
