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
import { detectChange } from "./change-detector.js";

interface LayerDeps {
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
  stateManager?: { loadGoal(goalId: string): Promise<any> };
  reportingEngine?: { generateNotification(type: string, context: Record<string, unknown>): Promise<any> };
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
  /** Callback for probe to update baseline_results on the owning entry. */
  updateBaseline?: (entryId: string, value: unknown, windowSize: number) => void;
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

    // Report output via ReportingEngine
    // output_format "report" intentionally skips notificationDispatcher — 
    // report output is delivered only through ReportingEngine
    if (cfg.output_format === "report" || cfg.output_format === "both") {
      if (deps.reportingEngine) {
        await deps.reportingEngine.generateNotification("schedule_report", {
          entry_name: entry.name,
          entry_id: entry.id,
          output: outputSummary,
          report_type: cfg.report_type || "schedule_cron",
        });
      } else {
        deps.logger.warn('ReportingEngine not available for output_format report');
      }
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
    const tokensUsed = result?.tokensUsed ?? 0;
    if (result) {
      deps.logger.info(`GoalTrigger "${entry.name}" completed: status=${result.finalStatus}, iterations=${result.totalIterations}`);
    }

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

export async function executeProbe(entry: ScheduleEntry, deps: LayerDeps): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.probe;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No probe config",
      fired_at: firedAt,
    });
  }

  // Look up data source adapter
  const adapter = await getAdapter(cfg.data_source_id, deps.dataSourceRegistry);
  if (!adapter) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: `Data source not found: ${cfg.data_source_id}`,
      fired_at: firedAt,
    });
  }

  try {
    // Execute probe query
    // dimension_name comes AFTER query_params spread so it is authoritative and cannot be
    // accidentally overridden by user-supplied query_params.
    const queryResult = await adapter.query({
      timeout_ms: 10000,
      ...cfg.query_params,
      dimension_name: cfg.data_source_id,
    } as Parameters<typeof adapter.query>[0]);

    const currentValue = queryResult.value ?? queryResult.raw;

    // Detect change
    const { changed, details } = detectChange(
      cfg.change_detector.mode,
      currentValue,
      entry.baseline_results,
      cfg.change_detector.threshold_value
    );

    deps.logger.info(`Probe "${entry.name}": ${details}`);

    let tokensUsed = 0;
    let outputSummary: string | undefined;

    // Optional LLM analysis on change
    if (changed && cfg.llm_on_change && deps.llmClient) {
      const prompt = cfg.llm_prompt_template
        ? cfg.llm_prompt_template.replace("{{result}}", JSON.stringify(currentValue))
        : `A scheduled probe detected a change. Current result: ${JSON.stringify(currentValue)}. Previous baselines: ${JSON.stringify(entry.baseline_results.slice(-3))}. Is this change significant? Respond concisely.`;

      try {
        const llmResponse = await deps.llmClient.sendMessage(
          [{ role: "user", content: prompt }],
          { model_tier: "light" }
        );
        tokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0);
        outputSummary = llmResponse.content;
      } catch (err) {
        deps.logger.warn(`Probe "${entry.name}" LLM analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update baseline_results via callback
    if (deps.updateBaseline) {
      deps.updateBaseline(entry.id, currentValue, cfg.change_detector.baseline_window);
    }

    // Dispatch change notification
    if (changed && deps.notificationDispatcher) {
      try {
        await deps.notificationDispatcher.dispatch({
          report_type: "schedule_change",
          entry_id: entry.id,
          entry_name: entry.name,
          details,
          output_summary: outputSummary,
        });
      } catch (err) {
        deps.logger.warn(`Probe "${entry.name}" notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
      tokens_used: tokensUsed,
      change_detected: changed,
      output_summary: outputSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Probe "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
    });
  }
}
