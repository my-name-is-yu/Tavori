/**
 * Phase 3 layer executors: Cron and GoalTrigger.
 * Extracted to keep schedule-engine.ts under 500 lines.
 */
import {
  ScheduleResultSchema,
  type ScheduleEntry,
  type ScheduleResult,
} from "./types/schedule.js";
import type { IDataSourceAdapter } from "../platform/observation/data-source-adapter.js";
import type { DataSourceRegistry } from "../platform/observation/data-source-adapter.js";
import type { ILLMClient } from "../base/llm/llm-client.js";

interface LayerDeps {
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<void> };
  coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
  stateManager?: { loadGoal(goalId: string): Promise<any> };
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

async function getAdapter(
  sourceId: string,
  registry: Map<string, IDataSourceAdapter> | DataSourceRegistry | undefined
): Promise<IDataSourceAdapter | undefined> {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(sourceId);
  try {
    return (registry as DataSourceRegistry).getSource(sourceId);
  } catch {
    return undefined;
  }
}

export async function executeCron(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.cron;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No cron config",
      fired_at: firedAt,
    });
  }

  // Check daily budget
  if ((entry.tokens_used_today ?? 0) >= entry.max_tokens_per_day) {
    deps.logger.info(`Cron "${entry.name}" skipped: daily budget exceeded`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      error_message: "daily budget exceeded",
      fired_at: firedAt,
    });
  }

  try {
    // Gather context from data sources
    const contextMap: Record<string, string> = {};
    for (const sourceId of cfg.context_sources) {
      const adapter = await getAdapter(sourceId, deps.dataSourceRegistry);
      if (adapter) {
        try {
          const result = await adapter.query({
            timeout_ms: 10000,
            dimension_name: sourceId,
          } as Parameters<typeof adapter.query>[0]);
          contextMap[sourceId] = JSON.stringify(result.value ?? result.raw);
        } catch (err) {
          deps.logger.warn(`Cron "${entry.name}" context source "${sourceId}" failed: ${err instanceof Error ? err.message : String(err)}`);
          contextMap[sourceId] = "";
        }
      } else {
        deps.logger.warn(`Cron "${entry.name}" context source "${sourceId}" not found`);
        contextMap[sourceId] = "";
      }
    }

    // Interpolate prompt template
    let prompt = cfg.prompt_template;
    for (const [key, value] of Object.entries(contextMap)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // Call LLM
    let tokensUsed = 0;
    let outputSummary: string | undefined;

    if (deps.llmClient) {
      const llmResponse = await deps.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { model_tier: "light", max_tokens: cfg.max_tokens }
      );
      tokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0);
      outputSummary = llmResponse.content;
    }

    // TODO Phase 4: integrate ReportingEngine for report/both output_format
    if (cfg.output_format === "report" || cfg.output_format === "both") {
      deps.logger.warn('output_format "report" not yet implemented — ReportingEngine integration deferred to Phase 4');
    }

    // Dispatch notification if configured
    if ((cfg.output_format === "notification" || cfg.output_format === "both") && deps.notificationDispatcher) {
      try {
        await deps.notificationDispatcher.dispatch({
          report_type: "schedule_report_ready",
          entry_id: entry.id,
          entry_name: entry.name,
          output_summary: outputSummary,
        });
      } catch (err) {
        deps.logger.warn(`Cron "${entry.name}" notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      output_summary: outputSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Cron "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
    });
  }
}

export async function executeGoalTrigger(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.goal_trigger;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No goal_trigger config",
      fired_at: firedAt,
    });
  }

  // Check daily budget
  if ((entry.tokens_used_today ?? 0) >= entry.max_tokens_per_day) {
    deps.logger.info(`GoalTrigger "${entry.name}" skipped: daily budget exceeded`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "skipped",
      duration_ms: 0,
      error_message: "daily budget exceeded",
      fired_at: firedAt,
    });
  }

  // Check if goal is already active
  if (cfg.skip_if_active && deps.stateManager) {
    try {
      const goal = await deps.stateManager.loadGoal(cfg.goal_id);
      if (goal && (goal.status === "active" || goal.status === "running")) {
        deps.logger.info(`GoalTrigger "${entry.name}" skipped: goal ${cfg.goal_id} is already active`);
        return ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "skipped",
          duration_ms: 0,
          error_message: `goal ${cfg.goal_id} is already active`,
          fired_at: firedAt,
        });
      }
    } catch (err) {
      deps.logger.warn(`GoalTrigger "${entry.name}" could not check goal state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!deps.coreLoop) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No coreLoop provided",
      fired_at: firedAt,
    });
  }

  try {
    const result = await deps.coreLoop.run(cfg.goal_id, { maxIterations: cfg.max_iterations });
    const tokensUsed = typeof result?.tokensUsed === "number" ? result.tokensUsed : 0;

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`GoalTrigger "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
    });
  }
}
