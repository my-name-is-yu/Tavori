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
import { executeCron, executeGoalTrigger, executeProbe } from "./schedule-engine-layers.js";
import type { IDataSourceAdapter } from "../platform/observation/data-source-adapter.js";
import type { DataSourceRegistry } from "../platform/observation/data-source-adapter.js";
import type { ILLMClient } from "../base/llm/llm-client.js";

const SCHEDULES_FILE = "schedules.json";

interface ScheduleEngineDeps {
  baseDir: string;
  logger?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
  dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  llmClient?: ILLMClient;
  // Intentionally loose: schedule notifications are lightweight payloads and do not go through
  // the full Report pipeline (which requires Report schema fields like id, goal_id, generated_at).
  // Using Record<string,unknown> here allows ScheduleEngine to dispatch without constructing
  // a full Report object. Full Report integration deferred to Phase 4.
  notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
  stateManager?: { loadGoal(goalId: string): Promise<any> };
}

const noopLogger = {
  info: (_msg: string, _ctx?: Record<string, unknown>) => {},
  warn: (_msg: string, _ctx?: Record<string, unknown>) => {},
  error: (_msg: string, _ctx?: Record<string, unknown>) => {},
};

export class ScheduleEngine {
  private entries: ScheduleEntry[] = [];
  private schedulesPath: string;
  private logger: NonNullable<ScheduleEngineDeps["logger"]>;
  private dataSourceRegistry?: Map<string, IDataSourceAdapter> | DataSourceRegistry;
  private llmClient?: ILLMClient;
  private notificationDispatcher?: { dispatch(report: Record<string, unknown>): Promise<any> };
  private coreLoop?: { run(goalId: string, options?: { maxIterations?: number }): Promise<any> };
  private stateManager?: { loadGoal(goalId: string): Promise<any> };

  constructor(deps: ScheduleEngineDeps) {
    this.schedulesPath = path.join(deps.baseDir, SCHEDULES_FILE);
    this.logger = deps.logger ?? noopLogger;
    this.dataSourceRegistry = deps.dataSourceRegistry;
    this.llmClient = deps.llmClient;
    this.notificationDispatcher = deps.notificationDispatcher;
    this.coreLoop = deps.coreLoop;
    this.stateManager = deps.stateManager;
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
      | "max_tokens_per_day"
      | "tokens_used_today"
      | "budget_reset_at"
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
    // Reset daily budget for entries whose budget_reset_at is null or in the past
    const nowMs = Date.now();
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (!e.budget_reset_at || new Date(e.budget_reset_at).getTime() <= nowMs) {
        this.entries[i] = {
          ...e,
          tokens_used_today: 0,
          budget_reset_at: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
        };
      }
    }

    const due = await this.getDueEntries();
    const results: ScheduleResult[] = [];

    for (const entry of due) {
      let result: ScheduleResult;

      if (entry.layer === "heartbeat") {
        result = await this.executeHeartbeat(entry);
      } else if (entry.layer === "probe") {
        result = await this.executeProbe(entry);
      } else if (entry.layer === "cron") {
        result = await this.executeCron(entry);
      } else if (entry.layer === "goal_trigger") {
        result = await this.executeGoalTrigger(entry);
      } else {
        result = ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "skipped",
          duration_ms: 0,
          fired_at: new Date().toISOString(),
        });
        this.logger.info(`Skipping unknown layer entry: ${entry.name} (layer=${entry.layer})`);
      }

      // Update entry state
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      if (idx !== -1) {
        const e = this.entries[idx];
        const newFailures =
          result.status === "error" || result.status === "down"
            ? e.consecutive_failures + 1
            : 0;

        this.entries[idx] = {
          ...e,
          last_fired_at: result.fired_at,
          next_fire_at: this.computeNextFireAt(e.trigger),
          updated_at: new Date().toISOString(),
          total_executions: e.total_executions + 1,
          total_tokens_used: e.total_tokens_used + (result.tokens_used ?? 0),
          tokens_used_today: (e.tokens_used_today ?? 0) + (result.tokens_used ?? 0),
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
          result.status === "down" &&
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
    return executeProbe(entry, {
      ...this.layerDeps(),
      updateBaseline: (entryId, value, windowSize) => {
        const idx = this.entries.findIndex((e) => e.id === entryId);
        if (idx !== -1) {
          const updated = [...this.entries[idx].baseline_results, value];
          this.entries[idx] = {
            ...this.entries[idx],
            baseline_results: updated.slice(-windowSize),
          };
        }
      },
    });
  }

  // ─── Cron execution (Phase 3) ───

  async executeCron(entry: ScheduleEntry): Promise<ScheduleResult> {
    return executeCron(entry, this.layerDeps());
  }

  // ─── GoalTrigger execution (Phase 3) ───

  async executeGoalTrigger(entry: ScheduleEntry): Promise<ScheduleResult> {
    return executeGoalTrigger(entry, this.layerDeps());
  }

  private layerDeps() {
    return {
      dataSourceRegistry: this.dataSourceRegistry,
      llmClient: this.llmClient,
      notificationDispatcher: this.notificationDispatcher,
      coreLoop: this.coreLoop,
      stateManager: this.stateManager,
      logger: this.logger,
    };
  }

    // ─── Escalation logic ───

  private async checkEscalation(
    entry: ScheduleEntry,
    result: ScheduleResult
  ): Promise<ScheduleResult | null> {
    const esc = entry.escalation;
    if (!esc?.enabled) return null;

    const isFailure = result.status === "error" || result.status === "down";
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

    // Check minimum interval between escalations (derived from max_per_hour)
    // Simplified: enforces minimum interval between escalations (60min / max_per_hour).
    // Full rolling-window tracking deferred to Phase 4.
    if (entry.last_escalation_at) {
      const lastEsc = new Date(entry.last_escalation_at).getTime();
      const hourAgo = now - 60 * 60 * 1000;
      if (lastEsc > hourAgo) {
        const minIntervalMs = (60 * 60 * 1000) / esc.max_per_hour;
        if (now - lastEsc < minIntervalMs) {
          this.logger.info(`Escalation for "${entry.name}" suppressed (min interval)`);
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
        status: "error",
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
        status: "ok",
        duration_ms: Date.now() - start,
        fired_at: firedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Heartbeat "${entry.name}" failed: ${msg}`);
      return ScheduleResultSchema.parse({
        entry_id: entry.id,
        status: "down",
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
