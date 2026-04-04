// ─── suggest-normalizer.ts — pure helpers for suggest/improve commands ───

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

import { SuggestOutputSchema } from "../../base/types/suggest.js";
import type { SuggestOutput, Suggestion } from "../../base/types/suggest.js";
import type { GoalSuggestion } from "../../orchestrator/goal/goal-negotiator.js";
import type { CapabilityDetector } from "../../platform/observation/capability-detector.js";
import { buildTodoLikeMarkerInventory, formatTodoLikeMarkerInventory } from "./goal-utils.js";

// ─── Path helpers ───

export function extractCandidatePaths(targetPath: string, context: string, repoFiles: string[] = []): string[] {
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

// ─── Fallback synthesis ───

export function synthesizeFallbackSuggestions(targetPath: string, context: string, maxSuggestions: number, repoFiles: string[] = []): GoalSuggestion[] {
  const candidatePaths = extractCandidatePaths(targetPath, context, repoFiles);
  const suggestionLimit = Math.max(1, Math.min(3, maxSuggestions));
  const suggestions: GoalSuggestion[] = [];
  const contextLower = context.toLowerCase();
  const hasPackageJson = candidatePaths.some((p) => /package\.json$/i.test(p));
  const hasDocs = candidatePaths.some((p) => /^docs\//i.test(p) || /\/docs\//i.test(p));
  const hasDesign = candidatePaths.some((p) => /^design\//i.test(p) || /\/design\//i.test(p));
  const hasCliSource = candidatePaths.some((p) => /(?:^|\/)src\/.*(?:cli|command|runner)/i.test(p) || /(?:^|\/)tests\/cli\//i.test(p));
  const testCountMatch = context.match(/Test files:\s*(\d+)/i);
  const testCount = testCountMatch ? Number.parseInt(testCountMatch[1] ?? "0", 10) : candidatePaths.filter((p) => /^tests?\//i.test(p) || /\.test\.[a-z]+$/i.test(p)).length;
  const rawInventoryMatch = context.match(/raw_total_count:\s*(\d+)/i);
  const todoCountMatch = context.match(/TODO\/FIXME count:\s*(\d+)/i);
  const rawTotalCount = rawInventoryMatch
    ? Number.parseInt(rawInventoryMatch[1] ?? "0", 10)
    : todoCountMatch
      ? Number.parseInt(todoCountMatch[1] ?? "0", 10)
      : 0;
  const groupedCountMatch = context.match(/grouped_counts:\s*(\{.*\})/i);
  let groupedTodoCount = 0;
  let groupedFixmeCount = 0;
  if (groupedCountMatch) {
    try {
      const parsed = JSON.parse(groupedCountMatch[1] ?? "{}") as Partial<Record<"TODO" | "FIXME", unknown>>;
      groupedTodoCount = typeof parsed.TODO === "number" && Number.isFinite(parsed.TODO) ? parsed.TODO : 0;
      groupedFixmeCount = typeof parsed.FIXME === "number" && Number.isFinite(parsed.FIXME) ? parsed.FIXME : 0;
    } catch {
      // Ignore malformed grouped inventory context and fall back to raw count.
    }
  }
  const todoInventory = buildTodoLikeMarkerInventory(groupedTodoCount, groupedFixmeCount);
  const effectiveTodoInventory = {
    ...todoInventory,
    raw_total_count: rawTotalCount > 0 ? rawTotalCount : todoInventory.raw_total_count,
  };

  const addSuggestion = (title: string, target: string, change: string, rationale: string, dimensions: string[]) => {
    if (suggestions.length >= suggestionLimit) return;
    suggestions.push({
      title,
      description: `Update ${target} to ${change}.`,
      rationale,
      dimensions_hint: dimensions,
    });
  };

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

  if (effectiveTodoInventory.raw_total_count > 0 || hasPackageJson || candidatePaths.some((p) => /^src\//i.test(p) || /\/src\//i.test(p))) {
    addSuggestion(
      effectiveTodoInventory.raw_total_count > 0 ? "Resolve one tracked implementation gap" : "Harden one concrete repository path",
      effectiveTodoInventory.raw_total_count > 0 ? srcTarget : (hasPackageJson ? packageTarget : srcTarget),
      effectiveTodoInventory.raw_total_count > 0
        ? `replace one TODO or FIXME with a completed implementation or a verifiable follow-up in ${srcTarget}`
        : `clarify scripts, validation, or behavior so the next change is scoped to ${hasPackageJson ? packageTarget : srcTarget}`,
      effectiveTodoInventory.raw_total_count > 0
        ? `Local TODO and FIXME markers indicate an unfinished repo-specific improvement opportunity. ${formatTodoLikeMarkerInventory(effectiveTodoInventory)}`
        : "The repository surface includes concrete implementation files, so the fallback should stay anchored to a real path.",
      effectiveTodoInventory.raw_total_count > 0 ? ["implementation_gap", "maintainability"] : ["repo_actionability", "maintainability"]
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

// ─── Normalization helpers ───

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
  repoFiles: string[] = [],
  isSoftwareGoal = true
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
    ? dimensions.map((dimension) => `${dimension} reaches target threshold.`)
    : [`Complete the change in ${pathHint || displayPath} and confirm the improvement is verifiable.`];

  const result: Suggestion = {
    title: actionable.title.trim(),
    rationale: actionable.rationale.trim(),
    steps: normalizedSteps,
    success_criteria: successCriteria,
  };
  if (isSoftwareGoal) {
    result.repo_context = {
      path: (pathHint || displayPath).trim() || displayPath,
    };
  }
  return result;
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

export function buildFallbackSuggestPayload(
  targetPath: string,
  displayPath: string,
  context: string,
  maxSuggestions: number,
  repoFiles: string[] = [],
  isSoftwareGoal = true
): SuggestOutput {
  const suggestions = synthesizeFallbackSuggestions(targetPath, context, Math.max(1, maxSuggestions), repoFiles)
    .map((suggestion) => {
      const item: Suggestion = {
        title: suggestion.title,
        rationale: suggestion.rationale,
        steps: [suggestion.description],
        success_criteria: suggestion.dimensions_hint.length > 0
          ? suggestion.dimensions_hint.map((dimension) => `Verify measurable progress for ${dimension}.`)
          : [`Complete the scoped repository update under ${displayPath}.`],
      };
      if (isSoftwareGoal) {
        item.repo_context = { path: displayPath };
      }
      return item;
    });

  if (suggestions.length > 0) {
    return { suggestions };
  }

  const fallbackItem: Suggestion = {
    title: "Define one concrete improvement",
    rationale: "No valid suggestions were produced. Define a concrete next step.",
    steps: ["Review the context and define a measurable improvement."],
    success_criteria: ["Complete one concrete change and verify the result."],
  };
  if (isSoftwareGoal) {
    fallbackItem.repo_context = { path: displayPath };
    fallbackItem.title = "Inspect the repository and define one concrete improvement";
    fallbackItem.rationale = `No valid suggestions were produced, so ${displayPath} needs a direct repository-scoped next step.`;
    fallbackItem.steps = [`Review ${displayPath} and update one concrete file to produce a measurable improvement.`];
    fallbackItem.success_criteria = [`Complete one repository-scoped change under ${displayPath} and verify the result.`];
  }
  return { suggestions: [fallbackItem] };
}

export function normalizeLegacySuggestPayload(
  rawOutput: unknown,
  targetPath: string,
  displayPath: string,
  context: string,
  maxSuggestions: number,
  repoFiles: string[] = [],
  isSoftwareGoal = true
): SuggestOutput {
  const candidateSource = extractSuggestCandidates(rawOutput);
  const normalizedSuggestions = candidateSource
    .map((candidate) => normalizeLegacySuggestion(candidate, targetPath, displayPath, context, repoFiles, isSoftwareGoal))
    .filter((suggestion, index, all) => all.findIndex((item) => item.title === suggestion.title) === index)
    .slice(0, Math.max(1, maxSuggestions));

  if (normalizedSuggestions.length > 0) {
    return { suggestions: normalizedSuggestions };
  }

  return buildFallbackSuggestPayload(targetPath, displayPath, context, maxSuggestions, repoFiles, isSoftwareGoal);
}

export function normalizeSuggestPayload(
  rawOutput: unknown,
  targetPath: string,
  displayPath: string,
  context: string,
  maxSuggestions: number,
  repoFiles: string[] = [],
  isSoftwareGoal = true
): SuggestOutput {
  const parsed = SuggestOutputSchema.safeParse(rawOutput);
  if (parsed.success) {
    if (!isSoftwareGoal) {
      return {
        suggestions: parsed.data.suggestions.map(({ repo_context: _rc, ...rest }) => rest),
      };
    }
    return parsed.data;
  }

  const legacyNormalized = normalizeLegacySuggestPayload(
    rawOutput,
    targetPath,
    displayPath,
    context,
    maxSuggestions,
    repoFiles,
    isSoftwareGoal
  );
  const reparsed = SuggestOutputSchema.safeParse(legacyNormalized);
  if (reparsed.success) {
    return reparsed.data;
  }

  const fallback = buildFallbackSuggestPayload(targetPath, displayPath, context, maxSuggestions, repoFiles, isSoftwareGoal);
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

export async function generateSuggestOutput(
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

// ─── Project context gathering ───

export async function gatherProjectContext(targetPath: string): Promise<string> {
  const parts: string[] = [];

  // Read package.json if present
  try {
    const pkgPath = `${targetPath}/package.json`;
    const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    const name = typeof pkg.name === "string" ? pkg.name : "";
    const description = typeof pkg.description === "string" ? pkg.description : "";
    const scripts = pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts as Record<string, unknown>).join(", ")
      : "";
    const prefix = name ? `Node.js project '${name}'` : "Node.js project";
    const descPart = description ? `. ${description}` : "";
    const scriptsPart = scripts ? `. Scripts: ${scripts}` : "";
    parts.push(`${prefix}${descPart}${scriptsPart}`);
  } catch {
    // no package.json or parse error — skip
  }

  // List top-level directory entries
  try {
    const entries = fs.readdirSync(targetPath);
    const dirs = entries.filter((e) => {
      try { return fs.statSync(`${targetPath}/${e}`).isDirectory(); } catch { return false; }
    });
    const files = entries.filter((e) => {
      try { return fs.statSync(`${targetPath}/${e}`).isFile(); } catch { return false; }
    });
    const topDirs = dirs.slice(0, 10).map((d) => `${d}/`).join(", ");
    const topFiles = files.slice(0, 5).join(", ");
    const filePart = [topDirs, topFiles].filter(Boolean).join(", ");
    if (filePart) {
      parts.push(`Files: ${filePart}`);
    }
  } catch {
    // readdirSync failed — skip
  }

  // Get last 5 git commit subjects using spawnSync (no shell, no injection risk)
  const gitResult = spawnSync("git", ["log", "--oneline", "-5", "--format=%s"], {
    cwd: targetPath,
    encoding: "utf-8",
  });
  if (gitResult.status === 0 && gitResult.stdout) {
    const log = gitResult.stdout.trim();
    if (log) {
      parts.push(`Recent changes: ${log.split("\n").join("; ")}`);
    }
  }

  return parts.join(". ");
}
