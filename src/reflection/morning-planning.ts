import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic } from "../base/utils/json-io.js";
import type { StateManager } from "../base/state/state-manager.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import { z } from "zod";
import type { PlanningReport, GoalSummary } from "./types.js";
import { PlanningReportSchema } from "./types.js";
import type { HookManager } from "../runtime/hook-manager.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";

// ─── LLM response schema ───

const LLMPlanningResponseSchema = z.object({
  priorities: z.array(
    z.object({
      goal_id: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      reasoning: z.string(),
    })
  ),
  suggestions: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
});

// ─── Helpers ───

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function aggregateGapScore(gaps: Array<{ normalized_weighted_gap: number }>): number {
  if (gaps.length === 0) return 0;
  return Math.max(...gaps.map((g) => g.normalized_weighted_gap));
}

async function buildGoalSummaries(stateManager: StateManager): Promise<GoalSummary[]> {
  const goalIds = await stateManager.listGoalIds();
  const summaries: GoalSummary[] = [];

  for (const id of goalIds) {
    const goal = await stateManager.loadGoal(id);
    if (!goal || goal.status !== "active") continue;

    const gapHistory = await stateManager.loadGapHistory(id);
    const latest = gapHistory.at(-1);
    const gapScore = latest ? aggregateGapScore(latest.gap_vector) : 0;

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

export async function runMorningPlanning(deps: {
  stateManager: StateManager;
  llmClient: ILLMClient;
  baseDir: string;
  notificationDispatcher?: INotificationDispatcher;
  hookManager?: HookManager;
}): Promise<PlanningReport> {
  const { stateManager, llmClient, baseDir, notificationDispatcher, hookManager } = deps;
  const date = todayISO();
  const now = new Date().toISOString();

  const goalSummaries = await buildGoalSummaries(stateManager);

  let priorities: PlanningReport["priorities"] = [];
  let suggestions: string[] = [];
  let concerns: string[] = [];

  if (goalSummaries.length > 0) {
    const prompt = `${getInternalIdentityPrefix("morning planner")} Review these active goals and create a daily plan.

Goals:
${JSON.stringify(goalSummaries, null, 2)}

For each goal, assign priority (high/medium/low) with reasoning.
List any suggestions for new actions or concerns.

Respond with JSON matching this schema:
{ "priorities": [{"goal_id": string, "priority": "high"|"medium"|"low", "reasoning": string}], "suggestions": [string], "concerns": [string] }`;

    try {
      const response = await llmClient.sendMessage([{ role: "user", content: prompt }]);
      const parsed = llmClient.parseJSON(response.content, LLMPlanningResponseSchema);
      priorities = parsed.priorities;
      suggestions = parsed.suggestions ?? [];
      concerns = parsed.concerns ?? [];
    } catch {
      // LLM error — return partial report with empty priorities
    }
  }

  const report = PlanningReportSchema.parse({
    date,
    created_at: now,
    goals_reviewed: goalSummaries.length,
    priorities,
    suggestions,
    concerns,
  });

  // Persist report
  const reflectionsDir = path.join(baseDir, "reflections");
  await fsp.mkdir(reflectionsDir, { recursive: true });
  await writeJsonFileAtomic(path.join(reflectionsDir, `morning-${date}.json`), report);

  void hookManager?.emit("ReflectionComplete", { data: { type: "morning_planning" } });

  // Notify
  if (notificationDispatcher && goalSummaries.length > 0) {
    const now2 = new Date().toISOString();
    await notificationDispatcher.dispatch({
      id: `morning-planning-${date}`,
      report_type: "daily_summary",
      goal_id: null,
      title: `Morning Planning — ${date}`,
      content: `Reviewed ${goalSummaries.length} goals. ${concerns.length} concern(s).`,
      verbosity: "standard",
      generated_at: now2,
      delivered_at: null,
      read: false,
    });
  }

  return report;
}
