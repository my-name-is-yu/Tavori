import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { Goal } from "../../base/types/goal.js";
import type { DaemonConfig, DaemonState, ResidentActivity } from "../../base/types/daemon.js";
import { ResidentActivitySchema } from "../../base/types/daemon.js";
import type { StateManager } from "../../base/state/state-manager.js";
import { PulSeedEventSchema } from "../../base/types/drive.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { CuriosityEngine } from "../../platform/traits/curiosity-engine.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { MemoryLifecycleManager } from "../../platform/knowledge/memory/memory-lifecycle.js";
import type { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { lintAgentMemory } from "../../platform/knowledge/knowledge-manager-lint.js";
import { DreamAnalyzer } from "../../platform/dream/dream-analyzer.js";
import { DreamConsolidator, type DreamLegacyConsolidationReport } from "../../platform/dream/dream-consolidator.js";
import { DreamScheduleSuggestionStore } from "../../platform/dream/dream-schedule-suggestions.js";
import { createRuntimeDreamSoilSyncService } from "../../platform/dream/dream-soil-sync.js";
import type { DreamReport, DreamRunReport, DreamTier } from "../../platform/dream/dream-types.js";
import { runDreamConsolidation } from "../../reflection/dream-consolidation.js";
import type { Logger } from "../logger.js";
import type { LoopSupervisor } from "../executor/index.js";
import type { ScheduleEngine } from "../schedule/engine.js";
import { runProactiveMaintenance } from "./maintenance.js";

export function resolveResidentWorkspaceDir(configuredPath?: string): string {
  const trimmed = configuredPath?.trim();
  return trimmed ? path.resolve(trimmed) : process.cwd();
}

export function gatherResidentWorkspaceContext(workspaceDir: string, seedDescription?: string): string {
  const parts: string[] = [`Workspace: ${workspaceDir}`];
  const seed = seedDescription?.trim();
  if (seed) {
    parts.push(`Resident trigger hint: ${seed}`);
  }

  try {
    const pkgPath = path.join(workspaceDir, "package.json");
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
    // No package metadata available.
  }

  try {
    const entries = fs.readdirSync(workspaceDir);
    const dirs = entries.filter((entry) => {
      try {
        return fs.statSync(path.join(workspaceDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
    const files = entries.filter((entry) => {
      try {
        return fs.statSync(path.join(workspaceDir, entry)).isFile();
      } catch {
        return false;
      }
    });
    const visibleEntries = [
      dirs.slice(0, 10).map((entry) => `${entry}/`).join(", "),
      files.slice(0, 5).join(", "),
    ].filter(Boolean).join(", ");
    if (visibleEntries) {
      parts.push(`Files: ${visibleEntries}`);
    }
  } catch {
    // Workspace listing is best-effort.
  }

  const gitResult = spawnSync("git", ["log", "--oneline", "-5", "--format=%s"], {
    cwd: workspaceDir,
    encoding: "utf-8",
  });
  if (gitResult.status === 0 && gitResult.stdout.trim().length > 0) {
    parts.push(`Recent changes: ${gitResult.stdout.trim().split("\n").join("; ")}`);
  }

  return parts.join(". ");
}

export interface DaemonRunnerResidentContext {
  baseDir: string;
  config: DaemonConfig;
  state: DaemonState;
  currentGoalIds: string[];
  stateManager: StateManager;
  driveSystem: { writeEvent(event: unknown): Promise<void> };
  logger: Logger;
  goalNegotiator?: GoalNegotiator;
  curiosityEngine?: CuriosityEngine;
  llmClient?: ILLMClient;
  memoryLifecycle?: MemoryLifecycleManager;
  knowledgeManager?: KnowledgeManager;
  scheduleEngine?: ScheduleEngine;
  supervisor?: LoopSupervisor;
  saveDaemonState(): Promise<void>;
  refreshOperationalState(): void;
  abortSleep(): void;
}

export async function loadExistingGoalTitles(
  context: Pick<DaemonRunnerResidentContext, "stateManager">,
): Promise<string[]> {
  const goalIds = await context.stateManager.listGoalIds().catch(() => []);
  const titles: string[] = [];
  for (const goalId of goalIds) {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (goal?.title) {
      titles.push(goal.title);
    }
  }
  return titles;
}

export async function loadKnownGoals(
  context: Pick<DaemonRunnerResidentContext, "stateManager">,
): Promise<Goal[]> {
  const goalIds = await context.stateManager.listGoalIds().catch(() => []);
  const goals: Goal[] = [];
  for (const goalId of goalIds) {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (goal) {
      goals.push(goal);
    }
  }
  return goals;
}

export async function persistResidentActivity(
  context: Pick<DaemonRunnerResidentContext, "state" | "saveDaemonState">,
  activity: Omit<ResidentActivity, "recorded_at"> & { recorded_at?: string },
): Promise<void> {
  const residentActivity = ResidentActivitySchema.parse({
    ...activity,
    recorded_at: activity.recorded_at ?? new Date().toISOString(),
  });
  context.state.last_resident_at = residentActivity.recorded_at;
  context.state.resident_activity = residentActivity;
  await context.saveDaemonState();
}

export async function triggerResidentGoalDiscovery(
  context: Pick<
    DaemonRunnerResidentContext,
    "goalNegotiator" | "currentGoalIds" | "config" | "supervisor" | "refreshOperationalState" | "abortSleep" | "logger"
  > &
    Pick<DaemonRunnerResidentContext, "saveDaemonState" | "state" | "stateManager">,
  details?: Record<string, unknown>,
): Promise<void> {
  if (!context.goalNegotiator) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because goal negotiation is unavailable.",
    });
    return;
  }

  if (context.currentGoalIds.length > 0) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because active goals are already running.",
    });
    return;
  }

  const hintedDescription =
    typeof details?.["description"] === "string" ? details["description"].trim() : "";
  const hintedTitle =
    typeof details?.["title"] === "string" ? details["title"].trim() : "";

  try {
    const workspaceDir = resolveResidentWorkspaceDir(context.config.workspace_path);
    const workspaceContext = gatherResidentWorkspaceContext(workspaceDir, hintedDescription);
    const existingTitles = await loadExistingGoalTitles(context);
    const suggestions = await context.goalNegotiator.suggestGoals(workspaceContext, {
      maxSuggestions: 1,
      existingGoals: existingTitles,
      repoPath: workspaceDir,
    });
    const suggestion = suggestions[0];
    const suggestionTitle = suggestion?.title ?? hintedTitle;
    const negotiationDescription = suggestion?.description ?? hintedDescription;

    if (!negotiationDescription) {
      await persistResidentActivity(context, {
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Resident discovery ran but found no actionable goal to negotiate.",
        suggestion_title: suggestionTitle || undefined,
      });
      return;
    }

    const { goal } = await context.goalNegotiator.negotiate(negotiationDescription, {
      workspaceContext,
      timeoutMs: 30_000,
    });
    if (!context.currentGoalIds.includes(goal.id)) {
      context.currentGoalIds.push(goal.id);
    }
    context.refreshOperationalState();
    await persistResidentActivity(context, {
      kind: "negotiation",
      trigger: "proactive_tick",
      summary: `Resident discovery negotiated a new goal: ${suggestionTitle || goal.title}`,
      suggestion_title: suggestionTitle || goal.title,
      goal_id: goal.id,
    });
    context.supervisor?.activateGoal(goal.id);
    context.abortSleep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident discovery failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident discovery failed: ${message}`,
    });
  }
}

export async function runResidentCuriosityCycle(
  context: Pick<
    DaemonRunnerResidentContext,
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger"
  >,
  options?: {
    activityTrigger?: ResidentActivity["trigger"];
    focus?: string;
    reviewLabel?: string;
    skipWhenNoTriggers?: boolean;
  },
): Promise<boolean> {
  if (!context.curiosityEngine) {
    if (options?.skipWhenNoTriggers) {
      return false;
    }
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: "Resident investigation skipped because curiosity wiring is unavailable.",
    });
    return true;
  }

  try {
    const goals = await loadKnownGoals(context);
    const triggers = await context.curiosityEngine.evaluateTriggers(goals);
    const focus = options?.focus?.trim() ?? "";

    if (triggers.length === 0) {
      if (options?.skipWhenNoTriggers) {
        return false;
      }
      await persistResidentActivity(context, {
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} ran and found no curiosity triggers.`
          : `Resident investigation ran${focus ? ` for ${focus}` : ""} and found nothing actionable.`,
      });
      return true;
    }

    const proposals = await context.curiosityEngine.generateProposals(triggers, goals);
    if (proposals.length === 0) {
      await persistResidentActivity(context, {
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} ran but produced no curiosity proposals.`
          : `Resident investigation ran${focus ? ` for ${focus}` : ""} but produced no curiosity proposals.`,
      });
      return true;
    }

    const proposal = proposals[0]!;
    await persistResidentActivity(context, {
      kind: "curiosity",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: options?.reviewLabel
        ? `Resident ${options.reviewLabel} created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`
        : `Resident investigation created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`,
      suggestion_title: proposal.proposed_goal.description,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident investigation failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: `Resident investigation failed: ${message}`,
    });
    return true;
  }
}

export async function triggerResidentInvestigation(
  context: Pick<DaemonRunnerResidentContext, "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger">,
  details?: Record<string, unknown>,
): Promise<void> {
  const focus = typeof details?.["what"] === "string" ? details["what"].trim() : "";
  await runResidentCuriosityCycle(context, {
    activityTrigger: "proactive_tick",
    focus,
    skipWhenNoTriggers: false,
  });
}

export async function runScheduledGoalReview(
  context: Pick<DaemonRunnerResidentContext, "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "config">,
  lastGoalReviewAt: number,
  setLastGoalReviewAt: (value: number) => void,
): Promise<boolean> {
  if (!context.curiosityEngine || !context.config.proactive_mode) {
    return false;
  }
  const now = Date.now();
  if (now - lastGoalReviewAt < context.config.goal_review_interval_ms) {
    return false;
  }
  setLastGoalReviewAt(now);
  return runResidentCuriosityCycle(context, {
    activityTrigger: "schedule",
    reviewLabel: "goal review",
    skipWhenNoTriggers: false,
  });
}

export async function tryApplyPendingDreamSuggestion(
  context: Pick<DaemonRunnerResidentContext, "baseDir" | "scheduleEngine">,
): Promise<{
  suggestion: { id: string; name?: string; reason?: string };
  entry: { id: string };
  duplicate: boolean;
} | null> {
  const dreamStore = new DreamScheduleSuggestionStore(context.baseDir);
  const pendingSuggestion = (await dreamStore.list()).find((suggestion) => suggestion.status === "pending");
  if (!pendingSuggestion || !context.scheduleEngine) {
    return null;
  }

  return dreamStore.applySuggestion(pendingSuggestion.id, context.scheduleEngine);
}

export async function runDreamAnalysis(
  context: Pick<DaemonRunnerResidentContext, "baseDir" | "llmClient" | "logger">,
  tier: DreamTier,
): Promise<DreamRunReport> {
  const analyzer = new DreamAnalyzer({
    baseDir: context.baseDir,
    llmClient: context.llmClient,
    logger: context.logger,
  });
  return analyzer.run({ tier });
}

export async function runPlatformDreamConsolidation(
  context: Pick<
    DaemonRunnerResidentContext,
    "baseDir" | "logger" | "knowledgeManager" | "llmClient" | "memoryLifecycle" | "stateManager"
  >,
  tier: DreamTier,
): Promise<DreamReport | null> {
  try {
    const knowledgeManager = context.knowledgeManager;
    const llmClient = context.llmClient;
    const consolidator = new DreamConsolidator({
      baseDir: context.baseDir,
      logger: context.logger,
      syncService: createRuntimeDreamSoilSyncService(),
      memoryQualityService: knowledgeManager && llmClient
        ? {
            run: async (input) => {
              const result = await lintAgentMemory({
                km: knowledgeManager,
                llmCall: async (prompt) => {
                  const response = await llmClient.sendMessage(
                    [{ role: "user", content: prompt }],
                    { max_tokens: 2000, model_tier: "light" },
                  );
                  return response.content;
                },
                autoRepair: input.autoRepair,
                minAutoRepairConfidence: input.minAutoRepairConfidence,
              });
              return {
                findings: result.findings.length,
                contradictionsFound: result.findings.filter((finding) => finding.type === "contradiction").length,
                stalenessFound: result.findings.filter((finding) => finding.type === "staleness").length,
                redundancyFound: result.findings.filter((finding) => finding.type === "redundancy").length,
                repairsApplied: result.repairs_applied,
                entriesFlagged: result.entries_flagged,
              };
            },
          }
        : undefined,
      legacyConsolidationService: tier === "deep"
        ? {
            run: () => runDreamConsolidation({
              stateManager: context.stateManager,
              memoryLifecycle: context.memoryLifecycle,
              knowledgeManager: context.knowledgeManager,
              baseDir: context.baseDir,
            }),
          }
        : undefined,
    });
    return await consolidator.run({ tier });
  } catch (error) {
    context.logger.warn("Platform Dream consolidation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function legacyReportFromPlatformDream(report: DreamReport | null): DreamLegacyConsolidationReport | null {
  const category = report?.categories.find((result) => result.category === "legacyReflectionCompatibility");
  if (!category || category.status !== "completed") {
    return null;
  }
  const legacy = report?.operational?.legacy_reflection;
  return legacy
    ? {
        goals_consolidated: legacy.goals_consolidated,
        entries_compressed: legacy.entries_compressed,
        stale_entries_found: legacy.stale_entries_found,
        revalidation_tasks_created: legacy.revalidation_tasks_created,
      }
    : null;
}

export async function triggerResidentDreamMaintenance(
  context: Pick<
    DaemonRunnerResidentContext,
    "baseDir" | "scheduleEngine" | "saveDaemonState" | "state" | "logger" | "knowledgeManager" | "llmClient" | "memoryLifecycle" | "stateManager"
  >,
  details?: Record<string, unknown>,
  tier: DreamTier = "deep",
): Promise<void> {
  try {
    const appliedBeforeAnalysis = await tryApplyPendingDreamSuggestion(context);
    if (appliedBeforeAnalysis) {
      await persistResidentActivity(context, {
        kind: "dream",
        trigger: "proactive_tick",
        summary: appliedBeforeAnalysis.duplicate
          ? `Resident dream linked pending suggestion "${appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.id}" to existing schedule ${appliedBeforeAnalysis.entry.id}.`
          : `Resident dream applied pending suggestion "${appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.id}" into schedule ${appliedBeforeAnalysis.entry.id}.`,
        suggestion_title: appliedBeforeAnalysis.suggestion.name ?? appliedBeforeAnalysis.suggestion.reason,
      });
      return;
    }

    const analysisReport = await runDreamAnalysis(context, tier);
    const appliedAfterAnalysis = tier === "deep" ? await tryApplyPendingDreamSuggestion(context) : null;
    const platformReport = await runPlatformDreamConsolidation(context, tier);
    const consolidationReport = tier === "deep"
      ? legacyReportFromPlatformDream(platformReport) ?? await runDreamConsolidation({
          stateManager: context.stateManager,
          memoryLifecycle: context.memoryLifecycle,
          knowledgeManager: context.knowledgeManager,
          baseDir: context.baseDir,
        })
      : null;
    const requestedGoalId =
      typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";
    const goalHint = requestedGoalId ? ` for ${requestedGoalId}` : "";

    await persistResidentActivity(context, {
      kind: "dream",
      trigger: "proactive_tick",
      summary: tier === "light"
        ? `Resident dream light analysis ran${goalHint}; processed ${analysisReport.goalsProcessed.length} goals, persisted ${analysisReport.patternsPersisted} patterns, and generated ${analysisReport.scheduleSuggestions} schedule suggestion(s).`
        : `Resident dream deep analysis ran${goalHint}; processed ${analysisReport.goalsProcessed.length} goals, persisted ${analysisReport.patternsPersisted} patterns, generated ${analysisReport.scheduleSuggestions} schedule suggestion(s), compressed ${consolidationReport?.entries_compressed ?? 0} entries, and created ${consolidationReport?.revalidation_tasks_created ?? 0} revalidation tasks${appliedAfterAnalysis ? ` while applying "${appliedAfterAnalysis.suggestion.name ?? appliedAfterAnalysis.suggestion.id}"` : ""}.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident dream maintenance failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident dream maintenance failed: ${message}`,
    });
  }
}

export async function triggerResidentPreemptiveCheck(
  context: Pick<
    DaemonRunnerResidentContext,
    "stateManager" | "driveSystem" | "currentGoalIds" | "refreshOperationalState" | "supervisor" | "abortSleep" | "saveDaemonState" | "state" | "logger"
  >,
  details?: Record<string, unknown>,
): Promise<void> {
  const goalId =
    typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";

  if (!goalId) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident preemptive check skipped because no goal_id was provided.",
    });
    return;
  }

  try {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (!goal) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: "proactive_tick",
        summary: `Resident preemptive check skipped because goal "${goalId}" was not found.`,
        goal_id: goalId,
      });
      return;
    }

    await context.driveSystem.writeEvent(
      PulSeedEventSchema.parse({
        type: "external",
        source: "resident-proactive",
        timestamp: new Date().toISOString(),
        data: {
          event_type: "preemptive_check",
          goal_id: goalId,
          requested_by: "resident-daemon",
        },
      }),
    );
    if (!context.currentGoalIds.includes(goalId)) {
      context.currentGoalIds.push(goalId);
    }
    context.refreshOperationalState();
    context.supervisor?.activateGoal(goalId);
    context.abortSleep();
    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: `Resident preemptive check queued an observation wake-up for goal "${goalId}".`,
      goal_id: goalId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident preemptive check failed", { error: message, goal_id: goalId });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident preemptive check failed: ${message}`,
      goal_id: goalId || undefined,
    });
  }
}

export async function triggerIdleResidentMaintenance(
  context: Pick<
    DaemonRunnerResidentContext,
    "currentGoalIds" | "baseDir" | "memoryLifecycle" | "knowledgeManager" | "llmClient" | "saveDaemonState" | "state" | "logger" | "scheduleEngine" | "stateManager"
  >,
): Promise<void> {
  if (context.currentGoalIds.length > 0) {
    return;
  }

  const dreamSuggestionPath = path.join(context.baseDir, "dream", "schedule-suggestions.json");
  const hasDreamSuggestionFile = fs.existsSync(dreamSuggestionPath);
  if (!hasDreamSuggestionFile && !context.memoryLifecycle && !context.knowledgeManager && !context.llmClient) {
    return;
  }

  await triggerResidentDreamMaintenance(context, undefined, "light");
}

export async function proactiveTick(
  context: Pick<
    DaemonRunnerResidentContext,
    "config" | "llmClient" | "state" | "logger" | "saveDaemonState" | "curiosityEngine" | "stateManager" | "goalNegotiator" | "currentGoalIds" | "supervisor" | "refreshOperationalState" | "abortSleep" | "baseDir" | "scheduleEngine" | "knowledgeManager" | "memoryLifecycle" | "driveSystem"
  >,
  lastProactiveTickAt: number,
  setLastProactiveTickAt: (value: number) => void,
  lastGoalReviewAt: number,
  setLastGoalReviewAt: (value: number) => void,
): Promise<void> {
  if (!context.config.proactive_mode) {
    return;
  }

  if (await runScheduledGoalReview(context, lastGoalReviewAt, setLastGoalReviewAt)) {
    return;
  }

  const curiosityTriggered = await runResidentCuriosityCycle(context, {
    activityTrigger: "proactive_tick",
    skipWhenNoTriggers: true,
  });
  if (curiosityTriggered) {
    return;
  }

  const result = await runProactiveMaintenance({
    config: context.config,
    llmClient: context.llmClient,
    state: context.state,
    lastProactiveTickAt,
    logger: context.logger,
  });
  setLastProactiveTickAt(result.lastProactiveTickAt);
  if (!result.decision) {
    return;
  }

  if (result.decision.action === "sleep") {
    await persistResidentActivity(context, {
      kind: "sleep",
      trigger: "proactive_tick",
      summary: "Resident proactive tick stayed idle.",
    });
    await triggerIdleResidentMaintenance(context);
    return;
  }

  if (result.decision.action === "suggest_goal") {
    await triggerResidentGoalDiscovery(context, result.decision.details);
    return;
  }

  if (result.decision.action === "investigate") {
    await triggerResidentInvestigation(context, result.decision.details);
    return;
  }

  if (result.decision.action === "preemptive_check") {
    await triggerResidentPreemptiveCheck(context, result.decision.details);
    return;
  }

  await persistResidentActivity(context, {
    kind: "skipped",
    trigger: "proactive_tick",
    summary: `Resident proactive tick requested ${result.decision.action}, but no resident executor is wired for it yet.`,
  });
}
