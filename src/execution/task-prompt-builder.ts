import * as _fs from "node:fs";
import * as _path from "node:path";
import type { StateManager } from "../state-manager.js";

/**
 * Build the LLM prompt used to generate a task for the given goal and target dimension.
 *
 * Extracted from TaskLifecycle to keep prompt construction logic separate from
 * orchestration logic.
 */
export async function buildTaskGenerationPrompt(
  stateManager: StateManager,
  goalId: string,
  targetDimension: string,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string
): Promise<string> {
  // Load goal context to enrich the prompt
  const goal = await stateManager.loadGoal(goalId);
  const dim = goal?.dimensions.find((d) => d.name === targetDimension);

  // Build goal context section
  let goalSection: string;
  if (goal) {
    const titleLine = `Goal: ${goal.title}`;
    const descLine = goal.description ? `Description: ${goal.description}` : "";
    goalSection = [titleLine, descLine].filter(Boolean).join("\n");
  } else {
    goalSection = `Goal ID: ${goalId}`;
  }

  // Build dimension context section
  let dimensionSection: string;
  if (dim) {
    const currentVal = dim.current_value !== null && dim.current_value !== undefined
      ? String(dim.current_value)
      : "unknown";
    const threshold = dim.threshold;
    let targetDesc: string;
    if (threshold.type === "min") {
      targetDesc = `at least ${threshold.value}`;
    } else if (threshold.type === "max") {
      targetDesc = `at most ${threshold.value}`;
    } else if (threshold.type === "range") {
      targetDesc = `between ${threshold.low} and ${threshold.high}`;
    } else if (threshold.type === "present") {
      targetDesc = "present (non-null)";
    } else {
      targetDesc = `equal to ${(threshold as { value: unknown }).value}`;
    }
    const gapDesc = (() => {
      if (threshold.type === "min") {
        const val = typeof dim.current_value === "number" ? dim.current_value : null;
        if (val !== null) return `${(threshold.value as number) - val} below minimum`;
        return "current value unknown";
      } else if (threshold.type === "max") {
        const val = typeof dim.current_value === "number" ? dim.current_value : null;
        if (val !== null) return `${val - (threshold.value as number)} above maximum`;
        return "current value unknown";
      } else if (threshold.type === "present") {
        return dim.current_value == null ? "value is absent (needs to be set)" : "value is present";
      }
      return "gap exists";
    })();
    dimensionSection = `Dimension to improve: "${targetDimension}" (label: ${dim.label})

Gap Analysis:
- Current value: ${currentVal}
- Target threshold: ${targetDesc}
- Gap: ${gapDesc}`;
  } else {
    dimensionSection = `Dimension to improve: "${targetDimension}"`;
  }

  // Build adapter context section
  let adapterSection = "";
  if (adapterType === "github_issue") {
    adapterSection = `\nExecution context: GitHub issue creation.
- work_description: issue title (line 1) + issue body
- Generate specific, actionable issues only\n`;
  } else if (adapterType === "openai_codex_cli" || adapterType === "claude_code_cli") {
    adapterSection = `\nExecution context: CLI code agent in sandbox.
Constraints:
- No git commit/push/merge operations
- Success criteria must use file checks only (e.g., "file X exists")
- verification_method: use file existence/content checks (e.g., "test -f README.md")\n`;
  } else if (adapterType) {
    adapterSection = `\nExecution context: ${adapterType} adapter.\n`;
  }

  const knowledgeSection = knowledgeContext
    ? `\nRelevant domain knowledge:\n${knowledgeContext}\n`
    : "";

  // Read package.json for project identity (best-effort, no throw)
  let projectName = "";
  let projectDescription = "";
  try {
    const pkgPath = _path.join(process.cwd(), "package.json");
    if (_fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(_fs.readFileSync(pkgPath, "utf-8")) as {
        name?: string;
        description?: string;
      };
      projectName = pkg.name ?? "";
      projectDescription = pkg.description ?? "";
    }
  } catch {
    // silently ignore — repo context is best-effort
  }

  const repoContextParts: string[] = [];
  if (projectName) repoContextParts.push(`Project name: ${projectName}`);
  if (projectDescription) repoContextParts.push(`Project description: ${projectDescription}`);
  const repoSection = repoContextParts.length > 0
    ? `\nRepository context:\n${repoContextParts.join("\n")}\n`
    : "";

  const existingTasksSection = existingTasks && existingTasks.length > 0
    ? `\n=== Previously Generated Tasks (avoid duplication) ===\n${existingTasks.join("\n")}\nGenerate a task that addresses a DIFFERENT aspect of the goal than the existing tasks above.\n`
    : "";

  const workspaceSection = workspaceContext
    ? `\n=== Current Workspace State ===\n${workspaceContext}\n`
    : "\n=== Current Workspace State ===\nNo workspace context available.\n";

  return `${goalSection}
${dimensionSection}
${repoSection}${adapterSection}${knowledgeSection}${workspaceSection}${existingTasksSection}
Requirements:
- Specific to actual project (goal, description, repo context)
- No generic improvements unless in goal description
- One concrete, actionable task for "${targetDimension}" dimension
- Single measurable output in one session
- work_description: target file path(s), specific changes (not "improve X" → "add section Y to file Z")
- No vague review/triage tasks

Return JSON only (inside markdown code block):
{
  "work_description": "what to do (include file paths and specific changes)",
  "rationale": "why this matters",
  "approach": "how to accomplish it",
  "success_criteria": [
    {"description": "what success looks like", "verification_method": "how to verify", "is_blocking": true}
  ],
  "scope_boundary": {"in_scope": ["included"], "out_of_scope": ["excluded"], "blast_radius": "what could be affected"},
  "constraints": ["any constraints"],
  "reversibility": "reversible|irreversible|unknown",
  "estimated_duration": {"value": number, "unit": "minutes|hours|days|weeks"} | null
}`;
}
