import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../utils/json-io.js";
import type { StateManager } from "../state/state-manager.js";
import type { ILLMClient } from "../llm/llm-client.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import { z } from "zod";
import type { WeeklyReviewReport } from "./types.js";
import { WeeklyReviewReportSchema } from "./types.js";

// ─── LLM response schema ───

const LLMWeeklyResponseSchema = z.object({
  rankings: z.array(
    z.object({
      goal_id: z.string(),
      progress_rate: z.number().min(0).max(1),
      strategy_effectiveness: z.enum(["high", "medium", "low"]),
      recommendation: z.string(),
    })
  ),
  suggested_additions: z.array(z.string()).default([]),
  suggested_removals: z.array(z.string()).default([]),
  summary: z.string(),
});

// ─── Helpers ───

function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function computeWeeklyDelta(
  gapHistory: Array<{ gap_vector: Array<{ normalized_weighted_gap: number }> }>
): number {
  if (gapHistory.length < 2) return 0;
  const recent = gapHistory.at(-1)!;
  const prior = gapHistory.at(-2)!;
  const latest = Math.max(...recent.gap_vector.map((g) => g.normalized_weighted_gap));
  const previous = Math.max(...prior.gap_vector.map((g) => g.normalized_weighted_gap));
  // positive delta = gap is closing (progress)
  return Math.min(1, Math.max(0, previous - latest));
}

// ─── Main ───

export async function runWeeklyReview(deps: {
  stateManager: StateManager;
  llmClient: ILLMClient;
  baseDir: string;
  notificationDispatcher?: INotificationDispatcher;
}): Promise<WeeklyReviewReport> {
  const { stateManager, llmClient, baseDir, notificationDispatcher } = deps;
  const now = new Date().toISOString();
  const week = getISOWeek(new Date());

  // Build per-goal summaries
  const goalIds = await stateManager.listGoalIds();
  const goalSummaries: Array<{
    goal_id: string;
    title: string;
    weekly_delta: number;
  }> = [];

  for (const id of goalIds) {
    const goal = await stateManager.loadGoal(id);
    if (!goal || goal.status !== "active") continue;

    const gapHistory = await stateManager.loadGapHistory(id);
    const weekly_delta = computeWeeklyDelta(gapHistory);

    goalSummaries.push({
      goal_id: goal.id,
      title: goal.title,
      weekly_delta,
    });
  }

  let rankings: WeeklyReviewReport["rankings"] = [];
  let suggested_additions: string[] = [];
  let suggested_removals: string[] = [];
  let summary = "";

  if (goalSummaries.length > 0) {
    const prompt = `You are PulSeed's weekly reviewer. Analyze this week's goal progress and provide a strategic review.

Goals (weekly_delta = how much gap closed this week, 0-1):
${JSON.stringify(goalSummaries, null, 2)}

Rank each goal by progress_rate (0-1). Assess strategy_effectiveness (high/medium/low).
Suggest new goal additions or removals where appropriate.
Write a brief summary of the week.

Respond with JSON matching this schema:
{ "rankings": [{"goal_id": string, "progress_rate": number, "strategy_effectiveness": "high"|"medium"|"low", "recommendation": string}], "suggested_additions": [string], "suggested_removals": [string], "summary": string }`;

    try {
      const response = await llmClient.sendMessage([{ role: "user", content: prompt }]);
      const parsed = llmClient.parseJSON(response.content, LLMWeeklyResponseSchema);
      rankings = parsed.rankings;
      suggested_additions = parsed.suggested_additions ?? [];
      suggested_removals = parsed.suggested_removals ?? [];
      summary = parsed.summary;
    } catch {
      // LLM error — return partial report with empty rankings
    }
  }

  const report = WeeklyReviewReportSchema.parse({
    week,
    created_at: now,
    goals_reviewed: goalSummaries.length,
    rankings,
    suggested_additions,
    suggested_removals,
    summary,
  });

  // Persist report
  const reflectionsDir = path.join(baseDir, "reflections");
  await fsp.mkdir(reflectionsDir, { recursive: true });
  await writeJsonFileAtomic(path.join(reflectionsDir, `weekly-${week}.json`), report);

  // Notify
  if (notificationDispatcher && goalSummaries.length > 0) {
    await notificationDispatcher.dispatch({
      id: `weekly-review-${week}`,
      report_type: "weekly_report",
      goal_id: null,
      title: `Weekly Review — ${week}`,
      content: `Reviewed ${goalSummaries.length} goals. ${suggested_removals.length} removal(s) suggested.`,
      verbosity: "standard",
      generated_at: now,
      delivered_at: null,
      read: false,
    });
  }

  return report;
}
