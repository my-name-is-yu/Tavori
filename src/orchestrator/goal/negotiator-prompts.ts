import { z } from "zod";
import type { FeasibilityResult } from "../../base/types/negotiation.js";

// ─── Prompts ───

export function buildDecompositionPrompt(
  description: string,
  constraints: string[],
  availableDataSources?: Array<{ name: string; dimensions: string[] }>,
  workspaceContext?: string
): string {
  const constraintsSection =
    constraints.length > 0
      ? `\nConstraints:\n${constraints.map((c) => `- ${c}`).join("\n")}`
      : "";

  const dataSourcesSection =
    availableDataSources && availableDataSources.length > 0
      ? `DataSources (use exact dimension names for overlap; add 1-2 extra only if shell-measurable):
${availableDataSources.map((ds) => `- "${ds.name}": ${ds.dimensions.join(", ")}`).join("\n")}

`
      : "";

  const workspaceSection = workspaceContext
    ? `\nWorkspace:\n${workspaceContext}\nDerive dimensions measurable from this codebase (e.g. "task_note_count" max:0 if task notes exist).\n`
    : "";

  return `${dataSourcesSection}Decompose this goal into measurable dimensions.

Goal: ${description}${constraintsSection}${workspaceSection}

Each dimension needs: name (snake_case, prefer exact DataSource name), label, threshold_type ("min"|"max"|"range"|"present"|"match"), threshold_value (number/string/bool or null), observation_method_hint.

Rules:
- 100 dimensions max; prefer fewer focused dimensions over many vague ones; prefer mechanically measurable (shell/grep/test runner)
- "present" only for pure existence checks; use "min" (0.0-1.0) for quality/correctness/completeness
- No generic dimensions (code_quality, readability) unless goal names them AND a concrete shell command exists

Example:
[
  {"name":"test_coverage","label":"Test Coverage","threshold_type":"min","threshold_value":80,"observation_method_hint":"Run test suite, check coverage %"},
  {"name":"license_file_exists","label":"License File","threshold_type":"present","threshold_value":true,"observation_method_hint":"Check for LICENSE file in root"}
]`;
}

export function buildFeasibilityPrompt(
  dimension: string,
  description: string,
  baselineValue: number | string | boolean | null,
  thresholdValue: number | string | boolean | (number | string)[] | null,
  timeHorizonDays: number
): string {
  return `Dimension: ${dimension}
Goal: ${description}
Baseline: ${baselineValue === null ? "unknown" : String(baselineValue)}
Target: ${thresholdValue === null ? "unknown" : String(thresholdValue)}
Horizon: ${timeHorizonDays} days

{"assessment":"realistic"|"ambitious"|"infeasible","confidence":"high"|"medium"|"low","reasoning":"...","key_assumptions":[...],"main_risks":[...]}`;
}

export function buildResponsePrompt(
  description: string,
  responseType: "accept" | "counter_propose" | "flag_as_ambitious",
  feasibilityResults: FeasibilityResult[],
  counterProposal?: { realistic_target: number; reasoning: string }
): string {
  const feasibilitySummary = feasibilityResults
    .map((r) => `- ${r.dimension}: ${r.assessment} (${r.confidence})`)
    .join("\n");

  const instruction =
    responseType === "accept"
      ? "Write an encouraging acceptance message."
      : responseType === "counter_propose"
        ? `Write a counter-proposal: suggest ${counterProposal?.realistic_target} as a safer target. Reason: ${counterProposal?.reasoning}.`
        : "Flag this goal as ambitious. Note the risks and ask user to review.";

  return `Goal: ${description}
Feasibility:
${feasibilitySummary}

${instruction} Reply in 1-3 sentences, plain text.`;
}

// ─── Qualitative feasibility schema for LLM parsing ───

export const QualitativeFeasibilitySchema = z.object({
  assessment: z.enum(["realistic", "ambitious", "infeasible"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  key_assumptions: z.array(z.string()),
  main_risks: z.array(z.string()),
});
