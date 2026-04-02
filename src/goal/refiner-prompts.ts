import type { Goal } from "../types/goal.js";
export { sanitizeThresholdTypes, sanitizeThresholdValues } from "../llm/json-sanitizer.js";

/**
 * Builds the leaf test prompt for the GoalRefiner.
 *
 * The returned prompt asks an LLM to evaluate whether the given goal is
 * directly measurable and, when it is, to specify concrete dimensions.
 */
export function buildLeafTestPrompt(
  goal: Goal,
  availableDataSources: string[]
): string {
  const constraintsSection =
    goal.constraints.length > 0
      ? `Constraints: ${goal.constraints.join(", ")}`
      : "Constraints: none";

  const dataSourcesSection =
    availableDataSources.length > 0
      ? availableDataSources.join(", ")
      : "shell, file_existence";

  return `You are evaluating whether a goal is directly measurable.

Goal: "${goal.description}"
${constraintsSection}
Available data sources: ${dataSourcesSection}
Depth: ${goal.decomposition_depth}

A goal is measurable when you can specify ALL of these for EACH aspect:
1. data_source — where to observe (shell command, file check, API, etc.)
2. observation_command — exact command or check to run
3. threshold_type — min/max/range/present/match
4. threshold_value — concrete target value

Return JSON:
{
  "is_measurable": true/false,
  "dimensions": [
    {
      "name": "snake_case_name",
      "label": "Human Label",
      "threshold_type": "min",
      "threshold_value": 80,
      "data_source": "shell",
      "observation_command": "npm test -- --coverage | grep Statements"
    },
    {
      "name": "config_file",
      "label": "Config File Present",
      "threshold_type": "present",
      "threshold_value": null,
      "data_source": "file_existence",
      "observation_command": "test -f config.json"
    }
  ],
  "reason": "Brief explanation"
}

When is_measurable is false, set "dimensions" to null.
For "present" threshold_type, always set "threshold_value" to null.

If the goal spans multiple files or multiple independent targets, prefer decomposition into per-file subgoals. A goal with more than 3 dimensions affecting different files should almost always be decomposed rather than treated as a single leaf.

IMPORTANT: Respond with ONLY the JSON object above. Do not return an array, do not wrap in markdown, do not include any other text.`;
}
