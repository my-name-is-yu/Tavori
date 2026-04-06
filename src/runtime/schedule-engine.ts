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

const SCHEDULES_FILE = "schedules.json";

interface ScheduleEngineDeps {
  baseDir: string;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
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

  constructor(deps: ScheduleEngineDeps) {
    this.schedulesPath = path.join(deps.baseDir, SCHEDULES_FILE);
    this.logger = deps.logger ?? noopLogger;
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

      if (entry.layer !== "heartbeat") {
        result = ScheduleResultSchema.parse({
          entry_id: entry.id,
          status: "skipped",
          duration_ms: 0,
          fired_at: new Date().toISOString(),
        });
        this.logger.info(`Skipping non-heartbeat entry: ${entry.name} (layer=${entry.layer})`);
      } else {
        result = await this.executeHeartbeat(entry);
      }

      // Update entry state
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      if (idx !== -1) {
        const e = this.entries[idx];
        this.entries[idx] = {
          ...e,
          last_fired_at: result.fired_at,
          next_fire_at: this.computeNextFireAt(e.trigger),
          updated_at: new Date().toISOString(),
          total_executions: e.total_executions + 1,
          consecutive_failures:
            result.status === "failure" ? e.consecutive_failures + 1 : 0,
        };

        if (
          result.status === "failure" &&
          e.heartbeat &&
          this.entries[idx].consecutive_failures >= e.heartbeat.failure_threshold
        ) {
          this.logger.warn(
            `Entry "${e.name}" reached failure threshold (${this.entries[idx].consecutive_failures}/${e.heartbeat.failure_threshold})`
          );
        }
      }

      results.push(result);
    }

    if (results.length > 0) {
      await this.saveEntries();
    }

    return results;
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
