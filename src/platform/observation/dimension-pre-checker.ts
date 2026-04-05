import { execFile as execFileCb } from "child_process";
import { stat } from "fs/promises";
import { promisify } from "util";
import type { Dimension } from "../../base/types/goal.js";
import type { ObservationLogEntry } from "../../base/types/state.js";
import type { ToolExecutor } from "../../tools/executor.js";

const execFile = promisify(execFileCb);

// --- Result types ---

export interface PreCheckResult {
  changed: boolean;
  hint?: string;       // optional context for LLM if changed
  raw_value?: unknown; // the deterministic value, if available
}

// --- Interface ---

export interface IDimensionPreChecker {
  check(
    dimension: Dimension,
    lastObservation: ObservationLogEntry | null,
    goalContext: { workspace_path?: string }
  ): Promise<PreCheckResult>;
}

// --- Config ---

export interface DimensionPreCheckerConfig {
  min_observation_interval_sec: number;
  strategies: Array<"age" | "git_diff" | "file_stat">;
  toolExecutor?: ToolExecutor;
}

const DEFAULT_CONFIG: DimensionPreCheckerConfig = {
  min_observation_interval_sec: 60,
  strategies: ["age", "git_diff"],
};

// Age strategy: skip if last observation is younger than min_observation_interval.
function checkAge(
  lastObservation: ObservationLogEntry | null,
  minIntervalSec: number
): PreCheckResult | null {
  if (!lastObservation) return null; // no previous obs -> must run
  const lastTs = new Date(lastObservation.timestamp).getTime();
  const ageMs = Date.now() - lastTs;
  if (ageMs < minIntervalSec * 1000) {
    return { changed: false };
  }
  return null; // age check passes; defer to other strategies
}

// Git diff strategy via ToolExecutor (preferred) or raw execFile fallback.
async function checkGitDiff(
  workspacePath: string | undefined,
  lastObservation: ObservationLogEntry | null,
  toolExecutor?: ToolExecutor
): Promise<PreCheckResult | null> {
  if (!workspacePath) return null;
  if (!lastObservation) return null;

  if (toolExecutor) {
    try {
      const ctx = {
        cwd: workspacePath,
        goalId: "pre-check",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
        callId: "pre-check-dirty",
        sessionId: "observation",
      };

      const [unstaged, staged] = await Promise.all([
        toolExecutor.execute("git_diff", { target: "unstaged", maxLines: 1 }, ctx),
        toolExecutor.execute("git_diff", { target: "staged", maxLines: 1 }, ctx),
      ]);

      const isDirty =
        (unstaged.success && unstaged.data != null && String(unstaged.data).trim().length > 0) ||
        (staged.success && staged.data != null && String(staged.data).trim().length > 0);

      if (!isDirty) return { changed: false };

      const hint = [unstaged.data, staged.data]
        .filter(Boolean)
        .join("
")
        .trim()
        .slice(0, 200);
      return { changed: true, hint: hint || undefined };
    } catch {
      // ToolExecutor call failed — fall through to execFile fallback
    }
  }

  // Fallback: raw execFile
  try {
    const { stdout } = await execFile(
      "git",
      ["status", "--short"],
      { cwd: workspacePath, timeout: 8000, encoding: "utf8" }
    );

    if (stdout.trim().length === 0) {
      return { changed: false };
    }
    return { changed: true, hint: stdout.trim().slice(0, 200) };
  } catch {
    // Not a git repo or git unavailable — skip this strategy
    return null;
  }
}

// File stat strategy: if workspace mtime <= last observation timestamp, no change.
async function checkFileStat(
  workspacePath: string | undefined,
  lastObservation: ObservationLogEntry | null
): Promise<PreCheckResult | null> {
  if (!workspacePath) return null;
  if (!lastObservation) return null;

  try {
    const s = await stat(workspacePath);
    const lastObsTime = new Date(lastObservation.timestamp).getTime();
    const mtimeMs = s.mtimeMs;

    if (mtimeMs <= lastObsTime) {
      return { changed: false };
    }
    return { changed: true, hint: `Workspace mtime changed since last observation` };
  } catch {
    // stat failed (path does not exist, permissions) — skip
    return null;
  }
}

// --- Default implementation ---
export class DimensionPreChecker implements IDimensionPreChecker {
  private readonly config: DimensionPreCheckerConfig;

  constructor(config: Partial<DimensionPreCheckerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async check(
    dimension: Dimension,
    lastObservation: ObservationLogEntry | null,
    goalContext: { workspace_path?: string }
  ): Promise<PreCheckResult> {
    // No previous observation -> always run full observation
    if (!lastObservation) {
      return { changed: true };
    }

    const results: Array<PreCheckResult | null> = [];

    for (const strategy of this.config.strategies) {
      switch (strategy) {
        case "age":
          results.push(checkAge(lastObservation, this.config.min_observation_interval_sec));
          break;
        case "git_diff":
          results.push(
            await checkGitDiff(goalContext.workspace_path, lastObservation, this.config.toolExecutor)
          );
          break;
        case "file_stat":
          results.push(await checkFileStat(goalContext.workspace_path, lastObservation));
          break;
      }
    }

    // Filter out null results (strategy not applicable)
    const applicable = results.filter((r): r is PreCheckResult => r !== null);

    // No applicable strategy produced a result -> default to changed=true (run LLM)
    if (applicable.length === 0) {
      return { changed: true };
    }

    // If ANY strategy reports changed=true -> proceed to LLM
    const changedResult = applicable.find((r) => r.changed);
    if (changedResult) {
      return changedResult;
    }

    // ALL applicable strategies report changed=false -> skip
    const hints = applicable.map((r) => r.hint).filter(Boolean);
    const rawValue = applicable.find((r) => r.raw_value !== undefined)?.raw_value;

    return {
      changed: false,
      hint: hints.length > 0 ? hints.join("; ") : undefined,
      raw_value: rawValue,
    };
  }
}
