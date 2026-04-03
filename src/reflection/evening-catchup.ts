import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json-io.js";
import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import { z } from "zod";
import type { CatchupReport, GoalSummary } from "./types.js";
import { CatchupReportSchema } from "./types.js";
import type { HookManager } from "../runtime/hook-manager.js";

// ─── LLM response schema ───

const LLMCatchupResponseSchema = z.object({
  progress_summary: z.string(),
  completions: z.array(z.string()).default([]),
  stalls: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
});

// ─── Helpers ───

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadGoalSummaries(stateManager: StateManager): Promise<GoalSummary[]> {
  const goalIds = await stateManager.listGoalIds();
  const summaries: GoalSummary[] = [];

  for (const id of goalIds) {
    const goal = await stateManager.loadGoal(id);
    if (!goal || goal.status !== "active") continue;

    const gapHistory = await stateManager.loadGapHistory(id);
    const latest = gapHistory.at(-1);
    const gapScore = latest
      ? Math.max(...latest.gap_vector.map((g) => g.normalized_weighted_gap))
      : 0;

    summaries.push({
      goal_id: goal.id,
      title: goal.title,
      status: goal.status,
      gap_score: Math.min(1, Math.max(0, gapScore)),
      stall_level: 0,
      dimensions_count: goal.dimensions.length,
    });
  }

  return summaries;
}

// ─── Main ───

export async function runEveningCatchup(deps: {
  stateManager: StateManager;
  llmClient: ILLMClient;
  baseDir: string;
  notificationDispatcher?: INotificationDispatcher;
  hookManager?: HookManager;
}): Promise<CatchupReport> {
  const { stateManager, llmClient, baseDir, notificationDispatcher, hookManager } = deps;
  const date = todayISO();
  const now = new Date().toISOString();

  const goalSummaries = await loadGoalSummaries(stateManager);

  let progressSummary = "No active goals to review.";
  let completions: string[] = [];
  let stalls: string[] = [];
  let concerns: string[] = [];

  if (goalSummaries.length > 0) {
    // Load morning report if available for comparison
    const morningPath = path.join(baseDir, "reflections", `morning-${date}.json`);
    let morningData: unknown = null;
    try {
      const raw = await fsp.readFile(morningPath, "utf-8");
      morningData = JSON.parse(raw);
    } catch {
      // No morning report available
    }

    const prompt = `You are PulSeed's evening catch-up assistant. Review today's goal progress.

Current goal state:
${JSON.stringify(goalSummaries, null, 2)}

${morningData ? `Morning plan:\n${JSON.stringify(morningData, null, 2)}\n` : ""}

Summarize the day's progress. List any completions, stalls, or concerns.

Respond with JSON:
{ "progress_summary": string, "completions": [string], "stalls": [string], "concerns": [string] }`;

    try {
      const response = await llmClient.sendMessage([{ role: "user", content: prompt }]);
      const parsed = llmClient.parseJSON(response.content, LLMCatchupResponseSchema);
      progressSummary = parsed.progress_summary;
      completions = parsed.completions ?? [];
      stalls = parsed.stalls ?? [];
      concerns = parsed.concerns ?? [];
    } catch {
      // LLM error — return partial report
      progressSummary = "Unable to generate summary due to LLM error.";
    }
  }

  const report = CatchupReportSchema.parse({
    date,
    created_at: now,
    goals_reviewed: goalSummaries.length,
    progress_summary: progressSummary,
    completions,
    stalls,
    concerns,
  });

  // Persist report
  const reflectionsDir = path.join(baseDir, "reflections");
  await fsp.mkdir(reflectionsDir, { recursive: true });
  await writeJsonFileAtomic(path.join(reflectionsDir, `evening-${date}.json`), report);

  void hookManager?.emit("ReflectionComplete", { data: { type: "evening_catchup" } });

  // Notify
  if (notificationDispatcher && goalSummaries.length > 0) {
    const now2 = new Date().toISOString();
    await notificationDispatcher.dispatch({
      id: `evening-catchup-${date}`,
      report_type: "daily_summary",
      goal_id: null,
      title: `Evening Catch-up — ${date}`,
      content: progressSummary,
      verbosity: "standard",
      generated_at: now2,
      delivered_at: null,
      read: false,
    });
  }

  return report;
}
