import type { Task } from "../../../base/types/task.js";
import type { AgentLoopCommandResult } from "./agent-loop-result.js";

const MECHANICAL_PREFIXES = [
  "npm",
  "npx",
  "pytest",
  "sh",
  "bash",
  "node",
  "make",
  "cargo",
  "go ",
  "gh ",
  "rg ",
  "grep ",
  "test ",
  "ls ",
];

const VERB_PREFIXES = [
  "run ",
  "use ",
  "check ",
  "verify ",
  "execute ",
  "confirm ",
];

type VerificationFamily =
  | "vitest"
  | "jest"
  | "pytest"
  | "tsc"
  | "eslint"
  | "biome"
  | "ruff"
  | "mypy"
  | "rg"
  | "grep"
  | "test"
  | "git_diff"
  | "git_status"
  | "npm_test"
  | "build"
  | "other";

export function isMechanicalVerificationMethod(method: string): boolean {
  const normalized = method.toLowerCase().trim();
  return MECHANICAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isTaskRelevantVerificationCommand(
  task: Task,
  commandResult: AgentLoopCommandResult,
): boolean {
  if (!commandResult.evidenceEligible) return false;

  const blockingCriteria = task.success_criteria.filter((criterion) => criterion.is_blocking);
  const mechanicalMethods = blockingCriteria
    .map((criterion) => criterion.verification_method)
    .filter(isMechanicalVerificationMethod);

  if (mechanicalMethods.length === 0) {
    return true;
  }

  const commandFamily = extractVerificationFamily(commandResult.command);
  const normalizedCommand = normalizeVerificationText(commandResult.command);
  return mechanicalMethods.some((method) => {
    const normalizedMethod = normalizeVerificationText(method);
    if (normalizedMethod === normalizedCommand) {
      return true;
    }
    const methodFamily = extractVerificationFamily(method);
    return methodFamily !== "other" && methodFamily === commandFamily;
  });
}

function extractVerificationFamily(input: string): VerificationFamily {
  const normalized = normalizeVerificationText(input);
  if (/\bvitest\b/.test(normalized)) return "vitest";
  if (/\bjest\b/.test(normalized)) return "jest";
  if (/\bpytest\b/.test(normalized)) return "pytest";
  if (/\btsc\b/.test(normalized)) return "tsc";
  if (/\beslint\b/.test(normalized)) return "eslint";
  if (/\bbiome\b/.test(normalized)) return "biome";
  if (/\bruff\b/.test(normalized)) return "ruff";
  if (/\bmypy\b/.test(normalized)) return "mypy";
  if (/^rg\b|\brg\b/.test(normalized)) return "rg";
  if (/^grep\b|\bgrep\b/.test(normalized)) return "grep";
  if (/^(test|\[)\b|\btest -f\b/.test(normalized)) return "test";
  if (/git diff/.test(normalized)) return "git_diff";
  if (/git status/.test(normalized)) return "git_status";
  if (/npm test|pnpm test|yarn test|bun test/.test(normalized)) return "npm_test";
  if (/\b(build|compile)\b/.test(normalized)) return "build";
  return "other";
}

function normalizeVerificationText(input: string): string {
  let normalized = input.toLowerCase().trim();
  for (const prefix of VERB_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }
  return normalized.replace(/\s+/g, " ");
}
