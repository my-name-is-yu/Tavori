// ─── MCP Server Tool Implementations ───

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { StateManager } from "../state/state-manager.js";
import { loadSharedEntries } from "../knowledge/knowledge-search.js";

export interface MCPServerDeps {
  stateManager: StateManager;
  baseDir: string;
}

type MCPResult = { content: [{ type: "text"; text: string }] };

function ok(data: unknown): MCPResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function err(message: string): MCPResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

// ─── pulseed_goal_list ───

export async function toolGoalList(deps: MCPServerDeps): Promise<MCPResult> {
  try {
    const ids = await deps.stateManager.listGoalIds();
    const goals = await Promise.all(
      ids.map(async (id) => {
        const goal = await deps.stateManager.loadGoal(id);
        if (!goal) return null;
        return { id: goal.id, title: goal.title, status: goal.status, loop_status: goal.loop_status };
      })
    );
    return ok(goals.filter(Boolean));
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_goal_status ───

export async function toolGoalStatus(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const goal = await deps.stateManager.loadGoal(args.goal_id);
    if (!goal) return err(`Goal not found: ${args.goal_id}`);
    const gapHistory = await deps.stateManager.loadGapHistory(args.goal_id);
    const latestGap = gapHistory.length > 0 ? gapHistory[gapHistory.length - 1] : null;
    return ok({ goal, latest_gap: latestGap });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_goal_create ───

export async function toolGoalCreate(
  deps: MCPServerDeps,
  args: { title: string; description: string }
): Promise<MCPResult> {
  try {
    const now = new Date().toISOString();
    const goalId = randomUUID();
    const goal = {
      id: goalId,
      parent_id: null,
      node_type: "goal",
      title: args.title,
      description: args.description,
      status: "pending" as const,
      dimensions: [],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: [],
      children_ids: [],
      target_date: null,
      origin: "manual",
      pace_snapshot: null,
      deadline: null,
      confidence_flag: null,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      decomposition_depth: 0,
      specificity_score: null,
      loop_status: "idle",
      created_at: now,
      updated_at: now,
    };
    const goalDir = path.join(deps.baseDir, "goals", goalId);
    await fsp.mkdir(goalDir, { recursive: true });
    await fsp.writeFile(path.join(goalDir, "goal.json"), JSON.stringify(goal, null, 2), "utf-8");
    return ok({ goal_id: goalId, title: args.title, status: "pending" });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_observe ───

export async function toolObserve(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const log = await deps.stateManager.loadObservationLog(args.goal_id);
    if (!log) return ok({ goal_id: args.goal_id, observations: [] });
    const recent = log.entries.slice(-10);
    return ok({ goal_id: args.goal_id, observations: recent });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_task_list ───

export async function toolTaskList(deps: MCPServerDeps, args: { goal_id: string }): Promise<MCPResult> {
  try {
    const tasksDir = path.join(deps.baseDir, "tasks", args.goal_id);
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(tasksDir);
    } catch {
      return ok({ goal_id: args.goal_id, tasks: [] });
    }
    const tasks: unknown[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") continue;
      try {
        const raw = await fsp.readFile(path.join(tasksDir, entry), "utf-8");
        tasks.push(JSON.parse(raw));
      } catch {
        // skip corrupt files
      }
    }
    return ok({ goal_id: args.goal_id, tasks });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_knowledge_search ───

export async function toolKnowledgeSearch(deps: MCPServerDeps, args: { query: string }): Promise<MCPResult> {
  try {
    const entries = await loadSharedEntries(deps.stateManager);
    const q = args.query.toLowerCase();
    const matched = entries.filter((e) => {
      const text = `${e.question ?? ""} ${e.answer ?? ""} ${(e.tags ?? []).join(" ")}`.toLowerCase();
      return text.includes(q);
    });
    return ok({ query: args.query, results: matched.slice(0, 10) });
  } catch (e) {
    return err(String(e));
  }
}

// ─── pulseed_trigger ───

export async function toolTrigger(
  deps: MCPServerDeps,
  args: { source: string; event_type: string; data: Record<string, unknown> }
): Promise<MCPResult> {
  try {
    const eventsDir = path.join(deps.baseDir, "events");
    await fsp.mkdir(eventsDir, { recursive: true });
    const eventId = randomUUID();
    const event = {
      id: eventId,
      source: args.source,
      event_type: args.event_type,
      data: args.data,
      created_at: new Date().toISOString(),
    };
    const filePath = path.join(eventsDir, `${eventId}.json`);
    await fsp.writeFile(filePath, JSON.stringify(event, null, 2), "utf-8");
    return ok({ event_id: eventId, status: "queued" });
  } catch (e) {
    return err(String(e));
  }
}
