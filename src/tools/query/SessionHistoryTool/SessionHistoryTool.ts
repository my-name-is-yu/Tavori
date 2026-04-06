import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import type { StateManager } from "../../../base/state/state-manager.js";

// NOTE: fs.readdirSync is used only for listing filenames (safe). All file READS go through stateManager.readRaw().

export const SessionHistoryInputSchema = z.object({
  goalId: z.string().optional(),
  limit: z.number().int().positive().default(5),
  includeObservations: z.boolean().default(true),
});
export type SessionHistoryInput = z.infer<typeof SessionHistoryInputSchema>;

interface SessionSummary {
  sessionId: string;
  goalId: string;
  strategy?: string;
  taskSummary?: string;
  observations?: unknown;
  outcome?: string;
  timestamp: string;
}

export class SessionHistoryTool implements ITool<SessionHistoryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "session_history",
    aliases: ["get_session_history", "observe_sessions"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = SessionHistoryInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: SessionHistoryInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const sessions = await this._loadSessions(input);
      return {
        success: true,
        data: { sessions },
        summary: `Found ${sessions.length} session(s)`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `SessionHistoryTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async _loadSessions(input: SessionHistoryInput): Promise<SessionSummary[]> {
    const baseDir = this.stateManager.getBaseDir();
    const sessionsDir = path.join(baseDir, "sessions");

    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    // Listing filenames is safe; all file READS go through stateManager.readRaw() (path traversal protection).
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"));

    // Filter by goalId if provided
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      try {
        const raw = await this.stateManager.readRaw(`sessions/${file}`) as Record<string, unknown> | null;
        if (raw == null) continue;
        const session = this._toSummary(raw, input.includeObservations);
        if (!session) continue;
        if (input.goalId && session.goalId !== input.goalId) continue;
        summaries.push(session);
      } catch {
        // skip unparseable files
      }
    }

    // Sort by actual timestamp descending (ISO 8601 strings sort lexicographically), then take limit
    summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return summaries.slice(0, input.limit);
  }

  private _toSummary(raw: Record<string, unknown>, includeObservations: boolean): SessionSummary | null {
    const id = typeof raw["id"] === "string" ? raw["id"] : undefined;
    const goalId = typeof raw["goal_id"] === "string" ? raw["goal_id"] : undefined;
    const startedAt = typeof raw["started_at"] === "string" ? raw["started_at"] : new Date(0).toISOString();

    if (!id || !goalId) return null;

    const summary: SessionSummary = {
      sessionId: id,
      goalId,
      timestamp: startedAt,
    };

    if (typeof raw["result_summary"] === "string") {
      summary.taskSummary = raw["result_summary"];
    }
    if (typeof raw["session_type"] === "string") {
      summary.strategy = raw["session_type"];
    }
    if (raw["ended_at"] != null) {
      summary.outcome = raw["ended_at"] ? "completed" : "in_progress";
    }

    if (includeObservations && raw["context_slots"] != null) {
      summary.observations = raw["context_slots"];
    }

    return summary;
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
