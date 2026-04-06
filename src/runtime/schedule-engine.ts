import { CronExpressionParser } from "cron-parser";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../base/utils/json-io.js";
import {
  ScheduleEntrySchema,
  ScheduleEntryListSchema,
  ScheduleResultSchema,
  type ScheduleEntry,
  type ScheduleResult,
} from "./types/schedule.js";
import type { IDataSourceAdapter } from "../platform/observation/data-source-adapter.js";
import type { DataSourceRegistry } from "../platform/observation/data-source-adapter.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { detectChange } from "./change-detector.js";

const SCHEDULES_FILE = "schedules.json";

interface ScheduleEngineDeps {
  baseDir: string;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<void> };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class ScheduleEngine {
  private entries: ScheduleEntry[] = [];
  private schedulesPath: string;
  private logger: NonNullable<ScheduleEngineDeps["logger"]>;
  private dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  private llmClient?: ILLMClient;
  private notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<void> };

  constructor(deps: ScheduleEngineDeps) {
    this.schedulesPath = path.join(deps.baseDir, SCHEDULES_FILE);
    this.logger = deps.logger ?? noopLogger;
    this.dataSourceRegistry = deps.dataSourceRegistry;
    this.llmClient = deps.llmClient;
    this.notificationDispatcher = deps.notificationDispatcher;
  }

  // ─── Persistence ───

  async loadEntries(): Promise<ScheduleEntry[]> {
    const raw = await readJsonFileOrNull(this.schedulesPath);
    if (raw === null) {
      this.entries = [];
      return [];
    }
    const result = ScheduleEntryListSchema.safeParse(raw);
    this.entries = result.success ? result.data : [];
    return this.entries;
  }

  async saveEntries(): Promise<void> {
    await writeJsonFileAtomic(this.schedulesPath, this.entries);
  }

  getEntries(): ScheduleEntry[] {
    return this.entries;
  }

  // ─── Entry management ───

  async addEntry(
    input: Omit<
      ScheduleEntry,
      | "id"
      | "created_at"
      | "updated_at"
      | "last_fired_at"
      | "next_fire_at"
      | "consecutive_failures"
      | "last_escalation_at"
      | "baseline_results"
      | "total_executions"
      | "total_tokens_used"
    >
  ): Promise<ScheduleEntry> {
    const now = new Date().toISOString();
    const entry = ScheduleEntrySchema.parse({
      ...input,
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      last_fired_at: null,
      next_fire_at: this.computeNextFireAt(input.trigger),
      consecutive_failures: 0,
      last_escalation_at: null,
      baseline_results: [],
      total_executions: 0,
      total_tokens_used: 0,
    });
    this.entries.push(entry);
    await this.saveEntries();
    return entry;
  }

  async removeEntry(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    await this.saveEntries();
    return true;
  }

  // ─── Scheduling ───

  async getDueEntries(): Promise<ScheduleEntry[]> {
    const now = Date.now();
    return this.entries.filter(
      (e) => e.enabled && new Date(e.next_fire_at).getTime() <= now
    );
  }

  async tick(): Promise<ScheduleResult[]> {
    const due = await this.getDueEntries();
    const results: ScheduleResult[] = [];

    for (const entry of due) {
      let result: ScheduleResult;

      if (entry.layer === "heartbeat") {
        result = await this.executeHeartbeat(entry);
      } else if (entry.layer === "probe") {
        result = await this.executeProbe(entry);
      } else {
        result = ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "skipped",
          duration_ms: 0,
          fired_at: new Date().toISOString(),
        });
        this.logger.info(`Skipping non-heartbeat/probe entry: ${entry.name} (layer=${entry.layer})`);
      }

      // Update entry state
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      if (idx !== -1) {
        const e = this.entries[idx];
        const newFailures =
          result.status === "error" || result.status === "failure"
            ? e.consecutive_failures + 1
            : 0;

        this.entries[idx] = {
          ...e,
          last_fired_at: result.fired_at,
          next_fire_at: this.computeNextFireAt(e.trigger),
          updated_at: new Date().toISOString(),
          total_executions: e.total_executions + 1,
          total_tokens_used: e.total_tokens_used + (result.tokens_used ?? 0),
          consecutive_failures: newFailures,
        };

        // Circuit breaker: disable entry if threshold exceeded
        if (
          e.escalation?.circuit_breaker_threshold &&
          newFailures >= e.escalation.circuit_breaker_threshold
        ) {
          this.entries[idx].enabled = false;
          this.logger.warn(
            `Entry "${e.name}" disabled by circuit breaker (${newFailures}/${e.escalation.circuit_breaker_threshold})`
          );
        }

        // Heartbeat failure threshold warning
        if (
          result.status === "failure" &&
          e.heartbeat &&
          newFailures >= e.heartbeat.failure_threshold
        ) {
          this.logger.warn(
            `Entry "${e.name}" reached failure threshold (${newFailures}/${e.heartbeat.failure_threshold})`
          );
        }

        // Escalation check
        const escalationResult = await this.checkEscalation(this.entries[idx], result);
        if (escalationResult !== null) {
          result = escalationResult;
          results.push(result);
          continue;
        }
      }

      results.push(result);
    }

    if (results.length > 0) {
      await this.saveEntries();
    }

    return results;
  }

  // ─── Probe execution (Phase 2) ───

  async executeProbe(entry: ScheduleEntry): Promise<ScheduleResult> {
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
    let adapter: IDataSourceAdapter | undefined;
    if (this.dataSourceRegistry) {
      if (this.dataSourceRegistry instanceof Map) {
        adapter = this.dataSourceRegistry.get(cfg.data_source_id);
      } else {
        try {
          adapter = (this.dataSourceRegistry as DataSourceRegistry).getSource(cfg.data_source_id);
        } catch {
          adapter = undefined;
        }
      }
    }
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
      const queryResult = await adapter.query({
        dimension_name: cfg.data_source_id,
        ...cfg.query_params,
      });

      const currentValue = queryResult.value ?? queryResult.raw;

      // Detect change
      const { changed, details } = detectChange(
        cfg.change_detector.mode,
        currentValue,
        entry.baseline_results,
        cfg.change_detector.threshold_value
      );

      this.logger.info(`Probe "${entry.name}": ${details}`);

      let tokensUsed = 0;
      let outputSummary: string | undefined;

      // Optional LLM analysis on change
      if (changed && cfg.llm_on_change && this.llmClient) {
        const prompt = cfg.llm_prompt_template
          ? cfg.llm_prompt_template.replace("{{result}}", JSON.stringify(currentValue))
          : `A scheduled probe detected a change. Current result: ${JSON.stringify(currentValue)}. Previous baselines: ${JSON.stringify(entry.baseline_results.slice(-3))}. Is this change significant? Respond concisely.`;

        try {
          const llmResponse = await this.llmClient.sendMessage(
            [{ role: "user", content: prompt }],
            { model_tier: "light" }
          );
          tokensUsed = llmResponse.usage?.total_tokens ?? 0;
          outputSummary = llmResponse.content;
        } catch (err) {
          this.logger.warn(`Probe "${entry.name}" LLM analysis failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Update baseline_results
      const windowSize = cfg.change_detector.baseline_window;
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      if (idx !== -1) {
        const updated = [...this.entries[idx].baseline_results, currentValue];
        this.entries[idx] = {
          ...this.entries[idx],
          baseline_results: updated.slice(-windowSize),
        };
      }

      // Dispatch change notification
      if (changed) {
        await this.dispatchNotification({
          report_type: "schedule_change",
          entry_id: entry.id,
          entry_name: entry.name,
          details,
          output_summary: outputSummary,
        });
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
      this.logger.error(`Probe "${entry.name}" failed: ${msg}`);
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "error",
        duration_ms: Date.now() - start,
        error_message: msg,
        fired_at: firedAt,
      });
    }
  }

  // ─── Escalation logic ───

  private async checkEscalation(
    entry: ScheduleEntry,
    result: ScheduleResult
  ): Promise<ScheduleResult | null> {
    const esc = entry.escalation;
    if (!esc?.enabled) return null;

    const isFailure = result.status === "error" || result.status === "failure";
    if (!isFailure) return null;

    const now = Date.now();

    // Check cooldown
    if (entry.last_escalation_at) {
      const lastEsc = new Date(entry.last_escalation_at).getTime();
      if (now - lastEsc < esc.cooldown_minutes * 60 * 1000) {
        this.logger.info(`Escalation for "${entry.name}" suppressed (cooldown)`);
        return null;
      }
    }

    // Check rate limit (max_per_hour)
    if (entry.last_escalation_at) {
      const lastEsc = new Date(entry.last_escalation_at).getTime();
      const hourAgo = now - 60 * 60 * 1000;
      if (lastEsc > hourAgo) {
        // Simple rate check: we only track last escalation, so check if within 1 hour
        // For full per-hour tracking, we'd need a ring buffer — simplified to "1 per period"
        const minIntervalMs = (60 * 60 * 1000) / esc.max_per_hour;
        if (now - lastEsc < minIntervalMs) {
          this.logger.info(`Escalation for "${entry.name}" suppressed (rate limit)`);
          return null;
        }
      }
    }

    // Update last_escalation_at
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx !== -1) {
      this.entries[idx] = {
        ...this.entries[idx],
        last_escalation_at: new Date().toISOString(),
      };
    }

    // Dispatch escalation notification
    await this.dispatchNotification({
      report_type: "schedule_escalation",
      entry_id: entry.id,
      entry_name: entry.name,
      target_layer: esc.target_layer,
      target_entry_id: esc.target_entry_id,
      consecutive_failures: entry.consecutive_failures,
    });

    this.logger.warn(
      `Escalating "${entry.name}" to ${esc.target_layer ?? "unknown"} (failures=${entry.consecutive_failures})`
    );

    // Activate target entry if specified
    if (esc.target_entry_id) {
      const targetIdx = this.entries.findIndex((e) => e.id === esc.target_entry_id);
      if (targetIdx !== -1) {
        this.entries[targetIdx] = {
          ...this.entries[targetIdx],
          enabled: true,
          next_fire_at: new Date().toISOString(), // fire immediately
        };
      }
    }

    return ScheduleResultSchema.parse({
      ...result,
      status: "escalated",
      escalated_to: esc.target_entry_id ?? esc.target_layer ?? null,
    });
  }

  // ─── Notification dispatch ───

  private async dispatchNotification(payload: Record<string, unknown>): Promise<void> {
    if (!this.notificationDispatcher) return;
    try {
      await this.notificationDispatcher.dispatch(payload);
    } catch (err) {
      this.logger.warn(`Notification dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Heartbeat execution (Phase 1) ───

  private async executeHeartbeat(entry: ScheduleEntry): Promise<ScheduleResult> {
    const firedAt = new Date().toISOString();
    const start = Date.now();
    const cfg = entry.heartbeat;

    if (!cfg) {
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "failure",
        duration_ms: 0,
        error_message: "No heartbeat config",
        fired_at: firedAt,
      });
    }

    try {
      const timeoutMs = cfg.timeout_ms;
      const config = cfg.check_config as Record<string, unknown>;

      switch (cfg.check_type) {
        case "http":
          await this.checkHttp(config.url as string, timeoutMs);
          break;
        case "tcp":
          await this.checkTcp(
            config.host as string,
            config.port as number,
            timeoutMs
          );
          break;
        case "process":
          this.checkProcess(config.pid as number);
          break;
        case "disk":
          await this.checkDisk(config.path as string);
          break;
        case "custom":
          await this.checkCustom(config.command as string, timeoutMs);
          break;
      }

      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "success",
        duration_ms: Date.now() - start,
        fired_at: firedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Heartbeat "${entry.name}" failed: ${msg}`);
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "failure",
        duration_ms: Date.now() - start,
        error_message: msg,
        fired_at: firedAt,
      });
    }
  }

  // ─── Check implementations ───

  private async checkHttp(url: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private checkTcp(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`TCP timeout after ${timeoutMs}ms`));
      });
      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  private checkProcess(pid: number): void {
    process.kill(pid, 0); // throws if process doesn't exist
  }

  private checkCustom(command: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(command, { timeout: timeoutMs }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async checkDisk(diskPath: string): Promise<void> {
    const { statfs } = await import("node:fs/promises");
    await statfs(diskPath); // throws if path doesn't exist
  }

  // ─── Schedule computation ───

  private computeNextFireAt(trigger: ScheduleEntry["trigger"]): string {
    if (trigger.type === "cron") {
      const next = CronExpressionParser.parse(trigger.expression).next();
      return next.toISOString() ?? new Date().toISOString();
    }
    return new Date(Date.now() + trigger.seconds * 1000).toISOString();
  }
}
