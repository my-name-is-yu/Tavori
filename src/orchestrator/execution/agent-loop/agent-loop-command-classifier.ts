import type { AgentLoopCommandResultCategory } from "./agent-loop-result.js";

export function classifyAgentLoopCommandResult(input: {
  toolName: string;
  command: string;
}): {
  category: AgentLoopCommandResultCategory;
  evidenceEligible: boolean;
} {
  const toolName = input.toolName.trim();
  const command = input.command.trim();

  if (toolName === "verify") {
    return { category: "verification", evidenceEligible: true };
  }

  if (toolName !== "shell_command") {
    return { category: "other", evidenceEligible: false };
  }

  if (matchesVerificationCommand(command)) {
    return { category: "verification", evidenceEligible: true };
  }
  if (matchesObservationCommand(command)) {
    return { category: "observation", evidenceEligible: false };
  }
  return { category: "other", evidenceEligible: false };
}

function matchesVerificationCommand(command: string): boolean {
  const patterns = [
    /^(test|\[)\s/,
    /^(rg|grep|fd|find)\s/,
    /^git\s+(diff(\s+--exit-code)?|status|show|rev-parse)\b/,
    /^(npm|pnpm|yarn|bun)\s+(test|run\s+test|run\s+lint|run\s+build|exec\s+tsc\b)\b/,
    /^npx\s+(vitest|jest|tsx?\b|tsc\b)/,
    /^(pytest|nosetests|go\s+test|cargo\s+test|cargo\s+check|cargo\s+clippy|uv\s+run\s+pytest)\b/,
    /^(tsc|eslint|biome|ruff|mypy)\b/,
  ];
  return patterns.some((pattern) => pattern.test(command));
}

function matchesObservationCommand(command: string): boolean {
  const patterns = [
    /^(pwd|ls|cat|head|tail|wc|echo|date|hostname|which|type|file)\b/,
    /^git\s+(branch|log|describe|tag\s+-l)\b/,
    /^du\b/,
    /^df\b/,
    /^tree\b/,
  ];
  return patterns.some((pattern) => pattern.test(command));
}
