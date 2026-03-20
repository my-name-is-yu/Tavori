// ─── motiva suggest and improve commands ───

import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient } from "../../llm/provider-factory.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { CapabilityDetector } from "../../observation/capability-detector.js";
import type { GoalSuggestion } from "../../goal/goal-negotiator.js";
import { SuggestOutputSchema } from "../../types/suggest.js";
import type { SuggestOutput, Suggestion } from "../../types/suggest.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";

// ─── Suggest helpers ───

function extractCandidatePaths(targetPath: string, context: string, repoFiles: string[] = []): string[] {
  const normalizedTarget = targetPath && targetPath !== "." ? targetPath.replace(/\/+$/, "") : ".";
  const candidates = new Set<string>();
  const pathPattern = /(?:^|[\s(])((?:README(?:\.[a-z0-9]+)?|package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|docs\/[^\s:),]+|design\/[^\s:),]+|src\/[^\s:),]+|tests?\/[^\s:),]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+))/gim;

  for (const repoFile of repoFiles) {
    const normalized = repoFile.trim().replace(/\\/g, "/");
    if (normalized.length > 0) {
      candidates.add(normalized);
    }
  }

  for (const match of context.matchAll(pathPattern)) {
    const raw = match[1]?.replace(/[),.:;]+$/, "");
    if (!raw) continue;
    if (normalizedTarget !== "." && !raw.startsWith(normalizedTarget)) {
      candidates.add(`${normalizedTarget}/${raw}`);
    } else {
      candidates.add(raw);
    }
  }

  if (candidates.size === 0) {
    candidates.add(normalizedTarget === "." ? "README.md" : `${normalizedTarget}/README.md`);
    candidates.add(normalizedTarget === "." ? "package.json" : `${normalizedTarget}/package.json`);
  }

  return [...candidates];
}

function ensureActionableSuggestion(suggestion: GoalSuggestion, targetPath: string, context: string, repoFiles: string[] = []): GoalSuggestion {
  const candidates = extractCandidatePaths(targetPath, context, repoFiles);
  const target = candidates[0] ?? (targetPath === "." ? "README.md" : `${targetPath}/README.md`);
  const description = suggestion.description.trim();
  const rationale = suggestion.rationale.trim();
  const hasPath = /(?:README(?:\.[a-z0-9]+)?|package\.json|tsconfig(?:\.[a-z0-9-]+)?\.json|docs\/|design\/|src\/|tests?\/|\/)/i.test(description);
  const hasChange = /\b(add|update|document|refactor|implement|create|remove|replace|wire|cover|verify|fix)\b/i.test(description);

  return {
    ...suggestion,
    description: hasPath && hasChange
      ? description
      : `${description.replace(/[. ]+$/, "")} by updating ${target} to deliver a verifiable improvement.`,
    rationale: rationale.length > 0
      ? rationale
      : `Target ${target} so the next change is anchored to a concrete repo file.`,
    dimensions_hint: suggestion.dimensions_hint.length > 0 ? suggestion.dimensions_hint : ["repo_actionability"],
  };
}

function synthesizeFallbackSuggestions(targetPath: string, context: string, maxSuggestions: number, repoFiles: string[] = []): GoalSuggestion[] {
  const candidatePaths = extractCandidatePaths(targetPath, context, repoFiles);
  const suggestionLimit = Math.max(1, Math.min(3, maxSuggestions));
  const suggestions: GoalSuggestion[] = [];
  const contextLower = context.toLowerCase();
  const hasReadme = candidatePaths.some((p) => /README(?:\.[a-z0-9]+)?$/i.test(p));
  const hasPackageJson = candidatePaths.some((p) => /package\.json$/i.test(p));
  const hasDocs = candidatePaths.some((p) => /^docs\//i.test(p) || /\/docs\//i.test(p));
  const hasDesign = candidatePaths.some((p) => /^design\//i.test(p) || /\/design\//i.test(p));
  const hasCliSource = candidatePaths.some((p) => /(?:^|\/)src\/.*(?:cli|command|runner)/i.test(p) || /(?:^|\/)tests\/cli\//i.test(p));
  const testCountMatch = context.match(/Test files:\s*(\d+)/i);
  const testCount = testCountMatch ? Number.parseInt(testCountMatch[1] ?? "0", 10) : candidatePaths.filter((p) => /^tests?\//i.test(p) || /\.test\.[a-z]+$/i.test(p)).length;
  const todoCountMatch = context.match(/TODO\/FIXME count:\s*(\d+)/i);
  const todoCount = todoCountMatch ? Number.parseInt(todoCountMatch[1] ?? "0", 10) : 0;

  const addSuggestion = (title: string, target: string, change: string, rationale: string, dimensions: string[]) => {
    if (suggestions.length >= suggestionLimit) return;
    suggestions.push({
      title,
      description: `Update ${target} to ${change}.`,
      rationale,
      dimensions_hint: dimensions,
    });
  };

  void hasReadme;

  const readmeTarget = candidatePaths.find((p) => /README(?:\.[a-z0-9]+)?$/i.test(p)) ?? (targetPath === "." ? "README.md" : `${targetPath}/README.md`);
  const packageTarget = candidatePaths.find((p) => /package\.json$/i.test(p)) ?? (targetPath === "." ? "package.json" : `${targetPath}/package.json`);
  const docsTarget = candidatePaths.find((p) => /^docs\//i.test(p) || /\/docs\//i.test(p))
    ?? candidatePaths.find((p) => /^design\//i.test(p) || /\/design\//i.test(p))
    ?? readmeTarget;
  const srcTarget = candidatePaths.find((p) => /^src\//i.test(p) || /\/src\//i.test(p)) ?? readmeTarget;
  const testTarget = candidatePaths.find((p) => /^tests?\//i.test(p) || /\.test\.[a-z]+$/i.test(p))
    ?? (targetPath === "." ? "tests/" : `${targetPath}/tests/`);

  if (testCount === 0) {
    addSuggestion(
      "Add baseline regression coverage for the repository",
      testTarget,
      `add a focused test that exercises the current behavior of ${srcTarget} and documents the expected output`,
      "No local test coverage was detected, so a repo-specific regression test is the safest non-empty fallback.",
      ["test_coverage", "reliability"]
    );
  } else if (hasCliSource || contextLower.includes("cli")) {
    addSuggestion(
      "Close a CLI behavior gap with a regression test",
      testTarget,
      "add or extend a CLI regression test that verifies path propagation, output shape, or command behavior against the current implementation",
      "CLI source and tests are present locally, so the fallback can propose a concrete repo-scoped behavior check.",
      ["test_coverage", "cli_reliability"]
    );
  }

  if (hasDocs || hasDesign || candidatePaths.some((p) => /README(?:\.[a-z0-9]+)?$/i.test(p))) {
    addSuggestion(
      hasDesign ? "Align design notes with implemented behavior" : "Tighten repository documentation",
      docsTarget,
      hasDesign
        ? `reconcile the documented design with ${srcTarget} so the next implementation change follows the current repo behavior`
        : "document setup steps, command usage, and the most important repo-specific workflows with a concrete example",
      hasDesign
        ? "Docs and design files provide enough local context to produce a concrete mismatch-resolution goal."
        : "Repository docs are available locally and remain actionable even when model suggestions are empty.",
      ["documentation", "developer_experience"]
    );
  }

  if (todoCount > 0 || hasPackageJson || candidatePaths.some((p) => /^src\//i.test(p) || /\/src\//i.test(p))) {
    addSuggestion(
      todoCount > 0 ? "Resolve one tracked implementation gap" : "Harden one concrete repository path",
      todoCount > 0 ? srcTarget : (hasPackageJson ? packageTarget : srcTarget),
      todoCount > 0
        ? `replace one TODO or FIXME with a completed implementation or a verifiable follow-up in ${srcTarget}`
        : `clarify scripts, validation, or behavior so the next change is scoped to ${hasPackageJson ? packageTarget : srcTarget}`,
      todoCount > 0
        ? "Local TODO and FIXME markers indicate an unfinished repo-specific improvement opportunity."
        : "The repository surface includes concrete implementation files, so the fallback should stay anchored to a real path.",
      todoCount > 0 ? ["implementation_gap", "maintainability"] : ["repo_actionability", "maintainability"]
    );
  }

  if (suggestions.length === 0) {
    addSuggestion(
      "Inspect one repository path and define a measurable improvement",
      srcTarget,
      "make a small, verifiable change that improves behavior, documentation, or test coverage for the current codebase",
      "Fallback output must stay non-empty and repository-scoped even when upstream suggestions and repo signals are sparse.",
      ["repo_actionability"]
    );
  }

  return suggestions.slice(0, suggestionLimit);
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function pickStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const normalized = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [];
}

function normalizeLegacySuggestion(
  candidate: unknown,
  targetPath: string,
  displayPath: string,
  context: string,
  repoFiles: string[] = []
): Suggestion {
  const record = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const title = pickFirstString(record.title, record.name, record.goal, record.action, "Repository improvement");
  const rationale = pickFirstString(
    record.rationale,
    record.reason,
    record.why,
    record.description,
    `Improve ${displayPath} with a concrete, verifiable next step.`
  );
  const description = pickFirstString(record.description, record.summary, record.details, record.rationale, title);
  const dimensions = pickStringArray(
    record.success_criteria,
    record.successCriteria,
    record.acceptance_criteria,
    record.criteria,
    record.done_when,
    record.dimensions_hint
  );
  const pathHint = pickFirstString(
    record.path,
    record.repoPath,
    (record.repo_context as { path?: unknown } | undefined)?.path,
    displayPath
  );
  const actionable = ensureActionableSuggestion(
    {
      title,
      description,
      rationale,
      dimensions_hint: dimensions,
    },
    targetPath,
    context,
    repoFiles
  );
  const steps = pickStringArray(record.steps, record.actions, record.tasks, record.checklist);
  const normalizedSteps = steps.length > 0 ? steps : [actionable.description];
  const successCriteria = dimensions.length > 0
    ? dimensions.map((dimension) => `Verify measurable progress for ${dimension}.`)
    : [`Complete the change in ${pathHint || displayPath} and confirm the improvement is verifiable.`];

  return {
    title: actionable.title.trim(),
    rationale: actionable.rationale.trim(),
    steps: normalizedSteps,
    success_criteria: successCriteria,
    repo_context: {
      path: (pathHint || displayPath).trim() || displayPath,
    },
  };
}

function extractSuggestCandidates(rawOutput: unknown): unknown[] {
  if (Array.isArray(rawOutput)) {
    return rawOutput;
  }
  if (!rawOutput || typeof rawOutput !== "object") {
    return [];
  }

  const record = rawOutput as Record<string, unknown>;
  const nestedCandidates = record.suggestions
    ?? record.goals
    ?? record.items
    ?? record.recommendations;

  return Array.isArray(nestedCandidates) ? nestedCandidates : [record];
}

function buildFallbackSuggestPayload(
  targetPath: string,
  displayPath: string,
  context: string,
  maxSuggestions: number,
  repoFiles: string[] = []
): SuggestOutput {
  const suggestions = synthesizeFallbackSuggestions(targetPath, context, Math.max(1, maxSuggestions), repoFiles)
    .map((suggestion) => ({
      title: suggestion.title,
      rationale: suggestion.rationale,
      steps: [suggestion.description],
      success_criteria: suggestion.dimensions_hint.length > 0
        ? suggestion.dimensions_hint.map((dimension) => `Verify measurable progress for ${dimension}.`)
        : [`Complete the scoped repository update under ${displayPath}.`],
      repo_context: {
        path: displayPath,
      },
    }));

  return {
    suggestions: suggestions.length > 0
      ? suggestions
      : [{
        title: "Inspect the repository and define one concrete improvement",
        rationale: `No valid suggestions were produced, so ${displayPath} needs a direct repository-scoped next step.`,
        steps: [`Review ${displayPath} and update one concrete file to produce a measurable improvement.`],
        success_criteria: [`Complete one repository-scoped change under ${displayPath} and verify the result.`],
        repo_context: { path: displayPath },
      }],
  };
}

function normalizeLegacySuggestPayload(
  rawOutput: unknown,
  targetPath: string,
  displayPath: string,
  context: string,
  maxSuggestions: number,
  repoFiles: string[] = []
): SuggestOutput {
  const candidateSource = extractSuggestCandidates(rawOutput);
  const normalizedSuggestions = candidateSource
    .map((candidate) => normalizeLegacySuggestion(candidate, targetPath, displayPath, context, repoFiles))
    .filter((suggestion, index, all) => all.findIndex((item) => item.title === suggestion.title) === index)
    .slice(0, Math.max(1, maxSuggestions));

  if (normalizedSuggestions.length > 0) {
    return { suggestions: normalizedSuggestions };
  }

  return buildFallbackSuggestPayload(targetPath, displayPath, context, maxSuggestions, repoFiles);
}

export function normalizeSuggestPayload(
  rawOutput: unknown,
  targetPath: string,
  displayPath: string,
  context: string,
  maxSuggestions: number,
  repoFiles: string[] = []
): SuggestOutput {
  const parsed = SuggestOutputSchema.safeParse(rawOutput);
  if (parsed.success) {
    return parsed.data;
  }

  const legacyNormalized = normalizeLegacySuggestPayload(
    rawOutput,
    targetPath,
    displayPath,
    context,
    maxSuggestions,
    repoFiles
  );
  const reparsed = SuggestOutputSchema.safeParse(legacyNormalized);
  if (reparsed.success) {
    return reparsed.data;
  }

  const fallback = buildFallbackSuggestPayload(targetPath, displayPath, context, maxSuggestions, repoFiles);
  const fallbackParsed = SuggestOutputSchema.safeParse(fallback);
  if (!fallbackParsed.success) {
    throw new Error(`Failed to normalize suggest output: ${fallbackParsed.error.message}`);
  }
  return fallbackParsed.data;
}

function suggestOutputHasCandidates(rawOutput: unknown): boolean {
  if (typeof rawOutput === "string") {
    return rawOutput.trim().length > 0;
  }

  if (Array.isArray(rawOutput)) {
    return rawOutput.length > 0;
  }

  if (!rawOutput || typeof rawOutput !== "object") {
    return false;
  }

  const record = rawOutput as Record<string, unknown>;
  const nestedCandidates = record.suggestions
    ?? record.goals
    ?? record.items
    ?? record.recommendations;

  if (Array.isArray(nestedCandidates)) {
    return nestedCandidates.length > 0;
  }

  return Object.keys(record).length > 0;
}

async function generateSuggestOutput(
  suggestGoals: (
    context: string,
    options: {
      maxSuggestions: number;
      existingGoals: string[];
      repoPath: string;
      capabilityDetector: CapabilityDetector;
    }
  ) => Promise<unknown>,
  context: string,
  options: {
    maxSuggestions: number;
    existingGoals: string[];
    repoPath: string;
    capabilityDetector: CapabilityDetector;
  }
): Promise<unknown> {
  const firstAttempt = await suggestGoals(context, options);
  if (suggestOutputHasCandidates(firstAttempt)) {
    return firstAttempt;
  }

  const retryContext = `${context}\n\nThe first response was empty. Return up to ${options.maxSuggestions} concrete, repository-scoped suggestions and do not return an empty result if actionable repo context is available.`;
  const retryAttempt = await suggestGoals(retryContext, options);
  return suggestOutputHasCandidates(retryAttempt) ? retryAttempt : firstAttempt;
}

// ─── cmdSuggest ───

export async function cmdSuggest(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<number> {
  const logger = getCliLogger();
  let values: { max?: string; path?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        max: { type: "string", short: "n", default: "5" },
        path: { type: "string", short: "p", default: "." },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { max?: string; path?: string }; positionals: string[] });
  } catch (err) {
    logger.error(formatOperationError("parse suggest command arguments", err));
    return 1;
  }

  const context = positionals[0];
  if (!context) {
    logger.error('Usage: motiva suggest "<context>" [--max N] [--path <dir>]');
    return 1;
  }

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise suggest dependencies", err));
    return 1;
  }

  const existingGoalIds = await deps.stateManager.listGoalIds();
  const existingTitles: string[] = [];
  for (const id of existingGoalIds) {
    const goal = await deps.stateManager.loadGoal(id);
    if (goal?.title) {
      existingTitles.push(goal.title);
    }
  }

  const requestedPath = values.path?.trim() ? values.path : ".";
  const targetPath = requestedPath;
  const displayPath = requestedPath;
  const repoFiles: string[] = [];
  const fullContext = context;

  console.log("Generating goal suggestions...\n");

  const capabilityDetectorLlmClient = await buildLLMClient();
  const capabilityReportingEngine = new ReportingEngine(stateManager);
  const capabilityDetector = new CapabilityDetector(stateManager, capabilityDetectorLlmClient, capabilityReportingEngine);

  const maxSuggestions = parseInt(values.max ?? "5", 10);
  let suggestions: unknown;
  try {
    suggestions = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      fullContext,
      {
        maxSuggestions,
        existingGoals: existingTitles,
        repoPath: targetPath,
        capabilityDetector,
      }
    );
  } catch (err) {
    logger.error(formatOperationError("generate goal suggestions", err));
    return 1;
  }

  const finalPayload = normalizeSuggestPayload(
    suggestions,
    targetPath,
    displayPath,
    fullContext,
    maxSuggestions,
    repoFiles
  );

  console.log(JSON.stringify(finalPayload, null, 2));

  return 0;
}

// ─── cmdImprove ───

export async function cmdImprove(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[]
): Promise<number> {
  const logger = getCliLogger();
  let values: { auto?: boolean; max?: string; yes?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        auto: { type: "boolean", default: false },
        max: { type: "string", short: "n", default: "3" },
        yes: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { auto?: boolean; max?: string; yes?: boolean }; positionals: string[] });
  } catch (err) {
    logger.error(formatOperationError("parse improve command arguments", err));
    return 1;
  }

  const targetPath = positionals[0] || ".";
  console.log(`\n[Motiva Improve] Analyzing ${targetPath}...\n`);

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise improve dependencies", err));
    return 1;
  }

  // Step 1: Gather context (stub — returns empty string as in original)
  const context = "";

  // Step 2: Suggest goals
  const existingGoalIds = await deps.stateManager.listGoalIds();
  const existingTitles: string[] = [];
  for (const id of existingGoalIds) {
    const goal = await deps.stateManager.loadGoal(id);
    if (goal?.title) {
      existingTitles.push(goal.title);
    }
  }

  let suggestions;
  try {
    suggestions = await deps.goalNegotiator.suggestGoals(context, {
      maxSuggestions: parseInt(values.max || "3", 10),
      existingGoals: existingTitles,
      repoPath: targetPath,
    });
  } catch (err) {
    logger.error(formatOperationError("generate improvement suggestions", err));
    return 1;
  }

  if (suggestions.length === 0) {
    console.log("No improvement goals found for the given path.");
    return 0;
  }

  // Step 3: Select goal(s)
  let selectedIndex = 0;
  if (values.auto) {
    console.log(`[Auto] Selected: ${suggestions[0]?.title ?? ""}`);
  } else {
    console.log("=== Suggested Improvements ===\n");
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      if (!s) continue;
      console.log(`${i + 1}. ${s.title}`);
      console.log(`   ${s.rationale}\n`);
    }
    if (values.yes) {
      selectedIndex = 0;
      console.log(`[--yes] Auto-selecting: ${suggestions[0]?.title ?? ""}\n`);
    } else {
      selectedIndex = 0;
      console.log(`Selected: ${suggestions[0]?.title ?? ""}\n`);
    }
  }

  const selected = suggestions[selectedIndex];
  if (!selected) {
    logger.error("Error: no suggestion available at index 0.");
    return 1;
  }

  // Step 4: Negotiate the selected goal
  console.log(`[Motiva Improve] Negotiating goal: "${selected.title}"...`);
  let goal: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["goal"];
  let response: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["response"];
  try {
    ({ goal, response } = await deps.goalNegotiator.negotiate(selected.description, {
      constraints: [],
    }));
  } catch (err) {
    logger.error(formatOperationError(`negotiate goal "${selected.title}"`, err));
    return 1;
  }

  const responseType = (response as { type: string }).type;
  if (responseType === "reject") {
    logger.error(`Goal negotiation rejected: ${response.message}`);
    return 1;
  }

  console.log(`[Motiva Improve] Goal registered: ${goal.id}`);
  console.log(`  Response: ${responseType} — ${response.message}\n`);

  // Step 5: Run the loop (if --auto or --yes)
  if (values.auto || values.yes) {
    console.log(`[Motiva Improve] Starting improvement loop for goal ${goal.id}...`);
    try {
      await deps.coreLoop.run(goal.id);
    } catch (err) {
      logger.error(formatOperationError(`run improvement loop for goal "${goal.id}"`, err));
      return 1;
    }
    console.log(`[Motiva Improve] Loop completed for goal ${goal.id}`);
  } else {
    console.log(`Goal created. Run with: motiva run --goal ${goal.id}`);
  }

  return 0;
}
