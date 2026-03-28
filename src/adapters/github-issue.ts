// ─── GitHubIssueAdapter ───
//
// IAdapter implementation that creates GitHub issues via the `gh` CLI.
// The task prompt is parsed for issue details; a ```github-issue JSON``` block
// is preferred, falling back to first-line-as-title / rest-as-body.
//
// Environment variables:
//   PULSEED_GITHUB_REPO — "owner/name", overrides auto-detection

import { spawn } from "node:child_process";
import type { IAdapter, AgentTask, AgentResult } from "../execution/adapter-layer.js";
import { spawnWithTimeout } from "./spawn-helper.js";
import type { Logger } from "../runtime/logger.js";
import type { Task } from "../types/task.js";

// ─── Config ───

export interface GitHubIssueAdapterConfig {
  /** "owner/name". Reads PULSEED_GITHUB_REPO env var if not set; auto-detects via gh CLI otherwise. */
  repo?: string;
  /** Labels always applied to every created issue. Default: ["pulseed"] */
  defaultLabels?: string[];
  /** Path to the gh executable. Default: "gh" */
  ghPath?: string;
  /** When true, log the command instead of running it. Default: false */
  dryRun?: boolean;
  /** Ignored — kept for API compatibility. Timeout is taken from AgentTask.timeout_ms. */
  timeout_ms?: number;
}

// ─── Parsed issue details ───

export interface ParsedIssue {
  title: string;
  body: string;
  labels: string[];
}

// ─── Adapter ───

export class GitHubIssueAdapter implements IAdapter {
  readonly adapterType = "github_issue";
  readonly capabilities = ["create_issue"] as const;

  private readonly repo: string | undefined;
  private readonly defaultLabels: string[];
  private readonly ghPath: string;
  private readonly dryRun: boolean;
  private readonly logger?: Logger;

  constructor(config?: GitHubIssueAdapterConfig, logger?: Logger) {
    this.repo = config?.repo ?? process.env["PULSEED_GITHUB_REPO"] ?? process.env["PULSEED_GITHUB_REPO"];
    this.defaultLabels = config?.defaultLabels ?? ["pulseed"];
    this.ghPath = config?.ghPath ?? "gh";
    this.dryRun = config?.dryRun ?? false;
    this.logger = logger;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const startedAt = Date.now();
    const parsed = this.parsePrompt(task.prompt);

    // ── Dry-run mode ──────────────────────────────────────────────────────
    if (this.dryRun) {
      const repo = this.repo ?? "(auto-detect)";
      const cmd = this.buildGhArgs(parsed, repo).join(" ");
      const dryMsg = `[dry-run] Would run: ${this.ghPath} ${cmd}`;
      this.logger?.info(dryMsg);
      return {
        success: true,
        output: dryMsg,
        error: null,
        exit_code: 0,
        elapsed_ms: Date.now() - startedAt,
        stopped_reason: "completed",
      };
    }

    // ── Duplicate detection ───────────────────────────────────────────────
    const dupResult = await this.checkOpenIssueExists(parsed.title);
    if (dupResult !== null) {
      const skipMsg = `Skipped: similar issue already exists (#${dupResult})`;
      this.logger?.debug(`[GitHubIssueAdapter] ${skipMsg}`);
      return {
        success: true,
        output: skipMsg,
        error: null,
        exit_code: 0,
        elapsed_ms: Date.now() - startedAt,
        stopped_reason: "completed",
      };
    }

    return new Promise<AgentResult>((resolve) => {
      const knownRepo = this.repo;

      if (knownRepo) {
        // ── Repo already known — spawn gh issue create directly ─────────────
        void this.spawnCreate(parsed, knownRepo, task.timeout_ms, startedAt, resolve);
      } else {
        // ── Auto-detect: spawn gh repo view, then spawn gh issue create ─────
        // This uses nested callbacks (not await) so that the second spawn() call
        // happens synchronously inside the close handler of the first spawn.
        // This ensures event listeners are registered before the test emits events.
        this.spawnDetect(task.timeout_ms, (repo, detectErr) => {
          if (detectErr !== null || !repo) {
            resolve({
              success: false,
              output: "",
              error: `Failed to detect GitHub repo: ${detectErr ?? "no repo found"}`,
              exit_code: null,
              elapsed_ms: Date.now() - startedAt,
              stopped_reason: "error",
            });
            return;
          }
          void this.spawnCreate(parsed, repo, task.timeout_ms, startedAt, resolve);
        });
      }
    });
  }

  /**
   * Format a prompt as a structured ```github-issue JSON block so that
   * parsePrompt() can extract a proper issue title without picking up
   * context-slot labels as the title.
   */
  formatPrompt(task: Task): string {
    const titleLine = task.work_description.split("\n")[0]?.trim() ?? task.work_description;
    const title = titleLine.length > 120 ? titleLine.slice(0, 117) + "..." : titleLine;
    const issuePayload = JSON.stringify({ title, body: task.work_description });
    return `\`\`\`github-issue\n${issuePayload}\n\`\`\``;
  }

  /**
   * Check whether an open GitHub issue with a similar title already exists.
   *
   * Runs `gh issue list --state open --label <label> --search "<title>" --json number,title --limit 10`
   * and returns the issue number of the first match (>60% word overlap), or null if no match / on any error.
   *
   * Returns null (not a match) on any error so the adapter stays functional when gh is unavailable.
   */
  async checkOpenIssueExists(title: string): Promise<number | null> {
    const label = this.defaultLabels[0] ?? "pulseed";
    const args = [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      label,
      "--search",
      title,
      "--json",
      "number,title",
      "--limit",
      "10",
    ];

    if (this.repo) {
      args.push("--repo", this.repo);
    }

    return new Promise<number | null>((resolve) => {
      let stdout = "";
      let resolved = false;

      const child = spawn(this.ghPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.on("error", () => {
        if (resolved) return;
        resolved = true;
        resolve(null);
      });

      child.on("close", (code: number | null) => {
        if (resolved) return;
        resolved = true;

        if (code !== 0) {
          resolve(null);
          return;
        }

        try {
          const issues = JSON.parse(stdout.trim()) as Array<{ number: number; title: string }>;
          const match = issues.find((issue) => titlesOverlap(title, issue.title));
          resolve(match?.number ?? null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * IAdapter.checkDuplicate — returns true if an open issue with a similar title already
   * exists. Delegates to checkOpenIssueExists, which is already fail-open (returns null
   * on any error), so this method always returns false on error.
   */
  async checkDuplicate(task: AgentTask): Promise<boolean> {
    const parsed = this.parsePrompt(task.prompt);
    if (!parsed.title) return false;
    const issueNumber = await this.checkOpenIssueExists(parsed.title);
    return issueNumber !== null;
  }

  /**
   * Return titles of all open issues labelled with the default label (e.g. "pulseed").
   * Used by CoreLoop to inject existing task context into the prompt so the LLM can
   * avoid creating duplicates.
   *
   * Runs `gh issue list --state open --label <label> --json title --limit 20`.
   * Returns an empty array on any error (fail-open).
   */
  async listExistingTasks(): Promise<string[]> {
    const label = this.defaultLabels[0] ?? "pulseed";
    const args = [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      label,
      "--json",
      "title",
      "--limit",
      "20",
    ];

    return new Promise<string[]>((resolve) => {
      let stdout = "";
      let resolved = false;

      const child = spawn(this.ghPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.on("error", () => {
        if (resolved) return;
        resolved = true;
        resolve([]);
      });

      child.on("close", (code: number | null) => {
        if (resolved) return;
        resolved = true;

        if (code !== 0) {
          resolve([]);
          return;
        }

        try {
          const issues = JSON.parse(stdout.trim()) as Array<{ title: string }>;
          resolve(issues.map((issue) => issue.title));
        } catch {
          resolve([]);
        }
      });
    });
  }

  /**
   * Parse the task prompt to extract issue title, body, and labels.
   *
   * Preferred format — a fenced ```github-issue block containing JSON:
   *   ```github-issue
   *   { "title": "...", "body": "...", "labels": ["bug"] }
   *   ```
   *
   * Fallback: first non-empty line = title, remainder = body, labels = defaultLabels only.
   *
   * Labels from the JSON block are merged with defaultLabels (deduplicated).
   */
  parsePrompt(prompt: string): ParsedIssue {
    const fenceMatch = prompt.match(/```github-issue\s*\n([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        const raw = JSON.parse(fenceMatch[1].trim()) as {
          title?: unknown;
          body?: unknown;
          labels?: unknown;
        };

        const title =
          typeof raw.title === "string" && raw.title.trim() !== ""
            ? raw.title.trim()
            : "(no title)";

        const body = typeof raw.body === "string" ? raw.body : "";

        const extraLabels: string[] = Array.isArray(raw.labels)
          ? (raw.labels as unknown[]).filter((l): l is string => typeof l === "string")
          : [];

        const labels = dedupeLabels([...this.defaultLabels, ...extraLabels]);

        return { title, body, labels };
      } catch {
        // JSON parse failed — fall through to plain-text fallback
      }
    }

    // Plain-text fallback
    const lines = prompt.split("\n");
    const firstNonEmpty = lines.find((l) => l.trim() !== "");
    const title = firstNonEmpty?.trim() ?? "(no title)";
    const afterFirst = lines
      .slice(lines.indexOf(firstNonEmpty ?? "") + 1)
      .join("\n")
      .trim();

    return {
      title,
      body: afterFirst,
      labels: [...this.defaultLabels],
    };
  }

  // ─── Private helpers ───

  private buildGhArgs(parsed: ParsedIssue, repo: string): string[] {
    const args: string[] = [
      "issue",
      "create",
      "--title",
      parsed.title,
      "--body",
      parsed.body,
    ];

    for (const label of parsed.labels) {
      args.push("--label", label);
    }

    args.push("--repo", repo);

    return args;
  }

  /**
   * Spawn `gh repo view --json nameWithOwner` and call back with the detected
   * repo string or an error message. Uses raw callbacks (not Promise/await) so
   * the callback fires synchronously inside the close event handler, allowing
   * the caller to immediately spawn the next child process without any
   * microtask gap.
   */
  private spawnDetect(
    timeoutMs: number,
    cb: (repo: string | null, err: string | null) => void
  ): void {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;
    const startedAt = Date.now();

    const child = spawn(this.ghPath, ["repo", "view", "--json", "nameWithOwner"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        cb(null, err.message);
        return;
      }
      this.spawnGitRemote(remainingMs, cb);
    });

    child.on("close", (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      if (timedOut || code !== 0) {
        // Fall back to git remote parsing with remaining budget
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          cb(null, "Could not detect GitHub repo: timed out.");
          return;
        }
        this.spawnGitRemote(remainingMs, cb);
        return;
      }

      const text = stdout.trim();
      try {
        const parsed = JSON.parse(text) as { nameWithOwner?: string };
        const name = parsed.nameWithOwner?.trim();
        if (name && name.includes("/")) {
          cb(name, null);
          return;
        }
      } catch {
        // Not JSON — check plain "owner/repo"
        if (text.includes("/")) {
          cb(text, null);
          return;
        }
      }

      // Could not parse — fall back with remaining budget
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        cb(null, "Could not detect GitHub repo: timed out.");
        return;
      }
      this.spawnGitRemote(remainingMs, cb);
    });
  }

  /**
   * Fallback: parse git remote URL. Same callback-based pattern.
   */
  private spawnGitRemote(
    timeoutMs: number,
    cb: (repo: string | null, err: string | null) => void
  ): void {
    let stdout = "";
    let timedOut = false;
    let resolved = false;

    const child = spawn("git", ["remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      cb(
        null,
        "Could not detect GitHub repo. Set PULSEED_GITHUB_REPO or run inside a GitHub-backed git repo. " +
          `(git error: ${err.message})`
      );
    });

    child.on("close", (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      const url = stdout.trim();
      if (timedOut || code !== 0 || !url) {
        cb(
          null,
          "Could not detect GitHub repo. Set PULSEED_GITHUB_REPO or run inside a GitHub-backed git repo."
        );
        return;
      }

      // Parse SSH: git@github.com:owner/repo.git
      const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
      if (sshMatch) {
        cb(sshMatch[1], null);
        return;
      }

      // Parse HTTPS: https://github.com/owner/repo[.git]
      const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/);
      if (httpsMatch) {
        cb(httpsMatch[1], null);
        return;
      }

      cb(
        null,
        `Could not parse GitHub repo from git remote URL: ${url}. ` +
          "Set PULSEED_GITHUB_REPO to 'owner/name' explicitly."
      );
    });
  }

  /**
   * Spawn `gh issue create` and resolve the outer Promise.
   */
  private async spawnCreate(
    parsed: ParsedIssue,
    repo: string,
    timeoutMs: number,
    startedAt: number,
    resolve: (result: AgentResult) => void
  ): Promise<void> {
    const args = this.buildGhArgs(parsed, repo);

    const result = await spawnWithTimeout(
      this.ghPath,
      args,
      {},
      timeoutMs
    );

    const elapsed = Date.now() - startedAt;

    if (result.timedOut) {
      resolve({
        success: false,
        output: result.stdout,
        error: `Timed out after ${timeoutMs}ms`,
        exit_code: result.exitCode,
        elapsed_ms: elapsed,
        stopped_reason: "timeout",
      });
      return;
    }

    if (result.exitCode === null) {
      resolve({
        success: false,
        output: result.stdout,
        error: this.classifyGhError(result.stderr),
        exit_code: null,
        elapsed_ms: elapsed,
        stopped_reason: "error",
      });
      return;
    }

    const success = result.exitCode === 0;
    resolve({
      success,
      output: result.stdout,
      error: success
        ? null
        : this.classifyGhError(result.stderr) || `gh exited with code ${result.exitCode}`,
      exit_code: result.exitCode,
      elapsed_ms: elapsed,
      stopped_reason: success ? "completed" : "error",
    });
  }

  private classifyGhError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes("executable file not found") || lower.includes("enoent")) {
      return "gh CLI not found. Install the GitHub CLI (https://cli.github.com/).";
    }
    if (lower.includes("not logged into") || lower.includes("authentication token")) {
      return "gh CLI not authenticated. Run `gh auth login`.";
    }
    if (lower.includes("could not resolve") || lower.includes("repository not found")) {
      return `Repository not found or no access. Check PULSEED_GITHUB_REPO. Original: ${msg}`;
    }
    return msg;
  }
}

// ─── Utility ───

function dedupeLabels(labels: string[]): string[] {
  return [...new Set(labels)];
}

/**
 * Returns true when two issue titles have >60% word overlap (case-insensitive).
 * Short stop-words (≤2 chars) are excluded from the comparison.
 */
function titlesOverlap(a: string, b: string): boolean {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 || setB.size === 0) return false;

  let overlap = 0;
  for (const word of setA) {
    if (setB.has(word)) overlap++;
  }

  const ratio = overlap / Math.min(setA.size, setB.size);
  return ratio > 0.6;
}
