// ─── pulseed suggest and improve commands ───

import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { CharacterConfigManager } from "../../traits/character-config.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient } from "../../llm/provider-factory.js";
import { ReportingEngine } from "../../reporting-engine.js";
import { CapabilityDetector } from "../../observation/capability-detector.js";
import { buildDeps } from "../setup.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import {
  normalizeSuggestPayload,
  generateSuggestOutput,
  gatherProjectContext,
} from "./suggest-normalizer.js";
import { looksLikeSoftwareGoal } from "../../goal/goal-suggest.js";
import {
  buildAutoApprovalFn,
  buildLoopLogger,
  buildProgressHandler,
  runLoopWithSignals,
} from "../utils/loop-runner.js";

// ─── Shared setup helper ───

async function buildSuggestContext(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager
): Promise<{
  deps: Awaited<ReturnType<typeof buildDeps>>;
  existingTitles: string[];
  capabilityDetector: CapabilityDetector;
}> {
  const deps = await buildDeps(stateManager, characterConfigManager);

  const existingGoalIds = await deps.stateManager.listGoalIds();
  const existingTitles: string[] = [];
  for (const id of existingGoalIds) {
    const goal = await deps.stateManager.loadGoal(id);
    if (goal?.title) {
      existingTitles.push(goal.title);
    }
  }

  const llmClient = await buildLLMClient();
  const reportingEngine = new ReportingEngine(stateManager);
  const capabilityDetector = new CapabilityDetector(stateManager, llmClient, reportingEngine);

  return { deps, existingTitles, capabilityDetector };
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
    logger.error('Usage: pulseed suggest "<context>" [--max N] [--path <dir>]');
    return 1;
  }

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let setupResult: Awaited<ReturnType<typeof buildSuggestContext>>;
  try {
    setupResult = await buildSuggestContext(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise suggest dependencies", err));
    return 1;
  }

  const { deps, existingTitles, capabilityDetector } = setupResult;
  const targetPath = values.path?.trim() ? values.path : ".";
  const maxSuggestions = parseInt(values.max ?? "5", 10);
  const repoFiles: string[] = [];
  const isSoftware = looksLikeSoftwareGoal(context);

  console.log("Generating goal suggestions...\n");

  let suggestions: unknown;
  try {
    suggestions = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      context,
      { maxSuggestions, existingGoals: existingTitles, repoPath: targetPath, capabilityDetector }
    );
  } catch (err) {
    logger.error(formatOperationError("generate goal suggestions", err));
    return 1;
  }

  const finalPayload = normalizeSuggestPayload(suggestions, targetPath, targetPath, context, maxSuggestions, repoFiles, isSoftware);
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
  console.log(`\n[PulSeed Improve] Analyzing ${targetPath}...\n`);

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let setupResult: Awaited<ReturnType<typeof buildSuggestContext>>;
  try {
    setupResult = await buildSuggestContext(stateManager, characterConfigManager);
  } catch (err) {
    logger.error(formatOperationError("initialise improve dependencies", err));
    return 1;
  }

  const { deps, existingTitles, capabilityDetector } = setupResult;
  const context = await gatherProjectContext(targetPath);
  const maxSuggestions = parseInt(values.max || "3", 10);
  const repoFiles: string[] = [];
  const isSoftware = looksLikeSoftwareGoal(context);

  let rawSuggestions: unknown;
  try {
    rawSuggestions = await generateSuggestOutput(
      deps.goalNegotiator.suggestGoals.bind(deps.goalNegotiator),
      context,
      { maxSuggestions, existingGoals: existingTitles, repoPath: targetPath, capabilityDetector }
    );
  } catch (err) {
    logger.error(formatOperationError("generate improvement suggestions", err));
    return 1;
  }

  const normalizedPayload = normalizeSuggestPayload(rawSuggestions, targetPath, targetPath, context, maxSuggestions, repoFiles, isSoftware);
  const suggestions = normalizedPayload.suggestions;

  if (suggestions.length === 0) {
    console.log("No improvement goals found for the given path.");
    return 0;
  }

  // Select goal
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

  // Negotiate the selected goal
  const selectedDescription = selected.steps.join("\n");
  console.log(`[PulSeed Improve] Negotiating goal: "${selected.title}"...`);
  let goal: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["goal"];
  let response: Awaited<ReturnType<typeof deps.goalNegotiator.negotiate>>["response"];
  try {
    ({ goal, response } = await deps.goalNegotiator.negotiate(selectedDescription, {
      constraints: [],
      timeoutMs: 120_000,
    }));
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes("timed out");
    if (isTimeout) {
      logger.warn(`Goal negotiation timed out for "${selected.title}". Skipping.`);
      return 1;
    }
    logger.error(formatOperationError(`negotiate goal "${selected.title}"`, err));
    return 1;
  }

  const responseType = (response as { type: string }).type;
  if (responseType === "reject") {
    logger.error(`Goal negotiation rejected: ${response.message}`);
    return 1;
  }

  console.log(`[PulSeed Improve] Goal registered: ${goal.id}`);
  console.log(`  Response: ${responseType} — ${response.message}\n`);

  // Run the loop if --auto or --yes
  if (values.auto || values.yes) {
    console.log(`[PulSeed Improve] Starting improvement loop for goal ${goal.id}...`);
    const loopLogger = buildLoopLogger();
    const loopDeps = await buildDeps(
      stateManager,
      characterConfigManager,
      { maxIterations: maxSuggestions },
      buildAutoApprovalFn(),
      loopLogger,
      buildProgressHandler()
    );
    try {
      const result = await runLoopWithSignals(loopDeps.coreLoop, goal.id);
      console.log(`[PulSeed Improve] Loop completed for goal ${goal.id}`);
      if (result.finalStatus === "stalled") {
        logger.error("Improvement loop stalled. No further progress detected.");
        return 2;
      }
      if (result.finalStatus === "error") {
        logger.error("Improvement loop ended with an error.");
        return 1;
      }
    } catch (err) {
      logger.error(formatOperationError(`run improvement loop for goal "${goal.id}"`, err));
      return 1;
    }
  } else {
    console.log(`Goal created. Run with: pulseed run --goal ${goal.id}`);
  }

  return 0;
}
